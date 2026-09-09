import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { spawn } from 'node:child_process';
import { beginMcpLogin, completeMcpLogin } from '../agent/mcpAuth.js';
import type { McpManager } from '../agent/mcp.js';

/**
 * A terminal's half of an MCP sign-in.
 *
 * `heapcode web` answers the callback on the server it is already running;
 * a terminal and the VS Code extension have none, so they open one for the
 * length of the login and close it again. In `src/node/` because that is
 * where Node-only work belongs — and because the extension depends on core
 * alone, so anything both it and the CLI need has to live here rather than
 * in the CLI's own tree. Loopback is not a fallback here but the required shape: hosted
 * authorization servers reject plain-HTTP redirects to anything else, and
 * accept `http://127.0.0.1:<port>` precisely because RFC 8252 §7.3 carves it
 * out for native apps.
 *
 * The port is ephemeral, and dynamic registration is what makes that
 * workable — the client is registered against the port we actually got,
 * at the moment we get it, rather than against one reserved in advance.
 */

const TIMEOUT_MS = 5 * 60_000;

export interface SignInResult {
  ok: boolean;
  detail?: string;
}

/**
 * Run one sign-in to completion. `announce` is handed the URL to visit —
 * printed rather than only opened, because a headless or remote terminal has
 * no browser to hand and the person needs the link either way.
 */
export async function signInToMcpServer(
  manager: McpManager,
  name: string,
  announce: (url: string) => void,
): Promise<SignInResult> {
  const serverUrl = await manager.serverUrl(name);
  if (!serverUrl) return { ok: false, detail: `"${name}" is a local command, which does not sign in.` };

  const { server, port } = await listen();
  try {
    const redirect = `http://127.0.0.1:${port}/oauth/callback`;
    const provider = manager.providerFor(name, redirect);
    if (!provider) return { ok: false, detail: 'No secure store is available for tokens.' };

    const { authorizationUrl, state } = await beginMcpLogin(provider, serverUrl);
    const arrival = waitForCode(server, state);
    announce(authorizationUrl);
    openBrowser(authorizationUrl);

    const code = await arrival;
    if (!code.ok) return code;
    await completeMcpLogin(provider, serverUrl, code.code, state);
    await manager.ensureConnected();
    return { ok: true };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  } finally {
    server.close();
  }
}

function listen(): Promise<{ server: ReturnType<typeof createServer>; port: number }> {
  return new Promise((resolve, reject) => {
    // Nothing is served until `waitForCode` attaches a handler, so a stray
    // request that arrives first gets a socket that is simply closed.
    const server = createServer((_req, res) => res.writeHead(404).end());
    server.once('error', reject);
    // 0 asks the OS for a free port; 127.0.0.1 keeps it off the network.
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (addr && typeof addr === 'object') resolve({ server, port: addr.port });
      else reject(new Error('could not open a local port for the sign-in'));
    });
  });
}

type CodeArrival = { ok: true; code: string } | { ok: false; detail: string };

function waitForCode(server: ReturnType<typeof createServer>, state: string): Promise<CodeArrival> {
  return new Promise((resolve) => {
    const finish = (result: CodeArrival): void => {
      clearTimeout(timer);
      server.removeListener('request', onRequest);
      resolve(result);
    };
    const timer = setTimeout(() => finish({ ok: false, detail: 'The sign-in was not completed in time.' }), TIMEOUT_MS);

    const onRequest = (req: IncomingMessage, response: ServerResponse): void => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (url.pathname !== '/oauth/callback') {
        response.writeHead(404, { 'content-type': 'text/plain' });
        response.end('not found');
        return;
      }
      const error = url.searchParams.get('error_description') ?? url.searchParams.get('error');
      const code = url.searchParams.get('code');
      // The only CSRF protection this flow has. A mismatch is not retried.
      const matched = url.searchParams.get('state') === state;
      const ok = !error && Boolean(code) && matched;
      response.writeHead(ok ? 200 : 400, { 'content-type': 'text/html; charset=utf-8' });
      response.end(
        `<!doctype html><meta charset="utf-8"><title>${ok ? 'Signed in' : 'Sign-in failed'}</title>` +
          `<body style="font:15px/1.6 system-ui,sans-serif;display:grid;place-content:center;min-height:100vh;text-align:center">` +
          `<p>${ok ? 'Signed in. You can close this tab and go back to your terminal.' : 'Sign-in failed. Return to your terminal and try again.'}</p>`,
      );
      if (ok) finish({ ok: true, code: code! });
      else if (error) finish({ ok: false, detail: error });
      else if (!matched) finish({ ok: false, detail: 'That sign-in did not match the one we started.' });
    };

    server.on('request', onRequest);
  });
}

/**
 * Best-effort. The URL is printed regardless, so a machine with no browser —
 * or an SSH session — loses nothing by this failing silently.
 */
function openBrowser(url: string): void {
  const command =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  try {
    spawn(command, [url], { stdio: 'ignore', detached: true, shell: process.platform === 'win32' }).unref();
  } catch {
    // printed above; nothing else to do
  }
}
