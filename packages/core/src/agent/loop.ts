import type { ChatMessage, ChatResponse, Provider } from '../providers/types.js';
import { isAbortError } from '../providers/errors.js';
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
  type ToolCall,
  type ToolDefinition,
  type ToolResult,
} from './tools.js';

export type AgentOutcome = 'done' | 'stopped' | 'max-iterations' | 'error';

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
}

export interface AgentOptions {
  provider: Provider;
  model: string;
  task: string;
  /** Images attached to the task (data: URLs) — needs a vision-capable model. */
  images?: string[];
  workspaceName: string;
  tools: ToolDefinition[];
  /** True → OpenAI-native function calling; false → structured-text fallback. */
  nativeToolCalls: boolean;
  execute(call: ToolCall): Promise<ToolResult>;
  /** Resolve to false to deny; a denial is reported to the model, not fatal. */
  requestPermission(call: ToolCall, tool: ToolDefinition): Promise<boolean>;
  events: AgentEvents;
  /** Ask for a numbered plan first, then execute it step by step. */
  plan?: boolean;
  maxIterations?: number;
  temperature?: number;
  maxTokens?: number;
  /** Model context window in tokens; drives usage reporting and compaction. */
  contextWindow?: number;
  signal?: AbortSignal;
}

const PLAN_REQUEST =
  'Before doing anything, write a concise numbered plan (3-8 steps) for this task. ' +
  'Plain text only — do NOT call any tools yet.';

const CONTINUE_NUDGE =
  'You are not done — continue working. Call the next tool NOW in your reply. ' +
  'Do not describe what you will do; do it. Reply without a tool call ONLY when the task is fully complete.';

const MAX_NUDGES = 4;

const FINISH_REMINDER =
  'If the task is fully complete, call the finish tool with a summary. ' +
  'Otherwise, continue working by calling the next tool.';

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

/** Narration that announces more work while stopping — the premature-finish signature. */
function looksUnfinished(text: string): boolean {
  return /\b(not (yet )?(complete|done|finished)|next step|will (now|then|proceed)|proceed(ing)? to|i need to|i am now|remaining steps?|continuing (with|to)|now (executing|creating|writing|implementing|building|adding|moving|starting)|executing steps?|let me (now )?(create|write|implement|add|start)|going to (create|write|implement|add|start)|starting (with|on|step))\b/i.test(
    text,
  );
}

const MAX_REPAIRS = 3;

export async function runAgent(opts: AgentOptions): Promise<AgentOutcome> {
  const {
    provider,
    model,
    tools,
    events,
    nativeToolCalls,
    maxIterations = 25,
    signal,
  } = opts;

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
    if (!provider.chatStreamed) {
      return { response: await provider.chat(buildRequest(msgs, withTools)), streamed: false };
    }
    let streamed = false;
    let reasoned = false;
    let toolChars = 0;
    const response = await provider.chatStreamed(
      buildRequest(msgs, withTools),
      (text, kind = 'text') => {
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
      },
    );
    if (reasoned) events.onReasoningEnd?.();
    if (streamed) events.onTextEnd?.();
    return { response, streamed };
  };
  const systemPrompt = nativeToolCalls
    ? buildNativeAgentSystemPrompt(opts.workspaceName)
    : buildFallbackAgentSystemPrompt(opts.workspaceName, toolsWithFinish);

  const messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: opts.task, images: opts.images },
  ];

  const execTool = async (call: ToolCall): Promise<ToolResult> => {
    const tool = toolsByName.get(call.name);
    if (!tool) {
      return {
        id: call.id,
        name: call.name,
        content: `Unknown tool "${call.name}". Available: ${tools.map((t) => t.name).join(', ')}.`,
        isError: true,
      };
    }
    events.onToolCall(call);
    let result: ToolResult;
    if (tool.permission !== 'read' && !(await opts.requestPermission(call, tool))) {
      result = { id: call.id, name: call.name, content: DENIED_RESULT_TEXT, isError: true };
    } else {
      try {
        result = await opts.execute(call);
      } catch (err) {
        result = {
          id: call.id,
          name: call.name,
          content: `Tool failed: ${err instanceof Error ? err.message : String(err)}`,
          isError: true,
        };
      }
    }
    events.onToolResult(result);
    return result;
  };

  let repairs = 0;
  let nudges = 0;
  let finishReminderSent = false;

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

  try {
    if (opts.plan) {
      const { response: planRes } = await respondLive(
        [...messages, { role: 'user', content: PLAN_REQUEST }],
        false,
        false, // plan text renders as a card, but reasoning still streams live
      );
      const planText = planRes.content.trim();
      if (planText) {
        events.onPlan?.(planText);
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

    for (let iteration = 0; iteration < maxIterations; iteration++) {
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
          return 'done';
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
            messages.push({ role: 'tool', content: result.content, toolCallId: result.id });
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
        // Tool-free reply that announces more work → nudge it to keep going
        // instead of ending the session prematurely.
        if (looksUnfinished(response.content) && nudges < MAX_NUDGES) {
          nudges++;
          if (!streamed && response.content.trim()) events.onText(response.content);
          messages.push({ role: 'assistant', content: response.content });
          messages.push({ role: 'user', content: CONTINUE_NUDGE });
          continue;
        }
        // Tool-free and not clearly finished: protocol violation — remind once
        // that ending goes through finish(summary).
        if (!looksFinished(response.content) && !finishReminderSent) {
          finishReminderSent = true;
          if (!streamed && response.content.trim()) events.onText(response.content);
          messages.push({ role: 'assistant', content: response.content });
          messages.push({ role: 'user', content: FINISH_REMINDER });
          continue;
        }
        if (!streamed && response.content.trim()) events.onText(response.content);
        else if (!response.content.trim()) {
          await summarize('Summarize what you did and whether the task is complete.');
        }
        return 'done';
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
        if (looksUnfinished(response.content) && nudges < MAX_NUDGES) {
          nudges++;
          if (response.content.trim()) events.onText(response.content);
          messages.push({ role: 'assistant', content: response.content });
          messages.push({ role: 'user', content: CONTINUE_NUDGE });
          continue;
        }
        if (response.content.trim()) events.onText(response.content);
        else await summarize('Summarize what you did and whether the task is complete.');
        return 'done';
      }

      const first = parsed.calls[0]!;
      if (first.name === FINISH_TOOL.name) {
        if (parsed.narration) events.onText(parsed.narration);
        const summary = String(first.args?.summary ?? '').trim();
        if (summary) events.onText(summary);
        return 'done';
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
    await summarize(
      'You hit the iteration limit. Summarize the progress so far, what remains, and suggested next steps. Do not call any tools.',
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
