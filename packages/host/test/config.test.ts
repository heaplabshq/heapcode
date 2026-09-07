import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConfigStore } from '../src/config/store.js';
import { SecretsStore } from '../src/config/secrets.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'heapcode-config-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('ConfigStore', () => {
  it('saves a profile, makes it active, and round-trips through a fresh instance', async () => {
    const store = new ConfigStore(join(dir, 'config.json'));
    await store.saveProfile({ name: 'local', preset: 'ollama', baseUrl: 'http://localhost:11434/v1', model: 'llama3.1:8b' });

    const reloaded = new ConfigStore(join(dir, 'config.json'));
    expect(await reloaded.getActiveProfile()).toMatchObject({ name: 'local', model: 'llama3.1:8b' });
    expect(await reloaded.listProfiles()).toHaveLength(1);
  });

  it('switching connections requires the target to exist', async () => {
    const store = new ConfigStore(join(dir, 'config.json'));
    await store.saveProfile({ name: 'a', preset: 'ollama', baseUrl: 'http://x', model: 'm' });
    await expect(store.setActiveProfile('nope')).rejects.toThrow(/No connection named "nope"/);
    await store.setActiveProfile('a');
    expect((await store.getActiveProfile())?.name).toBe('a');
  });

  it('deleting the active connection falls back to another', async () => {
    const store = new ConfigStore(join(dir, 'config.json'));
    await store.saveProfile({ name: 'a', preset: 'ollama', baseUrl: 'http://x', model: 'm' });
    await store.saveProfile({ name: 'b', preset: 'ollama', baseUrl: 'http://x', model: 'm2' });
    await store.setChatModel('a', 'm');
    await store.deleteProfile('a');
    expect((await store.listConnections()).map((c) => c.name)).toEqual(['b']);
  });
});

/**
 * Roles moved out of profiles and into one global table (core's
 * config/roles.ts). What this file has to pin is the store half: that an old
 * config still opens, that the names its API keys are filed under survive, and
 * that deleting a connection does not leave assignments pointing into space.
 */
describe('ConfigStore — connections and roles', () => {
  const legacy = {
    profiles: [
      {
        name: 'work',
        preset: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        model: 'gpt-4o',
        contextWindow: 128_000,
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
    ],
    activeProfile: 'work',
    telemetryEnabled: true,
  };

  async function withLegacyConfig(): Promise<ConfigStore> {
    const path = join(dir, 'config.json');
    await writeFile(path, JSON.stringify(legacy), 'utf8');
    return new ConfigStore(path);
  }

  it('opens a pre-split config and flattens its redirects', async () => {
    const store = await withLegacyConfig();

    expect((await store.listConnections()).map((c) => c.name)).toEqual(['work', 'homelab']);
    expect(await store.getRoles()).toMatchObject({
      chat: { connection: 'work', model: 'gpt-4o', contextWindow: 128_000 },
      // The redirect pointed at homelab and read *its* embeddings model.
      embeddings: { connection: 'homelab', model: 'nomic-embed-text:latest' },
      rerank: { connection: 'work', model: 'gpt-4o-mini' },
    });
  });

  it('keeps every connection name, because API keys are filed under them', async () => {
    // A rename here means every user re-enters every key.
    const store = await withLegacyConfig();
    const secrets = new SecretsStore(join(dir, 'secrets.json'));
    await secrets.setApiKey('work', 'sk-live');

    expect(await store.getConnection('work')).toBeTruthy();
    expect(await secrets.getApiKey('work')).toBe('sk-live');
  });

  it('does not rewrite the file just for being read', async () => {
    // Migration is in memory. A read with a disk side effect on every command's
    // startup path is a bad thing to have.
    const path = join(dir, 'config.json');
    await writeFile(path, JSON.stringify(legacy), 'utf8');
    const before = await stat(path);
    await new ConfigStore(path).listConnections();

    expect((await stat(path)).mtimeMs).toBe(before.mtimeMs);
  });

  it('leaves the old profiles in the file, so a downgrade is not destructive', async () => {
    const store = await withLegacyConfig();
    await store.setRole('edit', { connection: 'homelab', model: 'qwen2.5-coder' });

    const written = JSON.parse(await readFile(join(dir, 'config.json'), 'utf8')) as Record<string, unknown>;
    expect(written.profiles).toHaveLength(2);
    expect(written.connections).toHaveLength(2);
  });

  it('resolves a role through the chain, not through a profile', async () => {
    const store = await withLegacyConfig();

    // context inherits rerank, which is set — so it lands on gpt-4o-mini.
    expect((await store.resolve('context'))?.model).toBe('gpt-4o-mini');
    // agent inherits chat.
    expect((await store.resolve('agent'))?.model).toBe('gpt-4o');
    // The endpoint comes from the connection, the model from the assignment.
    expect((await store.resolve('embeddings'))?.baseUrl).toBe('http://127.0.0.1:11434/v1');
  });

  it('clears a role, so it inherits again', async () => {
    const store = await withLegacyConfig();
    await store.setRole('rerank');

    expect((await store.resolve('rerank'))?.model).toBe('gpt-4o');
  });

  it('drops assignments pointing at a connection it deletes', async () => {
    // Resolution would survive them — it skips a missing connection and falls
    // down the chain — but a settings screen listing a model on an endpoint
    // that no longer exists reads as a bug rather than as a fallback.
    const store = await withLegacyConfig();
    await store.deleteConnection('homelab');

    expect((await store.getRoles()).embeddings).toBeUndefined();
    expect((await store.getRoles()).chat).toBeTruthy();
  });

  it('sets a chat model and its connection together', async () => {
    const store = await withLegacyConfig();
    await store.setChatModel('homelab', 'llama3.1');

    expect(await store.getActiveProfile()).toMatchObject({
      name: 'homelab',
      model: 'llama3.1',
      baseUrl: 'http://127.0.0.1:11434/v1',
    });
  });

  it('does not carry a model across when only the connection is switched', async () => {
    // A model id is meaningful only on the endpoint that serves it, and the
    // old `profile use` could leave chat naming one that does not exist there.
    const store = await withLegacyConfig();
    await store.setActiveProfile('homelab');

    expect((await store.getRoles()).chat).toEqual({ connection: 'homelab', model: '' });
  });
});

describe('SecretsStore', () => {
  it('stores API keys chmod 600, keyed per profile', async () => {
    const path = join(dir, 'secrets.json');
    const store = new SecretsStore(path);
    await store.setApiKey('prod', 'sk-test-123');

    expect(await store.getApiKey('prod')).toBe('sk-test-123');
    expect(await store.getApiKey('other')).toBeUndefined();

    const mode = (await stat(path)).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('deleting a key removes only that profile\'s key', async () => {
    const store = new SecretsStore(join(dir, 'secrets.json'));
    await store.setApiKey('a', 'key-a');
    await store.setApiKey('b', 'key-b');
    await store.deleteApiKey('a');
    expect(await store.getApiKey('a')).toBeUndefined();
    expect(await store.getApiKey('b')).toBe('key-b');
  });
});
