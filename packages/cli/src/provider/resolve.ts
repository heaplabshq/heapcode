import { createProvider, resolveContextWindow, type Provider, type ProviderProfileConfig } from '@heapcode/core';
import { SecretsStore } from '../config/secrets.js';

export interface ResolvedProvider {
  provider: Provider;
  profile: ProviderProfileConfig;
  contextWindow: number;
}

export async function resolveProvider(
  profile: ProviderProfileConfig,
  secrets: SecretsStore = new SecretsStore(),
): Promise<ResolvedProvider> {
  const apiKey = await secrets.getApiKey(profile.name);
  return {
    provider: createProvider(profile, apiKey),
    profile,
    contextWindow: resolveContextWindow(profile),
  };
}
