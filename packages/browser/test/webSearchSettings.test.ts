// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  loadWebSearchApiKey,
  loadWebSearchConfig,
  saveWebSearchApiKey,
  saveWebSearchConfig,
} from '../src/shared/settings.js';
import { isWebSearchEnabled, type WebSearchConfig } from '@heapcode/core/agent';

/**
 * Web search storage round-trips.
 *
 * The config and its key are what `run.ts` gates the tool on, so a save that
 * quietly fails to round-trip reads as "I configured it and the agent still
 * says searching is unavailable" — an on-switch that does not switch on. The
 * key slot is separate from the config for the same reason the provider key
 * is: the config is read back into forms, the key never is.
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

afterEach(() => vi.unstubAllGlobals());

describe('web search config', () => {
  it('round-trips a provider that needs no key, and that enables the tool', async () => {
    const store = stubChrome();
    const config: WebSearchConfig = { provider: 'duckduckgo' };

    await saveWebSearchConfig(config);

    expect(store['heapbrowse.webSearch']).toEqual(config);
    expect(await loadWebSearchConfig()).toEqual(config);
    // A saved no-key preset is the whole difference between a run that can
    // search and one told the tool does not exist.
    expect(isWebSearchEnabled(await loadWebSearchConfig(), await loadWebSearchApiKey())).toBe(true);
  });

  it('round-trips a key-requiring provider only once the key is saved too', async () => {
    stubChrome();
    await saveWebSearchConfig({ provider: 'brave' });

    // The preset says a key is required, so config-without-key must not
    // advertise a search that would 401 on its first call.
    expect(isWebSearchEnabled(await loadWebSearchConfig(), await loadWebSearchApiKey())).toBe(
      false,
    );

    await saveWebSearchApiKey('bsa-test-key');
    expect(isWebSearchEnabled(await loadWebSearchConfig(), await loadWebSearchApiKey())).toBe(true);
    expect(await loadWebSearchApiKey()).toBe('bsa-test-key');
  });

  it('treats an empty saved key as no key, so switching back to a keyless provider works', async () => {
    stubChrome();
    await saveWebSearchApiKey('bsa-test-key');
    await saveWebSearchConfig({ provider: 'brave' });

    // Saving an empty field is how the settings card says "no key".
    await saveWebSearchApiKey('');

    expect(await loadWebSearchApiKey()).toBeUndefined();
    await saveWebSearchConfig({ provider: 'duckduckgo' });
    expect(isWebSearchEnabled(await loadWebSearchConfig(), await loadWebSearchApiKey())).toBe(true);
  });

  it('reports nothing configured when storage is empty', async () => {
    stubChrome();
    expect(await loadWebSearchConfig()).toBeUndefined();
    expect(await loadWebSearchApiKey()).toBeUndefined();
    expect(isWebSearchEnabled(await loadWebSearchConfig(), await loadWebSearchApiKey())).toBe(
      false,
    );
  });
});