import type { ToolDefinition } from './tools.js';

/**
 * Structured-text tool protocol for models without native function calling:
 *
 *   <tool name="read_file">
 *   {"path": "src/index.ts"}
 *   </tool>
 *
 * One tool call per assistant turn; results come back wrapped in
 * <tool_result> in the next user message.
 */

const TOOL_BLOCK = /<tool\s+name="([\w-]+)"\s*>\s*([\s\S]*?)<\/tool>/g;

export interface ParsedToolCall {
  name: string;
  args?: Record<string, unknown>;
  parseError?: string;
}

export interface ParseOutcome {
  calls: ParsedToolCall[];
  /** Narration text outside tool blocks. */
  narration: string;
  /** True when the reply looks like it tried to call a tool. */
  hasToolIntent: boolean;
}

export function parseToolBlocks(content: string): ParseOutcome {
  const calls: ParsedToolCall[] = [];
  const narration = content.replace(TOOL_BLOCK, '').trim();

  for (const match of content.matchAll(TOOL_BLOCK)) {
    const name = match[1]!;
    let argsText = match[2]!.trim();
    // Models sometimes fence the JSON inside the block.
    argsText = argsText.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
    if (!argsText) {
      calls.push({ name, args: {} });
      continue;
    }
    try {
      calls.push({ name, args: JSON.parse(argsText) as Record<string, unknown> });
    } catch (err) {
      calls.push({ name, parseError: err instanceof Error ? err.message : String(err) });
    }
  }

  return {
    calls,
    narration,
    hasToolIntent: calls.length > 0 || /<tool[\s>]/.test(content),
  };
}

export function formatToolResult(name: string, content: string): string {
  return `<tool_result name="${name}">\n${content}\n</tool_result>`;
}

export function formatToolsForPrompt(tools: ToolDefinition[]): string {
  return tools
    .map(
      (t) =>
        `### ${t.name}\n${t.description}\nArguments JSON schema: ${JSON.stringify(t.parameters)}`,
    )
    .join('\n\n');
}

export const REPAIR_PROMPT =
  'Your last reply contained a malformed tool call. Reply again with EXACTLY this format ' +
  '(valid JSON on its own lines, one tool call only):\n' +
  '<tool name="TOOL_NAME">\n{"arg": "value"}\n</tool>';
