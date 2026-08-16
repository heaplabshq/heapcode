import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { hostname, networkInterfaces } from 'node:os';
import { RpcPeer } from '@heapcode/core';
import { WebSocketServer, type WebSocket } from 'ws';
import { AuthLimiter } from './authLimit.js';
import { WebSession, type WebSessionDeps } from './session.js';
import { serveStatic } from './static.js';
import { webSocketDuplex } from './wsDuplex.js';

export const DEFAULT_PORT = 7411;

export interface WebHostOptions extends Omit<WebSessionDeps, 'root'> {
  root: string;
  /** Bind address. Anything but a loopback address is an explicit LAN opt-in. */
  host?: string;
  port?: number;
  /** Overridden only by tests; production generates a fresh one per launch. */
  token?: string;
  /** Directory holding the built SPA. Omitted → API only (what W2 shipped). */
  staticDir?: string;
  /** Overridden only by tests, which cannot wait out a fifteen-minute block. */
  limiter?: AuthLimiter;
}

export interface RunningWebHost {
  url: string;
  token: string;
  port: number;
  host: string;
  session: WebSession;
  close(): Promise<void>;
}

/**
 * Deliberately plain `node:http` + `ws` rather than a framework.
 *
 * The whole HTTP surface is a health route, a token exchange, and a WebSocket
 * upgrade; the SPA is static files. Fastify would add dependencies to
 * something that ships inside a CLI users install, to save perhaps thirty
 * lines. Revisit if the route surface grows (WEB_APP_PLAN §13).
 */
export async function startWebHost(opts: WebHostOptions): Promise<RunningWebHost> {
  const host = opts.host ?? '127.0.0.1';
  const port = opts.port ?? DEFAULT_PORT;
  const token = opts.token ?? randomBytes(32).toString('hex');
  const staticDir = opts.staticDir;
  const limiter = opts.limiter ?? new AuthLimiter();

  // The browser is told which side of the trust boundary it is on, so it can
  // say so — the terminal warning is only seen by whoever ran the command, and
  // LAN mode's whole point is that other people open the page (§6.1, W3.4).
  const session = new WebSession({ ...opts, lan: !isLoopback(host) });

  const http = createServer((req, res) => {
    void handleHttp(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' });
      res.end('internal error');
    });
  });

  async function handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const peer = req.socket.remoteAddress;

    // Checked before anything else that reads the request: a blocked peer gets
    // one cheap answer, not a route.
    if (limiter.blocked(peer)) {
      res.writeHead(429, { 'content-type': 'text/plain', 'retry-after': '900' });
      res.end('too many failed attempts');
      return;
    }

    if (url.pathname === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    // The launch URL carries ?token=…. Exchange it for an HttpOnly cookie and
    // redirect to a clean path, so the token stops living in the address bar,
    // browser history, and any screenshot the user takes (§6.1). HttpOnly also
    // keeps it out of reach of scripts on the page.
    const queryToken = url.searchParams.get('token');
    if (queryToken && url.pathname === '/') {
      if (!tokenMatches(queryToken, token)) {
        limiter.fail(peer);
        res.writeHead(401, { 'content-type': 'text/plain' });
        res.end('unauthorized');
        return;
      }
      limiter.succeed(peer);
      res.writeHead(302, {
        location: '/',
        'set-cookie': `heapcode_token=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400`,
      });
      res.end();
      return;
    }

    // Everything else needs the cookie. Without this an unauthenticated
    // request could still pull the bundle; more importantly it keeps one
    // answer to "is this request authorized" for both HTTP and WS.
    if (!tokenMatches(cookieToken(req), token)) {
      limiter.fail(peer);
      res.writeHead(401, { 'content-type': 'text/plain' });
      res.end('unauthorized — open the URL printed by `heapcode web`');
      return;
    }
    limiter.succeed(peer);

    if (staticDir && (await serveStatic(staticDir, url.pathname, res))) return;

    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  }

  const wss = new WebSocketServer({ noServer: true });

  const boundPort = (): number => {
    const addr = http.address();
    return addr && typeof addr === 'object' ? addr.port : port;
  };

  http.on('upgrade', (req: IncomingMessage, socket: Socket, head: Buffer) => {
    const reject = (code: number, reason: string): void => {
      socket.write(`HTTP/1.1 ${code} ${reason}\r\n\r\n`);
      socket.destroy();
    };

    const peer = req.socket.remoteAddress;
    if (limiter.blocked(peer)) return reject(429, 'Too Many Requests');

    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    if (url.pathname !== '/rpc') return reject(404, 'Not Found');

    // CSRF defense. A page on another origin must not be able to open this
    // socket and start running shell commands as the user — the browser sends
    // Origin on WS handshakes and cannot forge it, so this is the check that
    // matters (§6.1). Absent Origin means a non-browser client (wscat, tests),
    // which cannot be driven by a hostile page.
    // Built from the port actually bound, not the one requested: with port 0,
    // or when the requested port was taken and the OS picked another, those
    // two differ — and an allowlist built from the request would reject every
    // real browser while looking perfectly correct in code review.
    const origin = req.headers.origin;
    if (origin && !allowedOrigins(host, boundPort()).has(origin)) return reject(403, 'Forbidden');

    // Query token for non-browser clients (wscat, tests); cookie for the SPA,
    // which by then has exchanged its URL token and no longer has it in JS.
    const presented = url.searchParams.get('token') ?? cookieToken(req);
    if (!tokenMatches(presented, token)) {
      limiter.fail(peer);
      return reject(401, 'Unauthorized');
    }
    limiter.succeed(peer);

    wss.handleUpgrade(req, socket, head, (ws) => attach(ws));
  });

  function attach(ws: WebSocket): void {
    const peer = new RpcPeer(webSocketDuplex(ws), 'ui');
    session.attach(peer);
    ws.on('close', () => session.detach(peer));
  }

  await new Promise<void>((resolve, reject) => {
    http.once('error', reject);
    http.listen(port, host, () => {
      http.removeListener('error', reject);
      resolve();
    });
  });

  const actualPort = (http.address() as { port: number }).port;

  return {
    url: `http://${host}:${actualPort}/?token=${token}`,
    token,
    port: actualPort,
    host,
    session,
    async close() {
      wss.close();
      await session.close();
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
}

/** Constant-time compare, so a wrong token leaks nothing through timing. */
function tokenMatches(given: string | null | undefined, expected: string): boolean {
  if (!given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** The token from the `heapcode_token` cookie, if present. */
function cookieToken(req: IncomingMessage): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === 'heapcode_token') return rest.join('=');
  }
  return undefined;
}

/**
 * The origins a real browser could legitimately present, for this bind.
 *
 * Deliberately an allowlist, and deliberately NOT "does Origin match the Host
 * header". That comparison looks like a correct same-origin check and passes
 * every test you would think to write, but it hands the attacker both sides:
 * with DNS rebinding, `evil.example` resolving to the bound address makes
 * `Host: evil.example:7411` and `Origin: http://evil.example:7411` agree
 * perfectly, and a page the user never trusted is inside. An allowlist of
 * addresses this machine actually answers on has no such hole.
 *
 * Loopback is the easy case. LAN mode is the one that was broken: bound to
 * `0.0.0.0`, the old code added nothing at all, so every phone or laptop that
 * connected — presenting `http://192.168.1.5:7411`, the address it typed —
 * was refused with 403 while the code read as correct. A wildcard bind means
 * "every address on this machine", so that is what gets enumerated.
 */
function allowedOrigins(host: string, port: number): Set<string> {
  const origins = new Set([
    `http://127.0.0.1:${port}`,
    `http://localhost:${port}`,
    `http://[::1]:${port}`,
  ]);
  if (isLoopback(host)) return origins;

  const add = (address: string): void => {
    // An IPv6 literal is bracketed in an origin; an IPv4 one is not.
    origins.add(`http://${address.includes(':') ? `[${address}]` : address}:${port}`);
  };

  if (host === '0.0.0.0' || host === '::') {
    // Every non-internal address this machine currently holds. Read per
    // upgrade rather than cached at startup, so moving between networks does
    // not silently invalidate the allowlist mid-session.
    for (const addresses of Object.values(networkInterfaces())) {
      for (const info of addresses ?? []) {
        if (!info.internal) add(info.address);
      }
    }
    // How a phone on the same network most often reaches a Mac. Still an
    // allowlist entry — this machine's own name, not whatever was requested.
    const name = hostname();
    if (name) {
      origins.add(`http://${name}:${port}`);
      if (!name.endsWith('.local')) origins.add(`http://${name}.local:${port}`);
    }
  } else {
    // An explicit `--host 192.168.1.5`: that address, and nothing else.
    add(host);
  }

  return origins;
}

export function isLoopback(host: string): boolean {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1';
}
