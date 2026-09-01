import { runAgent } from './loop.js';
import { buildAgentTask } from './task.js';
import {
  filesystemMutatingBlockedMessage,
  filterToolsForPersona,
  getPersona,
  intersectPersonas,
  looksFilesystemMutating,
  type AgentPersona,
} from './personas.js';
import type { ToolCall, ToolDefinition, ToolResult } from './tools.js';
import type { AgentEnvironment } from './promptSections.js';
import type { Provider, TokenUsage } from '../providers/types.js';
import type { ProviderProfileConfig } from '../config/profiles.js';

// Sub-agents get the same tools as the parent (minus delegate_task itself)
// with no path/file scoping — a live incident had one, tasked only with
// checking a specific file for bugs, wander off and rewrite an unrelated
// package.json once it ran out of real bugs to find. This is a soft
// guardrail (a task-level instruction, not an enforced restriction) — same
// class of protection personas already rely on via taskAddendum.
export const SUB_AGENT_SCOPE_ADDENDUM =
  'You are a sub-agent delegated a specific task. Stay strictly within its scope: only create, modify, or ' +
  "delete files that are explicitly named in the task or unambiguously required to do exactly what it asks. " +
  "If you notice something else worth changing (missing test infra, an unrelated bug, etc.), mention it in " +
  'your final summary instead of changing it yourself.';

/**
 * Everything a delegated sub-agent needs, with every host-specific concern
 * behind a function.
 *
 * `execute` is the seam that matters: in-process hosts pass their own tool
 * executor, and the core server passes a function that asks the host over the
 * protocol (`tool/execute`). Either way this file never learns what a
 * filesystem or an MCP client is.
 */
export interface SubAgentContext {
  provider: Provider;
  profile: ProviderProfileConfig;
  nativeToolCalls: boolean;
  contextWindow?: number;
  /** The parent's environment snapshot — see runAgentForSession. */
  environment?: AgentEnvironment;
  /** Base tools offered to the sub-agent — must NOT include delegate_task itself (one level of nesting only). */
  tools: ToolDefinition[];
  /** The parent's own persona — a sub-agent can never be more permissive than it (intersectPersonas). */
  persona: AgentPersona;
  workspaceName: string;
  signal?: AbortSignal;
  execute(call: ToolCall): Promise<ToolResult>;
  requestPermission(call: ToolCall, tool: ToolDefinition): Promise<boolean>;
  /** Fired before non-read tools — e.g. a shadow-git snapshot. Best-effort. */
  beforeToolCall?(call: ToolCall): Promise<void>;
  /** Human-readable rendering of a call, for the tool log returned to the parent. */
  describe(call: ToolCall): string;
  /** Resolves a `profile` argument to a different provider — undefined/unknown name falls back to the parent's own. */
  resolveProfile?(name: string): Promise<{ provider: Provider; profile: ProviderProfileConfig } | undefined>;
  /** Live progress as the sub-agent works, for rendering an indented tool-chip group — best-effort, all optional. */
  events?: {
    onSubToolCall?(call: ToolCall): void;
    onSubToolResult?(result: ToolResult): void;
    /** A sub-agent's turns are billed to the same account as its parent's, so they are reported the same way. */
    onUsage?(usage: TokenUsage): void;
  };
}

/**
 * Runs a delegated sub-agent to completion — an isolated, fresh-context
 * `runAgent()` call sharing the parent's workspace (so checkpoints and
 * /revert cover its edits too) and abort signal, but not the parent's
 * conversation history. Sequential by design: the parent's own tool-call
 * slot blocks on this, same as any other tool — no concurrent sub-agents
 * (local-model inference doesn't parallelize usefully anyway, and it would
 * make permission prompts arrive in an unpredictable order).
 */
export async function runSubAgent(call: ToolCall, ctx: SubAgentContext): Promise<ToolResult> {
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
  const subTools = filterToolsForPersona(ctx.tools, persona);

  const subExecute = async (subCall: ToolCall): Promise<ToolResult> => {
    if (subCall.name === 'ask_user') {
      return {
        id: subCall.id,
        name: subCall.name,
        content: 'A sub-agent cannot ask the user questions — proceed with your best judgment or note the ambiguity in your summary.',
      };
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
        content: filesystemMutatingBlockedMessage(persona),
        isError: true,
      };
    }
    return ctx.execute(subCall);
  };

  const toolLog: string[] = [];
  let summaryText = '';
  let deltaBuffer = '';

  const outcome = await runAgent({
    provider,
    model,
    task: buildAgentTask({ scopeAddendum: SUB_AGENT_SCOPE_ADDENDUM, personaAddendum: persona.taskAddendum, task }),
    workspaceName: ctx.workspaceName,
    tools: subTools,
    nativeToolCalls: ctx.nativeToolCalls,
    environment: ctx.environment,
    promptTier: ctx.profile.promptTier,
    execute: subExecute,
    requestPermission: (subCall, tool) => ctx.requestPermission(subCall, tool),
    beforeToolCall: async (subCall) => {
      await ctx.beforeToolCall?.(subCall);
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
        toolLog.push(ctx.describe(subCall));
        ctx.events?.onSubToolCall?.(subCall);
      },
      onToolResult: (result) => ctx.events?.onSubToolResult?.(result),
      onUsage: (usage) => ctx.events?.onUsage?.(usage),
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
