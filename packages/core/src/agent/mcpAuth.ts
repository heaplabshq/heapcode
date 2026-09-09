import { auth, UnauthorizedError, type OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type { OAuthClientInformationFull, OAuthClientMetadata, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';

/**
 * OAuth for hosted MCP servers.
 *
 * Every hosted connector worth naming — Notion, Linear, Sentry — answers an
 * anonymous `initialize` with 401 and an RFC 9728 challenge, so without this
 * they cannot be connected at all, only mis-typed at.
 *
 * The flow is the one `portfolio-os` proved: RFC 9728 discovery to find the
 * authorization server, RFC 7591 dynamic registration so nothing is
 * provisioned by hand, authorization-code + PKCE, and RFC 8707 `resource` so
 * a token minted for one server cannot be replayed against another. The
 * difference is that there it was written out longhand against `httpx`,
 * whereas the TypeScript SDK we already ship implements all four; what is
 * left is deciding where tokens live and where the browser comes back to.
 *
 * Both of those are host-specific, so both are injected. `heapcode web` and
 * `heapcode chat` already listen on a loopback origin and can answer the
 * callback on the server they are running; the CLI and the extension open a
 * listener for the length of a login. Notion accepts loopback redirects and
 * refuses plain-HTTP LAN ones ("Redirect URI must use HTTPS unless it is a
 * loopback HTTP URI"), which is why the redirect always follows the loopback
 * origin of the *host*, never the origin the page happened to be opened from.
 */

/** What has to survive a browser round trip, per server. */
export interface McpAuthRecord {
  /** From dynamic registration; reused until the redirect URI changes. */
  client?: OAuthClientInformationFull;
  tokens?: OAuthTokens;
  /** Single-use, held only while a login is in flight. */
  codeVerifier?: string;
  state?: string;
  /** The URI `client` was registered against. A change invalidates it. */
  redirectUri?: string;
}

/**
 * Where records are kept.
 *
 * Injected because the hosts genuinely differ: the CLI and both web hosts
 * share `~/.heapcode/`, so signing in once in `heapcode web` signs in the
 * CLI too, while the extension has `context.secrets` and should use it.
 */
export interface McpAuthStore {
  read(server: string): Promise<McpAuthRecord | undefined> | McpAuthRecord | undefined;
  write(server: string, record: McpAuthRecord): Promise<void> | void;
  clear(server: string): Promise<void> | void;
}

const CLIENT_NAME = 'Heap Code';

/**
 * An in-memory store, and the reason `McpAuthStore` is not optional.
 *
 * A manager built without persistence still works for the length of a
 * process; it just asks you to sign in again next time.
 */
export class MemoryAuthStore implements McpAuthStore {
  private records = new Map<string, McpAuthRecord>();
  read(server: string): McpAuthRecord | undefined {
    return this.records.get(server);
  }
  write(server: string, record: McpAuthRecord): void {
    this.records.set(server, record);
  }
  clear(server: string): void {
    this.records.delete(server);
  }
}

/**
 * `OAuthClientProvider` over an `McpAuthStore`, for one server.
 *
 * The SDK calls these one at a time and expects each to have landed before
 * the next, which is why every mutation reads the record back rather than
 * caching it: a login that begins in the web host and finishes in the CLI
 * (they share a file) must not have half of it in someone's process memory.
 */
export class McpOAuthProvider implements OAuthClientProvider {
  /**
   * Where the SDK last wanted to send the browser.
   *
   * Captured rather than opened: core has no browser, no terminal and no
   * webview, and which of those is available is exactly what distinguishes
   * the four surfaces this runs on. Read it back with `takeAuthorizationUrl`,
   * which also clears it — a URL left lying around outlives the verifier it
   * was minted with and would send someone into a login that cannot finish.
   */
  private pendingUrl?: URL;

  constructor(
    private readonly server: string,
    private readonly store: McpAuthStore,
    readonly redirectUrl: string,
  ) {}

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: CLIENT_NAME,
      redirect_uris: [this.redirectUrl],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      // A local app cannot keep a secret. PKCE is what protects this flow,
      // and Notion issues no client_secret when asked this way.
      token_endpoint_auth_method: 'none',
    };
  }

  private async record(): Promise<McpAuthRecord> {
    return (await this.store.read(this.server)) ?? {};
  }

  private async patch(changes: Partial<McpAuthRecord>): Promise<void> {
    await this.store.write(this.server, { ...(await this.record()), ...changes });
  }

  async clientInformation(): Promise<OAuthClientInformationFull | undefined> {
    const record = await this.record();
    // A registration made for a different callback is not usable against this
    // one, and re-registering costs a single request.
    if (record.redirectUri && record.redirectUri !== this.redirectUrl) return undefined;
    return record.client;
  }

  async saveClientInformation(client: OAuthClientInformationFull): Promise<void> {
    await this.patch({ client, redirectUri: this.redirectUrl });
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    return (await this.record()).tokens;
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    // The verifier and state are single-use; keeping them past the exchange
    // invites replay, and a stale `state` would defeat the callback's only
    // check the next time round.
    const { codeVerifier: _v, state: _s, ...rest } = await this.record();
    await this.store.write(this.server, { ...rest, tokens });
  }

  async saveCodeVerifier(codeVerifier: string): Promise<void> {
    await this.patch({ codeVerifier });
  }

  async codeVerifier(): Promise<string> {
    const verifier = (await this.record()).codeVerifier;
    if (!verifier) throw new Error(`No sign-in is in progress for "${this.server}".`);
    return verifier;
  }

  async state(): Promise<string> {
    const state = randomToken();
    await this.patch({ state });
    return state;
  }

  redirectToAuthorization(authorizationUrl: URL): void {
    this.pendingUrl = authorizationUrl;
  }

  /** The authorization URL from the last `auth()` call, consumed. */
  takeAuthorizationUrl(): URL | undefined {
    const url = this.pendingUrl;
    this.pendingUrl = undefined;
    return url;
  }

  async invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'): Promise<void> {
    if (scope === 'all') return void (await this.store.clear(this.server));
    const record = await this.record();
    if (scope === 'client') delete record.client;
    if (scope === 'tokens') delete record.tokens;
    if (scope === 'verifier') delete record.codeVerifier;
    await this.store.write(this.server, record);
  }

  /** The `state` this provider is expecting a callback to carry. */
  async expectedState(): Promise<string | undefined> {
    return (await this.record()).state;
  }
}

/**
 * 24 random bytes as hex.
 *
 * Web Crypto rather than `node:crypto` because this file sits under
 * `src/agent/`, which the browser-safe subpaths reach; hex rather than
 * base64url so it needs no encoder from either environment.
 */
function randomToken(): string {
  const bytes = new Uint8Array(24);
  globalThis.crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Whether a connection failure is "you have not signed in" rather than a fault. */
export function isAuthFailure(err: unknown): boolean {
  if (err instanceof UnauthorizedError) return true;
  const code = (err as { code?: unknown })?.code;
  if (code === 401 || code === 403) return true;
  const message = err instanceof Error ? err.message : String(err);
  return /\b401\b|unauthorized|invalid_token/i.test(message);
}

/**
 * Begin a sign-in: discover, register if needed, and return where to send
 * the browser. The verifier and state are written before we return, because
 * the code comes back on a different request.
 */
export async function beginMcpLogin(
  provider: McpOAuthProvider,
  serverUrl: string,
): Promise<{ authorizationUrl: string; state: string }> {
  provider.takeAuthorizationUrl();
  const result = await auth(provider, { serverUrl });
  if (result === 'AUTHORIZED') throw new Error('Already signed in.');
  const url = provider.takeAuthorizationUrl();
  const state = await provider.expectedState();
  if (!url || !state) throw new Error('The server did not offer an authorization URL.');
  return { authorizationUrl: url.toString(), state };
}

/**
 * Finish a sign-in. `state` is the only CSRF protection this flow has, so a
 * mismatch is refused outright rather than retried.
 */
export async function completeMcpLogin(
  provider: McpOAuthProvider,
  serverUrl: string,
  code: string,
  state: string,
): Promise<void> {
  const expected = await provider.expectedState();
  if (!expected || expected !== state) {
    throw new Error('That sign-in did not match one we started. Begin again from Settings.');
  }
  const result = await auth(provider, { serverUrl, authorizationCode: code });
  if (result !== 'AUTHORIZED') throw new Error('The authorization code was not accepted.');
}
