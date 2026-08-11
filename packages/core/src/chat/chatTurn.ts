import type { ChatMessage, Provider } from '../providers/types.js';
import type { ToolCall, ToolDefinition, ToolResult } from '../agent/tools.js';

/**
 * A chat-view turn: the ask-mode read-only tool loop, plus the plain streamed
 * reply it falls back to.
 *
 * This is deliberately **not** `runAgent`. A chat turn ends with prose, while
 * the agent loop requires structural termination through `finish(summary)`
 * (packages/core/src/agent/loop.ts:253, :539) and treats a tool-free reply as
 * a protocol violation worth up to `MAX_NUDGES` extra round-trips
 * (`:595-609`). Routing chat through that would cost up to six model calls per
 * message and would move the answer into `finish`'s summary argument, where it
 * streams as `kind: 'tool'` deltas rather than text — i.e. the reply would stop
 * appearing as it types. The two loops share a transport, not a termination
 * policy.
 *
 * Extracted verbatim from ChatViewProvider.runAskWithTools
 * (packages/vscode/src/chatViewProvider.ts:1212-1324 before this moved) and
 * the plain-reply path at `:1161-1173`. Everything host-shaped is injected:
 * tool execution stays with the host's own executor, and chip labelling stays
 * host-side because only the host knows how to render it — the same split the
 * agent path already uses (packages/vscode/src/agent/controller.ts:441-467).
 */

/** Ask-mode read-only tool loop: a few search/read rounds, then a forced final answer. */
export const MAX_ASK_TOOL_ITERATIONS = 4;

/**
 * Withdrawing tools silently invites a model mid-tool-use habit to
 * free-associate fake "[Tool call: ...]" text instead of wrapping up —
 * tell it plainly instead.
 */
export const TOOLS_ENDED_NOTICE =
  'Tool access has ended for this turn. Give your final, complete answer now in ' +
  'plain text based on what you already found — do not mention, reference, or ' +
  'write out any further tool calls.';

export interface ChatTurnEvents {
  /** Answer tokens, in order. */
  onDelta(text: string): void;
  /** Raw call — the host derives its own description for the chip. */
  onToolCall(call: ToolCall): void;
  onToolResult(result: ToolResult): void;
}

export interface ChatTurnOptions {
  provider: Provider;
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens: number;
  signal: AbortSignal;
  /**
   * Read-only tools for the ask loop. Empty or absent → a plain streamed
   * reply, which is what the caller wants when the model can't do native tool
   * calls, when there's no workspace, or when no read tools survive filtering
   * (the three `undefined` returns the extracted method had).
   *
   * The caller is responsible for the read-only part: `runAgent`'s permission
   * gate is what normally keeps a turn from mutating anything, and this loop
   * deliberately has none, because with an all-`read` toolset the gate never
   * fires anyway (loop.ts:335, :339).
   */
  tools?: ToolDefinition[];
  /** Runs a tool host-side. Required for the ask loop; absent → plain reply. */
  execute?(call: ToolCall): Promise<ToolResult>;
  maxToolIterations?: number;
  events: ChatTurnEvents;
}

export interface ChatTurnResult {
  finishReason?: string;
}

export async function runChatTurn(opts: ChatTurnOptions): Promise<ChatTurnResult> {
  return (await runAskWithTools(opts)) ?? (await streamPlainReply(opts));
}

/**
 * Lets the model call read/search tools — never write/execute/destructive
 * ones, so this never needs a permission prompt — to ground its answer in real
 * code instead of guessing. Bounded iterations; the last attempt always omits
 * tools so the turn is guaranteed to end in a normal answer rather than
 * looping forever.
 *
 * Returns undefined when there are no tools to offer, so the caller falls back
 * to a plain streamed reply.
 */
async function runAskWithTools(opts: ChatTurnOptions): Promise<ChatTurnResult | undefined> {
  const { provider, model, temperature, maxTokens, signal, events, execute } = opts;
  const tools = opts.tools ?? [];
  if (tools.length === 0 || !execute) return undefined;

  const maxIterations = opts.maxToolIterations ?? MAX_ASK_TOOL_ITERATIONS;
  const convo = [...opts.messages];

  for (let i = 0; i < maxIterations; i++) {
    const offerTools = i < maxIterations - 1;
    if (!offerTools) convo.push({ role: 'user', content: TOOLS_ENDED_NOTICE });

    if (!offerTools && provider.chatStreamed) {
      const res = await provider.chatStreamed(
        { model, messages: convo, temperature, maxTokens, signal },
        (text, kind) => {
          if (!kind || kind === 'text') events.onDelta(text);
        },
      );
      return { finishReason: res.finishReason };
    }

    const res = await provider.chat({
      model,
      messages: convo,
      tools: offerTools ? tools : undefined,
      temperature,
      maxTokens,
      signal,
    });

    if (offerTools && res.toolCalls && res.toolCalls.length > 0) {
      convo.push({
        role: 'assistant',
        content: res.content,
        toolCalls: res.toolCalls.map((c) => ({ id: c.id, name: c.name, args: c.args })),
      });
      for (const call of res.toolCalls) {
        const toolCall: ToolCall = { id: call.id, name: call.name, args: call.args };
        events.onToolCall(toolCall);
        // Same guard as the core agent loop: a failed tool call (e.g. the
        // model guessing a nonexistent path) becomes an error result the
        // model can self-correct from, never an exception that kills the
        // whole ask turn.
        let result: ToolResult;
        try {
          result = call.argsParseError
            ? {
                id: call.id,
                name: call.name,
                content: `Invalid JSON arguments: ${call.argsParseError}`,
                isError: true,
              }
            : await execute(toolCall);
        } catch (err) {
          result = {
            id: call.id,
            name: call.name,
            content: `Tool failed: ${err instanceof Error ? err.message : String(err)}`,
            isError: true,
          };
        }
        events.onToolResult(result);
        convo.push({ role: 'tool', content: result.content, toolCallId: call.id });
      }
      continue;
    }

    if (res.content) events.onDelta(res.content);
    return { finishReason: res.finishReason };
  }
  return undefined;
}

/** The turn when no tools are in play: stream the reply straight through. */
async function streamPlainReply(opts: ChatTurnOptions): Promise<ChatTurnResult> {
  let finishReason: string | undefined;
  const stream = opts.provider.streamChat({
    model: opts.model,
    messages: opts.messages,
    temperature: opts.temperature,
    maxTokens: opts.maxTokens,
    signal: opts.signal,
  });
  for await (const chunk of stream) {
    if (chunk.content) opts.events.onDelta(chunk.content);
    if (chunk.finishReason) finishReason = chunk.finishReason;
  }
  return { finishReason };
}

/**
 * Defensive net for the ask loop: strips fake "[Tool call: ...]" text a model
 * can still free-associate into its final answer despite the notice telling it
 * tools are gone. Best-effort — the response already streamed live before this
 * runs, so this only guarantees the stored/reloaded copy is clean.
 */
export function stripToolCallArtifacts(text: string): string {
  return text.replace(/\s*\[Tool call:[^\]]*\]/gi, '').replace(/\n{3,}/g, '\n\n').trim();
}
