import { describe, expect, it } from 'vitest';
import { callbackPage, CALLBACK_PATH, createMcpLoginRegistry } from '../src/mcpLogin.js';

describe('createMcpLoginRegistry', () => {
  it('points the callback at this server, not at the page that asked', () => {
    // Notion: "Redirect URI must use HTTPS unless it is a loopback HTTP URI".
    // A LAN-reached page must still sign in from the machine running the host.
    const registry = createMcpLoginRegistry(() => 'http://127.0.0.1:7411');
    expect(registry.redirectUri()).toBe(`http://127.0.0.1:7411${CALLBACK_PATH}`);
  });

  it('routes a callback to the login that state belongs to', async () => {
    const registry = createMcpLoginRegistry(() => 'http://127.0.0.1:7411');
    const seen: string[] = [];
    registry.begin('state-a', async (code) => void seen.push(`a:${code}`));
    registry.begin('state-b', async (code) => void seen.push(`b:${code}`));

    expect(await registry.complete('state-b', 'code-2')).toBe(true);
    expect(seen).toEqual(['b:code-2']);
  });

  it('reports no match rather than throwing when nothing is in flight', async () => {
    const registry = createMcpLoginRegistry(() => 'http://127.0.0.1:7411');
    expect(await registry.complete('never-issued', 'code')).toBe(false);
  });

  it('spends a state once, even when the exchange fails', async () => {
    const registry = createMcpLoginRegistry(() => 'http://127.0.0.1:7411');
    registry.begin('state-a', () => Promise.reject(new Error('exchange refused')));

    await expect(registry.complete('state-a', 'code')).rejects.toThrow(/exchange refused/);
    // The second presentation finds nothing: a failed attempt must not leave a
    // state that can be replayed with a different code.
    expect(await registry.complete('state-a', 'other-code')).toBe(false);
  });
});

describe('callbackPage', () => {
  it('escapes what the authorization server sent, which is not ours to trust', () => {
    const html = callbackPage({ ok: false, detail: '<img src=x onerror=alert(1)>' });
    expect(html).not.toContain('<img');
    expect(html).toContain('&#60;img');
  });

  it('says which way it went', () => {
    expect(callbackPage({ ok: true })).toContain('Signed in');
    expect(callbackPage({ ok: false })).toContain('Sign-in failed');
  });
});
