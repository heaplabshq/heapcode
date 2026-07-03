import { afterEach, describe, expect, it } from 'vitest';
import { OpenAICompatibleProvider } from '../src/providers/openaiCompatible.js';
import { ProviderError, isAbortError } from '../src/providers/errors.js';
import { startMockServer, type MockServer } from './mockServer.js';

let server: MockServer;
afterEach(async () => {
  await server?.close();
});

describe('OpenAICompatibleProvider.streamChat', () => {
  it('streams content chunks and stops at [DONE]', async () => {
    server = await startMockServer({ kind: 'sse', chunks: ['Hel', 'lo ', 'world'] });
    const provider = new OpenAICompatibleProvider({ baseUrl: server.baseUrl, apiKey: 'test-key' });

    let out = '';
    for await (const chunk of provider.streamChat({
      model: 'test-model',
      messages: [{ role: 'user', content: 'hi' }],
    })) {
      out += chunk.content;
    }

    expect(out).toBe('Hello world');
    const req = server.requests[0]!;
    expect(req.path).toBe('/v1/chat/completions');
    expect(req.headers.authorization).toBe('Bearer test-key');
    expect(req.body).toMatchObject({ model: 'test-model', stream: true });
  });

  it('ends cleanly when the stream closes without [DONE] (lax servers)', async () => {
    server = await startMockServer({ kind: 'sse', chunks: ['ok'], omitDone: true });
    const provider = new OpenAICompatibleProvider({ baseUrl: server.baseUrl });

    let out = '';
    for await (const chunk of provider.streamChat({ model: 'm', messages: [] })) {
      out += chunk.content;
    }
    expect(out).toBe('ok');
  });

  it('surfaces a readable auth error on 401', async () => {
    server = await startMockServer({
      kind: 'json',
      status: 401,
      body: { error: { message: 'bad key' } },
    });
    const provider = new OpenAICompatibleProvider({ baseUrl: server.baseUrl, apiKey: 'wrong' });

    const run = async () => {
      for await (const _ of provider.streamChat({ model: 'm', messages: [] })) {
        // no-op
      }
    };
    await expect(run).rejects.toThrowError(ProviderError);
    await expect(run).rejects.toThrowError(/Authentication failed \(401\).*bad key/);
  });

  it('surfaces the network cause when the server is unreachable', async () => {
    // Grab an ephemeral port and free it again → connecting yields ECONNREFUSED.
    const closed = await startMockServer({ kind: 'sse', chunks: [] });
    await closed.close();
    const provider = new OpenAICompatibleProvider({ baseUrl: closed.baseUrl });

    const run = async () => {
      for await (const _ of provider.streamChat({ model: 'm', messages: [] })) {
        // no-op
      }
    };
    await expect(run).rejects.toThrowError(ProviderError);
    await expect(run).rejects.toThrowError(/Cannot reach http:\/\/127\.0\.0\.1:\d+\/v1 \(ECONNREFUSED\)/);
  });

  it('cancels an in-flight stream via AbortSignal', async () => {
    server = await startMockServer({ kind: 'hang-after-first-chunk', firstChunk: 'partial' });
    const provider = new OpenAICompatibleProvider({ baseUrl: server.baseUrl });
    const controller = new AbortController();

    let out = '';
    let caught: unknown;
    try {
      for await (const chunk of provider.streamChat({
        model: 'm',
        messages: [],
        signal: controller.signal,
      })) {
        out += chunk.content;
        controller.abort(); // cancel as soon as the first chunk arrives
      }
    } catch (err) {
      caught = err;
    }

    expect(out).toBe('partial');
    expect(isAbortError(caught)).toBe(true);
  });
});

describe('OpenAICompatibleProvider.chat', () => {
  it('returns the full message content', async () => {
    server = await startMockServer({
      kind: 'json',
      status: 200,
      body: { choices: [{ message: { content: 'answer' }, finish_reason: 'stop' }] },
    });
    const provider = new OpenAICompatibleProvider({ baseUrl: server.baseUrl });
    const res = await provider.chat({ model: 'm', messages: [{ role: 'user', content: 'q' }] });
    expect(res).toEqual({ content: 'answer', finishReason: 'stop' });
  });
});

describe('OpenAICompatibleProvider.listModels', () => {
  it('lists model ids', async () => {
    server = await startMockServer({
      kind: 'json',
      status: 200,
      body: { data: [{ id: 'llama3.2' }, { id: 'qwen2.5-coder' }] },
    });
    const provider = new OpenAICompatibleProvider({ baseUrl: server.baseUrl });
    const models = await provider.listModels();
    expect(models.map((m) => m.id)).toEqual(['llama3.2', 'qwen2.5-coder']);
  });
});
