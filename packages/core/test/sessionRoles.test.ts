import { describe, expect, it } from 'vitest';
import { Session, type HelloParams, type KeyRequestResult, type ProviderProfileConfig } from '../src/index.js';

/**
 * Prerequisite 2 of docs/phase3-rag-design.md §5.3. Nothing server-side
 * implemented the `<role>Profile` redirect that both hosts do today
 * (packages/cli/src/provider/roles.ts:30-41,
 * packages/vscode/src/profileManager.ts:164-176) — and RAG is the feature
 * that uses it most, since embeddings/rerank/context each get their own.
 *
 * The redirect target is normally NOT pushed at hello: all three hosts send
 * only the active profile (App.tsx:426, headless.ts:207, serverLink.ts:91),
 * so `key/request` is the ordinary path here rather than a fallback. These
 * tests are written against that reality.
 */

function profile(name: string, extra: Partial<ProviderProfileConfig> = {}): ProviderProfileConfig {
  return { name, preset: 'custom', baseUrl: `https://${name}.example`, model: 'chat', ...extra };
}

function session(active: ProviderProfileConfig, keys: Record<string, string> = {}): Session {
  const hello: HelloParams = {
    token: 't',
    protocolVersion: 1,
    client: { name: 'test' },
    root: '/tmp/ws',
    profiles: [active],
    activeProfile: active.name,
    keys,
  };
  return new Session('sess', hello);
}

/** Stands in for the host's key/request handler; records what it was asked. */
function hostWith(known: Record<string, KeyRequestResult>, session: Session) {
  const asked: string[] = [];
  return {
    asked,
    requestKey: async (name: string): Promise<void> => {
      asked.push(name);
      session.adoptResolvedKey(name, known[name] ?? {});
    },
  };
}

describe('Session.providerForRole', () => {
  it('uses the active profile when the role names no redirect', async () => {
    const s = session(profile('cloud', { embeddingsModel: 'text-embedding-3-small' }), { cloud: 'k' });
    const host = hostWith({}, s);

    const resolved = await s.providerForRole('embeddingsModel', host.requestKey);

    expect(resolved?.profile.name).toBe('cloud');
    expect(host.asked).toEqual([]);
  });

  it('uses the active profile when the redirect points back at itself', async () => {
    // Both hosts treat a self-reference as "no redirect" (roles.ts:31).
    const s = session(profile('cloud', { embeddingsProfile: 'cloud' }), { cloud: 'k' });
    const host = hostWith({}, s);

    expect((await s.providerForRole('embeddingsModel', host.requestKey))?.profile.name).toBe('cloud');
    expect(host.asked).toEqual([]);
  });

  it('follows the redirect through key/request, since hello only ever pushed the active profile', async () => {
    const s = session(profile('cloud', { embeddingsProfile: 'ollama' }), { cloud: 'k' });
    const host = hostWith(
      { ollama: { profile: profile('ollama', { baseUrl: 'http://localhost:11434/v1', embeddingsModel: 'nomic-embed-text' }) } },
      s,
    );

    const resolved = await s.providerForRole('embeddingsModel', host.requestKey);

    expect(host.asked).toEqual(['ollama']);
    expect(resolved?.profile.name).toBe('ollama');
    expect(resolved?.profile.embeddingsModel).toBe('nomic-embed-text');
  });

  it('resolves each role through its own field, so embeddings and rerank can land on different profiles', async () => {
    const s = session(profile('cloud', { embeddingsProfile: 'ollama', rerankProfile: 'fast' }), { cloud: 'k' });
    const host = hostWith(
      { ollama: { profile: profile('ollama') }, fast: { profile: profile('fast'), apiKey: 'fk' } },
      s,
    );

    expect((await s.providerForRole('embeddingsModel', host.requestKey))?.profile.name).toBe('ollama');
    expect((await s.providerForRole('rerankModel', host.requestKey))?.profile.name).toBe('fast');
    expect((await s.providerForRole('contextModel', host.requestKey))?.profile.name).toBe('cloud');
    expect(host.asked).toEqual(['ollama', 'fast']);
  });

  it('falls back to the profile it redirected from when the host does not know the target', async () => {
    // Same leniency both hosts already have: `?? this.active` (roles.ts:32).
    const s = session(profile('cloud', { embeddingsProfile: 'typo' }), { cloud: 'k' });
    const host = hostWith({}, s);

    expect((await s.providerForRole('embeddingsModel', host.requestKey))?.profile.name).toBe('cloud');
    expect(host.asked).toEqual(['typo']);
  });

  it('asks the host once per profile, not once per call — a keyless local profile never gets a key', async () => {
    // The regression this guards: `!hasKey(name)` stays true forever for an
    // Ollama profile, so an unguarded check re-asks on every embedding batch.
    const s = session(profile('cloud', { embeddingsProfile: 'ollama' }), { cloud: 'k' });
    const host = hostWith({ ollama: { profile: profile('ollama') } }, s);

    for (let i = 0; i < 5; i++) await s.providerForRole('embeddingsModel', host.requestKey);

    expect(host.asked).toEqual(['ollama']);
    expect(s.hasKey('ollama')).toBe(false);
  });

  it('caches the Provider per profile, so a redirect resolves to the same instance', async () => {
    const s = session(profile('cloud', { embeddingsProfile: 'ollama' }), { cloud: 'k' });
    const host = hostWith({ ollama: { profile: profile('ollama') } }, s);

    const first = await s.providerForRole('embeddingsModel', host.requestKey);
    const second = await s.providerForRole('embeddingsModel', host.requestKey);

    expect(first?.provider).toBe(second?.provider);
  });

  it('works with no key requester at all — the redirect just falls back', async () => {
    const s = session(profile('cloud', { embeddingsProfile: 'ollama' }), { cloud: 'k' });

    expect((await s.providerForRole('embeddingsModel'))?.profile.name).toBe('cloud');
  });

  it('resolves from a named profile rather than the active one when asked to', async () => {
    const s = session(profile('cloud', { embeddingsProfile: 'ollama' }), { cloud: 'k' });
    const host = hostWith({ other: { profile: profile('other', { embeddingsProfile: 'elsewhere' }) }, elsewhere: { profile: profile('elsewhere') } }, s);
    await s.resolveProfile('other', host.requestKey);

    const resolved = await s.providerForRole('embeddingsModel', host.requestKey, 'other');

    expect(resolved?.profile.name).toBe('elsewhere');
  });

  it('drops the ask-once record on dispose, along with keys and providers', async () => {
    const s = session(profile('cloud', { embeddingsProfile: 'ollama' }), { cloud: 'k' });
    const host = hostWith({ ollama: { profile: profile('ollama') } }, s);
    await s.providerForRole('embeddingsModel', host.requestKey);

    s.dispose();

    expect(s.getProfile('cloud')).toBeUndefined();
    expect(s.hasKey('cloud')).toBe(false);
    // Nothing survives the connection (§2) — including "we already asked".
    expect(await s.providerForRole('embeddingsModel', host.requestKey)).toBeUndefined();
  });
});

describe('Session.resolveProfile', () => {
  it('adopts the profile and key the host returns', async () => {
    const s = session(profile('cloud'), { cloud: 'k' });
    const host = hostWith({ other: { profile: profile('other'), apiKey: 'ok' } }, s);

    const resolved = await s.resolveProfile('other', host.requestKey);

    expect(resolved?.profile.baseUrl).toBe('https://other.example');
    expect(s.hasKey('other')).toBe(true);
  });

  it('does not ask for a profile it already holds a key for', async () => {
    const s = session(profile('cloud'), { cloud: 'k' });
    const host = hostWith({}, s);

    expect((await s.resolveProfile('cloud', host.requestKey))?.profile.name).toBe('cloud');
    expect(host.asked).toEqual([]);
  });
});
