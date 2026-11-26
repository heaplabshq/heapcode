import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { AnthropicProvider, normalizeBaseUrl, toAnthropicMessages } from '../src/providers/anthropic.js';
import { AzureOpenAIProvider } from '../src/providers/azure.js';
import { isContextOverflow, isAbortError, ProviderError } from '../src/providers/errors.js';
import { createProvider } from '../src/providers/factory.js';
import { OpenAICompatibleProvider } from '../src/providers/openaiCompatible.js';
import { getPreset, providerPresets } from '../src/providers/presets.js';
import type { ChatMessage } from '../src/providers/types.js';

// ---------------------------------------------------------------------------
// A local server speaking the Messages API's wire format, so the real SDK
// (HTTP, headers, SSE parsing) runs end to end.

interface Recorded {
  method: string;
  path: string;
  headers: IncomingHttpHeaders;
  body: Record<string, unknown>;
}

type Reply =
  | { kind: 'sse'; events: Array<Record<string, unknown>>; hangAfter?: boolean }
  | { kind: 'json'; status: number; body: unknown };

let server: Server | undefined;
afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
});

async function serve(...replies: Reply[]): Promise<{ baseUrl: string; requests: Recorded[] }> {
  const requests: Recorded[] = [];
  let n = 0;
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c: Buffer) => (raw += c.toString()));
    req.on('end', () => {
      requests.push({
        method: req.method ?? '',
        path: req.url ?? '',
        headers: req.headers,
        body: raw ? (JSON.parse(raw) as Record<string, unknown>) : {},
      });
      const reply = replies[Math.min(n++, replies.length - 1)]!;
      if (reply.kind === 'json') {
        res.writeHead(reply.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(reply.body));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const e of reply.events) res.write(`event: ${String(e.type)}\ndata: ${JSON.stringify(e)}\n\n`);
      if (!reply.hangAfter) res.end();
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { baseUrl: `http://127.0.0.1:${port}`, requests };
}

function message(events: Array<Record<string, unknown>>, stop = 'end_turn', usage = { output_tokens: 7 }) {
  return [
    {
      type: 'message_start',
      message: {
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        model: 'claude-opus-5-5',
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 1, cache_creation_input_tokens: 5, cache_read_input_tokens: 85 },
      },
    },
    ...events,
    { type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null }, usage },
    { type: 'message_stop' },
  ];
}

const text = (index: number, ...parts: string[]) => [
  { type: 'content_block_start', index, content_block: { type: 'text', text: '' } },
  ...parts.map((t) => ({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: t } })),
  { type: 'content_block_stop', index },
];

const thinking = (index: number, t: string) => [
  { type: 'content_block_start', index, content_block: { type: 'thinking', thinking: '', signature: '' } },
  { type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking: t } },
  { type: 'content_block_delta', index, delta: { type: 'signature_delta', signature: 'sig' } },
  { type: 'content_block_stop', index },
];

const toolUse = (index: number, id: string, name: string, ...json: string[]) => [
  { type: 'content_block_start', index, content_block: { type: 'tool_use', id, name, input: {} } },
  ...json.map((p) => ({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: p } })),
  { type: 'content_block_stop', index },
];

const provider = (baseUrl: string) => new AnthropicProvider({ baseUrl, apiKey: 'sk-ant-test', timeoutMs: 5_000 });

// ---------------------------------------------------------------------------

describe('existing providers are untouched', () => {
  it('createProvider still routes every other preset to the same classes', () => {
    for (const preset of providerPresets) {
      const p = createProvider({ name: preset.id, preset: preset.id, baseUrl: preset.defaultBaseUrl, model: 'm' });
      if (preset.id === 'anthropic') expect(p).toBeInstanceOf(AnthropicProvider);
      else if (preset.id === 'azure-openai') expect(p).toBeInstanceOf(AzureOpenAIProvider);
      else {
        expect(p).toBeInstanceOf(OpenAICompatibleProvider);
        expect(p).not.toBeInstanceOf(AnthropicProvider);
      }
    }
  });

  it('offers an Anthropic preset with no embeddings and an API-key link', () => {
    const preset = getPreset('anthropic');
    expect(preset.id).toBe('anthropic');
    expect(preset.requiresApiKey).toBe(true);
    expect(preset.capabilities).toMatchObject({ nativeToolCalls: true, embeddings: false, vision: true, fim: false });
    expect(preset.apiKeyUrl).toMatch(/^https:\/\//);
  });
});

describe('toAnthropicMessages', () => {
  it('lifts system messages and groups every tool result into one user turn', () => {
    const history: ChatMessage[] = [
      { role: 'system', content: 'Be brief.' },
      { role: 'user', content: 'Read two files' },
      {
        role: 'assistant',
        content: 'Reading.',
        toolCalls: [
          { id: 'call_a', name: 'read_file', args: { path: 'a' } },
          { id: 'call_b', name: 'read_file', args: { path: 'b' } },
        ],
      },
      { role: 'tool', toolCallId: 'call_a', content: 'A' },
      { role: 'tool', toolCallId: 'call_b', content: 'B' },
    ];
    const { system, messages } = toAnthropicMessages(history);
    expect(system).toBe('Be brief.');
    expect(messages).toHaveLength(3);
    expect(messages[1]).toEqual({
      role: 'assistant',
      content: [
        { type: 'text', text: 'Reading.' },
        { type: 'tool_use', id: 'call_a', name: 'read_file', input: { path: 'a' } },
        { type: 'tool_use', id: 'call_b', name: 'read_file', input: { path: 'b' } },
      ],
    });
    expect(messages[2]).toEqual({
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'call_a', content: 'A' },
        { type: 'tool_result', tool_use_id: 'call_b', content: 'B' },
      ],
    });
  });

  it('answers a tool call that has no recorded result, and keeps an orphaned result as text', () => {
    const { messages } = toAnthropicMessages([
      { role: 'user', content: 'go' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'x', name: 'run', args: {} }] },
      { role: 'user', content: 'never mind' },
      { role: 'tool', toolCallId: 'gone', content: 'stale output' },
    ]);
    const last = messages[2]!;
    expect(last.role).toBe('user');
    const blocks = last.content as Array<{ type: string; tool_use_id?: string; is_error?: boolean; text?: string }>;
    expect(blocks[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'x', is_error: true });
    expect(blocks.some((b) => b.type === 'tool_result' && b.tool_use_id === 'gone')).toBe(false);
    expect(blocks.some((b) => b.type === 'text' && b.text?.includes('stale output'))).toBe(true);
  });

  it('starts and ends on a user turn and drops empty text', () => {
    const { messages } = toAnthropicMessages([
      { role: 'assistant', content: 'plan' },
      { role: 'user', content: '   ' },
      { role: 'assistant', content: 'more' },
    ]);
    expect(messages[0]!.role).toBe('user');
    expect(messages[messages.length - 1]!.role).toBe('user');
    expect(JSON.stringify(messages)).not.toContain('"text":"   "');
  });

  it('sanitizes tool ids from other providers consistently on both sides', () => {
    const { messages } = toAnthropicMessages([
      { role: 'user', content: 'go' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'fc.1:abc', name: 'run', args: {} }] },
      { role: 'tool', toolCallId: 'fc.1:abc', content: 'ok' },
    ]);
    expect(JSON.stringify(messages[1])).toContain('"id":"fc_1_abc"');
    expect(JSON.stringify(messages[2])).toContain('"tool_use_id":"fc_1_abc"');
  });

  it('turns data-URL images into base64 image blocks ahead of the text', () => {
    const { messages } = toAnthropicMessages([
      { role: 'user', content: 'what is this', images: ['data:image/jpg;base64,AAAA', 'data:image/tiff;base64,BBBB'] },
    ]);
    expect(messages[0]!.content).toEqual([
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'AAAA' } },
      { type: 'text', text: 'what is this' },
    ]);
  });
});

describe('AnthropicProvider requests', () => {
  it('sends a native Messages request: key header, no sampling params, caching, eager tool streaming', async () => {
    const { baseUrl, requests } = await serve({ kind: 'sse', events: message(text(0, 'ok')) });
    await provider(baseUrl + '/v1/').chat({
      model: 'claude-opus-4-8',
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'hi' },
      ],
      tools: [{ name: 'read_file', description: 'Read', parameters: { properties: { path: { type: 'string' } } } }],
      temperature: 0.2,
      topP: 0.9,
      frequencyPenalty: 1,
      maxTokens: 2_000,
    });
    const req = requests[0]!;
    expect(req.path).toBe('/v1/messages');
    // SDK 1.x authenticates API keys with a bearer header.
    expect(req.headers.authorization).toBe('Bearer sk-ant-test');
    expect(req.body).toMatchObject({
      model: 'claude-opus-4-8',
      system: 'sys',
      max_tokens: 2_000,
      stream: true,
      cache_control: { type: 'ephemeral' },
      tools: [
        {
          name: 'read_file',
          eager_input_streaming: true,
          input_schema: { type: 'object', properties: { path: { type: 'string' } } },
        },
      ],
    });
    for (const key of ['temperature', 'top_p', 'frequency_penalty', 'presence_penalty', 'thinking', 'fallbacks']) {
      expect(req.body).not.toHaveProperty(key);
    }
    expect(req.headers['anthropic-beta']).toBeUndefined();
  });

  it('asks Claude 5 models for summarized thinking and opts into refusal fallbacks', async () => {
    const { baseUrl, requests } = await serve({ kind: 'sse', events: message(text(0, 'ok')) });
    await provider(baseUrl).chat({ model: 'claude-opus-5-5', messages: [{ role: 'user', content: 'hi' }] });
    expect(requests[0]!.body).toMatchObject({
      thinking: { type: 'adaptive', display: 'summarized' },
      fallbacks: 'default',
      max_tokens: 64_000,
    });
    expect(String(requests[0]!.headers['anthropic-beta'])).toContain('server-side-fallback-2026-07-01');
  });

  it('gives a tiny max_tokens room to think on thinking models, at low effort', async () => {
    const { baseUrl, requests } = await serve({ kind: 'sse', events: message(text(0, '3')) });
    await provider(baseUrl).chat({ model: 'claude-haiku-5-5', messages: [{ role: 'user', content: 'rank' }], maxTokens: 64 });
    expect(requests[0]!.body).toMatchObject({ max_tokens: 4_096, output_config: { effort: 'low' } });
    expect(requests[0]!.body).not.toHaveProperty('fallbacks');
  });
});

describe('AnthropicProvider responses', () => {
  it('streams text, reports thinking as reasoning, and returns tool calls and usage', async () => {
    const { baseUrl } = await serve({
      kind: 'sse',
      events: message(
        [...thinking(0, 'Need the file.'), ...text(1, 'Let me ', 'look.'), ...toolUse(2, 'toolu_1', 'read_file', '{"pa', 'th":"a.ts"}')],
        'tool_use',
        { output_tokens: 42 },
      ),
    });
    const deltas: Array<[string, string | undefined]> = [];
    const res = await provider(baseUrl).chatStreamed(
      { model: 'claude-opus-5-5', messages: [{ role: 'user', content: 'read a.ts' }] },
      (t, kind) => deltas.push([t, kind]),
    );
    expect(res.content).toBe('Let me look.');
    expect(res.finishReason).toBe('tool_calls');
    expect(res.toolCalls).toEqual([{ id: 'toolu_1', name: 'read_file', args: { path: 'a.ts' } }]);
    expect(res.usage).toEqual({ promptTokens: 100, completionTokens: 42, totalTokens: 142 });
    expect(deltas.filter(([, k]) => k === 'reasoning').map(([t]) => t)).toEqual(['Need the file.']);
    expect(deltas.filter(([, k]) => k === 'tool').map(([t]) => t).join('')).toBe('{"path":"a.ts"}');
  });

  it('streamChat yields only answer text and ends with the finish reason', async () => {
    const { baseUrl } = await serve({ kind: 'sse', events: message([...thinking(0, 'hmm'), ...text(1, 'Hel', 'lo')]) });
    const chunks = [];
    for await (const c of provider(baseUrl).streamChat({ model: 'claude-opus-5-5', messages: [{ role: 'user', content: 'hi' }] })) {
      chunks.push(c);
    }
    expect(chunks.map((c) => c.content).join('')).toBe('Hello');
    expect(chunks[chunks.length - 1]!.finishReason).toBe('stop');
  });

  it('never hands back a tool input that was cut off at max_tokens', async () => {
    const { baseUrl } = await serve({
      kind: 'sse',
      events: message(toolUse(0, 'toolu_1', 'write_file', '{"path":"a.ts","contents":"par'), 'max_tokens'),
    });
    const res = await provider(baseUrl).chat({ model: 'claude-opus-5-5', messages: [{ role: 'user', content: 'x' }] });
    expect(res.finishReason).toBe('length');
    expect(res.toolCalls![0]!.argsParseError).toMatch(/cut off/);
    expect(res.toolCalls![0]!.args).toEqual({});
  });

  it('turns a refusal into an error instead of an empty reply', async () => {
    const events = message(text(0, 'I'), 'refusal');
    (events[events.length - 2]!.delta as Record<string, unknown>).stop_details = {
      type: 'refusal',
      category: 'cyber',
      explanation: 'Declined.',
    };
    const { baseUrl } = await serve({ kind: 'sse', events });
    await expect(
      provider(baseUrl).chat({ model: 'claude-opus-5-5', messages: [{ role: 'user', content: 'x' }] }),
    ).rejects.toThrow(/declined this request \(cyber\)/);
  });
});

describe('AnthropicProvider errors and models', () => {
  it('reports a bad key readably', async () => {
    const { baseUrl } = await serve({
      kind: 'json',
      status: 401,
      body: { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } },
    });
    const err = await provider(baseUrl)
      .chat({ model: 'claude-opus-5-5', messages: [{ role: 'user', content: 'x' }] })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).status).toBe(401);
    expect((err as ProviderError).message).toMatch(/rejected the API key/);
  });

  it("keeps Anthropic's context-overflow wording so compaction can react to it", async () => {
    const { baseUrl } = await serve({
      kind: 'json',
      status: 400,
      body: { type: 'error', error: { type: 'invalid_request_error', message: 'prompt is too long: 1000001 tokens > 1000000 maximum' } },
    });
    const err = await provider(baseUrl)
      .chat({ model: 'claude-opus-5-5', messages: [{ role: 'user', content: 'x' }] })
      .catch((e: unknown) => e);
    expect(isContextOverflow((err as Error).message)).toBe(true);
  });

  it('surfaces a user abort as an AbortError', async () => {
    const { baseUrl } = await serve({ kind: 'sse', events: message(text(0, 'partial')).slice(0, 3), hangAfter: true });
    const controller = new AbortController();
    const run = provider(baseUrl).chatStreamed(
      { model: 'claude-opus-5-5', messages: [{ role: 'user', content: 'x' }], signal: controller.signal },
      () => controller.abort(),
    );
    const err = await run.catch((e: unknown) => e);
    expect(isAbortError(err)).toBe(true);
  });

  it('lists models with their context windows', async () => {
    const { baseUrl, requests } = await serve({
      kind: 'json',
      status: 200,
      body: {
        data: [
          { type: 'model', id: 'claude-opus-5-5', display_name: 'Claude Opus 5.5', created_at: '2026-01-01T00:00:00Z', max_input_tokens: 1_000_000, max_tokens: 128_000 },
          { type: 'model', id: 'claude-haiku-4-5', display_name: 'Claude Haiku 4.5', created_at: '2025-01-01T00:00:00Z', max_input_tokens: 200_000, max_tokens: 64_000 },
        ],
        has_more: false,
        first_id: 'claude-opus-5-5',
        last_id: 'claude-haiku-4-5',
      },
    });
    const models = await provider(baseUrl).listModels();
    expect(requests[0]!.path).toMatch(/^\/v1\/models/);
    expect(models).toEqual([
      { id: 'claude-opus-5-5', contextLength: 1_000_000 },
      { id: 'claude-haiku-4-5', contextLength: 200_000 },
    ]);
  });

  it('refuses embeddings and FIM completions with a pointer to another connection', async () => {
    const p = provider('https://api.anthropic.com');
    await expect(p.embeddings()).rejects.toThrow(/another connection/);
    await expect(p.completion()).rejects.toThrow(/another connection/);
  });

  it('normalizes base URLs copied from OpenAI-style setups', () => {
    expect(normalizeBaseUrl('https://api.anthropic.com/v1/')).toBe('https://api.anthropic.com');
    expect(normalizeBaseUrl('')).toBe('https://api.anthropic.com');
    expect(normalizeBaseUrl('https://proxy.example.com/anthropic')).toBe('https://proxy.example.com/anthropic');
  });
});
