import { runAgent } from '../agent/loop.js';
import { getPersona, looksFilesystemMutating } from '../agent/personas.js';
import { runSubAgent } from '../agent/subAgent.js';
import type { ToolCall, ToolDefinition, ToolResult } from '../agent/tools.js';
import type { Session } from './session.js';
import { METHODS, type AgentEvent, type AgentRunParams, type AgentRunResult } from './protocol.js';

/**
 * The host-facing half of a run: everything the server needs the host to do.
 * Injected rather than reaching for the RpcPeer directly so the run logic is
 * testable without a socket.
 */
export interface RunHost {
  emit(event: AgentEvent): void;
  executeTool(call: ToolCall, parent?: string): Promise<ToolResult>;
  requestPermission(call: ToolCall, tool: ToolDefinition): Promise<boolean>;
  snapshotBefore(call: ToolCall): Promise<void>;
  /** Resolve a profile the session doesn't already hold a key for (§2, option b). */
  requestKey(profileName: string): Promise<void>;
}

/**
 * Runs an agent turn server-side.
 *
 * The three things that used to live in each host's `execute` closure and
 * now live here, once, are the persona run_command guard, delegate_task
 * dispatch, and sub-agent recursion. Everything genuinely host-shaped —
 * touching the filesystem, MCP, the editor — goes back over `executeTool`.
 */
export async function runAgentForSession(
  session: Session,
  params: AgentRunParams,
  host: RunHost,
  signal: AbortSignal,
): Promise<AgentRunResult> {
  const profileName = params.profileName ?? session.activeProfile;
  const resolved = session.providerFor(profileName);
  if (!resolved) throw new Error(`Unknown profile "${profileName}" for this session.`);

  // Host-resolved when sent (see AgentRunParams.persona); the default only
  // matters for a caller that omits it entirely.
  const persona = params.persona ?? getPersona(undefined);

  /** Tools a sub-agent may be offered — never delegate_task itself (one level of nesting only). */
  const subAgentTools = params.tools.filter((t) => t.name !== 'delegate_task');

  const describe = (call: ToolCall): string => `${call.name}(${Object.keys(call.args).join(', ')})`;

  const execute = async (call: ToolCall): Promise<ToolResult> => {
    if (call.name === 'delegate_task') {
      if (!params.subAgents) {
        return {
          id: call.id,
          name: call.name,
          content:
            'Sub-agent delegation is disabled for this run (the --sub-agents flag was not passed). ' +
            'Handle the sub-task yourself in this conversation instead — do not claim it was delegated.',
          isError: true,
        };
      }
      return runSubAgent(call, {
        provider: resolved.provider,
        profile: resolved.profile,
        nativeToolCalls: params.nativeToolCalls,
        contextWindow: params.contextWindow,
        tools: subAgentTools,
        persona,
        workspaceName: params.workspaceName,
        signal,
        // A sub-agent's tool calls go back over the SAME channel as the
        // parent's, tagged with the delegate_task call id — which is exactly
        // the `parent` field the NDJSON event schema already carried.
        execute: (subCall) => host.executeTool(subCall, call.id),
        requestPermission: (subCall, tool) => host.requestPermission(subCall, tool),
        beforeToolCall: (subCall) => host.snapshotBefore(subCall),
        describe,
        // Session.resolveProfile holds the same rule this used to inline, plus
        // an ask-once guard — a keyless local profile leaves `hasKey` false
        // forever, so the old condition re-asked the host on every delegation.
        resolveProfile: (name) => session.resolveProfile(name, host.requestKey),
        events: {
          onSubToolCall: (subCall) =>
            host.emit({ type: 'tool_call', id: subCall.id, name: subCall.name, args: subCall.args, parent: call.id }),
          onSubToolResult: (result) =>
            host.emit({
              type: 'tool_result',
              id: result.id,
              name: result.name,
              content: result.content,
              isError: result.isError,
              parent: call.id,
            }),
        },
      });
    }

    // A shell command can mutate files as easily as write_file — block it for
    // write-restricted personas. Server-side because the persona is.
    if (
      call.name === 'run_command' &&
      persona.allowedPermissions &&
      !persona.allowedPermissions.includes('write') &&
      looksFilesystemMutating(String(call.args.command ?? ''))
    ) {
      return {
        id: call.id,
        name: call.name,
        content: `Blocked: this command looks like it would create, modify, or delete files, which the ${persona.label} persona does not allow.`,
        isError: true,
      };
    }

    return host.executeTool(call);
  };

  const outcome = await runAgent({
    provider: resolved.provider,
    model: params.model,
    task: params.task,
    history: params.history,
    images: params.images,
    workspaceName: params.workspaceName,
    tools: params.tools,
    nativeToolCalls: params.nativeToolCalls,
    contextWindow: params.contextWindow,
    plan: params.plan,
    planOnly: params.planOnly,
    resumePlan: params.resumePlan,
    proposeMemoryNote: params.proposeMemoryNote,
    requireVerificationBeforeFinish: params.requireVerificationBeforeFinish,
    maxIterations: params.maxIterations,
    temperature: params.temperature,
    maxTokens: params.maxTokens,
    signal,
    execute,
    requestPermission: (call, tool) => host.requestPermission(call, tool),
    beforeToolCall: (call) => host.snapshotBefore(call),
    events: {
      onText: (text) => host.emit({ type: 'text', text }),
      onTextDelta: (text) => host.emit({ type: 'text_delta', text }),
      onTextEnd: () => host.emit({ type: 'text_end' }),
      onPlan: (text) => host.emit({ type: 'plan', text }),
      onToolCall: (call) => host.emit({ type: 'tool_call', id: call.id, name: call.name, args: call.args }),
      onToolResult: (result) =>
        host.emit({ type: 'tool_result', id: result.id, name: result.name, content: result.content, isError: result.isError }),
      onReasoningDelta: (text) => host.emit({ type: 'reasoning_delta', text }),
      onReasoningEnd: () => host.emit({ type: 'reasoning_end' }),
      onToolStream: (chars) => host.emit({ type: 'tool_stream', chars }),
      onContextUsage: (usedTokens, windowTokens) => host.emit({ type: 'context_usage', usedTokens, windowTokens }),
      onCompaction: (beforeTokens, afterTokens) => host.emit({ type: 'compaction', beforeTokens, afterTokens }),
      onMemoryCandidate: (note) => host.emit({ type: 'memory_candidate', note }),
    },
  });

  return { outcome };
}

export const AGENT_EVENT_METHOD = METHODS.agentEvent;
