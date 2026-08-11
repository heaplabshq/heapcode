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
 *
 * Two other dialects are accepted on input, because a lot of open-weight
 * models emit one of them no matter what the system prompt asks for — they
 * were fine-tuned on it. Neither was recognized before, so a reply using one
 * read as pure narration: the loop saw no tool call, nudged, and eventually
 * gave up on a task the model was actively trying to perform.
 *
 *   Hermes / Qwen:  <tool_call>{"name": "read_file", "arguments": {…}}</tool_call>
 *   Llama / Nemotron XML:
 *       <function=run_command>
 *       <parameter=command>curl …</parameter>
 *       </function>
 *
 * Only the canonical form is ever *asked* for (see REPAIR_PROMPT); the others
 * exist purely so a model that insists on its training format still works.
 */

const TOOL_BLOCK = /<tool\s+name="([\w-]+)"\s*>\s*([\s\S]*?)<\/tool>/g;
/** Hermes-style: a <tool_call> wrapper whose body is a JSON object. */
const HERMES_BLOCK = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g;
/** `<function=name>` or `<function name="name">`, to a matching close tag. */
const XML_FUNCTION = /<function(?:=|\s+name=")([\w-]+)"?\s*>([\s\S]*?)<\/function\s*>/g;
/** `<parameter=name>` or `<parameter name="name">`. */
const XML_PARAMETER = /<parameter(?:=|\s+name=")([\w-]+)"?\s*>([\s\S]*?)<\/parameter\s*>/g;
/** Anything that looks like an attempt at a tool call, however malformed. */
const TOOL_INTENT = /<tool[\s>]|<tool_call>|<function[=\s]|<parameter[=\s]/;

function stripFence(text: string): string {
  return text.replace(/^```(?:json|xml)?\s*/i, '').replace(/```\s*$/, '').trim();
}

/**
 * A `<parameter>` body is raw text, not JSON — `curl -L …` has to survive as
 * a string. Only values that unambiguously read as JSON literals are coerced,
 * so a path like `2024` staying a string is the deliberate outcome for
 * anything ambiguous... except bare numbers and booleans, which schemas
 * genuinely do ask for (max_results, recursive).
 */
function coerceParameter(raw: string): unknown {
  const text = raw.trim();
  if (!/^(?:true|false|null|-?\d+(?:\.\d+)?|[[{])/.test(text)) return text;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

/** `<function=…><parameter=…>` blocks anywhere in `content`. */
function parseXmlFunctions(content: string): ParsedToolCall[] {
  const calls: ParsedToolCall[] = [];
  XML_FUNCTION.lastIndex = 0;
  for (let fn = XML_FUNCTION.exec(content); fn; fn = XML_FUNCTION.exec(content)) {
    const args: Record<string, unknown> = {};
    XML_PARAMETER.lastIndex = 0;
    for (let p = XML_PARAMETER.exec(fn[2]!); p; p = XML_PARAMETER.exec(fn[2]!)) {
      args[p[1]!] = coerceParameter(p[2]!);
    }
    calls.push({ name: fn[1]!, args });
  }
  return calls;
}

/** `<tool_call>` blocks whose body is a Hermes-style JSON object. */
function parseHermesBlocks(content: string): ParsedToolCall[] {
  const calls: ParsedToolCall[] = [];
  HERMES_BLOCK.lastIndex = 0;
  for (let m = HERMES_BLOCK.exec(content); m; m = HERMES_BLOCK.exec(content)) {
    const body = stripFence(m[1]!);
    // A <tool_call> wrapping the XML form is common too — let that path own it.
    if (/<function[=\s]/.test(body)) continue;
    if (!body) continue;
    try {
      const parsed = JSON.parse(body) as { name?: unknown; arguments?: unknown; parameters?: unknown };
      const name = typeof parsed.name === 'string' ? parsed.name : undefined;
      if (!name) {
        calls.push({ name: 'unknown', parseError: 'tool_call JSON has no "name" field.' });
        continue;
      }
      const rawArgs = parsed.arguments ?? parsed.parameters ?? {};
      // Some models double-encode the arguments object as a JSON string.
      const args =
        typeof rawArgs === 'string'
          ? ((): Record<string, unknown> => {
              try {
                return JSON.parse(rawArgs) as Record<string, unknown>;
              } catch {
                return {};
              }
            })()
          : (rawArgs as Record<string, unknown>);
      calls.push({ name, args });
    } catch (err) {
      calls.push({ name: 'unknown', parseError: err instanceof Error ? err.message : String(err) });
    }
  }
  return calls;
}

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

  // Canonical form wins; the tolerated dialects only fill in when it is absent,
  // so a reply mixing them cannot produce the same call twice.
  if (calls.length === 0) calls.push(...parseHermesBlocks(content), ...parseXmlFunctions(content));

  const narration = content
    .replace(TOOL_BLOCK, '')
    .replace(HERMES_BLOCK, '')
    .replace(XML_FUNCTION, '')
    .trim();

  return {
    calls,
    narration,
    hasToolIntent: calls.length > 0 || TOOL_INTENT.test(content),
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
