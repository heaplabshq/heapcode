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

describe('OpenAICompatibleProvider.chatStreamed', () => {
  it('aggregates streamed content and split tool-call deltas', async () => {
    server = await startMockServer({
      kind: 'sse-raw',
      events: [
        JSON.stringify({ choices: [{ delta: { content: 'Let me ' } }] }),
        JSON.stringify({ choices: [{ delta: { content: 'read it.' } }] }),
        JSON.stringify({
          choices: [
            { delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'read_file', arguments: '{"pa' } }] } },
          ],
        }),
        JSON.stringify({
          choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'th": "a.ts"}' } }] } }],
        }),
        JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
      ],
    });
    const provider = new OpenAICompatibleProvider({ baseUrl: server.baseUrl });
    const deltas: string[] = [];
    const res = await provider.chatStreamed(
      { model: 'm', messages: [{ role: 'user', content: 'q' }] },
      (t, kind = 'text') => {
        if (kind === 'text') deltas.push(t);
      },
    );

    expect(res.content).toBe('Let me read it.');
    expect(deltas.join('')).toBe('Let me read it.');
    expect(res.toolCalls).toEqual([
      { id: 'c1', name: 'read_file', args: { path: 'a.ts' }, argsParseError: undefined },
    ]);
    expect(res.finishReason).toBe('tool_calls');
    expect((server.requests[0]!.body as { stream: boolean }).stream).toBe(true);
  });

  it('routes reasoning_content and tool-argument deltas to their channels', async () => {
    server = await startMockServer({
      kind: 'sse-raw',
      events: [
        JSON.stringify({ choices: [{ delta: { reasoning_content: 'Hmm, the file is ' } }] }),
        JSON.stringify({ choices: [{ delta: { reasoning_content: 'empty…' } }] }),
        JSON.stringify({ choices: [{ delta: { content: 'Creating it now.' } }] }),
        JSON.stringify({
          choices: [
            { delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'write_file', arguments: '{"path":' } }] } },
          ],
        }),
        JSON.stringify({
          choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"a.html","content":"x"}' } }] } }],
        }),
      ],
    });
    const provider = new OpenAICompatibleProvider({ baseUrl: server.baseUrl });
    const byKind: Record<string, string> = { text: '', reasoning: '', tool: '' };
    const res = await provider.chatStreamed(
      { model: 'm', messages: [] },
      (t, kind = 'text') => (byKind[kind] += t),
    );

    expect(byKind.reasoning).toBe('Hmm, the file is empty…');
    expect(byKind.text).toBe('Creating it now.');
    expect(byKind.tool).toBe('{"path":"a.html","content":"x"}');
    // Reasoning never leaks into the answer content.
    expect(res.content).toBe('Creating it now.');
    expect(res.toolCalls![0]!.args).toEqual({ path: 'a.html', content: 'x' });
  });

  it('fails fast when the endpoint never sends headers', async () => {
    server = await startMockServer({ kind: 'hang' });
    const provider = new OpenAICompatibleProvider({ baseUrl: server.baseUrl, timeoutMs: 300 });
    await expect(provider.chatStreamed({ model: 'm', messages: [] })).rejects.toThrowError(
      /No response from/,
    );
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
