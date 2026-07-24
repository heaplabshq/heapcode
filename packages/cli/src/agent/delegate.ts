import {
  runAgent,
  type Provider,
  type ProviderProfileConfig,
  type ToolCall,
  type ToolDefinition,
  type ToolResult,
} from '@heapcode/core';
import type { WorkspaceToolExecutor } from './workspaceTools.js';
import type { ShadowGit } from './shadowGit.js';
import type { McpManager } from './mcp.js';
import { filterToolsForPersona, getPersona, intersectPersonas, looksFilesystemMutating, type AgentPersona } from './personas.js';

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

/**
 * Runs a delegated sub-agent to completion — an isolated, fresh-context
 * `runAgent()` call sharing the parent's workspace executor (so checkpoints
 * and /revert cover its edits too) and abort signal (so Esc interrupts it),
 * but not the parent's conversation history. Sequential by design: the
 * parent's own tool-call slot blocks on this, same as any other tool — no
 * concurrent sub-agents (local-model inference doesn't parallelize usefully
 * anyway, and it would make permission prompts arrive in an unpredictable
 * order). Port of packages/vscode/src/agent/controller.ts's runSubAgent.
 */
export async function runSubAgent(call: ToolCall, ctx: DelegateContext): Promise<ToolResult> {
  const task = String(call.args.task ?? '').trim();
  if (!task) return { id: call.id, name: call.name, content: 'Missing "task" argument.', isError: true };

  let provider = ctx.provider;
  let profile = ctx.profile;
  const profileName = call.args.profile ? String(call.args.profile) : undefined;
  if (profileName && profileName !== ctx.profile.name && ctx.resolveProfile) {
    const resolved = await ctx.resolveProfile(profileName);
    if (resolved) {
      provider = resolved.provider;
      profile = resolved.profile;
    }
    // Unknown profile name — falls back to the parent's own, same lenient
    // pattern the role-profile redirects (RoleResolver) already use.
  }
  const model = profile.agentModel || profile.model;
  if (!model) return { id: call.id, name: call.name, content: `Profile "${profile.name}" has no model configured.`, isError: true };

  const requestedPersona = getPersona(call.args.persona ? String(call.args.persona) : undefined);
  const persona = intersectPersonas(ctx.persona, requestedPersona);
  const mcpTools = ctx.mcpManager?.getToolDefinitions() ?? [];
  const subTools = filterToolsForPersona([...ctx.tools, ...mcpTools], persona);

  const subExecute = async (subCall: ToolCall): Promise<ToolResult> => {
    if (subCall.name === 'ask_user') {
      return {
        id: subCall.id,
        name: subCall.name,
        content: 'A sub-agent cannot ask the user questions — proceed with your best judgment or note the ambiguity in your summary.',
      };
    }
    if (ctx.mcpManager?.isMcpTool(subCall.name)) {
      try {
        return { id: subCall.id, name: subCall.name, content: await ctx.mcpManager.call(subCall.name, subCall.args) };
      } catch (err) {
        return { id: subCall.id, name: subCall.name, content: err instanceof Error ? err.message : String(err), isError: true };
      }
    }
    if (
      subCall.name === 'run_command' &&
      persona.allowedPermissions &&
      !persona.allowedPermissions.includes('write') &&
      looksFilesystemMutating(String(subCall.args.command ?? ''))
    ) {
      return {
        id: subCall.id,
        name: subCall.name,
        content: `Blocked: this command looks like it would create, modify, or delete files, which the ${persona.label} persona does not allow.`,
        isError: true,
      };
    }
    return ctx.executor.execute(subCall, ctx.signal);
  };

  const toolLog: string[] = [];
  let summaryText = '';
  let deltaBuffer = '';

  const outcome = await runAgent({
    provider,
    model,
    task: [persona.taskAddendum, task].filter(Boolean).join('\n\n---\n\n'),
    workspaceName: ctx.workspaceName,
    tools: subTools,
    nativeToolCalls: ctx.nativeToolCalls,
    execute: subExecute,
    requestPermission: (subCall, tool) => ctx.permissions.request(subCall, tool, ctx.executor.describe(subCall)),
    beforeToolCall: async (subCall) => {
      await ctx.shadowGit?.snapshot(`[sub-agent] ${subCall.name}: ${ctx.executor.describe(subCall).slice(0, 80)}`);
    },
    events: {
      onText: (text) => {
        if (text.trim()) summaryText += (summaryText ? '\n\n' : '') + text;
      },
      onTextDelta: (text) => {
        deltaBuffer += text;
      },
      onTextEnd: () => {
        if (deltaBuffer.trim()) summaryText += (summaryText ? '\n\n' : '') + deltaBuffer;
        deltaBuffer = '';
      },
      onToolCall: (subCall) => {
        toolLog.push(ctx.executor.describe(subCall));
        ctx.events?.onSubToolCall?.(subCall);
      },
      onToolResult: (result) => ctx.events?.onSubToolResult?.(result),
    },
    contextWindow: ctx.contextWindow,
    signal: ctx.signal,
  });

  const content =
    `outcome: ${outcome}\n` +
    `${toolLog.length} tool call(s)${toolLog.length ? ':\n' + toolLog.map((d, i) => `  ${i + 1}. ${d}`).join('\n') : ''}\n\n` +
    (summaryText.trim() || '(sub-agent produced no summary text)');

  return {
    id: call.id,
    name: call.name,
    content,
    isError: outcome === 'error' || outcome === 'max-iterations' || outcome === 'incomplete',
  };
}
