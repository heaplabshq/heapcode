import { extractFirstCodeBlock } from '../edit/codeBlocks.js';
import type { ChatMessage } from '../providers/types.js';

const EDIT_SYSTEM_PROMPT =
  'You are a precise code editing engine. You will receive a piece of selected code and an instruction. ' +
  'Reply with EXACTLY ONE fenced code block containing the complete replacement for the selected code. ' +
  'No explanations, no comments about your changes, nothing outside the code block. ' +
  'Keep the surrounding style and conventions. Do not change behavior beyond what the instruction requires.';

export interface InlineEditOptions {
  instruction: string;
  selectedCode: string;
  languageId: string;
  filePath: string;
  /** Optional code around the selection, for style/context. */
  prefix?: string;
  suffix?: string;
  /** Optional semantically-related snippets from elsewhere in the workspace (from the RAG index). */
  relatedCode?: string;
}

export function buildInlineEditMessages(opts: InlineEditOptions): ChatMessage[] {
  const parts: string[] = [`File: ${opts.filePath} (${opts.languageId})`];
  if (opts.prefix) {
    parts.push(`CODE BEFORE SELECTION (context only, do not include in reply):\n${opts.prefix}`);
  }
  parts.push(`SELECTED CODE:\n\`\`\`${opts.languageId}\n${opts.selectedCode}\n\`\`\``);
  if (opts.suffix) {
    parts.push(`CODE AFTER SELECTION (context only, do not include in reply):\n${opts.suffix}`);
  }
  if (opts.relatedCode) {
    parts.push(
      `RELATED CODE FROM ELSEWHERE IN THE WORKSPACE (context only, do not include in reply):\n${opts.relatedCode}`,
    );
  }
  parts.push(`INSTRUCTION: ${opts.instruction}`);

  return [
    { role: 'system', content: EDIT_SYSTEM_PROMPT },
    { role: 'user', content: parts.join('\n\n') },
  ];
}

const COMMIT_SYSTEM_PROMPT =
  'You write git commit messages. Given a diff, reply with ONLY the commit message: ' +
  'a conventional-commit subject line (max 72 chars, e.g. "fix: handle empty input"), ' +
  'then, only if the change is non-trivial, a blank line and a short body in plain prose. ' +
  'No code fences, no quotes, no commentary.';

export function buildCommitMessages(diff: string): ChatMessage[] {
  return [
    { role: 'system', content: COMMIT_SYSTEM_PROMPT },
    { role: 'user', content: `Write the commit message for this diff:\n\n${diff}` },
  ];
}

/**
 * Strips what models add despite the prompt: a code fence around the whole
 * message, or wrapping quotes. Beside the prompt it belongs to rather than in
 * whichever host happened to render the result — the extension did this
 * inline before commit-message generation moved to the server.
 */
export function normalizeCommitMessage(content: string): string {
  const unfenced = (extractFirstCodeBlock(content) ?? content).trim();
  return unfenced.replace(/^["'`]+|["'`]+$/g, '').trim();
}
