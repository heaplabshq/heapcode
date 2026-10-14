import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Templates, createRunDir, loadWorkspace, runFlow, saveFlow, tracePathFor, writeRunSummary } from '@heapcode/qa';
import { BrowserMissingError, PlaywrightDriver } from '../src/driver.js';

const LOGIN = `<!doctype html><title>Log in</title><form action="/welcome">
  <label for="e">Email</label><input id="e" name="email">
  <label for="p">Password</label><input id="p" type="password" name="pw">
  <button>Log in</button></form>`;

let server: Server;
let base = '';
let driver: PlaywrightDriver | undefined;

beforeAll(async () => {
  server = createServer((req, res) => {
    res.setHeader('content-type', 'text/html');
    if (req.url === '/login') return res.end(LOGIN);
    if (req.url?.startsWith('/welcome')) {
      const email = new URL(req.url, 'http://x').searchParams.get('email');
      return res.end(`<!doctype html><title>Hi</title><h1>Welcome</h1><p id="who">Signed in as ${email}</p>`);
    }
    res.statusCode = 404;
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    driver = await PlaywrightDriver.launch({ timeout: 5000 });
  } catch (err) {
    if (!(err instanceof BrowserMissingError)) throw err;
  }
}, 60_000);

afterAll(async () => {
  await driver?.close();
  await new Promise((r) => server.close(r));
}, 60_000);

function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'heapqa-run-'));
  mkdirSync(join(dir, 'flows'));
  mkdirSync(join(dir, 'steps'));
  writeFileSync(join(dir, 'heapqa.yaml'), `baseUrl: ${base}\ntimeout: 5000\n`);
  writeFileSync(join(dir, '.env.test'), 'PW=hunter2\n');
  writeFileSync(
    join(dir, 'steps', 'log-in.yaml'),
    `name: log in
inputs: { email: nobody@x.test }
steps:
  - goto: /login
  - type: { into: { label: Email }, text: "{{email}}" }
  - type: { into: { label: Password }, text: "{{secret:PW}}" }
  - click: { role: button, name: Log in }
`,
  );
  writeFileSync(
    join(dir, 'flows', 'ok.yaml'),
    `name: logs in
inputs: { email: "qa+{{runId}}@x.test" }
steps:
  - use: log-in
    with: { email: "{{email}}" }
  - expect: { url: /welcome }
  - expect: { text: { in: { css: "#who" }, contains: "{{email}}" } }
`,
  );
  writeFileSync(join(dir, 'flows', 'broken.yaml'), 'name: broken\nsteps:\n  - goto: /login\n  - click: { role: button, name: Sign up }\n  - goto: /never\n');
  return dir;
}

describe('runFlow on Playwright', { timeout: 30_000 }, () => {
  it('plays a flow with a reusable step, and saves results without the secret', async () => {
    if (!driver) return;
    const ws = loadWorkspace(workspace(), {});
    expect(ws.errors).toEqual([]);
    const runDir = createRunDir(ws.dir, 'run1');
    const templates = new Templates({ inputs: {}, secret: ws.secret, env: {}, runId: 'run1' });
    const flow = ws.flows.get('ok')!;
    const result = await runFlow('ok', flow, {
      driver,
      library: ws.steps,
      templates: templates.withInputs(flow.inputs),
      baseUrl: ws.config.baseUrl,
      timeout: ws.config.timeout,
      screenshots: 'every-step',
      tracePath: tracePathFor(runDir, 'ok'),
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe('passed');
    expect(result.trace).toBeUndefined();
    const saved = saveFlow(runDir, result);
    const file = writeRunSummary({ runId: 'run1', startedAt: '', durationMs: 0, dir: runDir, passed: 1, failed: 0, flows: [saved] });
    const json = readFileSync(file, 'utf8');
    expect(json).not.toContain('hunter2');
    expect(json).toContain('«secret:PW»');
    expect(existsSync(join(runDir, 'screenshots', 'ok', '1.3.png'))).toBe(true);
    expect(existsSync(tracePathFor(runDir, 'ok'))).toBe(false);
  });

  it('stops at the first failure and keeps a trace of it', async () => {
    if (!driver) return;
    const ws = loadWorkspace(workspace(), {});
    const runDir = createRunDir(ws.dir, 'run2');
    const result = await runFlow('broken', ws.flows.get('broken')!, {
      driver,
      library: ws.steps,
      templates: new Templates({ inputs: {}, secret: ws.secret, env: {}, runId: 'run2' }),
      baseUrl: ws.config.baseUrl,
      timeout: ws.config.timeout,
      screenshots: 'on-failure',
      tracePath: tracePathFor(runDir, 'broken'),
    });
    expect(result.steps.map((s) => s.status)).toEqual(['passed', 'failed', 'skipped']);
    expect(result.steps[1]!.error).toBe('Could not find button "Sign up" (role found 0).');
    expect(result.steps[1]!.screenshot?.length).toBeGreaterThan(0);
    expect(result.steps[0]!.screenshot).toBeUndefined();
    expect(existsSync(result.trace!)).toBe(true);
    // The page at the failure: an outline in the step, the whole tree saved beside the run.
    expect(result.steps[1]!.page?.outline).toMatch(/\[\d+\] button "Log in"/);
    const saved = saveFlow(runDir, result);
    expect(saved.failurePage).toBe(join('pages', 'broken.json'));
    expect(JSON.parse(readFileSync(join(runDir, saved.failurePage!), 'utf8')).nodes.length).toBeGreaterThan(5);
  });
});
