import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fingerprintOf } from '@heapcode/page/fingerprint';
import { findSimilar } from '@heapcode/page/similarity';
import { locate } from '@heapcode/qa';
import { BrowserMissingError, PlaywrightDriver } from '../src/driver.js';

const V1 = `<!doctype html><title>Sign up</title>
<main>
  <h1>Sign up</h1>
  <form onsubmit="event.preventDefault(); document.querySelector('#out').textContent = 'Welcome ' + this.email.value">
    <label for="email">Email</label><input id="email" name="email" placeholder="you@example.com">
    <label for="country">Country</label>
    <select id="country"><option value="in">India</option><option value="fr">France</option></select>
    <button id="go-1" data-testid="create">Create account</button>
  </form>
  <p id="out"></p>
  <button onclick="console.error('boom'); fetch('/missing')">Break</button>
</main>`;

// The same page after a redesign: new ids, no test id, the button wrapped and moved.
const V2 = V1.replace(
  '<button id="go-1" data-testid="create">Create account</button>',
  '<div class="actions"><button id="go-7f2" class="btn">Create account</button></div>',
);

let server: Server;
let base = '';
let driver: PlaywrightDriver | undefined;
let missing = '';

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === '/v1') return res.end(V1);
    if (req.url === '/v2') return res.end(V2);
    res.statusCode = 404;
    res.end('nope');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    driver = await PlaywrightDriver.launch({ timeout: 5000 });
  } catch (err) {
    if (!(err instanceof BrowserMissingError)) throw err;
    missing = err.message;
  }
}, 60_000);

afterAll(async () => {
  await driver?.close();
  await new Promise((r) => server.close(r));
}, 60_000);

describe('PlaywrightDriver', { timeout: 30_000 }, () => {
  it('has a browser to test with (or explains why not)', () => {
    if (!driver) console.warn(`Skipping browser tests: ${missing}`);
    expect(driver || missing).toBeTruthy();
  });

  it('finds elements by each strategy and acts on them', async () => {
    if (!driver) return;
    const page = await driver.open(`${base}/v1`);
    expect(page.title).toBe('Sign up');

    const email = await locate(driver, { testId: 'nope', label: 'Email', placeholder: 'you@example.com' });
    expect(email).toMatchObject({ found: true, strategy: 'label' });
    if (!email.found) return;
    await driver.type(email.target, 'a@b.test', { clear: true });

    const country = await locate(driver, { label: 'Country' });
    if (!country.found) throw new Error('country');
    await driver.select(country.target, 'France');

    const button = await locate(driver, { testId: 'create', role: 'button', name: 'Create account' });
    expect(button).toMatchObject({ found: true, strategy: 'testId' });
    if (!button.found) return;
    await driver.click(button.target);

    const out = await locate(driver, { css: '#out' });
    if (!out.found) throw new Error('out');
    expect(await driver.textOf(out.target)).toBe('Welcome a@b.test');
  });

  it('collects console errors and failed requests', async () => {
    if (!driver) return;
    await driver.open(`${base}/v1`);
    driver.drainConsole();
    driver.drainFailedRequests();
    const broke = await locate(driver, { role: 'button', name: 'Break' });
    if (!broke.found) throw new Error('break');
    // Listen before clicking: on a fast machine the 404 is back before a
    // listener added afterwards would be.
    const responded = driver.page.waitForResponse((r) => r.url().endsWith('/missing'));
    await driver.click(broke.target);
    await responded;
    expect(driver.drainConsole().some((l) => l.level === 'error' && l.message === 'boom')).toBe(true);
    expect(driver.drainFailedRequests()).toContainEqual(expect.objectContaining({ status: 404, method: 'GET' }));
  });

  it('inspects the full DOM and acts on a node found again after a redesign', async () => {
    if (!driver) return;
    await driver.open(`${base}/v1`);
    const before = await driver.inspect();
    const saved = fingerprintOf(before, before.nodes.find((n) => n.attrs['data-testid'] === 'create')!.id);
    expect(saved.rect).toBeDefined();

    await driver.open(`${base}/v2`);
    // Every saved strategy except the name is gone…
    const located = await locate(driver, { testId: 'create', css: '#go-1' });
    expect(located.found).toBe(false);
    // …and the similarity match finds it anyway, with no model.
    const after = await driver.inspect();
    const match = findSimilar(saved, after);
    expect(after.nodes[match.best!.nodeId]!.attrs.id).toBe('go-7f2');

    const email = await locate(driver, { label: 'Email' });
    if (!email.found) throw new Error('email');
    await driver.type(email.target, 'healed@b.test', { clear: true });
    await driver.click({ nodeId: match.best!.nodeId });
    const out = await locate(driver, { css: '#out' });
    if (!out.found) throw new Error('out');
    expect(await driver.textOf(out.target)).toBe('Welcome healed@b.test');
  });

  it('refuses addresses that are not local or listed', async () => {
    if (!driver) return;
    await expect(driver.open('https://example.com/')).rejects.toThrow(/not listed in heapqa.yaml/);
  });
});
