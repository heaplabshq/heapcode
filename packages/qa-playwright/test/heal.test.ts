import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ChatRequest, ChatResponse, Provider } from '@heapcode/core/providers';
import { Templates, applyHeals, createHealer, loadWorkspace, readFingerprints, runFlow, saveRefreshed, type Healer, type RunOptions } from '@heapcode/qa';
import { BrowserMissingError, PlaywrightDriver } from '../src/driver.js';

const page = (form: string): string =>
  `<!doctype html><title>Profile</title><h1>Profile</h1><form onsubmit="event.preventDefault(); document.querySelector('#out').textContent = 'Saved'">
   <label for="n">Name</label><input id="n">${form}</form><p id="out"></p>`;
const VERSIONS: Record<string, string> = {
  // As recorded.
  v1: page('<button id="save-1" data-testid="save" class="btn">Save changes</button>'),
  // A redesign: new id, no test id, wrapped, reworded a little, an extra button —
  // every strategy of the locator fails, yet it is plainly the same button.
  v2: page('<div class="row"><button id="save-9" class="btn btn-lg">Save all changes</button><button type="button">Cancel</button></div>'),
  // Reworded and restyled beyond what similarity trusts.
  v3: page('<div><button type="button" class="link">Discard</button><button id="x" class="primary">Update profile</button></div>'),
  // The feature is gone.
  v4: page('<p>Profiles are read-only now.</p>'),
};
let version = 'v1';

let server: Server;
let base = '';
let driver: PlaywrightDriver | undefined;

beforeAll(async () => {
  server = createServer((_req, res) => {
    res.setHeader('content-type', 'text/html');
    res.end(VERSIONS[version]);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    driver = await PlaywrightDriver.launch({ timeout: 2000 });
  } catch (err) {
    if (!(err instanceof BrowserMissingError)) throw err;
  }
}, 60_000);

afterAll(async () => {
  await driver?.close();
  await new Promise((r) => server.close(r));
}, 60_000);

function folder(): string {
  const dir = mkdtempSync(join(tmpdir(), 'heapqa-heal-'));
  mkdirSync(join(dir, 'flows'));
  writeFileSync(join(dir, 'heapqa.yaml'), `baseUrl: ${base}\ntimeout: 1500\n`);
  writeFileSync(
    join(dir, 'flows', 'profile.yaml'),
    `name: save profile
steps:
  - goto: /
  - type: { into: { label: Name }, text: Ada }
  - click: { testId: save, role: button, name: Save changes, css: "#save-1" }
    intent: save the profile
  - expect: { text: { in: { css: "#out" }, equals: Saved } }
`,
  );
  return dir;
}

async function run(dir: string, healer?: Healer, refresh = false) {
  const ws = loadWorkspace(dir, {});
  const options: RunOptions = {
    driver: driver!,
    library: ws.steps,
    templates: new Templates({ inputs: {}, secret: () => undefined, env: {}, runId: 'r' }),
    baseUrl: ws.config.baseUrl,
    timeout: ws.config.timeout,
    screenshots: 'none',
    fingerprints: (source) => readFingerprints(dir, source.id, source.kind),
    refreshFingerprints: refresh,
    ...(healer ? { healer } : {}),
  };
  return runFlow('profile', ws.flows.get('profile')!, options);
}

/** A model that searches for the job's words, then picks the first hit — or declares it gone. */
function healingModel(): Provider {
  let turn = 0;
  return {
    async chat(req: ChatRequest): Promise<ChatResponse> {
      turn += 1;
      const last = [...req.messages].reverse().find((m) => m.role === 'tool');
      const text = typeof last?.content === 'string' ? last.content : '';
      if (turn % 2 === 1) return { content: '', toolCalls: [{ id: `s${turn}`, name: 'search', args: { text: 'update' } }] };
      const hit = /\[(\d+)\] <button/.exec(text);
      return hit
        ? { content: '', toolCalls: [{ id: `p${turn}`, name: 'pick', args: { node: Number(hit[1]), reason: 'the profile form now saves with Update profile' } }] }
        : { content: '', toolCalls: [{ id: `g${turn}`, name: 'gone', args: { reason: 'there is no way to save the profile' } }] };
    },
  } as unknown as Provider;
}

describe('self-healing', { timeout: 60_000 }, () => {
  it('saves fingerprints, heals a redesign without a model, and the accepted fix needs no healing', async () => {
    if (!driver) return;
    const dir = folder();
    version = 'v1';
    const first = await run(dir, undefined, true);
    expect(first.status).toBe('passed');
    saveRefreshed(dir, first.refreshed);
    expect(readFingerprints(dir, 'profile')!.steps.map((s) => s.step)).toEqual([2, 3, 4]);

    version = 'v2';
    expect((await run(dir)).steps[2]!.error).toBe('Could not find button "Save changes" (testId found 0, role found 0, css found 0).');
    const healed = await run(dir, createHealer());
    expect(healed.status, healed.error).toBe('passed');
    expect(healed.steps[2]!.healed).toMatchObject({ via: 'similarity' });
    expect(healed.heals).toHaveLength(1);

    // Nothing changed on disk until accepted.
    expect(readFileSync(join(dir, 'flows', 'profile.yaml'), 'utf8')).toContain('#save-1');
    const applied = applyHeals(dir, healed.heals);
    expect(applied.map((a) => a.applied)).toEqual([true]);
    const yaml = readFileSync(join(dir, 'flows', 'profile.yaml'), 'utf8');
    expect(yaml).toContain('css: "#save-9"');
    expect(readFingerprints(dir, 'profile')!.steps.find((s) => s.step === 3)!.heals).toHaveLength(1);
    // A second accept of the same proposal is refused: the file moved on.
    expect(applyHeals(dir, healed.heals).map((a) => a.reason)).toEqual(['the step was edited since the run']);

    const after = await run(dir);
    expect(after.status).toBe('passed');
    expect(after.steps[2]!.healed).toBeUndefined();
  });

  it('asks the agent when similarity is not sure, and fails as a bug when the feature is gone', async () => {
    if (!driver) return;
    const dir = folder();
    version = 'v1';
    saveRefreshed(dir, (await run(dir, undefined, true)).refreshed);
    const templates = new Templates({ inputs: {}, secret: () => undefined, env: {}, runId: 'r' });
    const withAgent = () => createHealer({ agent: { provider: healingModel(), model: 'm', nativeToolCalls: true, templates } });

    version = 'v3';
    expect((await run(dir, createHealer())).steps[2]!.error).toMatch(/healing: best similarity \d+% /);
    const healed = await run(dir, withAgent());
    expect(healed.status).toBe('passed');
    expect(healed.steps[2]!.healed).toMatchObject({ via: 'agent', reason: 'the profile form now saves with Update profile', locator: { role: 'button', name: 'Update profile' } });

    version = 'v4';
    const gone = await run(dir, withAgent());
    expect(gone.status).toBe('failed');
    expect(gone.steps[2]).toMatchObject({ status: 'failed', bug: true });
    expect(gone.steps[2]!.error).toMatch(/not on the page any more: there is no way to save the profile/);
  });
});
