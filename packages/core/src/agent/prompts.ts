import type { ToolDefinition } from './tools.js';
import { formatToolsForPrompt } from './textProtocol.js';
import {
  BUDGET_SECTION,
  CODING_PROMPT_SECTIONS,
  composeAgentPrompt,
  type AgentEnvironment,
  type PromptTier,
  type PromptTierSetting,
} from './promptSections.js';

/**
 * The coding agent's operating instructions.
 *
 * The text lives in promptSections.ts as a registry; this module composes it
 * into the two prompts the loop actually sends — native tool calls and the
 * text-protocol fallback — and owns the parts that are about the loop rather
 * than the agent (the ending protocol, the tool-call syntax).
 */

/**
 * Below this context window, the full section set costs more than it returns.
 *
 * A local 32k model asked to hold a prompt of thousands of tokens is a model
 * with meaningfully less room to work in — the sections that go are the ones
 * a small model was ignoring anyway. The threshold is on *capability*, not
 * provider: a local model with a big window gets the full prompt, and a hosted
 * one with a small window gets the lean one. Chosen at 64k because every model
 * below it in practice also struggles with instruction-following at length.
 */
export const LEAN_TIER_CONTEXT_WINDOW = 65_536;

/** What a profile says about the tier, plus what the capability check would need. */
export interface TierSelection {
  /** From the profile. Unset means 'full' — see resolvePromptTier. */
  promptTier?: PromptTierSetting;
  /** Model context window in tokens, when known. */
  contextWindow?: number;
  /** Whether the run starts on native tool calling (false = text protocol). */
  nativeToolCalls: boolean;
}

/**
 * Which prompt tier a run gets.
 *
 * Unset means 'full', deliberately. Deriving it from the model was the first
 * design, and it is the wrong default for the same reason quietly shortening
 * anything is: the agent behaves differently and nothing says so, and the
 * difference shows up as the model ignoring an instruction it was never given.
 * A person who has just spent an afternoon on the prompt should get the prompt.
 *
 * 'auto' keeps that derivation as something a user chooses rather than
 * something that happens to them. It reads the two signals that suggest a
 * model cannot spend the tokens: a context window small enough that the full
 * prompt is a tax on the room left to work in, and a run on the text protocol,
 * which usually means a model that could not manage the native one.
 */
export function resolvePromptTier(selection: TierSelection): PromptTier {
  if (selection.promptTier === 'full' || selection.promptTier === 'lean') return selection.promptTier;
  if (selection.promptTier !== 'auto') return 'full';
  if (selection.contextWindow !== undefined && selection.contextWindow < LEAN_TIER_CONTEXT_WINDOW) return 'lean';
  if (!selection.nativeToolCalls) return 'lean';
  return 'full';
}

/** The registry's sections with this run's environment applied. */
function codingBase(environment: AgentEnvironment | undefined, tier: PromptTier | undefined): string {
  return composeAgentPrompt(CODING_PROMPT_SECTIONS, { environment, tier });
}

/** base + budget, in the exact spacing the single literal used to produce. */
function baseWithBudget(base: string, maxIterations?: number): string {
  const budget = maxIterations ? BUDGET_SECTION.render({ maxIterations }) : '';
  return budget ? `${base}\n${budget}` : base;
}

export interface AgentPromptOptions {
  /**
   * Replaces the coding-agent identity and rules above, for a host whose agent
   * is not a coding agent. The tool-calling protocol is appended either way,
   * because it describes how this loop works rather than what the agent is
   * for — a host that had to restate it would be copying the one part core
   * actually owns.
   */
  base?: string;
  /** Model turns this run may take. Omitted, the budget section is left out entirely. */
  maxIterations?: number;
  /**
   * Where the agent is: working directory, platform, git snapshot. Omitted,
   * the environment section renders nothing and the prompt is as it was
   * before the block existed. Ignored when `base` replaces the sections —
   * a host that writes its own identity describes its own surroundings.
   */
  environment?: AgentEnvironment;
  /**
   * Which section tier to compose. Omitted, every section is included —
   * the pre-tier prompt. Callers that want the capability-based default
   * should pass `resolvePromptTier(...)` rather than deciding themselves.
   */
  tier?: PromptTier;
}

/**
 * Declares the loop's steering tag to the model. Core-owned, appended by both
 * composers, deliberately outside the section registry: the nudges it describes
 * are sent by the loop itself (loop.ts), so a host that replaces the whole
 * base — heapbrowse — still gets steering it has been told how to read.
 */
const SYSTEM_REMINDER_DECLARATION =
  'Messages and tool results wrapped in <system-reminder> tags come from heapcode itself, not from the ' +
  'user. They are steering about the current run: follow them, and do not quote them back, apologize for ' +
  'them, or treat them as new scope.';

export function buildNativeAgentSystemPrompt(workspaceName: string, opts: AgentPromptOptions = {}): string {
  const base = baseWithBudget(opts.base ?? codingBase(opts.environment, opts.tier), opts.maxIterations);
  return (
    `${base}\n\nWorkspace: ${workspaceName}.\n\n` +
    `${SYSTEM_REMINDER_DECLARATION}\n\n` +
    '## Ending the run\n' +
    'Use the provided tools. For a conversational message, call `finish` immediately with your reply ' +
    'as the summary — nothing else. For a task, every reply must contain a tool call. When the task ' +
    'is complete, or you have established that it is not possible, call `finish` with a summary. ' +
    'That is the ONLY way to end the run.'
  );
}

export function buildFallbackAgentSystemPrompt(
  workspaceName: string,
  tools: ToolDefinition[],
  opts: AgentPromptOptions = {},
): string {
  const base = baseWithBudget(opts.base ?? codingBase(opts.environment, opts.tier), opts.maxIterations);
  return (
    `${base}\n\nWorkspace: ${workspaceName}.\n\n` +
    `${SYSTEM_REMINDER_DECLARATION}\n\n` +
    '## Calling tools\n' +
    'You call a tool by embedding EXACTLY this block in your reply (valid JSON, ONE call per reply):\n' +
    '<tool name="TOOL_NAME">\n{"arg": "value"}\n</tool>\n\n' +
    `Available tools:\n\n${formatToolsForPrompt(tools)}\n\n` +
    'The result arrives in the next message as <tool_result>.\n\n' +
    '## Ending the run\n' +
    'For a conversational message, reply with just your answer — no tool block needed. For a task, ' +
    'every reply must contain a tool call. When the task is complete, or you have established that it ' +
    'is not possible, call:\n' +
    '<tool name="finish">\n{"summary": "what was done and the outcome"}\n</tool>\n' +
    'That is the ONLY way to end the run.'
  );
}