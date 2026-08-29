import type { ChatMessage, TodoItem } from '@heapcode/core';

export type TranscriptItem =
  | { kind: 'header'; version?: string; profileName: string; model: string; baseUrl?: string; cwd?: string; messageCount?: number; canResume?: boolean }
  | { kind: 'message'; message: ChatMessage }
  | {
      kind: 'tool';
      id: string;
      name: string;
      description: string;
      status: 'running' | 'ok' | 'error';
      summary?: string;
      /** highlight.js language id for `summary`, inferred from the tool call's path arg — undefined renders as plain dim text. */
      language?: string;
      /** Called by a delegate_task sub-agent — rendered indented, under its parent's tool chip. */
      indent?: boolean;
    }
  | { kind: 'plan'; text: string }
  /**
   * The agent's live task list, updated in place by each todo_write: one card
   * per run, showing the current state rather than a history of every write.
   */
  | { kind: 'todo'; todos: TodoItem[] }
  /**
   * Markdown emitted by a command rather than by the model — rendered like an
   * assistant message but deliberately NOT a 'message', so it never becomes
   * part of the conversation history fed back to the agent. Used by
   * /pr-review's preview, which is long and belongs to the command, not the
   * chat.
   */
  | { kind: 'markdown'; text: string }
  | { kind: 'system'; text: string };
