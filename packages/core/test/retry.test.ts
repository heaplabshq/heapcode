import { afterEach, describe, expect, it } from 'vitest';
import { OpenAICompatibleProvider } from '../src/providers/openaiCompatible.js';
import { ProviderError } from '../src/providers/errors.js';
import { startMockServer, type MockServer } from './mockServer.js';

let server: MockServer;
afterEach(async () => {
  await server?.close();
});

describe('retry with backoff', () => {
  it('retries 429 then succeeds', async () => {
    server = await startMockServer({
      kind: 'sequence',
      responses: [
        { kind: 'json', status: 429, body: {}, headers: { 'retry-after': '0' } },
        { kind: 'json', status: 429, body: {}, headers: { 'retry-after': '0' } },
        { kind: 'json', status: 200, body: { choices: [{ message: { content: 'ok' } }] } },
      ],
    });
    const provider = new OpenAICompatibleProvider({ baseUrl: server.baseUrl });
    const res = await provider.chat({ model: 'm', messages: [] });
    expect(res.content).toBe('ok');
    expect(server.requests.length).toBe(3);
  });

  it('gives up after 3 attempts and surfaces the rate-limit error', async () => {
    server = await startMockServer({
      kind: 'sequence',
      responses: [{ kind: 'json', status: 429, body: {}, headers: { 'retry-after': '0' } }],
    });
    const provider = new OpenAICompatibleProvider({ baseUrl: server.baseUrl });
    await expect(provider.chat({ model: 'm', messages: [] })).rejects.toThrowError(
      /Rate limited \(429\)/,
    );
    expect(server.requests.length).toBe(3);
  });

  it('does not retry non-retryable errors like 401', async () => {
    server = await startMockServer({
      kind: 'sequence',
      responses: [{ kind: 'json', status: 401, body: {} }],
    });
    const provider = new OpenAICompatibleProvider({ baseUrl: server.baseUrl });
    await expect(provider.chat({ model: 'm', messages: [] })).rejects.toThrowError(ProviderError);
    expect(server.requests.length).toBe(1);
  });
});
