export type ChatRole = 'system' | 'user' | 'assistant';

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  signal?: AbortSignal;
}

export interface ChatChunk {
  content: string;
}

export interface ChatResponse {
  content: string;
  finishReason?: string;
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

export interface ModelInfo {
  id: string;
}

export interface ProviderConfig {
  baseUrl: string;
  apiKey?: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
}

export interface Provider {
  chat(req: ChatRequest): Promise<ChatResponse>;
  streamChat(req: ChatRequest): AsyncIterable<ChatChunk>;
  completion(req: CompletionRequest): Promise<CompletionResponse>;
  listModels(): Promise<ModelInfo[]>;
}
