import { describe, expect, it } from 'vitest';
import {
  Session,
  type HelloParams,
  type KeyRequestResult,
  type ModelRoleTable,
  type ProviderProfileConfig,
} from '../src/index.js';

/**
 * Role resolution in the server, after roles became global.
 *
 * It used to be two hops: a role read a `<role>Model` field off the active
 * profile, and a `<role>Profile` field could redirect it to another profile
 * whose same-named role field was read in turn. Now one table says which model
 * on which connection serves each role, and this resolves it in one lookup.
 *
 * The connection an assignment names is normally NOT pushed at hello — the
 * hosts send only what the chat role needs (App.tsx, headless.ts,
 * serverLink.ts) — so `key/request` is the ordinary path here rather than a
 * fallback. These tests are written against that reality.
 */

function profile(name: string, extra: Partial<ProviderProfileConfig> = {}): ProviderProfileConfig {
  return { name, preset: 'custom', baseUrl: `https://${name}.example`, model: 'chat', ...extra };
}

function session(
  active: ProviderProfileConfig,
  roles: ModelRoleTable = {},
  keys: Record<string, string> = {},
): Session {
  const hello: HelloParams = {
    token: 't',
    protocolVersion: 2,
    client: { name: 'test' },
    root: '/tmp/ws',
    profiles: [active],
    activeProfile: active.name,
    roles,
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

const chatOnCloud: ModelRoleTable = { chat: { connection: 'cloud', model: 'gpt-4o' } };

describe('Session.providerForRole', () => {
  it('serves a role from the connection its assignment names', async () => {
    const s = session(profile('cloud'), {
      ...chatOnCloud,
      embeddings: { connection: 'cloud', model: 'text-embedding-3-small' },
    }, { cloud: 'k' });
    const host = hostWith({}, s);

    const resolved = await s.providerForRole('embeddings', host.requestKey);

    expect(resolved?.profile.name).toBe('cloud');
    // The assignment's model wins over whatever chat model the connection
    // happened to be pushed carrying.
    expect(resolved?.profile.model).toBe('text-embedding-3-small');
    expect(host.asked).toEqual([]);
  });

  it('fetches a connection it has not been pushed, since hello sends only the chat one', async () => {
    const s = session(profile('cloud'), {
      ...chatOnCloud,
      embeddings: { connection: 'ollama', model: 'nomic-embed-text' },
    }, { cloud: 'k' });
    const host = hostWith(
      { ollama: { profile: profile('ollama', { baseUrl: 'http://localhost:11434/v1' }) } },
      s,
    );

    const resolved = await s.providerForRole('embeddings', host.requestKey);

    expect(host.asked).toEqual(['ollama']);
    expect(resolved?.profile.name).toBe('ollama');
    expect(resolved?.profile.baseUrl).toBe('http://localhost:11434/v1');
    expect(resolved?.profile.model).toBe('nomic-embed-text');
  });

  it('lets each role land on a different connection', async () => {
    const s = session(profile('cloud'), {
      ...chatOnCloud,
      embeddings: { connection: 'ollama', model: 'nomic-embed-text' },
      rerank: { connection: 'fast', model: 'rerank-1' },
    }, { cloud: 'k' });
    const host = hostWith(
      { ollama: { profile: profile('ollama') }, fast: { profile: profile('fast'), apiKey: 'fk' } },
      s,
    );

    expect((await s.providerForRole('embeddings', host.requestKey))?.profile.name).toBe('ollama');
    expect((await s.providerForRole('rerank', host.requestKey))?.profile.name).toBe('fast');
    // context inherits rerank, so it lands on the same connection without
    // needing an assignment of its own.
    expect((await s.providerForRole('context', host.requestKey))?.profile.model).toBe('rerank-1');
    expect(host.asked).toEqual(['ollama', 'fast']);
  });

  it('carries the assignment tuning, not the connection it was pushed with', async () => {
    // The reason tuning moved onto the assignment: a small model sharing an
    // endpoint with a large one must not inherit its context window.
    const s = session(profile('cloud', { contextWindow: 128_000 }), {
      ...chatOnCloud,
      rerank: { connection: 'cloud', model: 'small', contextWindow: 8_192, temperature: 0 },
    }, { cloud: 'k' });

    const resolved = await s.providerForRole('rerank');

    expect(resolved?.profile.contextWindow).toBe(8_192);
    expect(resolved?.profile.temperature).toBe(0);
  });

  it('falls back down the chain when the host does not know the connection a role names', async () => {
    // Only for a role that inherits: the active connection comes back carrying
    // its chat model, which for edit IS the bottom of its own chain.
    const s = session(profile('cloud'), {
      ...chatOnCloud,
      edit: { connection: 'typo', model: 'ghost' },
    }, { cloud: 'k' });
    const host = hostWith({}, s);

    const resolved = await s.providerForRole('edit', host.requestKey);
    expect(resolved?.profile.name).toBe('cloud');
    expect(resolved?.profile.model).toBe('gpt-4o');
    expect(host.asked).toEqual(['typo']);
  });

  it('leaves embeddings off rather than substituting the chat model, when its connection is gone', async () => {
    // The reported failure. The active connection is pushed carrying its CHAT
    // model, so falling back handed the embeddings role a chat model:
    // OpenRouter answered "Model <chat model> does not exist", and the index
    // was then discarded as written by a different embedder. A chat model
    // asked to embed is not a degraded answer, it is a wrong one.
    const s = session(profile('cloud'), {
      ...chatOnCloud,
      embeddings: { connection: 'homelab', model: 'nomic-embed-text' },
    }, { cloud: 'k' });
    const host = hostWith({}, s);

    expect(await s.providerForRole('embeddings', host.requestKey)).toBeUndefined();
    expect(await s.providerForRole('apply', host.requestKey)).toBeUndefined();
    expect(host.asked).toEqual(['homelab']);
  });

  it('says in the log why a role was left off, rather than substituting in silence', async () => {
    const lines: string[] = [];
    const s = new Session(
      'sess',
      {
        token: 't',
        protocolVersion: 2,
        client: { name: 'test' },
        root: '/tmp/ws',
        profiles: [profile('cloud')],
        activeProfile: 'cloud',
        roles: { ...chatOnCloud, embeddings: { connection: 'homelab', model: 'nomic' } },
        keys: { cloud: 'k' },
      },
      (line) => lines.push(line),
    );

    await s.providerForRole('embeddings');

    expect(lines.join('\n')).toContain('homelab');
    expect(lines.join('\n')).toMatch(/not configured/);
  });

  it('asks the host once per connection, not once per call', async () => {
    // The regression this guards: `!hasKey(name)` stays true forever for a
    // keyless Ollama connection, so an unguarded check re-asks on every batch.
    const s = session(profile('cloud'), {
      ...chatOnCloud,
      embeddings: { connection: 'ollama', model: 'nomic' },
    }, { cloud: 'k' });
    const host = hostWith({ ollama: { profile: profile('ollama') } }, s);

    for (let i = 0; i < 5; i++) await s.providerForRole('embeddings', host.requestKey);

    expect(host.asked).toEqual(['ollama']);
    expect(s.hasKey('ollama')).toBe(false);
  });

  it('caches the Provider per connection', async () => {
    const s = session(profile('cloud'), {
      ...chatOnCloud,
      embeddings: { connection: 'ollama', model: 'nomic' },
    }, { cloud: 'k' });
    const host = hostWith({ ollama: { profile: profile('ollama') } }, s);

    const first = await s.providerForRole('embeddings', host.requestKey);
    const second = await s.providerForRole('embeddings', host.requestKey);

    expect(first?.provider).toBe(second?.provider);
  });

  it('works with no key requester at all — an inheriting role falls back, embeddings does not', async () => {
    const s = session(profile('cloud'), {
      ...chatOnCloud,
      edit: { connection: 'ollama', model: 'qwen' },
      embeddings: { connection: 'ollama', model: 'nomic' },
    }, { cloud: 'k' });

    expect((await s.providerForRole('edit'))?.profile.name).toBe('cloud');
    expect(await s.providerForRole('embeddings')).toBeUndefined();
  });

  it('lets a caller pin a role to one connection, overriding the table', async () => {
    // delegate_task naming a profile is the case this exists for.
    const s = session(profile('cloud'), chatOnCloud, { cloud: 'k' });
    const host = hostWith({ other: { profile: profile('other') } }, s);

    const resolved = await s.providerForRole('agent', host.requestKey, 'other');

    expect(resolved?.profile.name).toBe('other');
  });

  it('leaves an unassigned embeddings role off rather than falling back to chat', async () => {
    // The bug the split exists to kill: a chat model asked to embed returns
    // something that is not an embedding, and it surfaces as bad search
    // results rather than as an error.
    const s = session(profile('cloud'), chatOnCloud, { cloud: 'k' });

    expect(await s.providerForRole('embeddings')).toBeUndefined();
    expect(await s.providerForRole('apply')).toBeUndefined();
  });

  it('falls back to the active connection when the host pushed no table at all', async () => {
    // A host that has not been converted yet still connects, and every role
    // that inherits resolves to the active connection's own model — which is
    // what a profile with no role overrides amounted to before the split.
    // Embeddings still does not: there is nothing to inherit from.
    const s = session(profile('cloud'), {}, { cloud: 'k' });

    expect((await s.providerForRole('agent'))?.profile.model).toBe('chat');
    expect(await s.providerForRole('embeddings')).toBeUndefined();
  });

  it('takes a new table mid-session, so a settings change lands without a reconnect', async () => {
    const s = session(profile('cloud'), chatOnCloud, { cloud: 'k' });

    s.setRoles({ ...chatOnCloud, edit: { connection: 'cloud', model: 'gpt-4o-mini' } });

    expect((await s.providerForRole('edit'))?.profile.model).toBe('gpt-4o-mini');
  });

  it('drops the ask-once record on dispose, along with keys and providers', async () => {
    const s = session(profile('cloud'), {
      ...chatOnCloud,
      embeddings: { connection: 'ollama', model: 'nomic' },
    }, { cloud: 'k' });
    const host = hostWith({ ollama: { profile: profile('ollama') } }, s);
    await s.providerForRole('embeddings', host.requestKey);

    s.dispose();

    expect(s.getProfile('cloud')).toBeUndefined();
    expect(s.hasKey('cloud')).toBe(false);
    // Nothing survives the connection (§2) — including "we already asked".
    expect(await s.providerForRole('embeddings', host.requestKey)).toBeUndefined();
  });
});

describe('Session.resolveProfile', () => {
  it('adopts the connection and key the host returns', async () => {
    const s = session(profile('cloud'), chatOnCloud, { cloud: 'k' });
    const host = hostWith({ other: { profile: profile('other'), apiKey: 'ok' } }, s);

    const resolved = await s.resolveProfile('other', host.requestKey);

    expect(resolved?.profile.baseUrl).toBe('https://other.example');
    expect(s.hasKey('other')).toBe(true);
  });

  it('does not ask for a connection it already holds a key for', async () => {
    const s = session(profile('cloud'), chatOnCloud, { cloud: 'k' });
    const host = hostWith({}, s);

    expect((await s.resolveProfile('cloud', host.requestKey))?.profile.name).toBe('cloud');
    expect(host.asked).toEqual([]);
  });
});
