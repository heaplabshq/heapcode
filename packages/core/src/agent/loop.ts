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
  maxIterations?: number;
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
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

  try {
    for (let iteration = 0; iteration < maxIterations; iteration++) {
      if (signal?.aborted) return 'stopped';

      const response = await provider.chat({
        model,
        messages,
        tools: nativeToolCalls ? tools : undefined,
        temperature: opts.temperature ?? 0.2,
        maxTokens: opts.maxTokens,
        signal,
      });

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
        if (response.content.trim()) events.onText(response.content);
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
        if (response.content.trim()) events.onText(response.content);
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
    return 'max-iterations';
  } catch (err) {
    if (isAbortError(err)) return 'stopped';
    events.onText(`Agent error: ${err instanceof Error ? err.message : String(err)}`);
    return 'error';
  }
}
