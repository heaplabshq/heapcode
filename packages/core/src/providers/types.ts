export type ChatRole = 'system' | 'user' | 'assistant' | 'tool';

export interface ToolCallRequest {
  id: string;
  name: string;
  /** Parsed arguments; empty object if the model sent invalid JSON. */
  args: Record<string, unknown>;
  argsParseError?: string;
}

export interface ChatMessage {
  role: ChatRole;
  content: string;
  /** Attached images as data: URLs — sent as image_url content parts (vision models). */
  images?: string[];
  /** Tool calls made by an assistant message. */
  toolCalls?: ToolCallRequest[];
  /** For role 'tool': which call this result answers. */
  toolCallId?: string;
}

export interface ToolSpec {
  name: string;
  description: string;
  /** JSON schema for the arguments object. */
  parameters: Record<string, unknown>;
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  /** Advertise tools (OpenAI function-calling format on the wire). */
  tools?: ToolSpec[];
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  signal?: AbortSignal;
}

export interface ChatChunk {
  content: string;
  /** Set on the final chunk when the provider reports why it stopped ('stop', 'length'…). */
  finishReason?: string;
}

/**
 * What one provider call cost, as the endpoint itself reported it.
 *
 * `null` means "not reported" and is deliberately distinct from 0 — a caller
 * deciding whether delegating work to a cheap model actually saves anything
 * has to be able to tell a free turn from an unmeasured one. Not every
 * OpenAI-compatible server returns a `usage` block, and several only do so
 * when asked (see `stream_options` in openaiCompatible.ts).
 */
export interface TokenUsage {
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
}

export interface ChatResponse {
  content: string;
  toolCalls?: ToolCallRequest[];
  finishReason?: string;
  /** Absent when the endpoint reported nothing at all. */
  usage?: TokenUsage;
}

export interface CompletionRequest {
  model: string;
  /** Raw prompt — for template-based FIM this is the rendered FIM string. */
  prompt: string;
  /**
   * Native FIM: servers that support it (Ollama, Mistral, OpenAI legacy)
   * apply the model's own FIM template server-side. Preferred when available.
   */
  suffix?: string;
  maxTokens?: number;
  temperature?: number;
  stop?: string[];
  signal?: AbortSignal;
}

export interface CompletionResponse {
  text: string;
}

export interface EmbeddingsRequest {
  model: string;
  input: string[];
  signal?: AbortSignal;
}

export interface EmbeddingsResponse {
  embeddings: number[][];
}

export interface ModelInfo {
  id: string;
  /** Context window in tokens, when the provider reports it in /models. */
  contextLength?: number;
}

export interface ProviderConfig {
  baseUrl: string;
  apiKey?: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
  /**
   * Which preset this profile came from, so a provider can use an endpoint's
   * non-standard APIs where the OpenAI-compatible surface falls short —
   * `contextLengthFor` is the only such case today.
   */
  preset?: string;
}

export interface Provider {
  chat(req: ChatRequest): Promise<ChatResponse>;
  streamChat(req: ChatRequest): AsyncIterable<ChatChunk>;
  /**
   * Streaming transport returning the full response (content + aggregated
   * tool calls). Preferred for agent turns: reasoning models can take longer
   * than any sane non-streaming timeout, but produce bytes immediately.
   * Delta kinds: 'text' (answer), 'reasoning' (thinking tokens from
   * reasoning models), 'tool' (tool-call argument fragments — progress only).
   */
  chatStreamed?(
    req: ChatRequest,
    onDelta?: (text: string, kind?: 'text' | 'reasoning' | 'tool') => void,
  ): Promise<ChatResponse>;
  completion(req: CompletionRequest): Promise<CompletionResponse>;
  embeddings(req: EmbeddingsRequest): Promise<EmbeddingsResponse>;
  listModels(): Promise<ModelInfo[]>;
  /**
   * One model's context length, asking the endpoint's own APIs when the
   * OpenAI-compatible `/models` does not report it (Ollama and LM Studio do
   * not). Best-effort: undefined means "could not find out", never an error.
   *
   * Here rather than in a host because it needs the endpoint's credentials,
   * and those live with the provider. Every host reads it through the
   * daemon's `provider/listModels`, so none of them has to hold a key to
   * learn how big the window really is.
   */
  contextLengthFor?(model: string): Promise<number | undefined>;
}
