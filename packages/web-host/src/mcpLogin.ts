import { beginMcpLogin, completeMcpLogin, type McpManager } from '@heapcode/core';

/**
 * OAuth logins in flight, and the one URL they come back to.
 *
 * A login leaves for the browser and returns on a *different* request, so
 * nothing about it can live in the RPC call that started it. The `state`
 * carries the connection: it is minted per attempt, handed to the
 * authorization server, and is the only thing the callback has to say which
 * login it belongs to.
 *
 * One registry serves both products. `heapcode web` mounts chat on the same
 * server and the same origin, so a single `/oauth/callback` answers for
 * either — which is also why the entry stores a closure rather than a
 * product name: whichever session began the login finishes it.
 */
export interface McpLoginRegistry {
  /** Where the authorization server sends the browser back to. */
  redirectUri(): string;
  begin(state: string, finish: (code: string) => Promise<void>): void;
  /** Returns false when no login is waiting on that `state`. */
  complete(state: string, code: string): Promise<boolean>;
}

/**
 * Long enough to sign in and grant access on a slow page, short enough that
 * an abandoned attempt does not leave a usable `state` lying around.
 */
const PENDING_TTL_MS = 10 * 60_000;

export function createMcpLoginRegistry(origin: () => string): McpLoginRegistry {
  const pending = new Map<string, { finish: (code: string) => Promise<void>; at: number }>();

  const sweep = (): void => {
    const cutoff = Date.now() - PENDING_TTL_MS;
    for (const [state, entry] of pending) if (entry.at < cutoff) pending.delete(state);
  };

  return {
    redirectUri: () => `${origin()}${CALLBACK_PATH}`,
    begin(state, finish) {
      sweep();
      pending.set(state, { finish, at: Date.now() });
    },
    async complete(state, code) {
      sweep();
      const entry = pending.get(state);
      if (!entry) return false;
      // Single-use in every outcome. A failed exchange must not leave a
      // `state` that can be presented again with a different code.
      pending.delete(state);
      await entry.finish(code);
      return true;
    },
  };
}

/** Single source of truth for the redirect URI's path. */
export const CALLBACK_PATH = '/oauth/callback';

/** The page the browser lands on when a sign-in ends. */
export function callbackPage(outcome: { ok: boolean; detail?: string }): string {
  const heading = outcome.ok ? 'Signed in' : 'Sign-in failed';
  const body = outcome.ok
    ? 'You can close this tab and go back to Heap Code.'
    : escapeHtml(outcome.detail ?? 'The authorization server did not complete the sign-in.');
  // Self-contained: this page is served on a cross-site navigation, so it has
  // no cookie, no session and no business loading the app bundle.
  return `<!doctype html><meta charset="utf-8"><title>${heading}</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 15px/1.6 ui-sans-serif, system-ui, sans-serif; margin: 0;
         display: grid; place-content: center; min-height: 100vh; text-align: center; padding: 24px; }
  h1 { font-size: 17px; font-weight: 600; margin: 0 0 6px; }
  p { margin: 0; opacity: .7; max-width: 42ch; }
</style>
<h1>${heading}</h1><p>${body}</p>`;
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/**
 * Start a sign-in for one configured server and return where to send the
 * browser. Shared by both products because the sequence is identical and the
 * registry is the same one — only the manager differs.
 */
export async function startMcpSignIn(
  manager: McpManager,
  logins: McpLoginRegistry | undefined,
  name: string,
  onConnected: () => void,
): Promise<{ authorizationUrl: string }> {
  if (!logins) throw new Error('This host cannot complete a sign-in.');
  const serverUrl = await manager.serverUrl(name);
  if (!serverUrl) throw new Error(`"${name}" is a local command, which does not sign in.`);
  const provider = manager.providerFor(name);
  if (!provider) throw new Error('No secure store is available for tokens.');

  const { authorizationUrl, state } = await beginMcpLogin(provider, serverUrl);
  logins.begin(state, async (code) => {
    await completeMcpLogin(provider, serverUrl, code, state);
    // Connect straight away, so the settings panel is already showing the
    // server's tools by the time the person switches back to that tab.
    await manager.ensureConnected();
    onConnected();
  });
  return { authorizationUrl };
}

/**
 * Which of these servers already have a stored token.
 *
 * Read from the secrets store rather than from the manager, because a signed
 * -in server that is momentarily unreachable should still offer Sign out
 * rather than pretending it was never authorized.
 */
export async function storedTokenNames(
  secrets: { getMcpAuth(server: string): Promise<{ tokens?: unknown } | undefined> },
  names: string[],
): Promise<Set<string>> {
  const found = new Set<string>();
  await Promise.all(
    names.map(async (name) => {
      if ((await secrets.getMcpAuth(name))?.tokens) found.add(name);
    }),
  );
  return found;
}
