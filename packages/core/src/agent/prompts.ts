import type { ToolDefinition } from './tools.js';
import { formatToolsForPrompt } from './textProtocol.js';
import {
  BUDGET_SECTION,
  CODING_PROMPT_SECTIONS,
  composeAgentPrompt,
  type AgentEnvironment,
  type PromptTier,
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

/** What an explicit per-profile override says, when it says anything. */
export interface TierSelection {
  /** Set by the profile — wins over everything. */
  promptTier?: PromptTier;
  /** Model context window in tokens, when known. */
  contextWindow?: number;
  /** Whether the run starts on native tool calling (false = text protocol). */
  nativeToolCalls: boolean;
}

/**
 * Which prompt tier a run gets.
 *
 * A small context window means the full prompt is a tax on the working room
 * the model has left, and a run on the text protocol is usually a model that
 * cannot manage the native one — small, local, or both. Either condition
 * selects lean; an explicit `promptTier` from the profile overrides both,
 * because the user is the one who knows which model they pointed at.
 */
export function resolvePromptTier(selection: TierSelection): PromptTier {
  if (selection.promptTier) return selection.promptTier;
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

export function buildNativeAgentSystemPrompt(workspaceName: string, opts: AgentPromptOptions = {}): string {
  const base = baseWithBudget(opts.base ?? codingBase(opts.environment, opts.tier), opts.maxIterations);
  return (
    `${base}\n\nWorkspace: ${workspaceName}.\n\n` +
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