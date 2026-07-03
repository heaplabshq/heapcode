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
  listModels(): Promise<ModelInfo[]>;
}
