import { describeHttpError, ProviderError } from './errors.js';
import { sseEvents } from './sse.js';
import type {
  ChatChunk,
  ChatRequest,
  ChatResponse,
  ModelInfo,
  Provider,
  ProviderConfig,
} from './types.js';

interface OpenAIChatCompletionChunk {
  choices?: Array<{ delta?: { content?: string | null }; finish_reason?: string | null }>;
}

interface OpenAIChatCompletion {
  choices?: Array<{ message?: { content?: string | null }; finish_reason?: string | null }>;
}

/**
 * Client for any OpenAI-compatible endpoint: OpenAI, Ollama (/v1), OpenRouter,
 * Groq, Together, vLLM, LM Studio, LocalAI, NVIDIA NIM, custom endpoints.
 * Provider-specific quirks (Azure auth, etc.) belong in thin subclasses.
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
      messages: req.messages,
      stream,
      ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
      ...(req.maxTokens !== undefined ? { max_tokens: req.maxTokens } : {}),
      ...(req.topP !== undefined ? { top_p: req.topP } : {}),
    });
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const res = await fetch(this.url('/chat/completions'), {
      method: 'POST',
      headers: this.headers(),
      body: this.chatBody(req, false),
      signal: req.signal ?? null,
    });
    if (!res.ok) throw await describeHttpError(res);
    const json = (await res.json()) as OpenAIChatCompletion;
    const choice = json.choices?.[0];
    return {
      content: choice?.message?.content ?? '',
      finishReason: choice?.finish_reason ?? undefined,
    };
  }

  async *streamChat(req: ChatRequest): AsyncIterable<ChatChunk> {
    const res = await fetch(this.url('/chat/completions'), {
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

  async listModels(): Promise<ModelInfo[]> {
    const res = await fetch(this.url('/models'), { headers: this.headers() });
    if (!res.ok) throw await describeHttpError(res);
    const json = (await res.json()) as { data?: Array<{ id?: string }> };
    return (json.data ?? [])
      .filter((m): m is { id: string } => typeof m.id === 'string')
      .map((m) => ({ id: m.id }));
  }
}
