import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Templates, explore, runFlow, serializeFlow } from '@heapcode/qa';
import { BrowserMissingError, PlaywrightDriver } from '../src/driver.js';

const html = (title: string, body: string): string => `<!doctype html><title>${title}</title><meta name="viewport" content="width=device-width">${body}`;
const visits: string[] = [];
const SITE: Record<string, string> = {
  '/': html('Home', `<h1>Shop</h1><nav><a href="/about">About</a> <a href="/orders">Orders</a> <a href="/settings">Settings</a>
     <a href="/missing">Old page</a> <a href="/logout">Log out</a> <a href="mailto:x@y.test">Mail</a> <a href="/report.pdf">PDF</a></nav>`),
  '/about': html('About', `<h1>About</h1><div style="width:900px;background:#eee">A banner that is too wide for a phone</div>`),
  '/orders': html('Orders', `<h1>Orders</h1><p>Total: <span id="total">NaN</span></p>
     <button onclick="refreshOrders()">Refresh</button>
     <button>Nothing</button>
     <button onclick="document.querySelector('#msg').textContent='Shown'">Show message</button><p id="msg"></p>
     <button onclick="alert('gone')">Delete all</button>
     <script>fetch('/api/stats')</script>`),
  '/settings': html('Settings', `<h1>Settings</h1>
     <form method="post" action="/settings"><label for="n">Name</label><input id="n" name="name">
       <label for="e">Email</label><input id="e" name="email" type="email"><button>Save</button></form>
     <form method="post" action="/login"><label for="u">User</label><input id="u" name="u"><label for="p">Password</label><input id="p" type="password" name="p"><button>Log in</button></form>`),
};

let server: Server;
let base = '';
let driver: PlaywrightDriver | undefined;

beforeAll(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url!, 'http://x');
    visits.push(`${req.method} ${url.pathname}`);
    res.setHeader('content-type', 'text/html');
    if (url.pathname === '/api/stats') {
      res.statusCode = 500;
      return res.end('boom');
    }
    if (req.method === 'POST' && url.pathname === '/settings') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const name = new URLSearchParams(body).get('name') ?? '';
        // The bug: a long name breaks the server.
        if (name.length > 100) {
          res.statusCode = 500;
          return res.end(html('Error', '<h1>Internal Server Error</h1>'));
        }
        res.end(html('Saved', '<h1>Saved</h1>'));
      });
      return;
    }
    if (SITE[url.pathname]) return res.end(SITE[url.pathname]);
    res.statusCode = 404;
    res.end(html('Not found', '<h1>Not found</h1>'));
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

describe('explore', { timeout: 120_000 }, () => {
  it('finds the plain bugs, leaves the dangerous things alone, and writes repros', async () => {
    if (!driver) return;
    const templates = new Templates({ inputs: {}, secret: () => undefined, env: {}, runId: 'r' });
    const result = await explore({ driver, startUrl: `${base}/`, baseUrl: base, targets: [], templates, screenshots: false });

    expect(result.pages.map((p) => new URL(p.url).pathname).sort()).toEqual(['/', '/about', '/missing', '/orders', '/settings']);
    expect(visits).not.toContain('GET /logout');
    expect(visits).not.toContain('POST /login');

    const by = (kind: string, text: RegExp) => result.findings.find((f) => f.kind === kind && text.test(`${f.title} ${f.detail}`));
    expect(by('broken-link', /\/missing returned 404/)).toBeDefined();
    expect(by('server-error', /\/api\/stats/)).toMatchObject({ severity: 'high' });
    expect(by('error-text', /"NaN" shown on the page/)).toBeDefined();
    expect(by('crash', /refreshOrders is not defined/)).toMatchObject({ action: 'pressing button "Refresh"' });
    expect(by('dead-button', /button "Nothing" does nothing/)).toMatchObject({ severity: 'low' });
    expect(by('dead-button', /Show message/)).toBeUndefined();
    expect(by('layout', /\/about scrolls sideways/)).toBeDefined();
    const longName = by('server-error', /POST \/settings/);
    expect(longName?.action).toBe('submitting the "Save" form with a long Name');
    expect(by('dead-button', /Refresh/)).toBeUndefined();
    expect(result.skipped.join('\n')).toMatch(/did not press "Delete all"/);
    expect(result.skipped.join('\n')).toMatch(/did not submit the "Log in" form \(it has a password field\)/);

    // The repro fails on replay — while the bug is there.
    const repro = longName!.repro!;
    expect(serializeFlow(repro)).toContain('- goto: /settings');
    const replay = await runFlow('repro', repro, { driver, library: new Map(), templates, baseUrl: base, timeout: 2000, screenshots: 'none', captureFailure: false });
    expect(replay.status).toBe('failed');
    const nan = await runFlow('repro2', by('error-text', /NaN/)!.repro!, { driver, library: new Map(), templates, baseUrl: base, timeout: 1000, screenshots: 'none', captureFailure: false });
    expect(nan.status).toBe('failed');
  });

  it('adds what an AI judge saw, labelled and never high', async () => {
    if (!driver) return;
    const templates = new Templates({ inputs: {}, secret: () => undefined, env: {}, runId: 'r' });
    const judged: string[] = [];
    const result = await explore({
      driver,
      startUrl: `${base}/about`,
      baseUrl: base,
      targets: [],
      templates,
      screenshots: false,
      maxPages: 1,
      buttons: false,
      forms: false,
      judge: async (page) => {
        judged.push(page.url);
        return [{ title: 'Banner runs off the screen', detail: 'The grey banner is wider than the page', severity: 'medium' }];
      },
    });
    expect(judged).toEqual([`${base}/about`]);
    expect(result.findings.find((f) => f.kind === 'looks-wrong')).toMatchObject({ title: 'AI: Banner runs off the screen', severity: 'medium' });
  });
});
