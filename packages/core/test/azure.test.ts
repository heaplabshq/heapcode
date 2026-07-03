import { describe, expect, it } from 'vitest';
import { AzureOpenAIProvider } from '../src/providers/azure.js';
import type { ChatRequest } from '../src/providers/types.js';

class Probe extends AzureOpenAIProvider {
  probeChatUrl(req: ChatRequest): string {
    return this.chatUrl(req);
  }
  probeHeaders(): Record<string, string> {
    return this.headers();
  }
}

describe('AzureOpenAIProvider', () => {
  const provider = new Probe({
    baseUrl: 'https://myres.openai.azure.com',
    apiKey: 'azkey',
    apiVersion: '2024-06-01',
  });

  it('builds deployment-scoped URLs with api-version', () => {
    expect(provider.probeChatUrl({ model: 'gpt-4o-deploy', messages: [] })).toBe(
      'https://myres.openai.azure.com/openai/deployments/gpt-4o-deploy/chat/completions?api-version=2024-06-01',
    );
  });

  it('authenticates with the api-key header, not Bearer', () => {
    const headers = provider.probeHeaders();
    expect(headers['api-key']).toBe('azkey');
    expect(headers.authorization).toBeUndefined();
  });
});
