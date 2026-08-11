import { runChatTurn } from '../chat/chatTurn.js';
import type { ToolCall, ToolResult } from '../agent/tools.js';
import type { Session } from './session.js';
import type { AgentEvent, ChatSendParams, ChatSendResult } from './protocol.js';

/**
 * The host-facing half of a chat turn. Much smaller than `RunHost`: an
 * all-`read` toolset means the permission and snapshot callbacks the agent
 * path needs are never reachable (`agent/loop.ts:335`, `:339` gate both on
 * `permission !== 'read'`), so `chat/send` genuinely has nothing to ask the
 * host beyond running a tool.
 */
export interface ChatHost {
  emit(event: AgentEvent): void;
  executeTool(call: ToolCall): Promise<ToolResult>;
  /**
   * The semantic index's answer for a `semantic_search` call, or undefined
   * when it has nothing. Chat offers the tool too (its read-only set includes
   * it), so it needs the same server-side dispatch the agent path has.
   */
  semanticSearch(query: string): Promise<string | undefined>;
}

/**
 * Runs a chat-view turn server-side.
 *
 * The loop is `runChatTurn` — the ask-mode loop the extension used to run
 * in-process, unchanged. All this adds is the wiring: resolve the profile to
 * a Provider from **this session's** keys, and translate the loop's callbacks
 * into the `agent/event` stream the hosts already render.
 */
export async function runChatForSession(
  session: Session,
  params: ChatSendParams,
  host: ChatHost,
  signal: AbortSignal,
): Promise<ChatSendResult> {
  const profileName = params.profileName ?? session.activeProfile;
  const resolved = session.providerFor(profileName);
  if (!resolved) throw new Error(`Unknown profile "${profileName}" for this session.`);

  return runChatTurn({
    provider: resolved.provider,
    model: params.model,
    messages: params.messages,
    temperature: params.temperature,
    maxTokens: params.maxTokens,
    signal,
    tools: params.tools,
    maxToolIterations: params.maxToolIterations,
    // Only wired when tools are actually offered, so a plain reply never
    // leaves a live tool channel dangling.
    execute:
      params.tools && params.tools.length > 0
        ? async (call) => {
            // Same split as the agent path: answered here when the index has
            // something, handed to the host's executor otherwise so its
            // text-search fallback still applies.
            if (call.name === 'semantic_search') {
              const formatted = await host.semanticSearch(String(call.args.query ?? ''));
              if (formatted) return { id: call.id, name: call.name, content: formatted };
            }
            return host.executeTool(call);
          }
        : undefined,
    events: {
      onDelta: (text) => host.emit({ type: 'text_delta', text }),
      onToolCall: (call) => host.emit({ type: 'tool_call', id: call.id, name: call.name, args: call.args }),
      onToolResult: (result) =>
        host.emit({
          type: 'tool_result',
          id: result.id,
          name: result.name,
          content: result.content,
          isError: result.isError,
        }),
    },
  });
}
