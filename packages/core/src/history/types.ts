import type { ChatMessage } from '../providers/types.js';
import type { ToolDisplay } from '../protocol.js';
import type { TodoItem } from '../agent/todo.js';

/**
 * A stored chat message. `content` is what the LLM saw (template-expanded,
 * with context blocks); `display` is what the user typed, for the UI.
 * `ui` marks agent-transcript entries (plans, tool chips, status) so history
 * reloads can re-render them; tool/status entries are excluded from future
 * LLM context.
 */
export interface StoredMessage extends ChatMessage {
  display?: string;
  /**
   * Attachment ids for images sent with this turn — not the bytes.
   *
   * The bytes live one file each beside the conversation (host-side
   * `AttachmentStore`), because this file is read whole on every load and a
   * screenshot is a couple of megabytes of base64. They used to be noted and
   * discarded, so a reload lost the picture the question was about.
   */
  images?: string[];
  /** Shadow-git commit of the workspace state just before this (user) turn ran. */
  checkpoint?: string;
  ui?: {
    plan?: boolean;
    tool?: ToolDisplay & { id?: string };
    status?: { state: string };
    /**
     * A reasoning ("thinking") block. Transcript furniture like tool chips:
     * kept so a reload re-renders the turn as it happened, and excluded from
     * future LLM context — a model's own scratchpad is not something to feed
     * back to it as if it were dialogue.
     */
    reasoning?: boolean;
    /**
     * The agent's task list, updated in place by each todo_write — one entry
     * shows the latest state, not a history of writes. Furniture like a tool
     * chip: rendered, never fed back as context.
     */
    todos?: TodoItem[];
  };
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
