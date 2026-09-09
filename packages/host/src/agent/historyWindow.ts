import { buildAgentHistory } from '@heapcode/core';
import type { AgentHistoryOptions, ChatMessage, StoredMessage } from '@heapcode/core';

/**
 * Multi-turn context passed to each agent run.
 *
 * The policy itself lives in core (context/agentHistory.ts) so the CLI, the
 * extension and the web host all get the same one — the tuning constants are
 * exported from there. This stays as the name every host already imports.
 */
export function trimHistoryForAgent(
  messages: StoredMessage[],
  opts?: AgentHistoryOptions,
): ChatMessage[] {
  return buildAgentHistory(messages, opts);
}
