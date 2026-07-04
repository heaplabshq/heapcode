import type { ChatMessage, Provider } from '../providers/types.js';
import { isAbortError } from '../providers/errors.js';
import { buildFallbackAgentSystemPrompt, buildNativeAgentSystemPrompt } from './prompts.js';
import { formatToolResult, parseToolBlocks, REPAIR_PROMPT } from './textProtocol.js';
import { DENIED_RESULT_TEXT, type ToolCall, type ToolDefinition, type ToolResult } from './tools.js';

export type AgentOutcome = 'done' | 'stopped' | 'max-iterations' | 'error';

export interface AgentEvents {
  /** Assistant narration/summary text. */
  onText(text: string): void;
  onToolCall(call: ToolCall): void;
  onToolResult(result: ToolResult): void;
  /** The upfront numbered plan (when planning is enabled). */
  onPlan?(text: string): void;
}

export interface AgentOptions {
  provider: Provider;
  model: string;
  task: string;
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
  signal?: AbortSignal;
}

const PLAN_REQUEST =
  'Before doing anything, write a concise numbered plan (3-8 steps) for this task. ' +
  'Plain text only — do NOT call any tools yet.';

const CONTINUE_NUDGE =
  'You are not done — continue working. Call the next tool NOW in your reply. ' +
  'Do not describe what you will do; do it. Reply without a tool call ONLY when the task is fully complete.';

const MAX_NUDGES = 4;

/** Narration that announces more work while stopping — the premature-finish signature. */
function looksUnfinished(text: string): boolean {
  return /\b(not (yet )?(complete|done|finished)|next step|will (now|then|proceed)|proceed(ing)? to|i need to|i am now|remaining steps?|continuing (with|to))\b/i.test(
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

  // Prefer streaming transport: reasoning models produce bytes immediately but
  // can exceed any sane non-streaming timeout on their full response.
  const respond = (msgs: ChatMessage[], withTools: boolean) => {
    const request = {
      model,
      messages: msgs,
      tools: withTools && nativeToolCalls ? tools : undefined,
      temperature: opts.temperature ?? 0.2,
      maxTokens: opts.maxTokens,
      signal,
    };
    return provider.chatStreamed ? provider.chatStreamed(request) : provider.chat(request);
  };
  const systemPrompt = nativeToolCalls
    ? buildNativeAgentSystemPrompt(opts.workspaceName)
    : buildFallbackAgentSystemPrompt(opts.workspaceName, tools);

  const messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: opts.task },
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

  /** One extra no-tools turn so every session ends with a human-readable conclusion. */
  const summarize = async (prompt: string): Promise<void> => {
    try {
      const res = await respond([...messages, { role: 'user', content: prompt }], false);
      if (res.content.trim()) events.onText(res.content);
    } catch {
      // Summary is best-effort — never turn a finished session into an error.
    }
  };

  try {
    if (opts.plan) {
      const planRes = await respond([...messages, { role: 'user', content: PLAN_REQUEST }], false);
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

      const response = await respond(messages, true);

      if (nativeToolCalls) {
        if (response.toolCalls && response.toolCalls.length > 0) {
          if (response.content.trim()) events.onText(response.content);
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
        // Tool-free reply that announces more work → nudge it to keep going
        // instead of ending the session prematurely.
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
        '\n\nThis endpoint/model may not support native tool calling — set `"capabilities": {"nativeToolCalls": false}` on the profile (cortex.profiles) to use the text-protocol fallback.';
    }
    events.onText(`Agent error: ${message}`);
    return 'error';
  }
}
