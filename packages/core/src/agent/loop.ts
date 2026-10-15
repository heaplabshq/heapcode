import { REPETITION_NOTICE, REPETITION_NUDGE, RepetitionError, RepetitionWatch } from './repetition.js';
import type { ChatMessage, ChatRequest, ChatResponse, Provider, TokenUsage } from '../providers/types.js';
import { isAbortError, isToolsUnsupported } from '../providers/errors.js';
import {
  COMPACTION_THRESHOLD,
  DEFAULT_CONTEXT_WINDOW,
  estimateMessagesTokens,
} from '../context/tokens.js';
import { buildFallbackAgentSystemPrompt, buildNativeAgentSystemPrompt, resolvePromptTier } from './prompts.js';
import { RECAP_BUDGET_MULTIPLIER, wantsConversationRecap } from './recap.js';

/**
 * Marks a compacted block, so a later compaction can recognise its own notes
 * and extend them rather than compressing a summary a second time.
 */
const COMPACTED_PREFIX = '[Earlier work compacted to save context]';
import type { AgentEnvironment, PromptTierSetting } from './promptSections.js';
import { formatToolResult, parseToolBlocks, REPAIR_PROMPT } from './textProtocol.js';
import { TODO_TOOL, parseTodos, renderTodos, type TodoItem } from './todo.js';
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
  /**
   * The agent's task list, each time todo_write updates it. Fired with the
   * full list, never a delta — the same thing the model was just shown, so a
   * host can render exactly what the agent believes is left.
   */
  onTodoUpdate?(todos: TodoItem[]): void;
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
  /**
   * Where the agent runs — working directory, platform, a git snapshot —
   * rendered into the environment section of the system prompt. Gathered once
   * by the caller before the run starts, so the whole run sees one snapshot
   * rather than facts that change underneath it. Ignored when `systemPrompt`
   * replaces the coding sections (a host that owns its identity describes its
   * own surroundings).
   */
  environment?: AgentEnvironment;
  /**
   * How much of the prompt this run gets, from the profile's `promptTier`.
   * Omitted, the run gets the full section set; 'auto' asks for the tier to
   * be derived from the model's context window and protocol. See
   * resolvePromptTier.
   */
  promptTier?: PromptTierSetting;
  /**
   * What this agent's work is made of, for the summary written when a run
   * outgrows the context window.
   *
   * Compaction throws away the middle of a transcript and keeps a summary, so
   * the instruction deciding what to preserve decides what the agent still
   * knows for the rest of the run. That instruction was hard-coded for a coding
   * agent -- keep the files changed and the commands run -- and a host whose
   * work has neither was being told to remember things that do not exist,
   * exactly when it could least afford to lose the things that do.
   *
   * Left unset it stays the coding wording, so nothing changes for a host that
   * has not thought about it.
   */
  compaction?: CompactionShape;
  signal?: AbortSignal;
}

/** How to summarize one kind of work, when a run has to be compacted. */
export interface CompactionShape {
  /** What the agent is, in the summarizer's system line. E.g. 'browser-agent'. */
  kind: string;
  /**
   * What must survive, most important first.
   *
   * Written as the things themselves rather than as advice: "pages visited and
   * what each one turned out to contain" tells a summarizer what to look for,
   * where "be thorough" does not.
   */
  preserve: string;
}

/** The wording every host got before any of them could say otherwise. */
const CODING_COMPACTION: CompactionShape = {
  kind: 'coding-agent',
  preserve:
    'files read/modified (and what was learned or changed in each), commands run with their ' +
    'outcomes, decisions made, errors hit, and exact current progress on the task',
};

const PLAN_REQUEST =
  'Before doing anything, write a concise plan for this task, scaled to what it actually ' +
  'needs. A simple question or lookup needs only 1-2 steps — do not pad it out. Reserve a ' +
  'longer numbered plan (up to ~8 steps) for genuinely multi-step build/edit work. ' +
  'Each step should be something you will actually do — a file to change, a command to run, a ' +
  'question to ask. "Investigate the codebase" and "understand the architecture" are not steps; ' +
  'they are how a plan turns into an hour of reading. Where you do not yet know enough to name a ' +
  'step, say what you will look at and what would decide it. ' +
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
/** Calls in a row that failed or changed nothing: the model is told at the first, the run ends at the second. */
const FRUITLESS_NUDGE = 5;
const FRUITLESS_STOP = 10;
/** Calls in a row that only repeated earlier ones: told at the first, stopped at the second. */
const REPEAT_NUDGE = 3;
const REPEAT_STOP = 8;
/** Changing calls that may succeed on a second identical try — they depend on the world outside the files. */
const RETRYABLE_TOOLS = new Set(['run_command', 'run_tests']);

const TOOL_PROTOCOL_FALLBACK_NOTICE =
  'This model rejected native tool calling, so heapcode switched to its text-based tool protocol ' +
  'for the rest of this run. Tool support comes from the model\'s chat template, so this is a ' +
  'property of the model rather than of the server. To skip this retry in future, set ' +
  '`"capabilities": {"nativeToolCalls": false}` on the profile — "/nativetools off" in the terminal does it for you.';

const MAX_NUDGES = 4;

/**
 * How the loop's own steering is marked on the wire.
 *
 * Nudges go out as `role: 'user'` messages (or a native tool result) because
 * every chat template understands those — but an unmarked nudge is a forged
 * user turn: nothing tells the model these words were not typed by the person
 * it is talking to, and steering is most needed exactly when the model is
 * least reliable about context. The tag is declared in the system prompt
 * (prompts.ts, in the core-owned tail every host's prompt passes through), so
 * a host that replaces the whole base still gets steering it knows how to
 * read. Same shape Claude Code uses for its own mid-run reminders.
 *
 * The boundary, so the next message added here lands on the right side of it:
 * nothing the loop authors is ever left looking like the user's own words, but
 * only *steering* takes this tag. Data the loop relays already carries a tag of
 * its own and keeps it — tool output is `<tool_result>` (textProtocol.ts, which
 * the fallback prompt teaches the model to read), images and compacted history
 * are bracket-marked. One tag for everything would mean re-teaching a protocol
 * the model already knows.
 *
 * A user decision the loop is passing on — the answer to `ask_user` at the step
 * limit — is steering too, and takes the tag. It is honest content in the wrong
 * voice otherwise: true, but phrased as though the user had typed it here.
 */
function systemReminder(text: string): string {
  return `<system-reminder>\n${text}\n</system-reminder>`;
}

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

  // Fixed for the life of the run, and consulted by both the initial prompt
  // and the mid-run fallback rewrite, so a protocol change never changes which
  // sections the model has been told to follow.
  const promptTier = resolvePromptTier(opts);

  /**
   * Makes ids this loop invents unique to the run. Pages pair a result with
   * its call by id across a whole conversation, and "steps_100" or "call_3"
   * recurs in every run that gets that far.
   */
  const runTag = Math.random().toString(36).slice(2, 8);
  const toolsByName = new Map(tools.map((t) => [t.name, t]));
  const toolsWithFinish = [...tools, FINISH_TOOL, TODO_TOOL];

  // Prefer streaming transport: reasoning models produce bytes immediately but
  // can exceed any sane non-streaming timeout on their full response.
  const buildRequest = (
    msgs: ChatMessage[],
    withTools: boolean,
    /** The retry after a reply looped: warmer, and steered away from repeating. */
    unstick?: { penalties: boolean },
    /** The run's signal joined with one that cuts this reply off (see `attempt`). */
    watched?: AbortSignal,
  ): ChatRequest => ({
    model,
    messages: msgs,
    tools: withTools && nativeToolCalls ? toolsWithFinish : undefined,
    temperature: unstick ? Math.max(0.7, (opts.temperature ?? 0.2) + 0.4) : (opts.temperature ?? 0.2),
    maxTokens: opts.maxTokens,
    ...(unstick?.penalties ? { frequencyPenalty: 0.5, presencePenalty: 0.3 } : {}),
    signal: watched ?? signal,
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
      messages[0] = {
        role: 'system',
        content: buildFallbackAgentSystemPrompt(opts.workspaceName, toolsWithFinish, {
          maxIterations,
          environment: opts.environment,
          tier: promptTier,
        }),
      };
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

    /**
     * One streamed attempt, watched for a loop. A reply that starts repeating
     * itself is cut off there (see repetition.ts) rather than left to run to
     * its token limit; the caller decides what happens next.
     */
    const attempt = async (request: (stop: AbortSignal) => ChatRequest): Promise<ChatResponse> => {
      const stop = new AbortController();
      const watched = signal ? AbortSignal.any([signal, stop.signal]) : stop.signal;
      const thinking = new RepetitionWatch();
      // Narration only: in the text protocol the reply carries tool calls —
      // whole files among them — where repeated blocks are ordinary.
      const saying = nativeToolCalls ? new RepetitionWatch() : undefined;
      let looped: RepetitionError | undefined;
      const onDelta = (text: string, kind: 'text' | 'reasoning' | 'tool' = 'text'): void => {
        if (looped) return;
        if (kind === 'reasoning') {
          reasoned = true;
          events.onReasoningDelta?.(text);
          if (thinking.push(text)) looped = new RepetitionError('reasoning');
        } else if (kind === 'tool') {
          toolChars += text.length;
          events.onToolStream?.(toolChars);
          return;
        } else {
          if (liveText && nativeToolCalls) {
            streamed = true;
            events.onTextDelta?.(text);
          }
          if (saying?.push(text)) looped = new RepetitionError('text');
        }
        if (looped) stop.abort(looped);
      };
      let reply: ChatResponse;
      try {
        reply = await provider.chatStreamed!(request(watched), onDelta);
      } catch (err) {
        if (looped) throw looped;
        throw err;
      }
      // A provider may hand back what it had when cut off instead of throwing.
      if (looped) throw looped;
      return reply;
    };

    const firstTry = async (): Promise<ChatResponse> => {
      try {
        return await attempt((watched) => buildRequest(msgs, withTools, undefined, watched));
      } catch (err) {
        if (!recoverFromUnsupportedTools(err)) throw err;
        // withTools is now moot — nativeToolCalls is false, so buildRequest
        // omits the array either way; passing false says so at the call site.
        return attempt((watched) => buildRequest(msgs, false, undefined, watched));
      }
    };

    let response: ChatResponse;
    try {
      response = await firstTry();
    } catch (err) {
      if (!(err instanceof RepetitionError)) throw err;
      // Once: said so in the transcript, told so in the request, and sampled
      // so as not to fall into the same groove. The looping reply is dropped.
      if (reasoned) events.onReasoningEnd?.();
      if (streamed) events.onTextEnd?.();
      reasoned = false;
      streamed = false;
      events.onText(REPETITION_NOTICE);
      const nudged: ChatMessage[] = [...msgs, { role: 'user', content: REPETITION_NUDGE }];
      try {
        response = await attempt((watched) => buildRequest(nudged, withTools, { penalties: true }, watched));
      } catch (again) {
        if (again instanceof RepetitionError) {
          throw new Error('The model kept repeating itself, even when asked again. Try again, or a different model for this role.');
        }
        if (signal?.aborted) throw again;
        // An endpoint that refuses the penalty settings still gets the nudge.
        response = await attempt((watched) => buildRequest(nudged, withTools, { penalties: false }, watched)).catch((last: unknown) => {
          if (last instanceof RepetitionError) {
            throw new Error('The model kept repeating itself, even when asked again. Try again, or a different model for this role.');
          }
          throw last;
        });
      }
    }
    if (reasoned) events.onReasoningEnd?.();
    if (streamed) events.onTextEnd?.();
    return { response: counted(response), streamed };
  };
  const systemPrompt = nativeToolCalls
    ? buildNativeAgentSystemPrompt(opts.workspaceName, {
        base: opts.systemPrompt,
        maxIterations,
        environment: opts.environment,
        tier: promptTier,
      })
    : buildFallbackAgentSystemPrompt(opts.workspaceName, toolsWithFinish, {
        base: opts.systemPrompt,
        maxIterations,
        environment: opts.environment,
        tier: promptTier,
      });

  const messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt },
    ...(opts.history ?? []).map((m): ChatMessage => ({ role: m.role, content: m.content })),
    { role: 'user', content: opts.task, images: opts.images },
  ];

  // Tests-dirty tracking for requireVerificationBeforeFinish (PLAN.md M7.3):
  // any successful write flips it on; any successful `verifies` call clears it.
  const hasVerifyTool = tools.some((t) => t.verifies);
  let dirtySinceVerify = false;

  /**
   * Results of look-up calls already made this run, keyed by call.
   *
   * The prompt tells the agent not to repeat itself, and a determined loop
   * does anyway: one real run made 81 web searches on a single question, six
   * of them character-for-character identical, and another re-read one file
   * ten times in overlapping slices. Telling it again in the next turn's
   * system prompt does not help, because the turn that repeats is the turn
   * that already had the answer.
   *
   * So the second identical call does not go out. It returns the first
   * answer, labelled — which costs nothing, and puts the information back in
   * front of a model that may have lost it to compaction, which is usually
   * why it asked twice.
   */
  const lookupCache = new Map<string, { at: number; result: ToolResult }>();
  /** Calls made so far, so a cached entry can be compared against the last write. */
  let callsMade = 0;
  /** When the workspace last changed. A read from before that may legitimately differ now. */
  let lastMutationAt = -1;

  /**
   * The run's own task list — populated by todo_write, read by the finish
   * gate. Unlike the verification gate this one is about the model's own
   * stated plan: a run that wrote "1. fix parser 2. add test 3. update docs"
   * and stopped after step 1 used to end with "done".
   */
  let todos: TodoItem[] = [];
  let todoNudges = 0;
  const MAX_TODO_NUDGES = 2;

  /**
   * Whether repeating this call could return something new.
   *
   * Only look-ups are cached, and only while nothing has been written since:
   * re-reading a file you have just edited is not a repeat, it is the point.
   * `run_command` is never cached however read-only it looks — `pwd` twice is
   * fine, and the loop has no way to know which commands have effects.
   */
  const cacheableLookup = (tool: ToolDefinition): boolean =>
    tool.permission === 'read' || tool.name === 'web_search' || tool.name === 'fetch_url';

  /**
   * Calls that change things, and failed — so the same call is not sent again
   * while nothing has changed. The look-up cache's counterpart: a model stuck
   * on an edit whose search text is not in the file will send that exact edit
   * thirty times, each failing the same way, each costing a turn.
   */
  const failedChanges = new Map<string, { at: number; result: ToolResult }>();
  /** The last call that changed something successfully — what makes a failed call worth retrying. */
  let lastChangeAt = -1;
  /**
   * Calls in a row that failed or changed nothing. Successful changes reset
   * it; successful look-ups do not, since read-then-fail-to-edit is exactly
   * the circle this watches for. A refusal by the person is not counted.
   */
  let fruitless = 0;
  /**
   * Look-ups in a row that only repeated an earlier one with nothing changed
   * since — the read-only circle (App.tsx, OrderSuccess.tsx, OrderDetail.tsx,
   * App.tsx…) that `fruitless` cannot see, because every one of those calls
   * succeeds. Any call that is not such a repeat resets it.
   */
  let repeats = 0;

  const execTool = async (rawCall: ToolCall): Promise<ToolResult> => {
    // Loop-owned bookkeeping, handled before the host roundtrip: the list is
    // this run's state, not workspace state, so no host has an executor for
    // it — same shape as finish, which the response path handles itself.
    if (rawCall.name === TODO_TOOL.name) {
      events.onToolCall(rawCall);
      const parsed = parseTodos(rawCall.args ?? {});
      let result: ToolResult;
      if (parsed.error) {
        result = { id: rawCall.id, name: rawCall.name, content: parsed.error, isError: true };
      } else {
        todos = parsed.todos;
        result = { id: rawCall.id, name: rawCall.name, content: renderTodos(todos) };
        events.onTodoUpdate?.(todos);
      }
      events.onToolResult(result);
      return result;
    }
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

    const at = callsMade++;
    const key = cacheableLookup(tool) ? `${call.name}:${JSON.stringify(call.args ?? {})}` : undefined;
    const cached = key ? lookupCache.get(key) : undefined;
    if (cached && cached.at > lastMutationAt) {
      // Said plainly, and with the answer attached: an agent that is going in
      // circles needs to be told which circle, not merely refused.
      repeats += 1;
      const circling =
        repeats >= REPEAT_NUDGE
          ? `That is ${repeats} calls in a row that only repeated earlier ones — you are going in circles. ` +
            'You already have everything those calls return. Stop reading and act now: make the change, ' +
            'run the check, or finish and say what is blocking you.\n\n'
          : '';
      const repeated: ToolResult = {
        ...cached.result,
        id: call.id,
        content:
          circling +
          'You already made this exact call earlier in this run and nothing has changed since. ' +
          'Here is what it returned — use it rather than calling again, and if it does not answer ' +
          'your question, a different call or a question to the user will.\n\n' +
          cached.result.content,
      };
      events.onToolResult(repeated);
      if (repeats >= REPEAT_STOP) {
        throw new Error(
          `Stopped: ${REPEAT_STOP} tool calls in a row only repeated earlier ones, so the agent was going in circles ` +
            '(reading the same files over and over). Ask again — perhaps with a hint at what to change, or with a ' +
            'different model for this role.',
        );
      }
      return repeated;
    }
    // A call that is not a repeat: whatever it is, the circle is broken.
    repeats = 0;

    // Commands may depend on the outside world (a server coming up), so a
    // failed one can fairly be tried again; an edit cannot.
    const changeKey =
      !cacheableLookup(tool) && !RETRYABLE_TOOLS.has(call.name) ? `${call.name}:${JSON.stringify(call.args ?? {})}` : undefined;
    const failedBefore = changeKey ? failedChanges.get(changeKey) : undefined;
    if (failedBefore && failedBefore.at > lastChangeAt) {
      const again: ToolResult = {
        id: call.id,
        name: call.name,
        isError: true,
        content:
          'You already made this exact call and it failed, and nothing has changed since — so it would fail ' +
          'the same way, and it was not run again. Its error was:\n\n' +
          failedBefore.result.content +
          '\n\nChange the approach: re-read the file for its current text, or make a different change.',
      };
      return settleFruitless(again, false);
    }

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
        // Anything that is not a look-up may have changed the workspace —
        // including a shell command, which is how most non-obvious changes
        // happen. Every cached read from before now is suspect.
        // A failed edit changed nothing, so the reads before it still stand;
        // a failed command may have done half its work, so it counts.
        if (!cacheableLookup(tool) && !(result.isError && !RETRYABLE_TOOLS.has(call.name))) lastMutationAt = at;
        else if (key && !result.isError) lookupCache.set(key, { at, result });
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
    if (!allowed) {
      events.onToolResult(result);
      return result;
    }
    if (changeKey && result.isError) failedChanges.set(changeKey, { at, result });
    if (!cacheableLookup(tool) && !result.isError) lastChangeAt = at;
    return settleFruitless(result, !cacheableLookup(tool) && !result.isError);
  };

  /**
   * Count a result toward the run of calls that got nowhere, telling the model
   * at FRUITLESS_NUDGE and ending the run at FRUITLESS_STOP — a stuck agent
   * otherwise spins until its step budget, minutes later.
   */
  const settleFruitless = (result: ToolResult, changedSomething: boolean): ToolResult => {
    if (changedSomething) fruitless = 0;
    else if (result.isError) fruitless += 1;
    let shown = result;
    if (result.isError && fruitless === FRUITLESS_NUDGE) {
      shown = {
        ...result,
        content:
          `${result.content}\n\nThat is ${FRUITLESS_NUDGE} calls in a row that failed or changed nothing. ` +
          'Stop repeating the same kind of attempt. Re-read what you are changing, rethink the approach, ' +
          'or ask the user if you are blocked.',
      };
    }
    events.onToolResult(shown);
    if (fruitless >= FRUITLESS_STOP) {
      throw new Error(
        `Stopped: ${FRUITLESS_STOP} tool calls in a row failed or changed nothing, so the agent was going in circles. ` +
          'Look at the last error above, then ask again — perhaps with a hint, or with a different model for this role.',
      );
    }
    return shown;
  };
  let repairs = 0;
  let nudges = 0;
  let finishReminderSent = false;
  let verificationNudges = 0;
  const MAX_VERIFICATION_NUDGES = 2;
  /**
   * Names the host's actual verifying tool rather than assuming `run_tests`.
   *
   * heapbrowse's is `read_page` — its agent changes a web page and verifies by
   * looking at it — and being told to "run the tests (run_tests)" sent the model
   * off explaining that it had no such tool, which is a wasted turn and reads to
   * the user like the product is confused about itself.
   */
  const verifyToolNames = tools.filter((t) => t.verifies).map((t) => t.name);
  const VERIFY_NUDGE =
    verifyToolNames.length > 0
      ? `Something changed since the last time you checked your work. Call ${verifyToolNames.join(' or ')} before finishing.`
      : 'Something changed since the last time you checked your work. Verify it before finishing.';

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
      messages.push({ role: 'tool', content: systemReminder(VERIFY_NUDGE), toolCallId: nativeFinishCall.id });
    } else {
      if (content.trim()) messages.push({ role: 'assistant', content });
      messages.push({ role: 'user', content: systemReminder(VERIFY_NUDGE) });
    }
    return true;
  };

  /**
   * Same deferral shape, for the model's own task list: a finish with items
   * still pending is a task ending above its own stated plan. Bounded for the
   * same reason the verification gate is — a model that keeps finishing over
   * its own list twice is telling the truth about being done, or is stuck,
   * and either way more nudging is not the tool for it.
   */
  const shouldDeferTodoFinish = (
    content: string,
    nativeFinishCall?: { id: string; name: string; args: Record<string, unknown> },
  ): boolean => {
    const open = todos.filter((t) => t.status !== 'completed');
    if (open.length === 0 || todoNudges >= MAX_TODO_NUDGES) return false;
    todoNudges++;
    const nudge =
      `Your todo list still has ${open.length} unfinished item${open.length === 1 ? '' : 's'}:\n` +
      open.map((t) => `- ${t.content}${t.status === 'in_progress' ? ' (in progress)' : ''}`).join('\n') +
      '\nFinish them, or call todo_write to drop the ones that turned out not to be needed, before finishing.';
    if (nativeFinishCall) {
      messages.push({ role: 'assistant', content, toolCalls: [nativeFinishCall] });
      messages.push({ role: 'tool', content: systemReminder(nudge), toolCallId: nativeFinishCall.id });
    } else {
      if (content.trim()) messages.push({ role: 'assistant', content });
      messages.push({ role: 'user', content: systemReminder(nudge) });
    }
    return true;
  };

  const contextWindow = opts.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
  // Compact when prompt + a reply would cross the threshold. Cap the output
  // reservation at a quarter of the window so small windows still get most
  // of their space for the transcript.
  const reservedOutput = Math.min(opts.maxTokens ?? 4_096, contextWindow / 4);
  // Raised when the task is *about* the conversation, so a recap is not
  // answered from notes that already dropped what was being asked about.
  // See agent/recap.ts for why this raises the budget rather than skipping.
  const recapRequested = wantsConversationRecap(opts.task);
  const compactionBudget =
    Math.max(2_000, contextWindow * COMPACTION_THRESHOLD - reservedOutput) *
    (recapRequested ? RECAP_BUDGET_MULTIPLIER : 1);

  /**
   * Context compaction: when the transcript outgrows the window, summarize
   * the middle (keeping the system prompt, the task, and the most recent
   * exchanges verbatim) and splice the summary in. Best-effort — on failure
   * the session continues and the provider's own error surfaces later.
   */
  const shape = opts.compaction ?? CODING_COMPACTION;

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

    // A second compaction folds the first one's summary back in. Labelling it
    // as existing notes rather than letting it arrive as another `user:` line
    // is what makes the model extend them instead of compressing a summary
    // again — the difference between notes that accumulate and notes that
    // erode. heapchat framed it this way explicitly (server.js:1958).
    const priorSummary = middle[0]?.content.startsWith(COMPACTED_PREFIX) ? middle[0].content : undefined;
    const fresh = (priorSummary ? middle.slice(1) : middle)
      .map((m) => {
        const calls = m.toolCalls ? ` [called: ${m.toolCalls.map((c) => c.name).join(', ')}]` : '';
        return `${m.role}: ${m.content.slice(0, 1_500)}${calls}`;
      })
      .join('\n');
    const transcript = priorSummary
      ? `NOTES SO FAR:\n${priorSummary}\n\nNEWER MESSAGES TO FOLD INTO THE NOTES:\n${fresh}`
      : fresh;
    try {
      const res = await provider.chat({
        model,
        messages: [
          {
            role: 'system',
            content: `You compress ${shape.kind} transcripts. Reply with only the summary.`,
          },
          {
            role: 'user',
            content:
              'Summarize this transcript so the agent can continue seamlessly. Preserve: ' +
              `${shape.preserve}. Max 500 words.\n\n${transcript}`,
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
        content: `${COMPACTED_PREFIX}\n${summary}\n[Continue the task from here.]`,
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
        id: `steps_${used}_${runTag}`,
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
      // strict providers start rejecting the whole transcript. Tagged, and
      // written about the user rather than as them: the decision it reports is
      // real, but the person did not type this sentence.
      messages.push({
        role: 'user',
        content: systemReminder(
          `You reached this run's step limit. The user was asked whether to continue and chose to keep ` +
            `going, so you have another ${maxIterations} steps. ` +
            'Pick the CURRENT task up exactly where you left off: call the next tool now. ' +
            'Do not start over, and do not summarize instead of working.',
        ),
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
          if (shouldDeferTodoFinish(response.content, finishCall)) continue;
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
            // A tool message cannot carry an image in the OpenAI-compatible
            // protocol, so images arrive as the user turn that follows it —
            // the only shape vision models accept. Marked as tool output rather
            // than as something the user said, since that is what it is.
            if (result.images?.length) {
              messages.push({
                role: 'user',
                content: `[image output from ${requested.name}]`,
                images: result.images,
              });
            }
          }
          continue;
        }
        // Truncated reply (output token cap) → the model never got to its tool
        // call. Push it to continue in smaller steps.
        if (response.finishReason === 'length' && nudges < MAX_NUDGES) {
          nudges++;
          if (!streamed && response.content.trim()) events.onText(response.content);
          messages.push({ role: 'assistant', content: response.content });
          messages.push({ role: 'user', content: systemReminder(TRUNCATED_NUDGE) });
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
            messages.push({ role: 'user', content: systemReminder(NATIVE_TOOL_CALL_REPAIR) });
            continue;
          }
          const call = textual.calls[0]!;
          if (!streamed && textual.narration.trim()) events.onText(textual.narration);
          messages.push({ role: 'assistant', content: response.content });
          const result = await execTool({ id: `call_${iteration}_${runTag}`, name: call.name, args: call.args ?? {} });
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
          messages.push({ role: 'user', content: systemReminder(unverified ? UNVERIFIED_RESULT_NUDGE : CONTINUE_NUDGE) });
          continue;
        }
        // Tool-free and not clearly finished: protocol violation — remind once
        // that ending goes through finish(summary).
        if (!awaitingUser && !trustworthyFinish && !finishReminderSent) {
          finishReminderSent = true;
          if (!streamed && response.content.trim()) events.onText(response.content);
          messages.push({ role: 'assistant', content: response.content });
          messages.push({ role: 'user', content: systemReminder(unverified ? UNVERIFIED_RESULT_NUDGE : FINISH_REMINDER) });
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
          messages.push({ role: 'user', content: systemReminder(REPAIR_PROMPT) });
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
          messages.push({ role: 'user', content: systemReminder(unverifiedFallback ? UNVERIFIED_RESULT_NUDGE : CONTINUE_NUDGE) });
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
        if (shouldDeferTodoFinish(response.content)) continue;
        return finish();
      }
      if (parsed.narration) events.onText(parsed.narration);
      messages.push({ role: 'assistant', content: response.content });

      if (first.parseError) {
        if (repairs < MAX_REPAIRS) {
          repairs++;
          messages.push({
            role: 'user',
            content: systemReminder(
              `The JSON arguments for "${first.name}" were invalid (${first.parseError}). ${REPAIR_PROMPT}`,
            ),
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
        id: `call_${iteration}_${runTag}`,
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
