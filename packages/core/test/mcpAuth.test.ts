import { describe, expect, it } from 'vitest';
import {
  completeMcpLogin,
  isAuthFailure,
  McpOAuthProvider,
  MemoryAuthStore,
  type McpAuthRecord,
} from '../src/index.js';

const REDIRECT = 'http://127.0.0.1:7411/oauth/callback';

function provider(store = new MemoryAuthStore(), redirect = REDIRECT): McpOAuthProvider {
  return new McpOAuthProvider('notion', store, redirect);
}

describe('McpOAuthProvider', () => {
  it('asks for a public client, because a local app cannot keep a secret', () => {
    const metadata = provider().clientMetadata;
    expect(metadata.token_endpoint_auth_method).toBe('none');
    expect(metadata.redirect_uris).toEqual([REDIRECT]);
    expect(metadata.grant_types).toContain('refresh_token');
  });

  it('reuses a stored registration, so signing in twice does not litter the server', async () => {
    const store = new MemoryAuthStore();
    const first = provider(store);
    await first.saveClientInformation({ client_id: 'abc', redirect_uris: [REDIRECT] } as never);
    expect((await provider(store).clientInformation())?.client_id).toBe('abc');
  });

  it('discards a registration made for a different callback', async () => {
    const store = new MemoryAuthStore();
    await provider(store).saveClientInformation({ client_id: 'abc', redirect_uris: [REDIRECT] } as never);
    // A terminal opens an ephemeral port per login, so this is the normal case
    // rather than an edge one: the old client_id is not valid for the new URI.
    const onAnotherPort = provider(store, 'http://127.0.0.1:59999/oauth/callback');
    expect(await onAnotherPort.clientInformation()).toBeUndefined();
  });

  it('drops the verifier and state once tokens land, so neither can be replayed', async () => {
    const store = new MemoryAuthStore();
    const p = provider(store);
    await p.saveCodeVerifier('verifier-1');
    const state = await p.state();
    expect(state).toHaveLength(48);
    await p.saveTokens({ access_token: 'tok', token_type: 'Bearer' });

    const record = store.read('notion') as McpAuthRecord;
    expect(record.tokens?.access_token).toBe('tok');
    expect(record.codeVerifier).toBeUndefined();
    expect(record.state).toBeUndefined();
    await expect(p.codeVerifier()).rejects.toThrow(/No sign-in is in progress/);
  });

  it('does not let a reconnect overwrite a login someone is in the middle of', async () => {
    const store = new MemoryAuthStore();

    // The sign-in the person is driving: state and verifier go to the store,
    // because the callback arrives on a different request.
    const login = provider(store);
    await login.saveCodeVerifier('verifier-from-the-real-login');
    const state = await login.state();

    // What a connection attempt uses. A 401 makes the SDK start a fresh
    // authorization, so this path mints its own state and verifier — and if
    // those reached the store, the consent screen still open in the browser
    // would come back to a login that no longer exists.
    const reconnect = new McpOAuthProvider('notion', store, REDIRECT, false);
    await reconnect.saveCodeVerifier('verifier-from-a-reconnect');
    await reconnect.state();

    const record = store.read('notion') as McpAuthRecord;
    expect(record.state).toBe(state);
    expect(record.codeVerifier).toBe('verifier-from-the-real-login');
    expect(await login.expectedState()).toBe(state);
  });

  it('a non-owning provider still shares tokens and registration', async () => {
    const store = new MemoryAuthStore();
    const reconnect = new McpOAuthProvider('notion', store, REDIRECT, false);
    // Refreshing a token and registering a client are exactly what the connect
    // path is for; only the login half is withheld from it.
    await reconnect.saveTokens({ access_token: 'refreshed', token_type: 'Bearer' });
    await reconnect.saveClientInformation({ client_id: 'abc', redirect_uris: [REDIRECT] } as never);

    expect((await provider(store).tokens())?.access_token).toBe('refreshed');
    expect((await provider(store).clientInformation())?.client_id).toBe('abc');
  });

  it('mints a fresh state each time, so an abandoned login cannot be resumed', async () => {
    const p = provider();
    expect(await p.state()).not.toBe(await p.state());
  });

  it('holds the authorization URL for the host to open, and hands it over once', () => {
    const p = provider();
    p.redirectToAuthorization(new URL('https://mcp.notion.com/authorize?x=1'));
    expect(p.takeAuthorizationUrl()?.host).toBe('mcp.notion.com');
    // Cleared: a URL outliving its verifier sends someone into a login that
    // cannot finish.
    expect(p.takeAuthorizationUrl()).toBeUndefined();
  });
});

describe('completeMcpLogin', () => {
  it('refuses a callback whose state does not match the login we started', async () => {
    const store = new MemoryAuthStore();
    const p = provider(store);
    await p.state();
    await expect(completeMcpLogin(p, 'https://mcp.notion.com/mcp', 'code', 'not-our-state')).rejects.toThrow(
      /did not match/,
    );
  });

  it('refuses a callback when no login is in flight at all', async () => {
    await expect(completeMcpLogin(provider(), 'https://mcp.notion.com/mcp', 'code', 'anything')).rejects.toThrow(
      /did not match/,
    );
  });
});

describe('isAuthFailure', () => {
  it('separates "refusing us" from "broken"', () => {
    expect(isAuthFailure(Object.assign(new Error('nope'), { code: 401 }))).toBe(true);
    expect(isAuthFailure(new Error('Error POSTing to endpoint: {"error":"invalid_token"}'))).toBe(true);
    expect(isAuthFailure(Object.assign(new Error('spawn foo ENOENT'), { code: 'ENOENT' }))).toBe(false);
    expect(isAuthFailure(new Error('getaddrinfo ENOTFOUND example.invalid'))).toBe(false);
  });
});
