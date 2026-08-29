// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { deleteProfile, loadApiKey, saveApiKey, saveProfile } from '../src/shared/settings.js';

/**
 * A profile's key, when the profile is renamed.
 *
 * Keys are stored under the profile's name, so a rename left the key behind
 * under the old one and the renamed profile authenticated with nothing. The
 * failure was a 401 on the next run — from a change that never mentioned keys,
 * with a write-only field that shows nothing, so there was no way to see what
 * had happened or that anything needed re-entering.
 */

function stubChrome(initial: Record<string, unknown> = {}) {
  const store: Record<string, unknown> = { ...initial };
  vi.stubGlobal('chrome', {
    storage: {
      local: {
        get: vi.fn(async (keys: string | string[]) => {
          const wanted = Array.isArray(keys) ? keys : [keys];
          return Object.fromEntries(wanted.filter((k) => k in store).map((k) => [k, store[k]]));
        }),
        set: vi.fn(async (values: Record<string, unknown>) => Object.assign(store, values)),
        remove: vi.fn(async (keys: string | string[]) => {
          for (const k of Array.isArray(keys) ? keys : [keys]) delete store[k];
        }),
      },
    },
  });
  return store;
}

const profile = (name: string) => ({
  name,
  preset: 'ollama-cloud' as const,
  baseUrl: 'https://ollama.com/v1',
  model: 'glm-5.3-flash:cloud',
});

afterEach(() => vi.unstubAllGlobals());

describe('renaming a profile', () => {
  it('takes the key with it', async () => {
    stubChrome({
      'heapbrowse.profiles': [profile('default')],
      'heapbrowse.activeProfile': 'default',
    });
    await saveApiKey('sk-secret', 'default');

    await saveProfile(profile('cloud'));

    expect(await loadApiKey('cloud')).toBe('sk-secret');
  });

  it('leaves nothing under the old name', async () => {
    const store = stubChrome({
      'heapbrowse.profiles': [profile('default')],
      'heapbrowse.activeProfile': 'default',
    });
    await saveApiKey('sk-secret', 'default');

    await saveProfile(profile('cloud'));

    expect(store['heapbrowse.apiKey.default']).toBeUndefined();
  });

  it('does nothing surprising when the profile had no key', async () => {
    const store = stubChrome({
      'heapbrowse.profiles': [profile('local')],
      'heapbrowse.activeProfile': 'local',
    });

    await saveProfile(profile('ollama'));

    expect(store['heapbrowse.apiKey.ollama']).toBeUndefined();
  });

  /** Saving without renaming must not disturb the key it already has. */
  it('keeps the key when only the model changed', async () => {
    stubChrome({
      'heapbrowse.profiles': [profile('cloud')],
      'heapbrowse.activeProfile': 'cloud',
    });
    await saveApiKey('sk-secret', 'cloud');

    await saveProfile({ ...profile('cloud'), model: 'qwen3:cloud' });

    expect(await loadApiKey('cloud')).toBe('sk-secret');
  });
});

describe('deleting a profile', () => {
  it('takes its key with it, so a later profile of the same name starts clean', async () => {
    const store = stubChrome({
      'heapbrowse.profiles': [profile('work'), profile('home')],
      'heapbrowse.activeProfile': 'work',
    });
    await saveApiKey('sk-work', 'work');

    await deleteProfile('work');

    expect(store['heapbrowse.apiKey.work']).toBeUndefined();
  });
});
