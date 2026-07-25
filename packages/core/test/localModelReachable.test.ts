import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assertPublicUrl } from '../src/net/safeFetch.js';
import { createProvider } from '../src/providers/factory.js';

/**
 * The SSRF guard must never reach the provider path.
 *
 * Running the model on a LAN box or on localhost (Ollama, LM Studio, vLLM) is
 * a first-class supported setup — arguably *the* setup this project is for —
 * and every one of those endpoints is on exactly the private/loopback
 * addresses fetch_url now refuses. The two are deliberately different trust
 * domains: the model endpoint is configured by the user, while a fetch_url
 * target can be chosen by injected text in a fetched page or MCP result.
 *
 * This test pins that distinction, so a later "let's apply the guard
 * everywhere for consistency" refactor fails loudly here instead of silently
 * cutting every local-model user off from their model.
 */
describe('a model hosted on a private address', () => {
  let server: Server;
  let baseUrl = '';

  beforeAll(async () => {
    server = createServer((_req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'hello from the LAN box' } }] }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
  });

  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it('is still reachable by the provider — the guard does not apply to model traffic', async () => {
    const provider = createProvider({ name: 'local', preset: 'openai', baseUrl, model: 'llama3.1' });
    const res = await provider.chat({ model: 'llama3.1', messages: [{ role: 'user', content: 'hi' }] });
    expect(res.content).toBe('hello from the LAN box');
  });

  it('is still refused by fetch_url, which untrusted content can aim', async () => {
    await expect(assertPublicUrl(baseUrl)).rejects.toThrow(/private, loopback, or link-local/);
  });
});
