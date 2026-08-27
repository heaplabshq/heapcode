import type { ChatMessage, ChatResponse, Provider, TokenUsage } from '../providers/types.js';
import { isAbortError, isToolsUnsupported } from '../providers/errors.js';
import {
  COMPACTION_THRESHOLD,
  DEFAULT_CONTEXT_WINDOW,
  estimateMessagesTokens,
} from '../context/tokens.js';
import { buildFallbackAgentSystemPrompt, buildNativeAgentSystemPrompt } from './prompts.js';
import { formatToolResult, parseToolBlocks, REPAIR_PROMPT } from './textProtocol.js';
import {
  DENIED_RESULT_TEXT,
  FINISH_TOOL,
  wrapUntrusted,
  type ToolCall,
  type ToolDefinition,
  type ToolResult,
} from './tools.js';

export type AgentOutcome = 'done' | 'stopped' | 'max-iterations' | 'error' | 'planned' | 'incomplete';

export interface AgentEvents {
  /** Assistant narration/summary text (complete message, non-streamed path). */
  onText(text: string): void;
  onToolCall(call: ToolCall): void;
  onToolResult(result: ToolResult): void;
  /** The upfront numbered plan (when planning is enabled). */
  onPlan?(text: string): void;
  /** Streamed narration tokens; a message ends with onTextEnd. */
  onTextDelta?(text: string): void;
  onTextEnd?(): void;
  /** Streamed reasoning ("thinking") tokens from reasoning models. */
  onReasoningDelta?(text: string): void;
  onReasoningEnd?(): void;
  /** Cumulative chars of the tool call currently being generated. */
  onToolStream?(chars: number): void;
  /** Estimated prompt tokens vs the model's context window, per iteration. */
  onContextUsage?(usedTokens: number, windowTokens: number): void;
  /** Older turns were summarized to stay inside the context window. */
  onCompaction?(beforeTokens: number, afterTokens: number): void;
  /**
   * Tokens one provider call cost, as the endpoint reported them — fired per
   * model call, including the compaction summary and any sub-agent's turns,
   * so a host that adds them up gets the run's true total. Never fires for an
   * endpoint that reports nothing.
   */
  onUsage?(usage: TokenUsage): void;
  /**
   * A note the agent found worth remembering long-term (a convention,
   * constraint, or gotcha) — only fires when opts.proposeMemoryNote is set.
   * The host decides whether/how to persist it; core never writes files.
   */
  onMemoryCandidate?(note: string): void;
}

export interface AgentOptions {
  provider: Provider;
  model: string;
  task: string;
  /**
   * Prior conversation turns (user/assistant text only) inserted between the
   * system prompt and the current task, so follow-up messages ("ok do that",
   * "the second option") actually carry their context. Hosts should cap this
   * (recent turns, trimmed content) — a long history is subject to compaction
   * like any other transcript content.
   */
  history?: ChatMessage[];
  /** Images attached to the task (data: URLs) — needs a vision-capable model. */
  images?: string[];
  workspaceName: string;
  /**
   * Replaces the built-in coding-agent identity and rules — for hosts whose
   * agent is not a coding agent (heapbrowse drives a web page, not a repo, and
   * the default prompt would send it looking for files that do not exist).
   *
   * Only the identity half is replaced. The tool-calling protocol is still
   * appended by core, since it describes how this loop terminates and how calls
   * are emitted, which is core's contract rather than the host's business.
   */
  systemPrompt?: string;
  tools: ToolDefinition[];
  /** True → OpenAI-native function calling; false → structured-text fallback. */
  nativeToolCalls: boolean;
  execute(call: ToolCall): Promise<ToolResult>;
  /** Resolve to false to deny; a denial is reported to the model, not fatal. */
  /**
   * Resolve to false to deny; a denial is reported to the model, not fatal.
   *
   * A host may also return `{ allowed: false, reason }` when it refused for a
   * reason of its own rather than because the user said no — a policy block, a
   * rate ceiling, an origin that is off limits. The default message says the
   * *user* denied it, and a model told that will keep looking for a route the
   * user might accept. Told it hit a ceiling, it stops.
   */
  requestPermission(
    call: ToolCall,
    tool: ToolDefinition,
  ): Promise<boolean | { allowed: boolean; reason?: string }>;
  /**
   * Called for non-read tools right after a permission grant, before execute()
   * — e.g. to snapshot the workspace for fine-grained rollback (PLAN.md M8).
   * Best-effort: never blocks or fails the tool call.
   */
  beforeToolCall?(call: ToolCall, tool: ToolDefinition): Promise<void>;
  events: AgentEvents;
  /** Ask for a numbered plan first, then execute it step by step. */
  plan?: boolean;
  /**
   * With `plan` set: stop right after the plan is produced (outcome
   * `'planned'`) instead of auto-continuing into execution. The host resumes
   * by calling runAgent again with `resumePlan` set to the approved text.
   */
  planOnly?: boolean;
  /**
   * Resume a previously-produced plan straight into execution, skipping the
   * plan-generation call — the companion to a prior `planOnly` call.
   */
  resumePlan?: string;
  /** On a clean finish, ask the model if anything's worth remembering long-term (see onMemoryCandidate). Off (no extra call at all) unless set. */
  proposeMemoryNote?: boolean;
  /**
   * Block `finish` (once, with a nudge) if a write/edit tool ran since the
   * last successful call to a `verifies`-marked tool (e.g. a test runner).
   * No-op unless the tool list actually includes a `verifies` tool.
   */
  requireVerificationBeforeFinish?: boolean;
  /** Model turns this run may take before it is cut off. Defaults to DEFAULT_MAX_ITERATIONS. */
  maxIterations?: number;
  /**
   * At the step limit, ask the user (through `ask_user`) whether to keep going
   * instead of just stopping. Set by hosts where a human is watching; leave off
   * where nobody can answer, since an unanswered question just stops anyway.
   */
  askToContinueAtLimit?: boolean;
  temperature?: number;
  maxTokens?: number;
  /** Model context window in tokens; drives usage reporting and compaction. */
  contextWindow?: number;
  signal?: AbortSignal;
}

const PLAN_REQUEST =
  'Before doing anything, write a concise plan for this task, scaled to what it actually ' +
  'needs. A simple question or lookup needs only 1-2 steps — do not pad it out. Reserve a ' +
  'longer numbered plan (up to ~8 steps) for genuinely multi-step build/edit work. ' +
  'Plain text only — do NOT call any tools yet.';

/**
 * Both nudges below explicitly scope "continue" to the CURRENT request
 * (the last user message), not to this conversation's history in general.
 * Observed live: after the model answered an unrelated read-only question
 * in full (a legitimate finish), this nudge alone — "you are not done,
 * continue working" — with no such scoping led it to resume a stale,
 * already-abandoned task from earlier in the same conversation instead of
 * just finishing the question it had actually just answered. It happened
 * twice more later in the same session on other unrelated turns.
 */
const CONTINUE_NUDGE =
  'You are not done with the CURRENT request (the last user message) — continue working on THAT only. ' +
  'Do not resume or "clean up" an unrelated, unfinished earlier task from this conversation unless the ' +
  'current request actually asks for it. Call the next tool NOW in your reply. ' +
  'Do not describe what you will do; do it. Reply without a tool call ONLY when the current request is fully complete.';

/**
 * Shown once when a run drops from native tool calling to the text protocol.
 * Says what happened and how to make it stick, because the automatic recovery
 * costs a round trip on every run until the profile is changed.
 */
const TOOL_PROTOCOL_FALLBACK_NOTICE =
  'This model rejected native tool calling, so heapcode switched to its text-based tool protocol ' +
  'for the rest of this run. Tool support comes from the model\'s chat template, so this is a ' +
  'property of the model rather than of the server. To skip this retry in future, set ' +
  '`"capabilities": {"nativeToolCalls": false}` on the profile — "/nativetools off" in the terminal does it for you.';

const MAX_NUDGES = 4;

/**
 * Sent when a reply contains a tool call written as text while the session is
 * using native tool calling. Names the offending shapes explicitly: a model
 * that emitted one is demonstrably fluent in it, and a generic "use the tool
 * API" instruction leaves it guessing at what it did wrong.
 */
const NATIVE_TOOL_CALL_REPAIR =
  'You wrote a tool call as plain text (e.g. <tool_call>, <function=…>, or <tool name=…>). ' +
  'This endpoint supports real tool calling — emit the call through the tool-calling API instead, ' +
  'as a structured tool_calls entry, not as text in your message content. ' +
  'Do not repeat the text form; make the actual call now.';

const FINISH_REMINDER =
  'If the CURRENT request (the last user message) is fully complete, call the finish tool with a summary. ' +
  'Otherwise, continue working on THAT request by calling the next tool — do not switch to an unrelated ' +
  'unfinished task from earlier in this conversation unless asked.';

/** A tool-free reply that reads as a real completion — accept without ceremony. */
function looksFinished(text: string): boolean {
  return /\b(task (is |was )?(now )?complete|completed successfully|all done|everything (is )?(done|in place)|nothing (more|else|further) to do|no changes (were )?(needed|required))\b/i.test(
    text,
  );
}

const TRUNCATED_NUDGE =
  'Your reply was cut off by the output token limit. Continue the work with SMALLER steps: ' +
  'write large files in sections (write_file for the first part, then edit_file to extend), ' +
  'and keep each tool call comfortably small.';

/**
 * A tool-free reply that ends by asking the user something is a turn
 * boundary — hand control back instead of nudging the model onward. A nudged
 * model answers its own question and picks an option on the user's behalf
 * (observed live: "Would you like to: 1… 2… 3…" followed by "I'll start by…"
 * in the same session with no user input in between).
 */
function asksTheUser(text: string): boolean {
  const trimmed = text.trim();
  if (/[?？]\s*$/.test(trimmed)) return true;
  const tail = trimmed.slice(-400).toLowerCase();
  return /\b(would you like|do you want|shall i|should i|which (one|option|file|approach)|let me know (which|what|how|if)|please (choose|pick|confirm|clarify))\b/.test(tail);
}

/**
 * A tool-free reply that describes having just observed an action's outcome
 * ("ran successfully", "exit code 0", "confirmed that...") is claiming
 * knowledge it cannot actually have — this branch runs precisely when NO
 * tool call happened this turn, so there is no real result to be reporting.
 * Observed live: a local model narrated "I will remove this duplicate line
 * ... The test suite ran successfully with an exit code of 0, confirming
 * that removing the redundant line did not cause any issues" as one single
 * tool-free reply — the file was never touched. Never trust this as a
 * finish signal, even if it also happens to match looksFinished.
 *
 * The same applies to claims of delegated/sub-agent work — observed live:
 * "The delegated investigation into src/strings.js is complete. The file
 * contains two exported functions..." with delegate_task never called (it
 * was not even offered — sub-agents were disabled); the "findings" were
 * pattern-matched from the repo map already in context.
 */
function claimsUnverifiedResult(text: string): boolean {
  if (
    /\b(exit code \d|tests? (passed|failed)|ran successfully|test suite (ran|passed)|confirmed (that|it)|verified (that|it)|no (issues|errors) (were )?(found|occurred))\b/i.test(
      text,
    )
  ) {
    return true;
  }
  return /\b(delegat(ed|ion)|sub-?agents?)\b[\s\S]{0,80}?\b(complete[d]?|done|finished|found|returned|report(s|ed)?)\b/i.test(
    text,
  );
}

const UNVERIFIED_RESULT_NUDGE =
  'You just described a result (a test run, an edit, an outcome) but did not actually call a tool this turn — ' +
  'you cannot know the outcome of an action you have not taken. Call the tool now. Never state what a tool ' +
  'result was before you have actually received it.';

/**
 * A reply still announcing work it is ABOUT to do ("I will first add…",
 * "I am adding…", "I'll place it…"). Only consulted at nudge EXHAUSTION,
 * never to gate the nudges themselves (the "default to not-finished" rule
 * covers that without any phrase list): a model that spent the entire nudge
 * budget narrating intent never acted, so the task verifiably did not
 * happen — the one case where accepting the reply as 'done' anyway would
 * silently report success on a skipped task (the original live incident).
 */
function announcesIntent(text: string): boolean {
  return /\b(i['’]ll|i (will|shall)|i am (now |currently )?(going|about) to|i am \w+ing|let me (now |first )?(start|begin|add|create|write|edit|fix|implement|run|check|read|investigate))\b/i.test(
    text,
  );
}

const MAX_REPAIRS = 3;

/**
 * Some models (observed live: a local Gemma fine-tune) consistently wrap
 * their tool arguments in an extra envelope key — `{"arg": {"pattern": "x"}}`
 * instead of `{"pattern": "x"}` — for every call, never self-correcting even
 * after repeated "Missing X argument" errors. Unwraps that shape precisely:
 * only when there's exactly one top-level key, that key doesn't match any of
 * the tool's own declared parameter names (so a tool that legitimately takes
 * one argument, e.g. semantic_search's `query`, is never touched), and the
 * value under it is itself a plain object. A tool call that already matches
 * its schema is always returned unchanged.
 */
function unwrapMisenvelopedArgs(args: Record<string, unknown>, tool: ToolDefinition): Record<string, unknown> {
  const keys = Object.keys(args);
  if (keys.length !== 1) return args;
  const onlyKey = keys[0]!;
  const schema = tool.parameters as { properties?: Record<string, unknown> } | undefined;
  const declared = Object.keys(schema?.properties ?? {});
  if (declared.includes(onlyKey)) return args;
  const nested = args[onlyKey];
  if (nested && typeof nested === 'object' && !Array.isArray(nested)) return nested as Record<string, unknown>;
  return args;
}

const MEMORY_NOTE_PROMPT =
  'Is there anything about this codebase worth remembering long-term — a non-obvious ' +
  'convention, constraint, or gotcha you discovered while working on this task? ' +
  'Reply with ONLY the note itself (1-3 sentences, plain text, no preamble), or reply ' +
  'with exactly "NONE" if there is nothing worth recording.';

/**
 * How many model turns one run may take before it is cut off.
 *
 * One iteration is one model turn, so a batch of parallel tool calls costs
 * one and a read-then-edit-then-test cycle costs three. Real multi-file work
 * spends them fast: a session that wrote ten test files, running the suite
 * after each, blew through the old cap of 25 every time and ended on the
 * iteration-limit summary below — which, being a list of what's done and what
 * remains, reads exactly like the agent stopping to plan instead of working.
 * That summary is the honest report of a cut-off run, so the fix is a ceiling
 * high enough that reaching it means something really is looping, not that
 * the task was merely large. It stays a ceiling: a user can lower it, the run
 * still compacts on the way, and Esc still stops it.
 */
export const DEFAULT_MAX_ITERATIONS = 100;

/** The two answers offered at the step limit; the first one buys another budget. */
export const KEEP_GOING_OPTION = 'Keep going';
export const STOP_HERE_OPTION = 'Stop here';

/**
 * Whether an answer to the step-limit question means "keep going".
 *
 * Anything unrecognized is a no, because the cost of guessing wrong in that
 * direction is another budget of model calls the user didn't ask for — and
 * "no answer" (a headless run, a closed tab, an idle timeout) arrives here as
 * unrecognized text too. Negations are checked FIRST: "don't continue" and "no,
 * keep going with something else" both contain an affirmative word, and reading
 * only for that word turns a refusal into consent.
 */
export function saidKeepGoing(answer: string): boolean {
  const text = answer
    .replace(/^user answered:/i, '')
    .trim()
    .toLowerCase();
  if (!text) return false;
  if (/^(no|nope|nah|stop|halt|abort|cancel|quit|don'?t|do not)\b/.test(text)) return false;
  return /^(keep going|keep working|continue|carry on|go on|proceed|resume|yes|yep|yeah|y|ok|okay|sure)\b/.test(text);
}

export async function runAgent(opts: AgentOptions): Promise<AgentOutcome> {
  const {
    provider,
    model,
    tools,
    events,
    maxIterations = DEFAULT_MAX_ITERATIONS,
    signal,
  } = opts;

  /**
   * Mutable for the life of the run: a model whose chat template has no tool
   * support rejects any request carrying `tools`, and the presets for local
   * servers assume native tool calling because most hosted endpoints have it.
   * Rather than failing the run over a protocol mismatch, the first such
   * rejection flips this and the turn is retried through the text protocol —
   * see the catch in respondLive.
   */
  let nativeToolCalls = opts.nativeToolCalls;
  let toolProtocolFellBack = false;

  const toolsByName = new Map(tools.map((t) => [t.name, t]));
  const toolsWithFinish = [...tools, FINISH_TOOL];

  // Prefer streaming transport: reasoning models produce bytes immediately but
  // can exceed any sane non-streaming timeout on their full response.
  const buildRequest = (msgs: ChatMessage[], withTools: boolean) => ({
    model,
    messages: msgs,
    tools: withTools && nativeToolCalls ? toolsWithFinish : undefined,
    temperature: opts.temperature ?? 0.2,
    maxTokens: opts.maxTokens,
    signal,
  });

  /**
   * Streamed turn. Reasoning tokens and tool-call generation progress always
   * stream to events; narration text streams live only when `liveText` (plan
   * turns buffer it for the plan card; fallback mode buffers because content
   * contains raw <tool> blocks).
   * Returns whether narration was already delivered via deltas.
   */
  const respondLive = async (
    msgs: ChatMessage[],
    withTools: boolean,
    liveText: boolean,
  ): Promise<{ response: ChatResponse; streamed: boolean }> => {
    // One shot at recovering from "this model can't do tool calling": drop to
    // the text protocol, rewrite the system prompt to describe it, and repeat
    // the same turn. Only once per run, and only while still native.
    const recoverFromUnsupportedTools = (err: unknown): boolean => {
      if (toolProtocolFellBack || !nativeToolCalls || !withTools) return false;
      const message = err instanceof Error ? err.message : String(err);
      if (!isToolsUnsupported(message)) return false;
      toolProtocolFellBack = true;
      nativeToolCalls = false;
      messages[0] = { role: 'system', content: buildFallbackAgentSystemPrompt(opts.workspaceName, toolsWithFinish) };
      events.onText(TOOL_PROTOCOL_FALLBACK_NOTICE);
      return true;
    };

    /** Every turn's response passes through here, so usage is counted in exactly one place. */
    const counted = (response: ChatResponse): ChatResponse => {
      if (response.usage) events.onUsage?.(response.usage);
      return response;
    };

    if (!provider.chatStreamed) {
      try {
        return { response: counted(await provider.chat(buildRequest(msgs, withTools))), streamed: false };
      } catch (err) {
        if (!recoverFromUnsupportedTools(err)) throw err;
        return { response: counted(await provider.chat(buildRequest(msgs, false))), streamed: false };
      }
    }
    let streamed = false;
    let reasoned = false;
    let toolChars = 0;
    const onDelta = (text: string, kind: 'text' | 'reasoning' | 'tool' = 'text'): void => {
      if (kind === 'reasoning') {
        reasoned = true;
        events.onReasoningDelta?.(text);
        return;
      }
      if (kind === 'tool') {
        toolChars += text.length;
        events.onToolStream?.(toolChars);
        return;
      }
      if (liveText && nativeToolCalls) {
        streamed = true;
        events.onTextDelta?.(text);
      }
    };
    let response: ChatResponse;
    try {
      response = await provider.chatStreamed(buildRequest(msgs, withTools), onDelta);
    } catch (err) {
      if (!recoverFromUnsupportedTools(err)) throw err;
      // withTools is now moot — nativeToolCalls is false, so buildRequest
      // omits the array either way; passing false says so at the call site.
      response = await provider.chatStreamed(buildRequest(msgs, false), onDelta);
    }
    if (reasoned) events.onReasoningEnd?.();
    if (streamed) events.onTextEnd?.();
    return { response: counted(response), streamed };
  };
  const systemPrompt = nativeToolCalls
    ? buildNativeAgentSystemPrompt(opts.workspaceName, opts.systemPrompt)
    : buildFallbackAgentSystemPrompt(opts.workspaceName, toolsWithFinish, opts.systemPrompt);

  const messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt },
    ...(opts.history ?? []).map((m): ChatMessage => ({ role: m.role, content: m.content })),
    { role: 'user', content: opts.task, images: opts.images },
  ];

  // Tests-dirty tracking for requireVerificationBeforeFinish (PLAN.md M7.3):
  // any successful write flips it on; any successful `verifies` call clears it.
  const hasVerifyTool = tools.some((t) => t.verifies);
  let dirtySinceVerify = false;

  const execTool = async (rawCall: ToolCall): Promise<ToolResult> => {
    const tool = toolsByName.get(rawCall.name);
    if (!tool) {
      return {
        id: rawCall.id,
        name: rawCall.name,
        content: `Unknown tool "${rawCall.name}". Available: ${tools.map((t) => t.name).join(', ')}.`,
        isError: true,
      };
    }
    const call: ToolCall = { ...rawCall, args: unwrapMisenvelopedArgs(rawCall.args, tool) };
    events.onToolCall(call);
    let result: ToolResult;
    const decision =
      tool.permission === 'read' ? true : await opts.requestPermission(call, tool);
    const allowed = typeof decision === 'boolean' ? decision : decision.allowed;
    if (!allowed) {
      const reason = typeof decision === 'boolean' ? undefined : decision.reason;
      result = {
        id: call.id,
        name: call.name,
        content: reason ?? DENIED_RESULT_TEXT,
        isError: true,
      };
    } else {
      try {
        if (tool.permission !== 'read') await opts.beforeToolCall?.(call, tool);
        result = await opts.execute(call);
        if (tool.untrustedOutput && !result.isError) {
          result = { ...result, content: wrapUntrusted(result.content) };
        }
        if (!result.isError) {
          if (tool.verifies) dirtySinceVerify = false;
          else if (tool.permission === 'write') dirtySinceVerify = true;
        }
      } catch (err) {
        result = {
          id: call.id,
          name: call.name,
          content: `Tool failed: ${err instanceof Error ? err.message : String(err)}`,
          isError: true,
        };
      }
    }
    // The id belongs to the CALL, not to whatever the host chose to put on the
    // result: it is what pairs the `role: 'tool'` message back to its
    // `tool_calls` entry on the wire. Hosts that build a result from scratch
    // have dropped it (the CLI's run_command returned `id: ''`), and the
    // resulting tool message went out with no tool_call_id at all — OpenRouter
    // answered `400 "Provider returned error"` (upstream: "missing field
    // `tool_call_id`") on the *next* request, so every session died the first
    // time the agent ran a shell command. Restamp here, once, for every host.
    result = { ...result, id: call.id };
    events.onToolResult(result);
    return result;
  };

  let repairs = 0;
  let nudges = 0;
  let finishReminderSent = false;
  let verificationNudges = 0;
  const MAX_VERIFICATION_NUDGES = 2;
  const VERIFY_NUDGE =
    'Files changed since the last passing test run. Run the tests (run_tests) before finishing.';

  /**
   * True when finish should be deferred — pushes a nudge as a side effect (call
   * sites `continue` on true). `nativeFinishCall` is only for the native
   * protocol's real `finish` tool call: that path must pair its declared
   * `toolCalls` entry with exactly one `role: 'tool'` message, or the next
   * request violates the wire protocol most native tool-calling APIs enforce.
   * The fallback (text) protocol and the tool-free "looks finished" paths have
   * no such pairing to maintain, so they get a plain nudge instead.
   */
  const shouldDeferFinish = (
    content: string,
    nativeFinishCall?: { id: string; name: string; args: Record<string, unknown> },
  ): boolean => {
    if (!opts.requireVerificationBeforeFinish || !hasVerifyTool || !dirtySinceVerify) return false;
    if (verificationNudges >= MAX_VERIFICATION_NUDGES) return false;
    verificationNudges++;
    if (nativeFinishCall) {
      messages.push({ role: 'assistant', content, toolCalls: [nativeFinishCall] });
      messages.push({ role: 'tool', content: VERIFY_NUDGE, toolCallId: nativeFinishCall.id });
    } else {
      if (content.trim()) messages.push({ role: 'assistant', content });
      messages.push({ role: 'user', content: VERIFY_NUDGE });
    }
    return true;
  };

  const contextWindow = opts.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
  // Compact when prompt + a reply would cross the threshold. Cap the output
  // reservation at a quarter of the window so small windows still get most
  // of their space for the transcript.
  const reservedOutput = Math.min(opts.maxTokens ?? 4_096, contextWindow / 4);
  const compactionBudget = Math.max(2_000, contextWindow * COMPACTION_THRESHOLD - reservedOutput);

  /**
   * Context compaction: when the transcript outgrows the window, summarize
   * the middle (keeping the system prompt, the task, and the most recent
   * exchanges verbatim) and splice the summary in. Best-effort — on failure
   * the session continues and the provider's own error surfaces later.
   */
  const compactIfNeeded = async (): Promise<void> => {
    const before = estimateMessagesTokens(messages);
    events.onContextUsage?.(before, contextWindow);
    if (before < compactionBudget) return;

    // Keep system + task at the head and the last ~8 messages at the tail;
    // never split an assistant tool-call from its tool results.
    let tailStart = Math.max(2, messages.length - 8);
    while (tailStart < messages.length && messages[tailStart]!.role === 'tool') tailStart++;
    const middle = messages.slice(2, tailStart);
    if (middle.length < 4) return;

    const transcript = middle
      .map((m) => {
        const calls = m.toolCalls ? ` [called: ${m.toolCalls.map((c) => c.name).join(', ')}]` : '';
        return `${m.role}: ${m.content.slice(0, 1_500)}${calls}`;
      })
      .join('\n');
    try {
      const res = await provider.chat({
        model,
        messages: [
          {
            role: 'system',
            content: 'You compress coding-agent transcripts. Reply with only the summary.',
          },
          {
            role: 'user',
            content:
              'Summarize this transcript so the agent can continue seamlessly. Preserve: files ' +
              'read/modified (and what was learned or changed in each), commands run with their ' +
              'outcomes, decisions made, errors hit, and exact current progress on the task. ' +
              `Max 500 words.\n\n${transcript}`,
          },
        ],
        maxTokens: 1_000,
        temperature: 0,
        signal,
      });
      if (res.usage) events.onUsage?.(res.usage);
      const summary = res.content.trim();
      if (!summary) return;
      messages.splice(2, tailStart - 2, {
        role: 'user',
        content: `[Earlier work compacted to save context]\n${summary}\n[Continue the task from here.]`,
      });
      const after = estimateMessagesTokens(messages);
      events.onCompaction?.(before, after);
      events.onContextUsage?.(after, contextWindow);
    } catch (err) {
      if (isAbortError(err)) throw err;
      // best-effort
    }
  };

  /** One extra no-tools turn so every session ends with a human-readable conclusion. */
  const summarize = async (prompt: string): Promise<void> => {
    try {
      const { response, streamed } = await respondLive(
        [...messages, { role: 'user', content: prompt }],
        false,
        true,
      );
      if (!streamed && response.content.trim()) events.onText(response.content);
    } catch {
      // Summary is best-effort — never turn a finished session into an error.
    }
  };

  /** Session-to-memory distillation: proposes a note; the host decides whether to keep it. */
  const proposeMemoryNote = async (): Promise<void> => {
    try {
      const { response } = await respondLive(
        [...messages, { role: 'user', content: MEMORY_NOTE_PROMPT }],
        false,
        false,
      );
      const note = response.content.trim();
      if (note && !/^none$/i.test(note)) events.onMemoryCandidate?.(note);
    } catch {
      // Best-effort — never turn a finished session into an error.
    }
  };

  /** Every clean-finish return path goes through here so memory distillation runs exactly once, only on success. */
  const finish = async (): Promise<'done'> => {
    if (opts.proposeMemoryNote) await proposeMemoryNote();
    return 'done';
  };

  try {
    if (opts.resumePlan) {
      // Companion to a prior planOnly call: reconstruct the transcript as if
      // the plan had just been produced and approved, then fall straight
      // through to the tool-calling loop below.
      messages.push({ role: 'user', content: PLAN_REQUEST });
      messages.push({ role: 'assistant', content: opts.resumePlan });
      messages.push({
        role: 'user',
        content:
          'The plan above was approved. Now execute it step by step using tools, starting with ' +
          'step 1. Briefly state which step you are on as you go.',
      });
    } else if (opts.plan) {
      const { response: planRes } = await respondLive(
        [...messages, { role: 'user', content: PLAN_REQUEST }],
        false,
        false, // plan text renders as a card, but reasoning still streams live
      );
      const planText = planRes.content.trim();
      if (planText) {
        events.onPlan?.(planText);
        if (opts.planOnly) return 'planned';
        messages.push({ role: 'user', content: PLAN_REQUEST });
        messages.push({ role: 'assistant', content: planText });
        messages.push({
          role: 'user',
          content:
            'Good. Now execute the plan step by step using tools, starting with step 1. ' +
            'Briefly state which step you are on as you go.',
        });
      }
    }

    /**
     * Steps granted so far. Starts at `maxIterations` and grows by that much
     * again each time the user says to keep going — every extension costs a
     * human answer, which is what bounds it.
     */
    let budget = maxIterations;

    /**
     * At the limit, ask rather than just stop.
     *
     * Routed through `ask_user` so this needs no new protocol method and no
     * new UI: every host already renders that question, already bounds the
     * wait, and already answers it with "nobody is here" when nobody is (a
     * headless run, a closed tab) — which lands as a no. Hosts that can't ask
     * leave `askToContinueAtLimit` off and behave exactly as before.
     *
     * Why continuing IN the run matters, rather than leaving the user to send
     * "continue" afterwards: only the summary survives into the conversation.
     * The run's own transcript — every file read, every test result — is
     * discarded when it returns, so a follow-up message starts the model over
     * from a paragraph describing work it can no longer see.
     */
    const askForMoreSteps = async (used: number): Promise<boolean> => {
      if (!opts.askToContinueAtLimit || !toolsByName.has('ask_user')) return false;
      const result = await execTool({
        id: `steps_${used}`,
        name: 'ask_user',
        args: {
          question:
            `I've used all ${used} steps allowed for this run and the task isn't finished yet. ` +
            `Keep going for another ${maxIterations}?`,
          options: [KEEP_GOING_OPTION, STOP_HERE_OPTION],
          // Not a gate on an action: if the user has stepped away, the right
          // outcome is the one that costs nothing — stop and report.
          blocksAction: false,
        },
      });
      if (result.isError || !saidKeepGoing(result.content)) return false;
      // A plain user message, not a tool result: the model never made this
      // call, and inventing a `tool_calls` entry to pair a result to is how
      // strict providers start rejecting the whole transcript.
      messages.push({
        role: 'user',
        content:
          `You reached this run's step limit and I said to keep going — you have another ${maxIterations} steps. ` +
          'Pick the CURRENT task up exactly where you left off: call the next tool now. ' +
          'Do not start over, and do not summarize instead of working.',
      });
      return true;
    };

    for (let iteration = 0; ; iteration++) {
      if (iteration >= budget) {
        if (!(await askForMoreSteps(iteration))) break;
        budget += maxIterations;
      }
      if (signal?.aborted) return 'stopped';
      await compactIfNeeded();

      const { response, streamed } = await respondLive(messages, true, true);

      if (nativeToolCalls) {
        // Structural termination: finish(summary) ends the session.
        const finishCall = response.toolCalls?.find((c) => c.name === FINISH_TOOL.name);
        if (finishCall) {
          if (!streamed && response.content.trim()) events.onText(response.content);
          const summary = String(finishCall.args.summary ?? '').trim();
          if (summary) events.onText(summary);
          else if (!response.content.trim()) {
            await summarize('Summarize what you did and whether the task is complete.');
          }
          if (shouldDeferFinish(response.content, finishCall)) continue;
          return finish();
        }
        if (response.toolCalls && response.toolCalls.length > 0) {
          if (!streamed && response.content.trim()) events.onText(response.content);
          messages.push({
            role: 'assistant',
            content: response.content,
            toolCalls: response.toolCalls.map((c) => ({ id: c.id, name: c.name, args: c.args })),
          });
          for (const requested of response.toolCalls) {
            const result = requested.argsParseError
              ? {
                  id: requested.id,
                  name: requested.name,
                  content: `Invalid JSON in tool arguments: ${requested.argsParseError}. Call the tool again with valid JSON.`,
                  isError: true,
                }
              : await execTool({ id: requested.id, name: requested.name, args: requested.args });
            // Pair off the call's own id (as chat/chatTurn.ts does), never the
            // result's — see execTool.
            messages.push({ role: 'tool', content: result.content, toolCallId: requested.id });
          }
          continue;
        }
        // Truncated reply (output token cap) → the model never got to its tool
        // call. Push it to continue in smaller steps.
        if (response.finishReason === 'length' && nudges < MAX_NUDGES) {
          nudges++;
          if (!streamed && response.content.trim()) events.onText(response.content);
          messages.push({ role: 'assistant', content: response.content });
          messages.push({ role: 'user', content: TRUNCATED_NUDGE });
          continue;
        }
        // The model wrote a tool call as prose instead of emitting a real one.
        // Some open-weight models do this no matter what the tools parameter
        // says — they were fine-tuned on a textual dialect and fall back to it
        // (a live Nemotron run emitted `<tool_call><function=run_command>…`
        // and the loop, seeing no native call, nudged until it gave up on a
        // task the model was actively trying to perform).
        //
        // Asking for a properly-formed call is tried first, because the native
        // protocol is the one this session is actually configured for. Only
        // when the model has been told and still repeats itself is the parsed
        // call executed — by then "it won't comply" is established, and
        // refusing to act on an unambiguous request the user can still see and
        // approve (every tool goes through the permission engine either way)
        // just reproduces the dead end this exists to fix.
        const textual = parseToolBlocks(response.content);
        if (textual.calls.length > 0 && !textual.calls[0]!.parseError) {
          if (repairs < MAX_REPAIRS) {
            repairs++;
            if (!streamed && response.content.trim()) events.onText(response.content);
            messages.push({ role: 'assistant', content: response.content });
            messages.push({ role: 'user', content: NATIVE_TOOL_CALL_REPAIR });
            continue;
          }
          const call = textual.calls[0]!;
          if (!streamed && textual.narration.trim()) events.onText(textual.narration);
          messages.push({ role: 'assistant', content: response.content });
          const result = await execTool({ id: `call_${iteration}`, name: call.name, args: call.args ?? {} });
          messages.push({ role: 'user', content: formatToolResult(result.name, result.content) });
          continue;
        }

        // A question addressed to the user beats every nudge below: the reply
        // is a turn boundary, and nudging would make the model answer itself.
        const awaitingUser = asksTheUser(response.content);
        // Default to NOT finished: a tool-free reply only ends the task
        // outright when it clearly reads as complete (looksFinished) AND
        // isn't itself claiming a result it couldn't actually have (no tool
        // call happened this turn — see claimsUnverifiedResult). Nudging is
        // the safe default here, not the exception — a narrower "does this
        // specific phrasing announce more work" check used to gate this
        // (looksUnfinished), but that whack-a-mole regex missed real
        // phrasings ("I will first add…", "I am adding…") a live local
        // model used, silently ending a task after one reply that never
        // called a tool. Worst case of over-nudging is a few extra turns
        // before MAX_NUDGES is exhausted, not a wrong (or fabricated) answer.
        const unverified = claimsUnverifiedResult(response.content);
        const trustworthyFinish = looksFinished(response.content) && !unverified;
        if (!awaitingUser && !trustworthyFinish && nudges < MAX_NUDGES) {
          nudges++;
          if (!streamed && response.content.trim()) events.onText(response.content);
          messages.push({ role: 'assistant', content: response.content });
          messages.push({ role: 'user', content: unverified ? UNVERIFIED_RESULT_NUDGE : CONTINUE_NUDGE });
          continue;
        }
        // Tool-free and not clearly finished: protocol violation — remind once
        // that ending goes through finish(summary).
        if (!awaitingUser && !trustworthyFinish && !finishReminderSent) {
          finishReminderSent = true;
          if (!streamed && response.content.trim()) events.onText(response.content);
          messages.push({ role: 'assistant', content: response.content });
          messages.push({ role: 'user', content: unverified ? UNVERIFIED_RESULT_NUDGE : FINISH_REMINDER });
          continue;
        }
        // Nudges AND the finish reminder are exhausted without a trustworthy
        // finish. Two shapes of reply are now KNOWN failures and must not be
        // dressed up as 'done': one that claims results no tool ever produced
        // (a fabricated "delegated investigation ... is complete" was
        // presented as success, live), and one still announcing intent (the
        // model narrated "I will…" for the whole nudge budget — the task
        // verifiably never ran). A plain answer that merely never phrase-
        // matched looksFinished (chat, Q&A) keeps the old benefit of the
        // doubt and falls through to acceptance below. Deliberately not
        // finish() on 'incomplete': no memory distillation on a non-success.
        if (!awaitingUser && !trustworthyFinish && (unverified || announcesIntent(response.content))) {
          if (!streamed && response.content.trim()) events.onText(response.content);
          return 'incomplete';
        }
        if (!streamed && response.content.trim()) events.onText(response.content);
        else if (!response.content.trim()) {
          await summarize('Summarize what you did and whether the task is complete.');
        }
        if (shouldDeferFinish(response.content)) continue;
        return finish();
      }

      // Structured-text fallback: one tool call per turn.
      const parsed = parseToolBlocks(response.content);
      if (parsed.calls.length === 0) {
        if (parsed.hasToolIntent && repairs < MAX_REPAIRS) {
          repairs++;
          messages.push({ role: 'assistant', content: response.content });
          messages.push({ role: 'user', content: REPAIR_PROMPT });
          continue;
        }
        // Same "default to not-finished" reasoning as the native branch above.
        const awaitingUserFallback = asksTheUser(response.content);
        const unverifiedFallback = claimsUnverifiedResult(response.content);
        const trustworthyFallbackFinish = looksFinished(response.content) && !unverifiedFallback;
        if (!awaitingUserFallback && !trustworthyFallbackFinish && nudges < MAX_NUDGES) {
          nudges++;
          if (response.content.trim()) events.onText(response.content);
          messages.push({ role: 'assistant', content: response.content });
          messages.push({ role: 'user', content: unverifiedFallback ? UNVERIFIED_RESULT_NUDGE : CONTINUE_NUDGE });
          continue;
        }
        // Nudge exhaustion — same 'incomplete' termination rules as the
        // native branch: fabricated results and still-announced intent are
        // known failures; a plain answer keeps the benefit of the doubt.
        if (
          !awaitingUserFallback &&
          !trustworthyFallbackFinish &&
          (unverifiedFallback || announcesIntent(response.content))
        ) {
          if (response.content.trim()) events.onText(response.content);
          return 'incomplete';
        }
        if (response.content.trim()) events.onText(response.content);
        else await summarize('Summarize what you did and whether the task is complete.');
        if (shouldDeferFinish(response.content)) continue;
        return finish();
      }

      const first = parsed.calls[0]!;
      if (first.name === FINISH_TOOL.name) {
        if (parsed.narration) events.onText(parsed.narration);
        const summary = String(first.args?.summary ?? '').trim();
        if (summary) events.onText(summary);
        if (shouldDeferFinish(response.content)) continue;
        return finish();
      }
      if (parsed.narration) events.onText(parsed.narration);
      messages.push({ role: 'assistant', content: response.content });

      if (first.parseError) {
        if (repairs < MAX_REPAIRS) {
          repairs++;
          messages.push({
            role: 'user',
            content: `The JSON arguments for "${first.name}" were invalid (${first.parseError}). ${REPAIR_PROMPT}`,
          });
          continue;
        }
        messages.push({
          role: 'user',
          content: formatToolResult(first.name, 'Invalid JSON arguments; tool not executed.'),
        });
        continue;
      }

      const result = await execTool({
        id: `call_${iteration}`,
        name: first.name,
        args: first.args ?? {},
      });
      messages.push({ role: 'user', content: formatToolResult(result.name, result.content) });
    }
    if (signal?.aborted) return 'stopped';
    await summarize(
      `You hit this run's ${budget}-step limit and are being cut off mid-task — this is not a request to stop. ` +
        'Say so in the first line, then summarize the progress so far, what remains, and the next step to take. ' +
        'Do not call any tools.',
    );
    return 'max-iterations';
  } catch (err) {
    if (isAbortError(err)) return 'stopped';
    let message = err instanceof Error ? err.message : String(err);
    if (nativeToolCalls && /tool|function/i.test(message)) {
      message +=
        '\n\nThis endpoint/model may not support native tool calling — set `"capabilities": {"nativeToolCalls": false}` on the profile (heapcode.profiles) to use the text-protocol fallback.';
    }
    events.onText(`Agent error: ${message}`);
    return 'error';
  }
}
