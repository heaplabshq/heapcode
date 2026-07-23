import { mkdtemp, rm, stat } from 'node:fs/promises';
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

  it('switching the active profile requires it to exist', async () => {
    const store = new ConfigStore(join(dir, 'config.json'));
    await store.saveProfile({ name: 'a', preset: 'ollama', baseUrl: 'http://x', model: 'm' });
    await expect(store.setActiveProfile('nope')).rejects.toThrow(/No profile named "nope"/);
    await store.setActiveProfile('a');
    expect((await store.getActiveProfile())?.name).toBe('a');
  });

  it('deleting the active profile falls back to another configured profile', async () => {
    const store = new ConfigStore(join(dir, 'config.json'));
    await store.saveProfile({ name: 'a', preset: 'ollama', baseUrl: 'http://x', model: 'm' });
    await store.saveProfile({ name: 'b', preset: 'ollama', baseUrl: 'http://x', model: 'm' });
    await store.setActiveProfile('a');
    await store.deleteProfile('a');
    expect((await store.getActiveProfile())?.name).toBe('b');
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
