import {
  runSubAgent as runSubAgentIn,
  type AgentPersona,
  type McpManager,
  type Provider,
  type ProviderProfileConfig,
  type ToolCall,
  type ToolDefinition,
  type ToolResult,
} from '@heapcode/core';
import type { WorkspaceToolExecutor } from './workspaceTools.js';
import type { ShadowGit } from './shadowGit.js';

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
 * The sub-agent runner itself now lives in @heapcode/core
 * (agent/subAgent.ts), shared with the core server, which runs delegation
 * server-side. This file is the CLI's adapter: it maps the executor,
 * MCP manager and shadow-git this host has into the injected functions core
 * asks for. Behavior is unchanged — the scope addendum, persona
 * intersection, ask_user refusal, run_command guard and result formatting
 * are all core's now, byte for byte.
 */
export interface DelegateContext {
  executor: WorkspaceToolExecutor;
  provider: Provider;
  profile: ProviderProfileConfig;
  nativeToolCalls: boolean;
  contextWindow: number;
  /** Base tools offered to the sub-agent — must NOT include delegate_task itself (one level of nesting only). */
  tools: ToolDefinition[];
  mcpManager?: McpManager;
  /** The parent's own persona — a sub-agent can never be more permissive than it (intersectPersonas). */
  persona: AgentPersona;
  /** Structural, not the concrete PermissionEngine class — headless mode resolves this without a real one (see headless.ts). */
  permissions: { request(call: ToolCall, tool: ToolDefinition, description: string): Promise<boolean> };
  shadowGit?: ShadowGit;
  workspaceName: string;
  signal?: AbortSignal;
  /** Resolves a `profile` argument to a different provider — undefined/unknown name falls back to the parent's own. */
  resolveProfile?(name: string): Promise<{ provider: Provider; profile: ProviderProfileConfig } | undefined>;
  /** Live progress as the sub-agent works, for rendering an indented tool-chip group — best-effort, all optional. */
  events?: {
    onSubToolCall?(call: ToolCall): void;
    onSubToolResult?(result: ToolResult): void;
  };
}

export function runSubAgent(call: ToolCall, ctx: DelegateContext): Promise<ToolResult> {
  const mcpTools = ctx.mcpManager?.getToolDefinitions() ?? [];
  return runSubAgentIn(call, {
    provider: ctx.provider,
    profile: ctx.profile,
    nativeToolCalls: ctx.nativeToolCalls,
    contextWindow: ctx.contextWindow,
    tools: [...ctx.tools, ...mcpTools],
    persona: ctx.persona,
    workspaceName: ctx.workspaceName,
    signal: ctx.signal,
    execute: async (subCall) => {
      // MCP dispatch is the CLI's own — core's sub-agent runner deals only
      // in "execute this tool", and MCP hosting is host-side today.
      if (ctx.mcpManager?.isMcpTool(subCall.name)) {
        try {
          return { id: subCall.id, name: subCall.name, content: await ctx.mcpManager.call(subCall.name, subCall.args) };
        } catch (err) {
          return { id: subCall.id, name: subCall.name, content: err instanceof Error ? err.message : String(err), isError: true };
        }
      }
      return ctx.executor.execute(subCall, ctx.signal);
    },
    requestPermission: (subCall, tool) => ctx.permissions.request(subCall, tool, ctx.executor.describe(subCall)),
    beforeToolCall: async (subCall) => {
      await ctx.shadowGit?.snapshot(`[sub-agent] ${subCall.name}: ${ctx.executor.describe(subCall).slice(0, 80)}`);
    },
    describe: (subCall) => ctx.executor.describe(subCall),
    resolveProfile: ctx.resolveProfile,
    events: ctx.events,
  });
}
