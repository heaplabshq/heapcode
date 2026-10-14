import { existsSync, mkdtempSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PNG } from 'pngjs';
import { Templates, parseFlow, runFlow, serializeFlow, type Flow } from '@heapcode/qa';
import { BrowserMissingError, PlaywrightDriver } from '../src/driver.js';

let look = 'blue';
let dot = false;
let server: Server;
let base = '';
let driver: PlaywrightDriver | undefined;

const PAGE = (): string => `<!doctype html><title>Card</title><style>body{margin:0;font:16px sans-serif}
  #card{width:300px;height:120px;margin:20px;background:${look};color:white;padding:10px}
  #tiny{position:absolute;left:500px;top:300px;width:${dot ? 2 : 0}px;height:2px;background:red}</style>
  <div id="card">Pro plan — $9</div><div id="tiny"></div>`;

beforeAll(async () => {
  server = createServer((_q, res) => {
    res.setHeader('content-type', 'text/html');
    res.end(PAGE());
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    driver = await PlaywrightDriver.launch({ timeout: 3000, viewport: { width: 640, height: 400 } });
  } catch (err) {
    if (!(err instanceof BrowserMissingError)) throw err;
  }
}, 60_000);

afterAll(async () => {
  await driver?.close();
  await new Promise((r) => server.close(r));
}, 60_000);

const FLOW = (): Flow => {
  const r = parseFlow('name: card\nsteps:\n  - goto: /\n  - expect: { screenshot: card-page }\n  - expect: { screenshot: { name: card, in: { css: "#card" }, maxDiff: 0.5 } }\n');
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
  return r.value;
};

describe('screenshot checks', { timeout: 60_000 }, () => {
  it('reads and writes the check', () => {
    expect(serializeFlow(FLOW())).toContain('- expect: { screenshot: card-page }');
    expect(serializeFlow(FLOW())).toContain('- expect: { screenshot: { name: card, in: { css: "#card" }, maxDiff: 0.5 } }');
    expect(parseFlow('name: x\nsteps:\n  - expect: { screenshot: ../evil }\n').ok).toBe(false);
  });

  it('saves the first picture, matches it, catches a change with a diff, and updates on request', async () => {
    if (!driver) return;
    const dir = mkdtempSync(join(tmpdir(), 'heapqa-visual-'));
    const run = (update = false) =>
      runFlow('card', FLOW(), {
        driver: driver!,
        library: new Map(),
        templates: new Templates({ inputs: {}, secret: () => undefined, env: {}, runId: 'r' }),
        baseUrl: base,
        timeout: 3000,
        screenshots: 'none',
        captureFailure: false,
        snapshots: { dir, update },
      });

    look = 'blue';
    const first = await run();
    expect(first.status).toBe('passed');
    expect(first.steps.map((s) => s.visual?.status)).toEqual([undefined, 'created', 'created']);
    expect(existsSync(join(dir, 'card', 'card-page.png'))).toBe(true);

    expect((await run()).steps.map((s) => s.visual?.status)).toEqual([undefined, 'matched', 'matched']);

    look = 'green';
    const changed = await run();
    expect(changed.status).toBe('failed');
    expect(changed.steps[1]!.visual).toMatchObject({ status: 'differs' });
    expect(changed.steps[1]!.error).toMatch(/^The page looks different from the saved "card-page" picture: \d+\.\d\d% of pixels changed \(allowed 1%\)\. If the change is intended, run again with --update-snapshots\.$/);
    const diff = PNG.sync.read(Buffer.from(changed.steps[1]!.visual!.diff!));
    expect(diff.width).toBe(640);

    const updated = await run(true);
    expect(updated.steps.map((s) => s.visual?.status)).toEqual([undefined, 'updated', 'updated']);
    expect((await run()).status).toBe('passed');
  });

  it('lets a few changed pixels through, within maxDiff', async () => {
    if (!driver) return;
    const dir = mkdtempSync(join(tmpdir(), 'heapqa-visual-'));
    const page = parseFlow('name: dot\nsteps:\n  - goto: /\n  - expect: { screenshot: whole }\n');
    if (!page.ok) throw new Error('parse');
    const run = () =>
      runFlow('dot', page.value, { driver: driver!, library: new Map(), templates: new Templates({ inputs: {}, secret: () => undefined, env: {}, runId: 'r' }), baseUrl: base, timeout: 3000, screenshots: 'none', captureFailure: false, snapshots: { dir, update: false } });
    look = 'blue';
    await run();
    dot = true;
    const dotted = await run();
    expect(dotted.status, dotted.error).toBe('passed');
    expect(dotted.steps[1]!.visual!.diffPercent).toBeGreaterThan(0);
    expect(dotted.steps[1]!.visual!.diffPercent).toBeLessThan(1);
    dot = false;
  });
});
