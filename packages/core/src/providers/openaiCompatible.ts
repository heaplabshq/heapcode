import { describeHttpError, ProviderError } from './errors.js';
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

interface OpenAIChatCompletionChunk {
  choices?: Array<{
    delta?: { content?: string | null; tool_calls?: OpenAIStreamToolCall[] };
    finish_reason?: string | null;
  }>;
}

interface OpenAIToolCall {
  id?: string;
  function?: { name?: string; arguments?: string };
}

interface OpenAIChatCompletion {
  choices?: Array<{
    message?: { content?: string | null; tool_calls?: OpenAIToolCall[] };
    finish_reason?: string | null;
  }>;
}

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 3;
const DEFAULT_TIMEOUT_MS = 120_000;

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
        content: m.content,
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
   * 3. A per-attempt timeout (default 120s; timeoutMs=0 disables, used for
   *    streaming) — a stalled endpoint must fail loudly, never hang the UI.
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

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const res = await this.fetchOrThrow(this.chatUrl(req), {
      method: 'POST',
      headers: this.headers(),
      body: this.chatBody(req, false),
      signal: req.signal ?? null,
    });
    if (!res.ok) throw await describeHttpError(res);
    const json = (await res.json()) as OpenAIChatCompletion;
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
      const content = chunk.choices?.[0]?.delta?.content;
      if (content) yield { content };
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

  async chatStreamed(
    req: ChatRequest,
    onDelta?: (text: string) => void,
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
          `No response from ${this.config.baseUrl} within ${Math.round(ttfbMs / 1000)}s.`,
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
      const choice = chunk.choices?.[0];
      if (choice?.delta?.content) {
        content += choice.delta.content;
        onDelta?.(choice.delta.content);
      }
      for (const tc of choice?.delta?.tool_calls ?? []) {
        const slot = toolSlots.get(tc.index ?? 0) ?? { name: '', args: '' };
        if (tc.id) slot.id = tc.id;
        if (tc.function?.name) slot.name += tc.function.name;
        if (tc.function?.arguments) slot.args += tc.function.arguments;
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
    const json = (await res.json()) as { data?: Array<{ id?: string }> };
    return (json.data ?? [])
      .filter((m): m is { id: string } => typeof m.id === 'string')
      .map((m) => ({ id: m.id }));
  }
}
