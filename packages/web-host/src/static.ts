import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
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
export async function serveStatic(dir: string, urlPath: string, res: ServerResponse): Promise<boolean> {
  const root = resolve(dir);

  const candidate = safeJoin(root, urlPath);
  const file = candidate && (await isFile(candidate)) ? candidate : join(root, 'index.html');
  if (!(await isFile(file))) return false;

  // Re-check the final choice: the index.html fallback is inside `root` by
  // construction, but this way one audit covers every path that reaches open().
  if (!isInside(root, file)) return false;

  const type = TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream';
  res.writeHead(200, {
    'content-type': type,
    // A local tool serving a freshly built bundle: never let a stale asset
    // outlive a rebuild. The bundle is on localhost, so there is nothing to save.
    'cache-control': 'no-store',
    // Defense in depth for the shell page itself; artifact sandboxing (W7)
    // gets its own, much stricter policy.
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
  });
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
