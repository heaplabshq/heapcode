import {
  describeErrorBody,
  describeHttpError,
  isContextOverflow,
  isToolsUnsupported,
  ProviderBodyError,
  ProviderError,
  type ProviderErrorBody,
} from './errors.js';
import { sseEvents } from './sse.js';
import type {
  ChatChunk,
  ChatRequest,
  ChatResponse,
  CompletionRequest,
  CompletionResponse,
  EmbeddingsRequest,
  EmbeddingsResponse,
  ModelInfo,
  Provider,
  ProviderConfig,
  TokenUsage,
} from './types.js';

interface OpenAIStreamToolCall {
  index?: number;
  id?: string;
  function?: { name?: string; arguments?: string };
}

/**
 * A 200 whose body carries an error instead of a reply. Routers do this for
 * upstream failures — OpenRouter answers 200 with
 * `{"error":{"message":"Upstream error from Nvidia: ResourceExhausted…"}}`,
 * and mid-stream sends a chunk with empty `choices` and the same `error`.
 * Both used to read as "the model replied with nothing": the agent then
 * nudged, or accepted an empty turn as finished, instead of reporting that
 * the request never ran. Free/shared endpoints hit this constantly.
 */
function throwIfBodyError(body: { error?: ProviderErrorBody } | undefined): void {
  if (!body?.error) return;
  const detail = describeErrorBody(body.error);
  // Carry the embedded code as the status so these get the same retry
  // treatment as the HTTP status they stand in for — an upstream 502
  // smuggled inside a 200 is still a transient 502, and on busy shared
  // endpoints it is the single most common way a request fails.
  throw new ProviderBodyError(
    detail || 'The endpoint returned an error with no message.',
    typeof body.error.code === 'number' ? body.error.code : undefined,
  );
}

/** A body error worth another attempt — same statuses fetchOrThrow retries. */
function isRetryableBodyError(err: unknown): boolean {
  if (!(err instanceof ProviderBodyError)) return false;
  if (err.status !== undefined) return RETRYABLE_STATUS.has(err.status);
  // No code to go on — fall back to what the gateway actually said.
  return TRANSIENT_MESSAGE.test(err.message);
}

/** The wire shape of an OpenAI-style `usage` block; every field is optional because plenty of servers send a partial one. */
interface OpenAIUsage {
  prompt_tokens?: number | null;
  completion_tokens?: number | null;
  total_tokens?: number | null;
}

/**
 * `usage` → TokenUsage, keeping "not reported" (null) distinct from zero.
 * Returns undefined when the block is missing entirely, so a caller can tell
 * an endpoint that reports nothing from one that reported an empty count.
 */
function parseUsage(usage: OpenAIUsage | undefined | null): TokenUsage | undefined {
  if (!usage) return undefined;
  const num = (v: number | null | undefined): number | null => (typeof v === 'number' ? v : null);
  const prompt = num(usage.prompt_tokens);
  const completion = num(usage.completion_tokens);
  const total = num(usage.total_tokens);
  return {
    promptTokens: prompt,
    completionTokens: completion,
    // Several servers send the two halves and omit the sum; adding them is
    // arithmetic on numbers the endpoint itself reported, not a guess.
    totalTokens: total ?? (prompt !== null && completion !== null ? prompt + completion : null),
  };
}

interface OpenAIChatCompletionChunk {
  error?: ProviderErrorBody;
  usage?: OpenAIUsage | null;
  choices?: Array<{
    delta?: {
      content?: string | null;
      /** DeepSeek/GLM/NIM-style reasoning stream. */
      reasoning_content?: string | null;
      /** OpenRouter-style reasoning stream. */
      reasoning?: string | null;
      tool_calls?: OpenAIStreamToolCall[];
    };
    finish_reason?: string | null;
  }>;
}

interface OpenAIToolCall {
  id?: string;
  function?: { name?: string; arguments?: string };
}

interface OpenAIChatCompletion {
  error?: ProviderErrorBody;
  usage?: OpenAIUsage | null;
  choices?: Array<{
    message?: { content?: string | null; tool_calls?: OpenAIToolCall[] };
    finish_reason?: string | null;
  }>;
}

/**
 * Statuses worth another attempt. Beyond the obvious 429/5xx: 408, and the
 * Cloudflare 52x family that fronts several hosted gateways — 524 in
 * particular is what a stalled upstream surfaces as, and treating it as
 * permanent turned a transient hiccup into a failed agent run.
 */
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504, 520, 521, 522, 523, 524]);

/**
 * Transient failures a gateway reports in the error *message* while giving no
 * usable status code — OpenRouter answers a stalled upstream with a bare
 * `{"error":{"message":"Upstream idle timeout exceeded"}}`, which carried no
 * code and so was never retried. Deliberately narrow: it must not catch
 * durable errors, and phrasings like "maximum context length exceeded" or
 * "model not found" match none of these.
 */
const TRANSIENT_MESSAGE =
  /\b(?:idle timeout|timeout exceeded|timed out|temporarily unavailable|overloaded|at capacity|no instances available|connection (?:reset|closed|error)|upstream (?:error|connect error|timeout)|please try again)\b/i;
const MAX_ATTEMPTS = 3;
// Local models can take a while to first-token on a long prompt (agent turns
// especially — big system prompt, tool schemas, file contents) while they
// prefill, well before generation even starts. 120s cut those off routinely.
const DEFAULT_TIMEOUT_MS = 300_000;

/**
 * Client for any OpenAI-compatible endpoint: OpenAI, Ollama (/v1), OpenRouter,
 * Groq, Together, vLLM, LM Studio, LocalAI, NVIDIA NIM, custom endpoints.
 * Provider-specific quirks (Azure auth/URLs, etc.) belong in thin subclasses.
 */
export class OpenAICompatibleProvider implements Provider {
  /**
   * Whether this endpoint accepts `stream_options: {include_usage: true}`.
   * Assumed yes — it is standard and almost every server ignores unknown
   * fields — and flipped to false for the rest of the session the first time
   * one answers a streamed call with 400. Usage reporting is a nicety; a
   * refused agent turn is not, so the field gives way rather than the run.
   */
  private streamUsageSupported = true;

  constructor(protected readonly config: ProviderConfig) {
    if (!config.baseUrl) {
      throw new ProviderError('No base URL configured.');
    }
  }

  protected url(path: string): string {
    return this.config.baseUrl.replace(/\/+$/, '') + path;
  }

  protected chatUrl(_req: ChatRequest): string {
    return this.url('/chat/completions');
  }

  protected completionsUrl(_req: CompletionRequest): string {
    return this.url('/completions');
  }

  protected modelsUrl(): string {
    return this.url('/models');
  }

  protected headers(): Record<string, string> {
    return {
      'content-type': 'application/json',
      ...(this.config.apiKey ? { authorization: `Bearer ${this.config.apiKey}` } : {}),
      ...this.config.headers,
    };
  }

  protected chatBody(req: ChatRequest, stream: boolean): string {
    return JSON.stringify({
      model: req.model,
      // Map to the wire format explicitly — send only what the spec defines.
      messages: req.messages.map((m) => ({
        role: m.role,
        // Vision: images ride along as image_url parts next to the text.
        content:
          m.images && m.images.length > 0
            ? [
                ...(m.content ? [{ type: 'text', text: m.content }] : []),
                ...m.images.map((url) => ({ type: 'image_url', image_url: { url } })),
              ]
            : m.content,
        ...(m.toolCalls && m.toolCalls.length > 0
          ? {
              tool_calls: m.toolCalls.map((c) => ({
                id: c.id,
                type: 'function',
                function: { name: c.name, arguments: JSON.stringify(c.args) },
              })),
            }
          : {}),
        ...(m.toolCallId ? { tool_call_id: m.toolCallId } : {}),
      })),
      stream,
      // OpenAI and the routers built like it report token usage on a streamed
      // call only when asked, and an agent turn is always streamed — so
      // without this, the one number a caller needs to judge whether
      // delegating work is actually cheaper is never sent. Dropped for the
      // rest of the session if the endpoint turns out to reject it
      // (`streamUsageSupported` below).
      ...(stream && this.streamUsageSupported ? { stream_options: { include_usage: true } } : {}),
      ...(req.tools && req.tools.length > 0
        ? {
            tools: req.tools.map((t) => ({
              type: 'function',
              function: { name: t.name, description: t.description, parameters: t.parameters },
            })),
          }
        : {}),
      ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
      ...(req.maxTokens !== undefined ? { max_tokens: req.maxTokens } : {}),
      ...(req.topP !== undefined ? { top_p: req.topP } : {}),
    });
  }

  /**
   * fetch() with three reliability layers:
   * 1. Network errors ("fetch failed") get their real cause (ECONNREFUSED,
   *    ETIMEDOUT, DNS…) surfaced, or users can't tell a wrong URL from a down server.
   * 2. 429/5xx responses are retried with exponential backoff (honoring
   *    Retry-After), up to 3 attempts. Streams only retry before first byte.
   * 3. A per-attempt timeout (default 300s; timeoutMs=0 disables). For
   *    streaming calls this bounds time-to-first-byte only, not the whole
   *    response — a stalled endpoint must fail loudly, never hang the UI.
   */
  protected async fetchOrThrow(
    url: string,
    init: RequestInit,
    timeoutMs: number = this.config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  ): Promise<Response> {
    for (let attempt = 1; ; attempt++) {
      let res: Response;
      try {
        let signal = (init.signal as AbortSignal | null | undefined) ?? undefined;
        if (timeoutMs > 0) {
          const timeout = AbortSignal.timeout(timeoutMs);
          signal = signal ? AbortSignal.any([signal, timeout]) : timeout;
        }
        res = await fetch(url, { ...init, signal: signal ?? null });
      } catch (err) {
        const userAborted = (init.signal as AbortSignal | null | undefined)?.aborted;
        if (err instanceof Error && err.name === 'AbortError' && userAborted) throw err;
        if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
          throw new ProviderError(
            `Request to ${this.config.baseUrl} timed out after ${Math.round(timeoutMs / 1000)}s. ` +
              'The endpoint may be overloaded, or may not support this request shape (e.g. tool calling).',
          );
        }
        const cause = (err as { cause?: { code?: string; message?: string } }).cause;
        const detail =
          cause?.code ?? cause?.message ?? (err instanceof Error ? err.message : String(err));
        throw new ProviderError(
          `Cannot reach ${this.config.baseUrl} (${detail}). Check the base URL and that the server is running and accessible from this machine.`,
        );
      }

      if (res.ok || !RETRYABLE_STATUS.has(res.status) || attempt >= MAX_ATTEMPTS) {
        return res;
      }

      const retryAfter = Number(res.headers.get('retry-after'));
      const backoff =
        Number.isFinite(retryAfter) && retryAfter > 0
          ? retryAfter * 1000
          : 400 * 2 ** (attempt - 1) + Math.random() * 200;
      await new Promise((r) => setTimeout(r, Math.min(backoff, 10_000)));
      const signal = init.signal as AbortSignal | null | undefined;
      if (signal?.aborted) return res;
    }
  }

  /**
   * Retries an attempt that failed on a retryable error smuggled into a 200
   * body (see throwIfBodyError). fetchOrThrow's retry layer cannot catch
   * these: by the time the body is parsed, the response has already come back
   * 200 and been handed over. Only pass attempts that are safe to repeat —
   * `canRetry` is how the streaming path refuses once it has emitted tokens.
   */
  protected async retryingBodyErrors<T>(
    signal: AbortSignal | null | undefined,
    attempt: () => Promise<T>,
    canRetry: () => boolean = () => true,
  ): Promise<T> {
    for (let n = 1; ; n++) {
      try {
        return await attempt();
      } catch (err) {
        if (n >= MAX_ATTEMPTS || signal?.aborted || !canRetry() || !isRetryableBodyError(err)) throw err;
        await new Promise((r) => setTimeout(r, Math.min(400 * 2 ** (n - 1) + Math.random() * 200, 10_000)));
        if (signal?.aborted) throw err;
      }
    }
  }

  chat(req: ChatRequest): Promise<ChatResponse> {
    return this.retryingBodyErrors(req.signal, () => this.chatOnce(req));
  }

  private async chatOnce(req: ChatRequest): Promise<ChatResponse> {
    const res = await this.fetchOrThrow(this.chatUrl(req), {
      method: 'POST',
      headers: this.headers(),
      body: this.chatBody(req, false),
      signal: req.signal ?? null,
    });
    if (!res.ok) throw await describeHttpError(res);
    const json = (await res.json()) as OpenAIChatCompletion;
    throwIfBodyError(json);
    const choice = json.choices?.[0];
    const toolCalls = (choice?.message?.tool_calls ?? [])
      .filter((c) => c.function?.name)
      .map((c, i) => {
        let args: Record<string, unknown> = {};
        let argsParseError: string | undefined;
        try {
          args = JSON.parse(c.function?.arguments || '{}') as Record<string, unknown>;
        } catch (err) {
          argsParseError = err instanceof Error ? err.message : String(err);
        }
        return { id: c.id ?? `call_${i}`, name: c.function!.name!, args, argsParseError };
      });
    return {
      content: choice?.message?.content ?? '',
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      finishReason: choice?.finish_reason ?? undefined,
      usage: parseUsage(json.usage),
    };
  }

  async *streamChat(req: ChatRequest): AsyncIterable<ChatChunk> {
    // No timeout on streams — long generations are legitimate; Stop covers it.
    const res = await this.fetchOrThrow(
      this.chatUrl(req),
      {
        method: 'POST',
        headers: this.headers(),
        body: this.chatBody(req, true),
        signal: req.signal ?? null,
      },
      0,
    );
    if (!res.ok) throw await describeHttpError(res);
    if (!res.body) throw new ProviderError('Response has no body.');

    for await (const data of sseEvents(res.body)) {
      if (data === '[DONE]') return;
      let chunk: OpenAIChatCompletionChunk;
      try {
        chunk = JSON.parse(data) as OpenAIChatCompletionChunk;
      } catch {
        continue; // tolerate malformed keep-alive lines from lax servers
      }
      throwIfBodyError(chunk);
      const content = chunk.choices?.[0]?.delta?.content;
      const finishReason = chunk.choices?.[0]?.finish_reason ?? undefined;
      if (content || finishReason) yield { content: content ?? '', finishReason };
    }
  }

  async completion(req: CompletionRequest): Promise<CompletionResponse> {
    const res = await this.fetchOrThrow(this.completionsUrl(req), {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({
        model: req.model,
        prompt: req.prompt,
        stream: false,
        ...(req.suffix !== undefined ? { suffix: req.suffix } : {}),
        ...(req.maxTokens !== undefined ? { max_tokens: req.maxTokens } : {}),
        ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
        ...(req.stop && req.stop.length > 0 ? { stop: req.stop.slice(0, 4) } : {}),
      }),
      signal: req.signal ?? null,
    });
    if (!res.ok) throw await describeHttpError(res);
    const json = (await res.json()) as { choices?: Array<{ text?: string | null }> };
    return { text: json.choices?.[0]?.text ?? '' };
  }

  async embeddings(req: EmbeddingsRequest): Promise<EmbeddingsResponse> {
    const res = await this.fetchOrThrow(this.url('/embeddings'), {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ model: req.model, input: req.input }),
      signal: req.signal ?? null,
    });
    if (!res.ok) throw await describeHttpError(res);
    const json = (await res.json()) as { data?: Array<{ embedding?: number[]; index?: number }> };
    const data = [...(json.data ?? [])].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    return { embeddings: data.map((d) => d.embedding ?? []) };
  }

  chatStreamed(
    req: ChatRequest,
    onDelta?: (text: string, kind?: 'text' | 'reasoning' | 'tool') => void,
  ): Promise<ChatResponse> {
    // Routers commonly answer a stream with nothing but an error chunk when
    // the upstream is at capacity, or kill one that has gone idle. Retrying is
    // only safe while nothing REPLAYABLE has been emitted — text and tool-call
    // deltas both accumulate into the returned response, so replaying them
    // would duplicate the answer or the arguments.
    //
    // Reasoning deltas do not: they are forwarded to the caller for display
    // and never folded into `content` (see chatStreamedOnce). Counting them as
    // replayable made a stall during a long think unrecoverable — exactly the
    // case a reasoning model on a shared endpoint hits most, since it is the
    // stretch where the upstream sends nothing the gateway recognizes as
    // progress. Re-showing a few thinking tokens is a far smaller cost than
    // losing the turn.
    let replayable = false;
    const track = (text: string, kind?: 'text' | 'reasoning' | 'tool') => {
      if (kind !== 'reasoning') replayable = true;
      onDelta?.(text, kind);
    };
    return this.retryingBodyErrors(
      req.signal,
      async () => {
        try {
          return await this.chatStreamedOnce(req, track);
        } catch (err) {
          // A 400 is the endpoint saying "you sent something I don't accept",
          // and the only thing we send that it might not know is
          // stream_options. Drop it and repeat the turn once — same shape as
          // the tool-protocol fallback in the agent loop. Safe to replay
          // because a 400 arrives before any byte of the stream does, and the
          // guard says so rather than assuming it.
          if (replayable || !this.retryWithoutStreamUsage(err)) throw err;
          return await this.chatStreamedOnce(req, track);
        }
      },
      () => !replayable,
    );
  }

  /** True once, per endpoint: a 400 that isn't already explained by something else disables usage reporting. */
  private retryWithoutStreamUsage(err: unknown): boolean {
    if (!this.streamUsageSupported) return false;
    if (!(err instanceof ProviderError) || err.status !== 400) return false;
    // A 400 the codebase can already name means something else entirely;
    // retrying without stream_options would only cost a request and report
    // the same failure a beat later.
    if (isContextOverflow(err.message) || isToolsUnsupported(err.message)) return false;
    this.streamUsageSupported = false;
    return true;
  }

  private async chatStreamedOnce(
    req: ChatRequest,
    onDelta: (text: string, kind?: 'text' | 'reasoning' | 'tool') => void,
  ): Promise<ChatResponse> {
    // Timeout applies to time-to-first-byte only; total stream time is unbounded.
    const ttfbMs = this.config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const internal = new AbortController();
    const signal = req.signal ? AbortSignal.any([req.signal, internal.signal]) : internal.signal;
    const ttfbTimer = setTimeout(() => internal.abort(), ttfbMs);

    let res: Response;
    try {
      res = await this.fetchOrThrow(
        this.chatUrl(req),
        { method: 'POST', headers: this.headers(), body: this.chatBody(req, true), signal },
        0,
      );
    } catch (err) {
      if (internal.signal.aborted && !req.signal?.aborted) {
        throw new ProviderError(
          `No response from ${this.config.baseUrl} within ${Math.round(ttfbMs / 1000)}s. ` +
            'If this is a local/slow model on a large prompt (e.g. an agent task), raise ' +
            '"timeoutMs" on this profile — it only bounds time-to-first-token, not the full reply.',
        );
      }
      throw err;
    } finally {
      clearTimeout(ttfbTimer);
    }
    if (!res.ok) throw await describeHttpError(res);
    if (!res.body) throw new ProviderError('Response has no body.');

    let content = '';
    let finishReason: string | undefined;
    /**
     * Usually the last chunk before [DONE], which carries `usage` and an EMPTY
     * `choices` array — so it is read off the chunk itself, never off a
     * choice. Some servers instead repeat a running total on every chunk;
     * last-one-wins is right either way.
     */
    let usage: TokenUsage | undefined;
    const toolSlots = new Map<number, { id?: string; name: string; args: string }>();

    for await (const data of sseEvents(res.body)) {
      if (data === '[DONE]') break;
      let chunk: OpenAIChatCompletionChunk;
      try {
        chunk = JSON.parse(data) as OpenAIChatCompletionChunk;
      } catch {
        continue;
      }
      throwIfBodyError(chunk);
      usage = parseUsage(chunk.usage) ?? usage;
      const choice = chunk.choices?.[0];
      const reasoning = choice?.delta?.reasoning_content ?? choice?.delta?.reasoning;
      if (reasoning) onDelta(reasoning, 'reasoning');
      if (choice?.delta?.content) {
        content += choice.delta.content;
        onDelta(choice.delta.content, 'text');
      }
      for (const tc of choice?.delta?.tool_calls ?? []) {
        const slot = toolSlots.get(tc.index ?? 0) ?? { name: '', args: '' };
        if (tc.id) slot.id = tc.id;
        if (tc.function?.name) slot.name += tc.function.name;
        if (tc.function?.arguments) {
          slot.args += tc.function.arguments;
          onDelta(tc.function.arguments, 'tool');
        }
        toolSlots.set(tc.index ?? 0, slot);
      }
      if (choice?.finish_reason) finishReason = choice.finish_reason;
    }

    const toolCalls = [...toolSlots.entries()]
      .sort(([a], [b]) => a - b)
      .filter(([, s]) => s.name)
      .map(([index, s]) => {
        let args: Record<string, unknown> = {};
        let argsParseError: string | undefined;
        try {
          args = JSON.parse(s.args || '{}') as Record<string, unknown>;
        } catch (err) {
          argsParseError = err instanceof Error ? err.message : String(err);
        }
        return { id: s.id ?? `call_${index}`, name: s.name, args, argsParseError };
      });

    return {
      content,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      finishReason,
      usage,
    };
  }

  async listModels(): Promise<ModelInfo[]> {
    const res = await this.fetchOrThrow(this.modelsUrl(), { headers: this.headers() });
    if (!res.ok) throw await describeHttpError(res);
    // Context-length field name varies: context_length (OpenRouter, Together),
    // max_model_len (vLLM), max_context_length (LM Studio), context_window (Groq).
    const json = (await res.json()) as {
      data?: Array<{
        id?: string;
        context_length?: number;
        max_model_len?: number;
        max_context_length?: number;
        context_window?: number;
      }>;
    };
    return (json.data ?? [])
      .filter((m): m is { id: string } & Record<string, number | undefined> => typeof m.id === 'string')
      .map((m) => {
        const ctx =
          m.context_length ?? m.max_model_len ?? m.max_context_length ?? m.context_window;
        return typeof ctx === 'number' && ctx > 0 ? { id: m.id, contextLength: ctx } : { id: m.id };
      });
  }

  /**
   * One model's real context length.
   *
   * `/v1/models` first, because most endpoints answer there. Ollama and LM
   * Studio do not — they carry it on their own APIs — and that gap is not
   * cosmetic: without it a host falls back to the preset's guess, and a guess
   * that is too large means the window never looks full, compaction never
   * fires, and the endpoint quietly drops the oldest part of the prompt
   * instead. The agent then forgets what it read a moment ago and reads it
   * again, which is what an unstoppable read loop looks like from outside.
   *
   * Best-effort throughout, with a short timeout: this is called to size a
   * meter and a budget, and neither is worth failing a turn over.
   */
  async contextLengthFor(model: string): Promise<number | undefined> {
    const listed = await this.listModels().catch(() => [] as ModelInfo[]);
    const reported = listed.find((m) => m.id === model)?.contextLength;
    if (reported) return reported;
    return this.probeNativeContextLength(model);
  }

  /**
   * Ollama's `/api/show` and LM Studio's `/api/v0/models` — the provider-native
   * APIs that do report a context length.
   *
   * Gated on the preset rather than tried speculatively: these are guesses at
   * another vendor's URL space, and firing them at, say, an OpenAI endpoint
   * would be a 404 nobody asked for.
   */
  private async probeNativeContextLength(model: string): Promise<number | undefined> {
    const preset = this.config.preset;
    if (preset !== 'ollama' && preset !== 'ollama-cloud' && preset !== 'lmstudio') return undefined;
    const origin = this.config.baseUrl.replace(/\/v1\/?$/, '');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5_000);
    try {
      if (preset === 'lmstudio') {
        const res = await fetch(`${origin}/api/v0/models/${encodeURIComponent(model)}`, {
          headers: this.headers(),
          signal: controller.signal,
        });
        if (!res.ok) return undefined;
        const json = (await res.json()) as { max_context_length?: number };
        return typeof json.max_context_length === 'number' && json.max_context_length > 0
          ? json.max_context_length
          : undefined;
      }
      // Ollama, local or hosted. The hosted one needs the key, which is why
      // this lives on the provider: `this.headers()` already carries it.
      const res = await fetch(`${origin}/api/show`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({ model }),
        signal: controller.signal,
      });
      if (!res.ok) return undefined;
      const json = (await res.json()) as { model_info?: Record<string, unknown> };
      for (const [k, v] of Object.entries(json.model_info ?? {})) {
        // Keyed by architecture: "llama.context_length", "qwen2.context_length".
        if (k.endsWith('.context_length') && typeof v === 'number' && v > 0) return v;
      }
      return undefined;
    } catch {
      // Endpoint down, or an API shape that has moved on. The caller falls
      // back to the preset default, which is where it started.
      return undefined;
    } finally {
      clearTimeout(timeout);
    }
  }
}
