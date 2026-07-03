import type { ChatMessage } from '../providers/types.js';

/**
 * A stored chat message. `content` is what the LLM saw (template-expanded,
 * with context blocks); `display` is what the user typed, for the UI.
 */
export interface StoredMessage extends ChatMessage {
  display?: string;
}

export interface ConversationMeta {
  id: string;
  title: string;
  updatedAt: number;
}

export interface Conversation extends ConversationMeta {
  messages: StoredMessage[];
}

export interface ConversationStore {
  list(): Promise<ConversationMeta[]>;
  get(id: string): Promise<Conversation | undefined>;
  save(conversation: Conversation): Promise<void>;
  delete(id: string): Promise<void>;
}
