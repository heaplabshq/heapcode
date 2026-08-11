import {
  describeErrorBody,
  describeHttpError,
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
  return (
    err instanceof ProviderBodyError && err.status !== undefined && RETRYABLE_STATUS.has(err.status)
  );
}

interface OpenAIChatCompletionChunk {
  error?: ProviderErrorBody;
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
  choices?: Array<{
    message?: { content?: string | null; tool_calls?: OpenAIToolCall[] };
    finish_reason?: string | null;
  }>;
}

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
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
    // the upstream is at capacity. Retrying is only safe while the caller has
    // seen no tokens — once any delta is out, replaying would duplicate it.
    let emitted = false;
    const track = (text: string, kind?: 'text' | 'reasoning' | 'tool') => {
      emitted = true;
      onDelta?.(text, kind);
    };
    return this.retryingBodyErrors(
      req.signal,
      () => this.chatStreamedOnce(req, track),
      () => !emitted,
    );
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
}
