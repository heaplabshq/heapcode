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

interface OpenAIChatCompletionChunk {
  choices?: Array<{ delta?: { content?: string | null }; finish_reason?: string | null }>;
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
   * fetch() with two reliability layers:
   * 1. Network errors ("fetch failed") get their real cause (ECONNREFUSED,
   *    ETIMEDOUT, DNS…) surfaced, or users can't tell a wrong URL from a down server.
   * 2. 429/5xx responses are retried with exponential backoff (honoring
   *    Retry-After), up to 3 attempts. Streams only retry before first byte.
   */
  protected async fetchOrThrow(url: string, init: RequestInit): Promise<Response> {
    for (let attempt = 1; ; attempt++) {
      let res: Response;
      try {
        res = await fetch(url, init);
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') throw err;
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
    const res = await this.fetchOrThrow(this.chatUrl(req), {
      method: 'POST',
      headers: this.headers(),
      body: this.chatBody(req, true),
      signal: req.signal ?? null,
    });
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

  async listModels(): Promise<ModelInfo[]> {
    const res = await this.fetchOrThrow(this.modelsUrl(), { headers: this.headers() });
    if (!res.ok) throw await describeHttpError(res);
    const json = (await res.json()) as { data?: Array<{ id?: string }> };
    return (json.data ?? [])
      .filter((m): m is { id: string } => typeof m.id === 'string')
      .map((m) => ({ id: m.id }));
  }
}
