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

/**
 * Routers answer 200-with-an-error-body for upstream failures instead of a
 * failing status, and bury the upstream provider's real message in
 * metadata.raw. Both were losing information: an unactionable "Provider
 * returned error", or (on 200) a silent empty reply the agent read as a real
 * turn. Shapes below are verbatim from live OpenRouter responses.
 */
describe('gateway error bodies', () => {
  const upstreamError = {
    error: {
      message: 'Provider returned error',
      code: 400,
      metadata: {
        raw: '{"error":{"message":"missing field `tool_call_id`","type":"Bad Request","code":400}}',
        provider_name: 'Nvidia',
      },
    },
  };

  it('surfaces the upstream provider message hidden in metadata.raw on a 4xx', async () => {
    server = await startMockServer({ kind: 'json', status: 400, body: upstreamError });
    const provider = new OpenAICompatibleProvider({ baseUrl: server.baseUrl });
    await expect(provider.chat({ model: 'm', messages: [] })).rejects.toThrow(
      /Provider returned error \(Nvidia: missing field `tool_call_id`\)/,
    );
  });

  /**
   * The shape a listed-but-dead model produces, captured live from
   * OpenRouter for `nvidia/nemotron-3-ultra-550b-a55b:free`: a 404 whose only
   * useful content is the provider name, with `raw` empty. The base URL and
   * model slug both resolved — the generic 404 copy sends users to check the
   * two things that are provably fine.
   */
  const deadUpstream = {
    error: {
      message: 'Provider returned error',
      code: 404,
      metadata: { raw: '', provider_name: 'Nvidia', is_byok: false },
    },
  };

  it('attributes the upstream provider on a 404 even when metadata.raw is empty', async () => {
    server = await startMockServer({ kind: 'json', status: 404, body: deadUpstream });
    const provider = new OpenAICompatibleProvider({ baseUrl: server.baseUrl });
    await expect(provider.chat({ model: 'm', messages: [] })).rejects.toThrow(
      /Provider returned error \(Nvidia\)/,
    );
  });

  it('blames the upstream, not the base URL, when a 404 names a provider', async () => {
    server = await startMockServer({ kind: 'json', status: 404, body: deadUpstream });
    const provider = new OpenAICompatibleProvider({ baseUrl: server.baseUrl });
    const err = await provider.chat({ model: 'm', messages: [] }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).message).toMatch(/Model unavailable upstream \(404\)/);
    expect((err as ProviderError).message).not.toMatch(/Check the base URL/);
  });

  it('still points at the base URL on a 404 with no upstream attribution', async () => {
    server = await startMockServer({
      kind: 'json',
      status: 404,
      body: { error: { message: 'Not Found' } },
    });
    const provider = new OpenAICompatibleProvider({ baseUrl: server.baseUrl });
    await expect(provider.chat({ model: 'm', messages: [] })).rejects.toThrow(
      /Endpoint or model not found \(404\)\. Check the base URL and model name\./,
    );
  });

  /**
   * Reported live as "Agent error: Upstream idle timeout exceeded" — the whole
   * turn lost. OpenRouter kills a stream whose upstream has gone quiet and
   * reports it in the body with no status code, so isRetryableBodyError had
   * nothing to match and gave up on the first attempt.
   */
  it('retries a bare "Upstream idle timeout exceeded" body error that carries no code', async () => {
    server = await startMockServer({
      kind: 'sequence',
      responses: [
        { kind: 'json', status: 200, body: { error: { message: 'Upstream idle timeout exceeded' }, choices: [] } },
        { kind: 'json', status: 200, body: { choices: [{ message: { content: 'answer' } }] } },
      ],
    });
    const provider = new OpenAICompatibleProvider({ baseUrl: server.baseUrl });
    const res = await provider.chat({ model: 'm', messages: [] });
    expect(res.content).toBe('answer');
  });

  it('does not retry a durable error just because it says "exceeded"', async () => {
    server = await startMockServer({
      kind: 'json',
      status: 200,
      body: { error: { message: "This model's maximum context length is 8192 tokens; exceeded." }, choices: [] },
    });
    const provider = new OpenAICompatibleProvider({ baseUrl: server.baseUrl });
    await expect(provider.chat({ model: 'm', messages: [] })).rejects.toThrow(/maximum context length/);
    expect(server.requests).toHaveLength(1);
  });

  it('retries a Cloudflare 524, which fronts several hosted gateways', async () => {
    server = await startMockServer({
      kind: 'sequence',
      responses: [
        { kind: 'json', status: 524, body: { error: { message: 'A timeout occurred' } } },
        { kind: 'json', status: 200, body: { choices: [{ message: { content: 'answer' } }] } },
      ],
    });
    const provider = new OpenAICompatibleProvider({ baseUrl: server.baseUrl });
    await expect(provider.chat({ model: 'm', messages: [] })).resolves.toMatchObject({ content: 'answer' });
  });

  /**
   * The shape that actually loses a turn on a reasoning model: the stream
   * emits thinking tokens, the upstream then goes quiet, and the gateway kills
   * it. Reasoning is display-only — it never accumulates into `content` — so
   * replaying cannot duplicate the answer, and refusing to retry here just
   * threw away a long think for nothing.
   */
  it('retries a stream that stalled after emitting only reasoning tokens', async () => {
    server = await startMockServer({
      kind: 'sequence',
      responses: [
        {
          kind: 'sse-raw',
          events: [
            JSON.stringify({ choices: [{ delta: { reasoning: 'Let me think about ' } }] }),
            JSON.stringify({ choices: [{ delta: { reasoning: 'the approach…' } }] }),
            JSON.stringify({ error: { message: 'Upstream idle timeout exceeded' }, choices: [] }),
          ],
        },
        { kind: 'sse-raw', events: [JSON.stringify({ choices: [{ delta: { content: 'answer' }, finish_reason: 'stop' }] })] },
      ],
    });
    const provider = new OpenAICompatibleProvider({ baseUrl: server.baseUrl });
    const byKind: Record<string, string> = { text: '', reasoning: '', tool: '' };
    const res = await provider.chatStreamed({ model: 'm', messages: [] }, (t, kind = 'text') => (byKind[kind] += t));

    expect(res.content).toBe('answer');
    // The retry replays the thinking, which is cosmetic; the answer is intact.
    expect(byKind.text).toBe('answer');
  });

  it('still refuses to retry once real answer text has gone out', async () => {
    server = await startMockServer({
      kind: 'sequence',
      responses: [
        {
          kind: 'sse-raw',
          events: [
            JSON.stringify({ choices: [{ delta: { content: 'Half an ans' } }] }),
            JSON.stringify({ error: { message: 'Upstream idle timeout exceeded' }, choices: [] }),
          ],
        },
        { kind: 'sse-raw', events: [JSON.stringify({ choices: [{ delta: { content: 'answer' } }] })] },
      ],
    });
    const provider = new OpenAICompatibleProvider({ baseUrl: server.baseUrl });
    // Replaying would emit "Half an ans" twice, or duplicate the answer.
    await expect(provider.chatStreamed({ model: 'm', messages: [] }, () => {})).rejects.toThrow(/idle timeout/i);
    expect(server.requests).toHaveLength(1);
  });

  it('still refuses to retry once tool-call arguments have gone out', async () => {
    server = await startMockServer({
      kind: 'sequence',
      responses: [
        {
          kind: 'sse-raw',
          events: [
            JSON.stringify({
              choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'read_file', arguments: '{"pa' } }] } }],
            }),
            JSON.stringify({ error: { message: 'Upstream idle timeout exceeded' }, choices: [] }),
          ],
        },
        { kind: 'sse-raw', events: [JSON.stringify({ choices: [{ delta: { content: 'x' } }] })] },
      ],
    });
    const provider = new OpenAICompatibleProvider({ baseUrl: server.baseUrl });
    await expect(provider.chatStreamed({ model: 'm', messages: [] }, () => {})).rejects.toThrow(/idle timeout/i);
    expect(server.requests).toHaveLength(1);
  });

  it('fails loudly on a 200 whose body carries an error instead of a reply', async () => {
    server = await startMockServer({
      kind: 'json',
      status: 200,
      body: {
        error: { message: 'Upstream error from Nvidia: ResourceExhausted', code: 502 },
        choices: [],
      },
    });
    const provider = new OpenAICompatibleProvider({ baseUrl: server.baseUrl });
    await expect(provider.chat({ model: 'm', messages: [] })).rejects.toThrow(/ResourceExhausted/);
  });

  it('retries a body error that stands in for a retryable status, then succeeds', async () => {
    server = await startMockServer({
      kind: 'sequence',
      responses: [
        {
          kind: 'json',
          status: 200,
          body: { error: { message: 'Upstream error: ResourceExhausted', code: 502 }, choices: [] },
        },
        { kind: 'json', status: 200, body: { choices: [{ message: { content: 'answer' } }] } },
      ],
    });
    const provider = new OpenAICompatibleProvider({ baseUrl: server.baseUrl });
    const res = await provider.chat({ model: 'm', messages: [] });
    expect(res.content).toBe('answer');
    expect(server.requests.length).toBe(2);
  });

  it('does not retry a body error whose code is not retryable', async () => {
    server = await startMockServer({ kind: 'json', status: 200, body: upstreamError });
    const provider = new OpenAICompatibleProvider({ baseUrl: server.baseUrl });
    await expect(provider.chat({ model: 'm', messages: [] })).rejects.toThrow(/tool_call_id/);
    expect(server.requests.length).toBe(1);
  });

  it('gives up after 3 attempts, not 3 × fetchOrThrow\'s own 3', async () => {
    server = await startMockServer({
      kind: 'sequence',
      responses: [
        {
          kind: 'json',
          status: 200,
          body: { error: { message: 'Upstream error: ResourceExhausted', code: 502 }, choices: [] },
        },
      ],
    });
    const provider = new OpenAICompatibleProvider({ baseUrl: server.baseUrl });
    await expect(provider.chat({ model: 'm', messages: [] })).rejects.toThrow(/ResourceExhausted/);
    expect(server.requests.length).toBe(3);
  });

  it('does not replay a stream that already emitted tokens before the error chunk', async () => {
    server = await startMockServer({
      kind: 'sse-raw',
      events: [
        JSON.stringify({ choices: [{ delta: { content: 'partial' } }] }),
        JSON.stringify({
          choices: [],
          error: { message: 'Upstream error: ResourceExhausted', code: 502 },
        }),
      ],
    });
    const provider = new OpenAICompatibleProvider({ baseUrl: server.baseUrl });
    await expect(provider.chatStreamed({ model: 'm', messages: [] })).rejects.toThrow(
      /ResourceExhausted/,
    );
    // Retrying would have re-emitted "partial" on top of what the caller saw.
    expect(server.requests.length).toBe(1);
  });

  it('fails loudly on an error chunk delivered mid-stream', async () => {
    server = await startMockServer({
      kind: 'sse-raw',
      events: [
        JSON.stringify({ choices: [{ delta: { content: 'partial' } }] }),
        JSON.stringify({
          choices: [],
          error: { message: 'Upstream error from Nvidia: ResourceExhausted', code: 502 },
        }),
      ],
    });
    const provider = new OpenAICompatibleProvider({ baseUrl: server.baseUrl });
    await expect(
      provider.chatStreamed({ model: 'm', messages: [] }),
    ).rejects.toThrow(/ResourceExhausted/);
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

describe('vision message serialization', () => {
  it('sends images as image_url content parts next to the text', async () => {
    server = await startMockServer({
      kind: 'json',
      status: 200,
      body: { choices: [{ message: { content: 'a cat' }, finish_reason: 'stop' }] },
    });
    const provider = new OpenAICompatibleProvider({ baseUrl: server.baseUrl });
    await provider.chat({
      model: 'm',
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'what is this?', images: ['data:image/png;base64,AAA'] },
      ],
    });
    const body = server.requests[0]!.body as { messages: Array<{ content: unknown }> };
    // Plain messages keep string content; only image turns become part arrays.
    expect(body.messages[0]!.content).toBe('sys');
    expect(body.messages[1]!.content).toEqual([
      { type: 'text', text: 'what is this?' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } },
    ]);
  });

  it('reports the context length from /models when present', async () => {
    server = await startMockServer({
      kind: 'json',
      status: 200,
      body: { data: [{ id: 'glm', context_length: 131072 }, { id: 'small' }] },
    });
    const provider = new OpenAICompatibleProvider({ baseUrl: server.baseUrl });
    const models = await provider.listModels();
    expect(models).toEqual([{ id: 'glm', contextLength: 131072 }, { id: 'small' }]);
  });
});

/**
 * Reported as "5 models across LM Studio and Ollama all die with a 400 after
 * the planning stage — Heap Code is broken". The request shape was fine; the
 * servers were started with a ~4096-token context while heapcode assumed
 * 32768, so turn one fit and turn two (with a tool result appended) did not.
 * A bare "Request failed with status 400" pointed at nothing.
 */
describe('a local server whose context window is smaller than heapcode assumes', () => {
  const BODIES: Array<[string, string]> = [
    ['llama.cpp / LM Studio', 'the request exceeds the available context size. try increasing the context size'],
    ['LM Studio (keep-tokens phrasing)', 'The number of tokens to keep from the initial prompt is greater than the context length'],
    ['Ollama', 'input length exceeds context length (num_ctx)'],
    ['OpenAI-compatible', "This model's maximum context length is 4096 tokens"],
  ];

  for (const [name, message] of BODIES) {
    it(`explains how to fix it, for the ${name} phrasing`, async () => {
      server = await startMockServer({ kind: 'json', status: 400, body: { error: { message } } });
      const provider = new OpenAICompatibleProvider({ baseUrl: server.baseUrl });
      const err = await provider.chat({ model: 'm', messages: [] }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ProviderError);
      const text = (err as ProviderError).message;
      expect(text).toMatch(/context window this endpoint was started with/);
      // The two things that actually fix it, named explicitly.
      expect(text).toMatch(/num_ctx|Context Length/);
      expect(text).toMatch(/contextWindow/);
      // The server's own words are still there for anyone diagnosing further.
      expect(text).toContain(message);
    });
  }

  it('leaves an unrelated 400 alone', async () => {
    server = await startMockServer({
      kind: 'json',
      status: 400,
      body: { error: { message: 'missing field `tool_call_id`' } },
    });
    const provider = new OpenAICompatibleProvider({ baseUrl: server.baseUrl });
    await expect(provider.chat({ model: 'm', messages: [] })).rejects.toThrow(
      /Request failed with status 400.*tool_call_id/,
    );
  });

  it('does not retry it — a bigger prompt will not fit on the second try either', async () => {
    server = await startMockServer({
      kind: 'json',
      status: 400,
      body: { error: { message: 'the request exceeds the available context size' } },
    });
    const provider = new OpenAICompatibleProvider({ baseUrl: server.baseUrl });
    await expect(provider.chat({ model: 'm', messages: [] })).rejects.toThrow();
    expect(server.requests).toHaveLength(1);
  });
});

/**
 * Usage reporting exists so a caller can answer "did delegating this to a
 * cheaper model actually save anything?" — which means the numbers have to be
 * the endpoint's own, and "not reported" has to stay distinguishable from zero.
 */
describe('OpenAICompatibleProvider — token usage', () => {
  it('asks for usage on a streamed call, and reads it off the final chunk', async () => {
    server = await startMockServer({
      kind: 'sse',
      chunks: ['done'],
      usage: { prompt_tokens: 1_200, completion_tokens: 80, total_tokens: 1_280 },
    });
    const provider = new OpenAICompatibleProvider({ baseUrl: server.baseUrl });

    const res = await provider.chatStreamed({ model: 'm', messages: [{ role: 'user', content: 'hi' }] });

    expect(res.usage).toEqual({ promptTokens: 1_200, completionTokens: 80, totalTokens: 1_280 });
    expect(server.requests[0]!.body).toMatchObject({ stream_options: { include_usage: true } });
  });

  it('never asks for it on a non-streamed call, but reads it when the body carries one', async () => {
    server = await startMockServer({
      kind: 'json',
      status: 200,
      body: { choices: [{ message: { content: 'hi' } }], usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 } },
    });
    const provider = new OpenAICompatibleProvider({ baseUrl: server.baseUrl });

    const res = await provider.chat({ model: 'm', messages: [] });

    expect(res.usage).toEqual({ promptTokens: 10, completionTokens: 4, totalTokens: 14 });
    expect(server.requests[0]!.body).not.toHaveProperty('stream_options');
  });

  it('adds up the halves when a server reports them without the sum', async () => {
    server = await startMockServer({ kind: 'sse', chunks: ['x'], usage: { prompt_tokens: 30, completion_tokens: 12 } });
    const provider = new OpenAICompatibleProvider({ baseUrl: server.baseUrl });

    expect((await provider.chatStreamed({ model: 'm', messages: [] })).usage).toEqual({
      promptTokens: 30,
      completionTokens: 12,
      totalTokens: 42,
    });
  });

  it('reports nothing at all — rather than zeros — when the endpoint sends no usage block', async () => {
    server = await startMockServer({ kind: 'sse', chunks: ['x'] });
    const provider = new OpenAICompatibleProvider({ baseUrl: server.baseUrl });

    expect((await provider.chatStreamed({ model: 'm', messages: [] })).usage).toBeUndefined();
  });

  it('drops stream_options and repeats the turn when an endpoint rejects it, then stops asking', async () => {
    // A strict server 400s the unknown field; the turn must survive that,
    // because a refused agent run is a far worse outcome than a missing count.
    server = await startMockServer({
      kind: 'sequence',
      responses: [
        { kind: 'json', status: 400, body: { error: { message: 'unrecognized request argument: stream_options' } } },
        { kind: 'sse', chunks: ['recovered'] },
        { kind: 'sse', chunks: ['second turn'] },
      ],
    });
    const provider = new OpenAICompatibleProvider({ baseUrl: server.baseUrl });

    expect((await provider.chatStreamed({ model: 'm', messages: [] })).content).toBe('recovered');
    expect(server.requests[0]!.body).toMatchObject({ stream_options: { include_usage: true } });
    expect(server.requests[1]!.body).not.toHaveProperty('stream_options');

    // The endpoint said no once; asking again every turn would burn a request each time.
    expect((await provider.chatStreamed({ model: 'm', messages: [] })).content).toBe('second turn');
    expect(server.requests[2]!.body).not.toHaveProperty('stream_options');
  });
});
