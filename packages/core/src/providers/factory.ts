import type { ProviderProfileConfig } from '../config/profiles.js';
import { AzureOpenAIProvider } from './azure.js';
import { OpenAICompatibleProvider } from './openaiCompatible.js';
import type { Provider, ProviderConfig } from './types.js';

/** Create the right provider client for a profile. */
export function createProvider(profile: ProviderProfileConfig, apiKey?: string): Provider {
  const config: ProviderConfig = {
    baseUrl: profile.baseUrl,
    apiKey,
    headers: { ...profile.headers },
    timeoutMs: profile.timeoutMs,
  };

  switch (profile.preset) {
    case 'azure-openai':
      return new AzureOpenAIProvider(config);
    case 'openrouter':
      // OpenRouter uses these for app attribution; harmless elsewhere.
      config.headers = { 'x-title': 'Heap Code', ...config.headers };
      return new OpenAICompatibleProvider(config);
    default:
      return new OpenAICompatibleProvider(config);
  }
}
