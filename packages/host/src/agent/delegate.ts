// Re-exported from core so existing `@heapcode/host` import sites keep
// working; the definition itself lives with the other tool schemas now.
export { DELEGATE_TASK_TOOL } from '@heapcode/core';

/**
 * This module used to define the tool, and before that to run sub-agents.
 * Both moved: delegation runs server-side (docs/phase3-protocol-design.md §2),
 * so every host merely *offers* the tool with `agent/run` and the server does
 * the recursing. The one definition (core's) is the shared wording — the two
 * host copies had drifted into saying different things about the same tool.
 */