import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Recording, Templates, runFlow, serializeFlow } from '@heapcode/qa';
import { BrowserMissingError, PlaywrightDriver } from '../src/driver.js';

const APP: Record<string, string> = {
  '/login': `<!doctype html><title>Log in</title><form action="/welcome">
    <label for="e">Email</label><input id="e" name="email">
    <label for="p">Password</label><input id="p" type="password" name="pw">
    <label for="c">Plan</label><select id="c" name="plan"><option>Free</option><option>Pro</option></select>
    <button data-testid="submit"><span>Log in</span></button></form>`,
};

let server: Server;
let base = '';
let probe: PlaywrightDriver | undefined;

beforeAll(async () => {
  server = createServer((req, res) => {
    res.setHeader('content-type', 'text/html');
    const path = new URL(req.url!, 'http://x').pathname;
    if (APP[path]) return res.end(APP[path]);
    if (path === '/welcome') {
      const q = new URL(req.url!, 'http://x').searchParams;
      return res.end(`<!doctype html><title>Hi</title><h1>Welcome</h1><p id="who">${q.get('email')} on ${q.get('plan')}</p>`);
    }
    res.statusCode = 404;
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    probe = await PlaywrightDriver.launch({ timeout: 5000 });
  } catch (err) {
    if (!(err instanceof BrowserMissingError)) throw err;
  }
}, 60_000);

afterAll(async () => {
  await probe?.close();
  await new Promise((r) => server.close(r));
}, 60_000);

describe('recording in a real browser', { timeout: 60_000 }, () => {
  it('records a person logging in, and the flow it writes plays back', async () => {
    if (!probe) return;
    const driver = await PlaywrightDriver.launch({ timeout: 5000 });
    const recording = new Recording(base);
    try {
      const stop = await driver.record({
        event: (e) => {
          recording.add(e);
          return recording.stepCount;
        },
        navigated: (url) => recording.navigated(url),
        closed: () => {},
      });
      await driver.open(`${base}/login`);
      recording.start(`${base}/login`);
      // A person's actions: real input events, as a hand on the keyboard makes them.
      const page = driver.page;
      await page.waitForFunction(() => '__heapqaRecorder' in globalThis);
      await page.click('#e');
      await page.keyboard.type('a@b.test');
      await page.click('#p');
      await page.keyboard.type('hunter2');
      await page.selectOption('#c', 'Pro');
      await page.click('[data-testid=submit] span');
      await page.waitForURL(/welcome/);
      await page.waitForFunction(() => '__heapqaRecorder' in globalThis);
      // The toolbar is on the new page too, counting steps from before it.
      expect(await page.locator('heapqa-recorder').count()).toBe(1);
      await stop();
    } finally {
      await driver.close();
    }

    const { flow, secrets, fingerprints } = recording.finish('log in');
    const yaml = serializeFlow(flow);
    expect(yaml).not.toContain('hunter2');
    expect(secrets).toEqual({ PASSWORD: 'hunter2' });
    expect(flow.steps.map((s) => s.kind)).toEqual(['goto', 'type', 'type', 'select', 'click']);
    expect(flow.steps[4]).toMatchObject({ kind: 'click', target: { testId: 'submit', role: 'button', name: 'Log in' } });
    expect(fingerprints.steps.length).toBe(4);

    // Played back with no person and no model.
    const result = await runFlow('log-in', flow, {
      driver: probe,
      library: new Map(),
      templates: new Templates({ inputs: flow.inputs, secret: (n) => secrets[n], env: {}, runId: 'r' }),
      baseUrl: base,
      timeout: 5000,
      screenshots: 'none',
    });
    expect(result.error).toBeUndefined();
    expect(probe.current().url).toContain('/welcome?email=a%40b.test&pw=hunter2&plan=Pro');
  });
});
