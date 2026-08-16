import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { serveStatic } from '../src/static.js';

/**
 * The jail. `serveStatic` opens files on behalf of an unauthenticated-until-
 * proven request, so "does it stay inside the directory" is the only thing
 * about it that is security-relevant — and the one thing a reviewer cannot
 * confirm by reading a `join()`.
 */

let dir: string;
let server: Server;
let base: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'hcstatic-'));
  await writeFile(join(dir, 'index.html'), '<!doctype html>INDEX', 'utf8');
  await mkdir(join(dir, 'assets'), { recursive: true });
  await writeFile(join(dir, 'assets', 'app.js'), 'console.log(1)', 'utf8');
  // The file that must never be served: a sibling of the served directory.
  await writeFile(join(dir, '..', `secret-${process.pid}.txt`), 'TOP SECRET', 'utf8');

  server = createServer((req, res) => {
    void serveStatic(dir, req.url ?? '/', res).then((served) => {
      if (!served) {
        res.writeHead(404);
        res.end('nope');
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(join(dir, '..', `secret-${process.pid}.txt`), { force: true });
  await rm(dir, { recursive: true, force: true });
});

describe('serveStatic', () => {
  it('serves a real file with the right content type', async () => {
    const res = await fetch(`${base}/assets/app.js`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/javascript');
    expect(await res.text()).toBe('console.log(1)');
  });

  it('falls back to index.html so client-side routes survive a refresh', async () => {
    const res = await fetch(`${base}/some/spa/route`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('INDEX');
  });

  it('never escapes the directory, however the traversal is spelled', async () => {
    const attempts = [
      '/../secret-PID.txt',
      '/../../secret-PID.txt',
      '/..%2fsecret-PID.txt',
      '/%2e%2e%2fsecret-PID.txt',
      '/assets/../../secret-PID.txt',
      '/....//secret-PID.txt',
    ].map((p) => p.replace('PID', String(process.pid)));

    for (const path of attempts) {
      const res = await fetch(`${base}${path}`);
      const body = await res.text();
      expect(body, `leaked via ${path}`).not.toContain('TOP SECRET');
    }
  });

  it('serves no-store, so a rebuilt bundle is never shadowed by a cached one', async () => {
    const res = await fetch(`${base}/index.html`);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });

  /**
   * The shell page holds the socket that runs commands, so the CSP is what is
   * still true if DOMPurify is ever bypassed. `img-src` is the one that closes
   * a channel open today: DOMPurify permits `<img>` with an arbitrary `src`,
   * so model output could otherwise beacon out to any host.
   */
  describe('the shell CSP', () => {
    const csp = async (): Promise<string> =>
      (await fetch(`${base}/index.html`)).headers.get('content-security-policy') ?? '';

    it('confines every default fetch and every connection to this origin', async () => {
      const policy = await csp();
      expect(policy).toContain("default-src 'self'");
      expect(policy).toContain("connect-src 'self'");
    });

    it('permits no remote images, so injected markup cannot beacon out', async () => {
      const policy = await csp();
      const imgSrc = /img-src ([^;]+)/.exec(policy)?.[1] ?? '';
      expect(imgSrc).toContain("'self'");
      expect(imgSrc).toContain('data:'); // pasted attachments
      expect(imgSrc).not.toMatch(/https?:|\*/);
    });

    it('cannot be framed, and cannot have its base or form targets hijacked', async () => {
      const policy = await csp();
      expect(policy).toContain("frame-ancestors 'none'");
      expect(policy).toContain("base-uri 'none'");
      expect(policy).toContain("form-action 'none'");
      expect(policy).toContain("object-src 'none'");
    });

    /**
     * Pinned deliberately. Measured in Chrome: a `srcdoc` iframe inherits this
     * policy on top of its own, so dropping `'unsafe-inline'` here stops the
     * scripts inside an HTML artifact from running — the Preview tab breaks
     * while the diff looks like a tightening. Whoever removes it should be
     * moving artifacts to an HTTP-served route in the same change.
     */
    it('still allows inline script, because artifacts inherit this policy', async () => {
      expect(await csp()).toContain("script-src 'self' 'unsafe-inline'");
    });
  });
});
