import { sharedAgentTools, type ToolDefinition } from '@heapcode/core';

/**
 * Heap Chat's tool roster.
 *
 * A **separate array**, not `agentToolDefinitions` behind a filter. That is
 * the guardrail in docs/CHAT_MODE_PLAN.md §Guardrails 2, and it is not
 * stylistic: a filtered shared array means every tool added for Heap Code is
 * offered to Heap Chat until someone remembers to exclude it, and the failure
 * is silent in the direction that matters — a knowledge assistant quietly
 * gaining `run_command`.
 *
 * Reusing the *definitions* from core is fine and deliberate; a second
 * description of `read_file` would drift from the executor that runs it.
 * What must not be shared is the decision about which ones are on the list.
 *
 * Deliberately absent, and not oversights: every write, edit, delete and
 * rename tool, `run_command`, `run_tests`, `repo_map`, `get_symbols`,
 * `download_file`, `multi_edit`, `create_directory` and `delegate_task`.
 * Heap Chat reads; it does not change the folder it is pointed at.
 */
export const chatToolDefinitions: ToolDefinition[] = [
  sharedAgentTools.read_file,
  // Added after C4: "is there a receipt photo in this folder?" is not
  // answerable without being able to look. The roster's five had no way to
  // enumerate anything, so the model fell back to `search` with a pattern of
  // "." and reasoned about whatever that happened to match — which for a PNG
  // is nothing, so it concluded the photo did not exist.
  sharedAgentTools.list_dir,
  sharedAgentTools.search,
  sharedAgentTools.semantic_search,
  // Always offered, executed only when configured — the same posture Heap Code
  // takes. A model that cannot see the tool has no way to know web search is a
  // concept here, and one that cannot see it will claim it searched anyway.
  sharedAgentTools.web_search,
  sharedAgentTools.fetch_url,
  // Not a sixth capability over the folder — it is how the run talks back.
  // The plan's C0 named five tools; this one earns its place because the
  // loop gates `askToContinueAtLimit` on the roster containing `ask_user`
  // (agent/loop.ts:951), so without it both that and `chat/askUser` are
  // protocol that can never fire. Executed by the session, not the executor.
  sharedAgentTools.ask_user,
];

/** Tool names this host will execute. Anything else is refused, not attempted. */
export const CHAT_TOOL_NAMES: ReadonlySet<string> = new Set(chatToolDefinitions.map((t) => t.name));
