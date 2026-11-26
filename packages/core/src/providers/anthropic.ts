import type Anthropic from '@anthropic-ai/sdk';
import { ProviderError } from './errors.js';
import type {
  ChatChunk,
  ChatMessage,
  ChatRequest,
  ChatResponse,
  CompletionResponse,
  EmbeddingsResponse,
  ModelInfo,
  Provider,
  ProviderConfig,
  TokenUsage,
  ToolCallRequest,
  ToolSpec,
} from './types.js';

type MessageParam = Anthropic.Beta.BetaMessageParam;
type ContentBlock = Anthropic.Beta.BetaContentBlockParam;
type ImageBlock = Anthropic.Beta.BetaImageBlockParam;
type ToolResultBlock = Anthropic.Beta.BetaToolResultBlockParam;
type Delta = (text: string, kind?: 'text' | 'reasoning' | 'tool') => void;
type SdkModule = typeof import('@anthropic-ai/sdk');

/**
 * The SDK is loaded on first use, not at import. This module sits in the
 * browser-safe provider layer that every host bundles — heapbrowse's side
 * panel included — and a static import added ~400 KB there for every user,
 * whatever provider they picked. Imported dynamically, bundlers split it into
 * a chunk that only an Anthropic connection ever loads.
 */
let sdkModule: Promise<SdkModule> | undefined;
/** Set once the import resolves; the error mappers need its classes for instanceof. */
let loaded: SdkModule | undefined;
function loadSdk(): Promise<SdkModule> {
  return (sdkModule ??= import('@anthropic-ai/sdk').then((m) => (loaded = m)));
}

export const ANTHROPIC_DEFAULT_BASE_URL = 'https://api.anthropic.com';

/** Streamed turns get room for thinking plus a long reply; matches Anthropic's guidance for agentic turns. */
const DEFAULT_STREAMED_MAX_TOKENS = 64_000;
/**
 * Thinking counts toward `max_tokens` on the models that always think, so a
 * cap sized for a one-line answer (rerank asks for 64) would end the turn
 * before the answer starts. Raised to this floor, with effort turned down so
 * the extra room is not spent thinking harder about a short task.
 */
const THINKING_MIN_MAX_TOKENS = 4_096;
const DEFAULT_TIMEOUT_MS = 300_000;
const MAX_ATTEMPTS = 3;

/**
 * Claude 5-family models: adaptive thinking is on by default (always on for
 * some), so the request asks for it explicitly with a readable summary that
 * the UI shows as reasoning. Older models are left on the API's own default,
 * which is no thinking — enabling it there changes cost and replay rules for
 * a model the user picked knowing how it behaves.
 */
const THINKING_MODEL = /^claude-(?:opus|sonnet|haiku|fable|mythos)-5(?:$|-)/;

/**
 * Models that accept server-side refusal fallbacks. When a safety classifier
 * declines a request, the API re-runs it on the model Anthropic recommends for
 * that category inside the same call, so a false positive does not end the
 * agent run. Anything else is sent without the parameter.
 */
const FALLBACK_MODEL = /^claude-(?:fable-5-[12]|opus-5|opus-5-5|sonnet-5-5)$/;
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

/**
 * Native client for Anthropic's Messages API, built on the official SDK.
 *
 * Heap Code's history is OpenAI-shaped (system/user/assistant/tool messages,
 * images as data URLs); `toAnthropicMessages` translates it per request.
 *
 * Thinking blocks are never sent back. Heap Code edits its history between
 * turns — compaction splices the middle, the tool-protocol fallback rewrites
 * the system prompt — and Anthropic binds each thinking block to the exact
 * conversation that produced it, so replaying them after an edit is a 400 on
 * accounts where that check is enforced. Omitting every thinking block is
 * always valid; the model re-plans from its visible text and tool calls.
 *
 * Sampling parameters (temperature, top_p, penalties) are not sent: current
 * Claude models reject them, and the agent sets temperature on every turn.
 */
export class AnthropicProvider implements Provider {
  private client: Anthropic | undefined;

  constructor(private readonly config: ProviderConfig) {}

  private async sdk(): Promise<Anthropic> {
    if (this.client) return this.client;
    const { default: AnthropicClient } = await loadSdk();
    try {
      this.client = new AnthropicClient({
        // Undefined lets the SDK fall back to ANTHROPIC_API_KEY in the CLI.
        ...(this.config.apiKey ? { apiKey: this.config.apiKey } : {}),
        baseURL: normalizeBaseUrl(this.config.baseUrl),
        defaultHeaders: { ...this.config.headers },
        timeout: timeoutMs(this.config.timeoutMs),
        // heapbrowse calls the API from the extension with the user's own key,
        // which never leaves their browser; the SDK refuses browser use unless
        // told this is deliberate.
        dangerouslyAllowBrowser: true,
      });
    } catch (err) {
      throw new ProviderError(
        `No Anthropic API key for this connection. Add one in settings (${err instanceof Error ? err.message : String(err)}).`,
      );
    }
    return this.client;
  }

  /** Not streamed on the surface, but streamed underneath: thinking models can outlast any non-streaming timeout. */
  chat(req: ChatRequest): Promise<ChatResponse> {
    return this.chatStreamed(req);
  }

  async *streamChat(req: ChatRequest): AsyncIterable<ChatChunk> {
    // The SDK stream is pull-based, but chatStreamed reports through a
    // callback; a small queue bridges the two without buffering the reply.
    const queue: ChatChunk[] = [];
    let wake: (() => void) | undefined;
    let done = false;
    let failure: unknown;
    const run = this.chatStreamed(req, (text, kind) => {
      if (kind !== 'text') return;
      queue.push({ content: text });
      wake?.();
    }).then(
      (res) => {
        queue.push({ content: '', finishReason: res.finishReason });
        done = true;
        wake?.();
      },
      (err: unknown) => {
        failure = err;
        done = true;
        wake?.();
      },
    );
    for (;;) {
      if (queue.length > 0) {
        yield queue.shift()!;
        continue;
      }
      if (done) break;
      await new Promise<void>((resolve) => (wake = resolve));
      wake = undefined;
    }
    await run;
    if (failure) throw failure;
  }

  async chatStreamed(req: ChatRequest, onDelta?: Delta): Promise<ChatResponse> {
    // Retrying is safe only until something the caller accumulates has been
    // emitted — same rule as the OpenAI-compatible provider. Reasoning is
    // display-only, so it does not count.
    let replayable = false;
    const track: Delta = (text, kind) => {
      if (kind !== 'reasoning') replayable = true;
      onDelta?.(text, kind);
    };
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.chatStreamedOnce(req, track);
      } catch (err) {
        const mapped = toProviderError(err, this.config.baseUrl);
        if (
          attempt >= MAX_ATTEMPTS ||
          replayable ||
          req.signal?.aborted ||
          !isTransientMidStream(err)
        ) {
          throw mapped;
        }
        await new Promise((r) => setTimeout(r, Math.min(400 * 2 ** (attempt - 1) + Math.random() * 200, 10_000)));
      }
    }
  }

  private async chatStreamedOnce(req: ChatRequest, onDelta: Delta): Promise<ChatResponse> {
    const { system, messages } = toAnthropicMessages(req.messages);
    const thinking = THINKING_MODEL.test(req.model);
    const requested = req.maxTokens ?? DEFAULT_STREAMED_MAX_TOKENS;
    const short = thinking && requested < THINKING_MIN_MAX_TOKENS;
    const fallbacks = FALLBACK_MODEL.test(req.model);

    const client = await this.sdk();
    const stream = await client.beta.messages.create(
      {
        model: req.model,
        max_tokens: short ? THINKING_MIN_MAX_TOKENS : requested,
        messages,
        ...(system ? { system } : {}),
        ...(req.tools && req.tools.length > 0 ? { tools: req.tools.map(toAnthropicTool) } : {}),
        ...(thinking ? { thinking: { type: 'adaptive', display: 'summarized' } } : {}),
        ...(short ? { output_config: { effort: 'low' } } : {}),
        // An agent turn resends the same system prompt, tools and history
        // every iteration; caching the prefix makes each later turn read it
        // at a tenth of the price.
        cache_control: { type: 'ephemeral' },
        ...(fallbacks ? { betas: [FALLBACK_BETA], fallbacks: 'default' as const } : {}),
        stream: true,
      },
      { signal: req.signal ?? undefined },
    );

    let content = '';
    let stopReason: string | null | undefined;
    let refusal: { category?: string | null; explanation?: string | null } | undefined;
    let usage: TokenUsage | undefined;
    let inputTokens = 0;
    let cacheTokens = 0;
    const blocks = new Map<number, { kind: string; id?: string; name?: string; json: string }>();

    for await (const event of stream) {
      switch (event.type) {
        case 'message_start': {
          const u = event.message.usage;
          inputTokens = u.input_tokens ?? 0;
          cacheTokens = (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
          break;
        }
        case 'content_block_start': {
          const block = event.content_block;
          if (block.type === 'text' && content && !content.endsWith('\n')) {
            // Separate answer text that arrives in several blocks (text, a
            // tool call, more text) the way it would read in one message.
            content += '\n\n';
            onDelta('\n\n', 'text');
          }
          blocks.set(event.index, {
            kind: block.type,
            ...(block.type === 'tool_use' ? { id: block.id, name: block.name } : {}),
            json: '',
          });
          break;
        }
        case 'content_block_delta': {
          const delta = event.delta;
          if (delta.type === 'text_delta') {
            content += delta.text;
            onDelta(delta.text, 'text');
          } else if (delta.type === 'thinking_delta') {
            if (delta.thinking) onDelta(delta.thinking, 'reasoning');
          } else if (delta.type === 'input_json_delta') {
            const slot = blocks.get(event.index);
            if (slot) slot.json += delta.partial_json;
            if (delta.partial_json) onDelta(delta.partial_json, 'tool');
          }
          break;
        }
        case 'message_delta': {
          stopReason = event.delta.stop_reason ?? stopReason;
          const details = (event.delta as { stop_details?: typeof refusal }).stop_details;
          if (details) refusal = details;
          const u = event.usage;
          if (typeof u.input_tokens === 'number') inputTokens = u.input_tokens;
          if (u.cache_creation_input_tokens != null || u.cache_read_input_tokens != null) {
            cacheTokens = (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
          }
          const prompt = inputTokens + cacheTokens;
          usage = { promptTokens: prompt, completionTokens: u.output_tokens, totalTokens: prompt + u.output_tokens };
          break;
        }
      }
    }

    // The SDK's stream ends quietly when its request is aborted rather than
    // throwing, which would hand a cut-off reply back as if it were complete.
    // Every other provider rejects with an AbortError; so does this one.
    if (req.signal?.aborted) throw abortError();

    if (stopReason === 'refusal') {
      // A classifier decline (after any fallback also declined). Thrown, not
      // returned: an empty or cut-off turn would read as "the model has
      // nothing to say" and the agent would nudge it again; a tool call it
      // cut off mid-input must never run.
      const category = refusal?.category ? ` (${refusal.category})` : '';
      throw new ProviderError(
        `Claude declined this request${category}.${refusal?.explanation ? ` ${refusal.explanation}` : ''}`,
      );
    }

    const truncated = stopReason === 'max_tokens' || stopReason === 'model_context_window_exceeded';
    const toolCalls: ToolCallRequest[] = [...blocks.entries()]
      .sort(([a], [b]) => a - b)
      .filter(([, b]) => b.kind === 'tool_use' && b.name)
      .map(([index, b]) => parseToolCall(b.id ?? `call_${index}`, b.name!, b.json, truncated));

    return {
      content,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      finishReason: mapStopReason(stopReason),
      usage,
    };
  }

  completion(): Promise<CompletionResponse> {
    return Promise.reject(
      new ProviderError(
        "Claude models don't do fill-in-the-middle completions. Assign the completion role to another connection (a local Ollama model works well).",
      ),
    );
  }

  embeddings(): Promise<EmbeddingsResponse> {
    return Promise.reject(
      new ProviderError(
        "Anthropic doesn't offer an embeddings API. Assign the embeddings role to another connection (for example nomic-embed-text on Ollama).",
      ),
    );
  }

  async listModels(): Promise<ModelInfo[]> {
    try {
      const models: ModelInfo[] = [];
      const client = await this.sdk();
      for await (const m of client.models.list({ limit: 100 })) {
        models.push(m.max_input_tokens ? { id: m.id, contextLength: m.max_input_tokens } : { id: m.id });
      }
      return models;
    } catch (err) {
      throw toProviderError(err, this.config.baseUrl);
    }
  }

  async contextLengthFor(model: string): Promise<number | undefined> {
    try {
      const client = await this.sdk();
      const m = await client.models.retrieve(model, undefined, { timeout: 5_000, maxRetries: 0 });
      return m.max_input_tokens ?? undefined;
    } catch {
      return undefined;
    }
  }
}

/**
 * The SDK appends `/v1/messages` itself, so a base URL copied from an
 * OpenAI-style setup (`…/v1`) would otherwise become `/v1/v1/messages`.
 */
export function normalizeBaseUrl(baseUrl: string | undefined): string {
  const trimmed = (baseUrl ?? '').trim().replace(/\/+$/, '').replace(/\/v1$/, '');
  return trimmed || ANTHROPIC_DEFAULT_BASE_URL;
}

function timeoutMs(configured: number | undefined): number {
  if (configured === undefined) return DEFAULT_TIMEOUT_MS;
  // 0 means "no timeout" on every other provider.
  return configured > 0 ? configured : 24 * 60 * 60 * 1000;
}

function mapStopReason(reason: string | null | undefined): string | undefined {
  switch (reason) {
    case 'end_turn':
    case 'stop_sequence':
    case 'pause_turn':
      return 'stop';
    case 'max_tokens':
    case 'model_context_window_exceeded':
      return 'length';
    case 'tool_use':
      return 'tool_calls';
    default:
      return reason ?? undefined;
  }
}

function parseToolCall(id: string, name: string, json: string, truncated: boolean): ToolCallRequest {
  if (truncated) {
    // A cut-off input often still parses as a smaller object; running it
    // would write half a file. Report it as unparseable instead.
    return { id, name, args: {}, argsParseError: 'The tool input was cut off at the output token limit.' };
  }
  try {
    const parsed: unknown = JSON.parse(json || '{}');
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return { id, name, args: parsed as Record<string, unknown> };
    }
    return { id, name, args: {}, argsParseError: 'The tool input was not a JSON object.' };
  } catch (err) {
    return { id, name, args: {}, argsParseError: err instanceof Error ? err.message : String(err) };
  }
}

function toAnthropicTool(tool: ToolSpec): Anthropic.Beta.BetaTool {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: { type: 'object', ...tool.parameters } as Anthropic.Beta.BetaTool.InputSchema,
    // Stream large inputs (a whole file for write_file) as they are generated
    // instead of in one burst at the end; parseToolCall validates strictly.
    eager_input_streaming: true,
  };
}

/** Tool-use ids must match ^[a-zA-Z0-9_-]+$; histories from other providers may not. */
function toolId(id: string | undefined): string {
  const clean = (id ?? '').replace(/[^a-zA-Z0-9_-]/g, '_');
  return clean || 'call';
}

const DATA_URL = /^data:(image\/[a-z+.-]+);base64,(.*)$/is;
const MEDIA_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

function toImageBlock(url: string): ImageBlock | undefined {
  const match = DATA_URL.exec(url);
  if (match) {
    const mediaType = match[1]!.toLowerCase().replace('image/jpg', 'image/jpeg');
    if (!MEDIA_TYPES.has(mediaType)) return undefined;
    return {
      type: 'image',
      source: {
        type: 'base64',
        media_type: mediaType as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp',
        data: match[2]!.replace(/\s+/g, ''),
      },
    };
  }
  if (/^https?:\/\//i.test(url)) return { type: 'image', source: { type: 'url', url } };
  return undefined;
}

function images(urls: string[] | undefined): ImageBlock[] {
  return (urls ?? []).map(toImageBlock).filter((b): b is ImageBlock => b !== undefined);
}

/**
 * Heap Code's OpenAI-shaped history → a valid Messages API request.
 *
 * - System messages become the top-level `system` prompt.
 * - Tool results become `tool_result` blocks, and every result of one
 *   assistant turn lands in the single user message that follows it.
 * - Consecutive same-role messages are merged; empty text is dropped (the
 *   API rejects empty and whitespace-only text blocks).
 * - Pairing is repaired: a tool call with no recorded result (a cancelled
 *   turn) gets an error result, and a result whose call is gone (compacted
 *   away) is kept as plain text — the API rejects both shapes otherwise.
 * - The conversation starts and ends on a user turn: current models reject
 *   a trailing assistant message as a prefill.
 */
export function toAnthropicMessages(history: ChatMessage[]): { system: string; messages: MessageParam[] } {
  const systemParts: string[] = [];
  const turns: Array<{ role: 'user' | 'assistant'; content: ContentBlock[] }> = [];

  const push = (role: 'user' | 'assistant', blocks: ContentBlock[]) => {
    if (blocks.length === 0) return;
    const last = turns[turns.length - 1];
    if (last && last.role === role) last.content.push(...blocks);
    else turns.push({ role, content: blocks });
  };

  for (const m of history) {
    switch (m.role) {
      case 'system':
        if (m.content.trim()) systemParts.push(m.content);
        break;
      case 'user': {
        const blocks: ContentBlock[] = images(m.images);
        if (m.content.trim()) blocks.push({ type: 'text', text: m.content });
        push('user', blocks);
        break;
      }
      case 'assistant': {
        const blocks: ContentBlock[] = [];
        if (m.content.trim()) blocks.push({ type: 'text', text: m.content });
        for (const call of m.toolCalls ?? []) {
          blocks.push({ type: 'tool_use', id: toolId(call.id), name: call.name, input: call.args ?? {} });
        }
        push('assistant', blocks);
        break;
      }
      case 'tool': {
        const pics = images(m.images);
        const text = m.content.trim() ? m.content : '(no output)';
        const result: ToolResultBlock = {
          type: 'tool_result',
          tool_use_id: toolId(m.toolCallId),
          content: pics.length > 0 ? [{ type: 'text', text }, ...pics] : text,
        };
        push('user', [result]);
        break;
      }
    }
  }

  // Repair tool_use / tool_result pairing, turn by turn.
  const messages: MessageParam[] = [];
  for (let i = 0; i < turns.length; i++) {
    const turn = turns[i]!;
    if (turn.role === 'assistant') {
      messages.push(turn);
      const callIds = turn.content
        .filter((b): b is Anthropic.Beta.BetaToolUseBlockParam => b.type === 'tool_use')
        .map((b) => b.id);
      if (callIds.length === 0) continue;
      const next = turns[i + 1];
      const nextBlocks = next?.role === 'user' ? next.content : [];
      const answered = new Set(
        nextBlocks.filter((b): b is ToolResultBlock => b.type === 'tool_result').map((b) => b.tool_use_id),
      );
      const missing: ToolResultBlock[] = callIds
        .filter((id) => !answered.has(id))
        .map((id) => ({
          type: 'tool_result',
          tool_use_id: id,
          is_error: true,
          content: 'No result was recorded for this call (it was cancelled or interrupted).',
        }));
      if (missing.length === 0) continue;
      if (next?.role === 'user') next.content.unshift(...missing);
      else turns.splice(i + 1, 0, { role: 'user', content: missing });
      continue;
    }

    // A user turn: keep only results answering the assistant turn just
    // before it, results first (the API requires them to lead the message).
    const prev = messages[messages.length - 1];
    const callIds = new Set(
      prev?.role === 'assistant' && Array.isArray(prev.content)
        ? prev.content
            .filter((b): b is Anthropic.Beta.BetaToolUseBlockParam => b.type === 'tool_use')
            .map((b) => b.id)
        : [],
    );
    const results: ContentBlock[] = [];
    const rest: ContentBlock[] = [];
    for (const block of turn.content) {
      if (block.type !== 'tool_result') rest.push(block);
      else if (callIds.has(block.tool_use_id)) results.push(block);
      else rest.push({ type: 'text', text: `Tool result:\n${toolResultText(block)}` });
    }
    messages.push({ role: 'user', content: [...results, ...rest] });
  }

  if (messages[0]?.role !== 'user') messages.unshift({ role: 'user', content: 'Continue.' });
  if (messages[messages.length - 1]?.role === 'assistant') messages.push({ role: 'user', content: 'Continue.' });

  return { system: systemParts.join('\n\n'), messages };
}

function toolResultText(block: ToolResultBlock): string {
  if (typeof block.content === 'string') return block.content;
  return (block.content ?? [])
    .map((b) => (b.type === 'text' ? b.text : ''))
    .filter(Boolean)
    .join('\n');
}

/** Overloaded / internal errors that arrive as a stream event, after the SDK's own retries no longer apply. */
function isTransientMidStream(err: unknown): boolean {
  if (!loaded || !(err instanceof loaded.APIError) || err.status !== undefined) return false;
  const type = (err.error as { error?: { type?: string } } | undefined)?.error?.type;
  return type === 'overloaded_error' || type === 'api_error';
}

function abortError(): Error {
  const abort = new Error('Request aborted.');
  abort.name = 'AbortError';
  return abort;
}

/** SDK errors → the ProviderError shapes the rest of Heap Code already reads. */
export function toProviderError(err: unknown, baseUrl: string): unknown {
  if (err instanceof ProviderError) return err;
  // Errors only come back from calls made through the loaded SDK, so it is
  // always set here; the guard keeps an import failure from being masked.
  if (!loaded) return err;
  const sdk = loaded;
  if (err instanceof sdk.APIUserAbortError) return abortError();
  if (err instanceof sdk.APIConnectionTimeoutError) {
    return new ProviderError(
      `Request to ${baseUrl} timed out. Raise "timeoutMs" on this connection if it keeps happening.`,
    );
  }
  if (err instanceof sdk.APIConnectionError) {
    const cause = (err as { cause?: { code?: string; message?: string } }).cause;
    const detail = cause?.code ?? cause?.message ?? err.message;
    return new ProviderError(
      `Cannot reach ${baseUrl} (${detail}). Check the base URL and your network connection.`,
    );
  }
  if (err instanceof sdk.APIError) {
    const body = err.error as { error?: { message?: string; type?: string } } | undefined;
    const detail = body?.error?.message ?? err.message;
    const status = err.status;
    switch (status) {
      case 401:
        return new ProviderError(`Anthropic rejected the API key (401). Check the key for this connection. ${detail}`, status);
      case 403:
        return new ProviderError(`This API key isn't allowed to do that (403). ${detail}`, status);
      case 404:
        return new ProviderError(`Not found (404): ${detail}. Check the model name.`, status);
      case 429:
        return new ProviderError(`Rate limited by Anthropic (429). ${detail}`, status);
      case 529:
        return new ProviderError(`Anthropic is overloaded right now (529). Try again shortly. ${detail}`, status);
      default:
        // `detail` keeps Anthropic's own wording ("prompt is too long: …"),
        // which is what isContextOverflow recognises.
        return new ProviderError(status ? `${detail} (${status})` : detail, status);
    }
  }
  return err;
}
