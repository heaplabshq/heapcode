import {
  createProvider,
  providerPresets,
  type ModelInfo,
  type ProviderProfileConfig,
} from '@heapcode/core';
import type { ConfigStore, SecretsStore } from '@heapcode/host';

/**
 * What an endpoint serves, asked directly rather than through the daemon.
 *
 * The daemon is the right route once there is a session: it holds the profile
 * table, the keys crossed once at hello, and a role pointing at another
 * connection resolves there. But it only comes up when there is a model to
 * run on — and the field that most needs a list of models is the one that
 * chooses that model. A dropdown that is empty until you press "Test
 * connection", and empty again after a reload, is what that gap looks like
 * from the outside.
 *
 * So these two ask the provider directly. They are the same call the
 * connection test has always made; nothing here is a second implementation of
 * how a provider is reached.
 */

/** Models a connection that exists in config serves, using its stored key. */
export async function connectionModels(
  config: ConfigStore,
  secrets: SecretsStore,
  name: string,
): Promise<ModelInfo[]> {
  const profile = await config.getProfile(name);
  if (!profile) throw new Error(`No connection named "${name}"`);
  const provider = createProvider(profile, await secrets.getApiKey(profile.name));
  return provider.listModels();
}

export interface ProbeParams {
  preset?: string;
  baseUrl?: string;
  apiKey?: string;
  /** Use the key already stored for this connection, for an edit that left the field blank. */
  useStoredKeyFor?: string;
}

export interface ProbeResult {
  ok: boolean;
  models: string[];
  error?: string;
}

/**
 * Test an endpoint that is not a saved connection yet.
 *
 * Never routed through the daemon even when one is up: the daemon resolves
 * saved profiles by name, and the whole point here is a profile that does not
 * exist yet.
 */
export async function probeConnection(secrets: SecretsStore, params: ProbeParams): Promise<ProbeResult> {
  const { preset, baseUrl, apiKey, useStoredKeyFor } = params;
  if (!baseUrl?.trim()) return { ok: false, models: [], error: 'Enter a base URL first.' };
  const known = providerPresets.find((p) => p.id === preset);
  const key = apiKey || (useStoredKeyFor ? await secrets.getApiKey(useStoredKeyFor) : undefined);
  try {
    const provider = createProvider(
      { name: 'probe', preset: (known?.id ?? 'custom') as ProviderProfileConfig['preset'], baseUrl, model: '' },
      key,
    );
    const models = await provider.listModels();
    if (models.length === 0) {
      // Reached it, but it lists nothing — a real setup (some proxies serve
      // models they refuse to enumerate), so this is not an error.
      return { ok: true, models: [], error: 'Connected, but the endpoint lists no models — type the id yourself.' };
    }
    return { ok: true, models: models.map((m) => m.id) };
  } catch (err) {
    return { ok: false, models: [], error: err instanceof Error ? err.message : String(err) };
  }
}
