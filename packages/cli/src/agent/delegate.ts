import type { ToolDefinition } from '@heapcode/core';

/**
 * Not baked into `agentToolDefinitions` — it needs cross-cutting context
 * (persona, permissions, shadow-git, MCP) that WorkspaceToolExecutor itself
 * has no business knowing about, unlike every other built-in tool. It is
 * always OFFERED (so the model can respond honestly when asked to delegate),
 * but EXECUTION is opt-in: while sub-agents are disabled (App.tsx's
 * `subAgentsEnabled` / headless's `--sub-agents`), calling it returns an
 * informative "disabled" error instead of running.
 */
export const DELEGATE_TASK_TOOL: ToolDefinition = {
  name: 'delegate_task',
  description:
    'Delegate a self-contained sub-task to a fresh sub-agent with its own context window (no memory of this ' +
    'conversation). Use it for a chunk of work whose intermediate exploration would just clutter your own context ' +
    '— e.g. "investigate and summarize how X works" or "write tests for Y". The sub-agent shares this workspace ' +
    '(its edits use the same checkpoints as your own, so /rewind and /revert cover them too) but cannot delegate ' +
    'further — one level of nesting only. Runs to completion before returning; there is no parallelism.',
  parameters: {
    type: 'object',
    properties: {
      task: { type: 'string', description: 'A self-contained description of the sub-task — the sub-agent has no context beyond this.' },
      persona: { type: 'string', description: 'Optional: agent, architect, debug, or reviewer. Can never be more permissive than your own persona.' },
      profile: { type: 'string', description: 'Optional: run the sub-agent on a different configured provider profile.' },
    },
    required: ['task'],
  },
  permission: 'execute',
};

/**
 * The sub-agent runner used to live here as an adapter over
 * @heapcode/core's runSubAgent. Nothing calls it any more: delegation runs
 * server-side (docs/phase3-protocol-design.md §2), so both App.tsx and
 * headless.ts merely *offer* this tool and the server does the recursing.
 *
 * The definition stays because it is the CLI's own wording — the extension
 * advertises a different one — and both CLI surfaces add it to the tool list
 * they send with `agent/run`.
 */
