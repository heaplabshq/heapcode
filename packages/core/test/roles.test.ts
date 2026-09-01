import { describe, expect, it } from 'vitest';
import {
  describeRole,
  migrateProfiles,
  needsMigration,
  resolveRole,
  roleChain,
  toProfile,
  type LegacyProviderProfile,
  type ModelConfig,
} from '../src/config/roles.js';

const cloud = { name: 'cloud', preset: 'openai' as const, baseUrl: 'https://api.openai.com/v1' };
const local = { name: 'local', preset: 'ollama' as const, baseUrl: 'http://127.0.0.1:11434/v1' };

const config = (roles: ModelConfig['roles']): ModelConfig => ({ connections: [cloud, local], roles });

describe('resolveRole — one lookup, one chain', () => {
  it('uses a role its own assignment when it has one', () => {
    const c = config({
      chat: { connection: 'cloud', model: 'gpt-4o' },
      rerank: { connection: 'local', model: 'qwen3-rerank' },
    });
    const resolved = resolveRole(c, 'rerank');
    expect(resolved?.from).toBe('rerank');
    expect(resolved?.assignment.model).toBe('qwen3-rerank');
    expect(resolved?.connection.name).toBe('local');
  });

  it('walks the chain and reports where the answer came from', () => {
    // The reporting is the point: the old UI made the reader trace this by
    // hand across two profiles.
    const c = config({
      chat: { connection: 'cloud', model: 'gpt-4o' },
      edit: { connection: 'local', model: 'qwen2.5-coder' },
    });
    expect(resolveRole(c, 'rerank')?.from).toBe('edit');
    expect(resolveRole(c, 'context')?.from).toBe('edit');
    expect(resolveRole(c, 'agent')?.from).toBe('chat');
    expect(roleChain('context')).toEqual(['context', 'rerank', 'edit', 'chat']);
  });

  it('never lets embeddings inherit a chat model', () => {
    // A chat model asked to embed either errors or returns something that is
    // not an embedding, and the second surfaces as bad search results rather
    // than as a failure. Off is the honest answer.
    const c = config({ chat: { connection: 'cloud', model: 'gpt-4o' } });
    expect(resolveRole(c, 'embeddings')).toBeUndefined();
    expect(describeRole(c, 'embeddings')).toMatch(/semantic search is off/);
  });

  it('never lets apply inherit either', () => {
    const c = config({ chat: { connection: 'cloud', model: 'gpt-4o' } });
    expect(resolveRole(c, 'apply')).toBeUndefined();
    expect(describeRole(c, 'apply')).toMatch(/selection\/insert/);
  });

  it('skips an assignment whose connection was deleted, rather than honouring it', () => {
    // Otherwise createProvider is handed an endpoint with no base URL and
    // fails at request time, several layers from anything that explains it.
    const c: ModelConfig = {
      connections: [cloud],
      roles: {
        chat: { connection: 'cloud', model: 'gpt-4o' },
        edit: { connection: 'deleted', model: 'ghost' },
      },
    };
    const resolved = resolveRole(c, 'edit');
    expect(resolved?.from).toBe('chat');
    expect(resolved?.assignment.model).toBe('gpt-4o');
  });

  it('returns nothing when the chain bottoms out with no chat model', () => {
    expect(resolveRole(config({}), 'agent')).toBeUndefined();
  });
});

describe('toProfile — the flattened runtime shape', () => {
  it('takes the endpoint from the connection and the tuning from the assignment', () => {
    // The split that matters: a small rerank model sharing an endpoint with a
    // large agent model must not inherit its context window.
    const profile = toProfile(
      { ...local, timeoutMs: 600_000, capabilities: { nativeToolCalls: false } },
      { connection: 'local', model: 'qwen3-rerank', contextWindow: 8_192, temperature: 0 },
    );
    expect(profile).toMatchObject({
      name: 'local',
      baseUrl: 'http://127.0.0.1:11434/v1',
      model: 'qwen3-rerank',
      timeoutMs: 600_000,
      contextWindow: 8_192,
      temperature: 0,
      capabilities: { nativeToolCalls: false },
    });
  });

  it('keeps the connection name, because the API key is filed under it', () => {
    expect(toProfile(cloud, { connection: 'cloud', model: 'gpt-4o' }).name).toBe('cloud');
  });
});

describe('migrateProfiles', () => {
  const legacy: LegacyProviderProfile[] = [
    {
      name: 'work',
      preset: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-4o',
      contextWindow: 128_000,
      temperature: 0.2,
      // Embeddings ran on the local box through a redirect — the case the
      // whole `<role>Profile` mechanism existed for.
      embeddingsProfile: 'homelab',
      rerankModel: 'gpt-4o-mini',
    },
    {
      name: 'homelab',
      preset: 'ollama',
      baseUrl: 'http://127.0.0.1:11434/v1',
      model: 'llama3.1',
      embeddingsModel: 'nomic-embed-text:latest',
    },
  ];

  it('keeps every profile as a connection under its own name', () => {
    // Non-negotiable: the API key is stored under this name in all four hosts.
    const { connections } = migrateProfiles(legacy, 'work');
    expect(connections.map((c) => c.name)).toEqual(['work', 'homelab']);
    expect(connections[0]).toMatchObject({ preset: 'openai', baseUrl: 'https://api.openai.com/v1' });
  });

  it('seeds chat from the active profile, tuning included', () => {
    const { roles } = migrateProfiles(legacy, 'work');
    expect(roles.chat).toEqual({
      connection: 'work',
      model: 'gpt-4o',
      contextWindow: 128_000,
      temperature: 0.2,
      maxTokens: undefined,
      promptTier: undefined,
    });
  });

  it('flattens a redirect into a concrete connection and model', () => {
    // The old resolution was two hops: the redirect named a profile, and the
    // model came from that profile's own field for the same role.
    const { roles } = migrateProfiles(legacy, 'work');
    expect(roles.embeddings).toEqual({ connection: 'homelab', model: 'nomic-embed-text:latest' });
  });

  it('keeps a role that was set on the active profile itself', () => {
    const { roles } = migrateProfiles(legacy, 'work');
    expect(roles.rerank).toEqual({ connection: 'work', model: 'gpt-4o-mini' });
  });

  it('leaves an unset role unset, so it keeps inheriting', () => {
    // Pinning it to whatever chat happened to be at migration time would
    // freeze a choice the user never made.
    const { roles } = migrateProfiles(legacy, 'work');
    expect(roles.agent).toBeUndefined();
    expect(roles.edit).toBeUndefined();
  });

  it('falls back to a redirect target\'s chat model when it has no role model of its own', () => {
    const { roles } = migrateProfiles(
      [
        { ...legacy[0]!, rerankModel: undefined, rerankProfile: 'homelab' },
        { ...legacy[1]!, model: 'llama3.1' },
      ],
      'work',
    );
    expect(roles.rerank).toEqual({ connection: 'homelab', model: 'llama3.1' });
  });

  it('takes the first profile when no active one is named', () => {
    expect(migrateProfiles(legacy).roles.chat?.connection).toBe('work');
  });

  it('survives an empty config', () => {
    expect(migrateProfiles([])).toEqual({ connections: [], roles: {} });
  });
});

describe('needsMigration', () => {
  it('is true for the old shape and false once converted', () => {
    expect(needsMigration({ profiles: [] })).toBe(true);
    expect(needsMigration({ connections: [], profiles: [] })).toBe(false);
    expect(needsMigration({})).toBe(false);
  });
});
