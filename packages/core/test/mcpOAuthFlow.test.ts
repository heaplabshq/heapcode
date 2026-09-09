import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { McpManager, MemoryAuthStore, beginMcpLogin, completeMcpLogin } from '../src/index.js';
// @ts-expect-error -- plain .mjs fixture, no types
import { startOAuthMcpServer } from './fixtures/oauthMcpServer.mjs';

/**
 * The whole sign-in, end to end, against a server that speaks the same four
 * specs a hosted connector does.
 *
 * This exists because the live target we built against — Notion — answers
 * `server_error` from its own code exchange after a successful consent, so it
 * can prove the flow up to that point and no further. Everything here is ours:
 * a 401 with a discovery pointer, dynamic registration, PKCE, the callback,
 * the exchange, a connected client with a working token, and a refresh.
 */

const REDIRECT = 'http://127.0.0.1:7411/oauth/callback';

/** Stands in for the browser: follow the authorization URL, keep the query. */
async function consent(authorizationUrl: string): Promise<URLSearchParams> {
  const res = await fetch(authorizationUrl, { redirect: 'manual' });
  expect(res.status).toBe(302);
  return new URL(res.headers.get('location')!).searchParams;
}

describe('the MCP sign-in flow', () => {
  let fixture: Awaited<ReturnType<typeof startOAuthMcpServer>>;
  let store: MemoryAuthStore;
  let manager: McpManager;

  beforeEach(async () => {
    fixture = await startOAuthMcpServer({ requireResource: true });
    store = new MemoryAuthStore();
    manager = new McpManager(
      () => ({ fixture: { url: fixture.mcpUrl, transport: 'http' as const } }),
      undefined,
      '0.1.0',
      store,
      REDIRECT,
    );
  });

  afterEach(async () => {
    manager.dispose();
    await fixture.close();
  });

  it('reports a 401 as needing a sign-in, not as a fault', async () => {
    await manager.ensureConnected();
    expect(manager.connectedServerNames()).toEqual([]);
    expect(manager.awaitingSignIn('fixture')).toBe(true);
    expect(manager.failureFor('fixture')).toMatch(/Sign in/i);
  });

  it('signs in and connects, with the tools that were behind the token', async () => {
    await manager.ensureConnected();

    const provider = manager.providerFor('fixture')!;
    const { authorizationUrl, state } = await beginMcpLogin(provider, fixture.mcpUrl);
    const back = await consent(authorizationUrl);

    // The client's only CSRF check: what comes back is what went out.
    expect(back.get('state')).toBe(state);

    await completeMcpLogin(provider, fixture.mcpUrl, back.get('code')!, state);
    await manager.ensureConnected();

    expect(manager.connectedServerNames()).toEqual(['fixture']);
    expect(manager.getToolDefinitions().map((t) => t.name)).toEqual(['mcp__fixture__whoami']);
    expect(await manager.call('mcp__fixture__whoami', {})).toBe('authenticated');
  });

  it('registers as a public client and proves possession with PKCE', async () => {
    await manager.ensureConnected();
    const provider = manager.providerFor('fixture')!;
    const { authorizationUrl, state } = await beginMcpLogin(provider, fixture.mcpUrl);
    const back = await consent(authorizationUrl);
    await completeMcpLogin(provider, fixture.mcpUrl, back.get('code')!, state);

    const registration = fixture.seen.registrations.at(-1);
    expect(registration.token_endpoint_auth_method).toBe('none');
    expect(registration.redirect_uris).toEqual([REDIRECT]);

    const authorize = fixture.seen.authorizations.at(-1);
    expect(authorize.code_challenge_method).toBe('S256');
    // RFC 8707. The fixture rejects a request without it, so reaching here at
    // all is the assertion; naming it keeps the reason legible.
    expect(authorize.resource).toBe(fixture.mcpUrl);

    const exchange = fixture.seen.tokenRequests.at(-1);
    expect(exchange.code_verifier).toBeTruthy();
    expect(exchange.client_secret).toBeUndefined();
  });

  it('refreshes an expired token by itself, without asking again', async () => {
    await manager.ensureConnected();
    const provider = manager.providerFor('fixture')!;
    const { authorizationUrl, state } = await beginMcpLogin(provider, fixture.mcpUrl);
    const back = await consent(authorizationUrl);
    await completeMcpLogin(provider, fixture.mcpUrl, back.get('code')!, state);
    await manager.ensureConnected();

    const first = (await store.read('fixture'))!.tokens!.access_token;

    // Every issued access token stops working; the refresh token still does.
    fixture.revokeAccessTokens();
    manager.dispose();
    await manager.ensureConnected();

    expect(manager.connectedServerNames()).toEqual(['fixture']);
    expect(fixture.seen.tokenRequests.some((r: { grant_type: string }) => r.grant_type === 'refresh_token')).toBe(true);
    expect((await store.read('fixture'))!.tokens!.access_token).not.toBe(first);
  });

  it('spends an authorization code once', async () => {
    await manager.ensureConnected();
    const provider = manager.providerFor('fixture')!;
    const { authorizationUrl, state } = await beginMcpLogin(provider, fixture.mcpUrl);
    const back = await consent(authorizationUrl);
    const code = back.get('code')!;
    await completeMcpLogin(provider, fixture.mcpUrl, code, state);

    // Replaying it must fail — and it fails at our own state check first,
    // which saveTokens cleared, before the server is ever asked.
    await expect(completeMcpLogin(provider, fixture.mcpUrl, code, state)).rejects.toThrow(/did not match/);
  });

  it('signs out completely, so the next connection needs a fresh login', async () => {
    await manager.ensureConnected();
    const provider = manager.providerFor('fixture')!;
    const { authorizationUrl, state } = await beginMcpLogin(provider, fixture.mcpUrl);
    const back = await consent(authorizationUrl);
    await completeMcpLogin(provider, fixture.mcpUrl, back.get('code')!, state);
    await manager.ensureConnected();
    expect(manager.connectedServerNames()).toEqual(['fixture']);

    await manager.signOut('fixture');
    expect(await store.read('fixture')).toBeUndefined();

    await manager.ensureConnected();
    expect(manager.connectedServerNames()).toEqual([]);
    expect(manager.awaitingSignIn('fixture')).toBe(true);
  });

  it('a reconnect mid-login leaves the login still completable', async () => {
    await manager.ensureConnected();
    const provider = manager.providerFor('fixture')!;
    const { authorizationUrl, state } = await beginMcpLogin(provider, fixture.mcpUrl);

    // The bug this replaces: the SDK starts a fresh authorization on every
    // 401, and persisting its state and verifier destroyed the login the
    // person was in the middle of.
    await manager.ensureConnected();

    const back = await consent(authorizationUrl);
    await completeMcpLogin(provider, fixture.mcpUrl, back.get('code')!, state);
    await manager.ensureConnected();
    expect(manager.connectedServerNames()).toEqual(['fixture']);
  });
});
