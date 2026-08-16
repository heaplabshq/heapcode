import type { ChatMessage, StoredMessage } from '@heapcode/core';

// Multi-turn context passed to each agent run: recent turns only, trimmed —
// enough for "ok do that" to mean something, small enough not to crowd the
// context window (core compacts long transcripts, but why start bloated).
// Shared by the interactive UI and headless mode so a continued conversation
// behaves identically either way.
export const HISTORY_MAX_TURNS = 12;
export const HISTORY_MAX_CHARS = 4_000;

export function trimHistoryForAgent(messages: StoredMessage[]): ChatMessage[] {
  return messages
    // Tool chips, status markers and reasoning blocks are transcript
    // furniture, not things the model said (history/types.ts). They are
    // dropped BEFORE the window is taken, so a turn with twenty tool calls
    // doesn't push every real message out of the last HISTORY_MAX_TURNS.
    // Reasoning in particular must never come back as context: replaying a
    // model's own scratchpad to it as dialogue is how a stored transcript
    // starts steering the next turn.
    .filter((m) => !m.ui?.tool && !m.ui?.status && !m.ui?.reasoning)
    .slice(-HISTORY_MAX_TURNS)
    .map((m) => ({
      role: m.role,
      content: m.content.length > HISTORY_MAX_CHARS ? `${m.content.slice(0, HISTORY_MAX_CHARS)}…` : m.content,
    }));
}
