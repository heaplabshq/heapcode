import type { ChatMessage } from '../providers/types.js';

/**
 * Prompt contract for fast-apply models (FastApply-1.5B/7B and compatible):
 * given the full original code and an update snippet, the model outputs the
 * complete merged file inside <updated-code> tags.
 */

const APPLY_SYSTEM =
  'You are a coding assistant that helps merge code updates, ensuring every modification is fully integrated.';

export function buildApplyMessages(originalCode: string, updateSnippet: string): ChatMessage[] {
  return [
    { role: 'system', content: APPLY_SYSTEM },
    {
      role: 'user',
      content:
        'Merge all changes from the <update> snippet into the <code> below.\n' +
        "- Preserve the code's structure, order, comments, and indentation exactly.\n" +
        '- Output only the updated code, enclosed within <updated-code> and </updated-code> tags.\n' +
        '- Do not include any additional text, explanations, placeholders, ellipses, or code fences.\n\n' +
        `<code>${originalCode}</code>\n\n` +
        `<update>${updateSnippet}</update>\n\n` +
        'Provide the complete updated code.',
    },
  ];
}

export function extractUpdatedCode(response: string): string | undefined {
  const match = /<updated-code>([\s\S]*?)<\/updated-code>/.exec(response);
  if (match) return match[1]!.replace(/^\n/, '').replace(/\n$/, '');
  // Tolerate a missing closing tag on truncated output.
  const open = response.indexOf('<updated-code>');
  if (open !== -1) {
    return response
      .slice(open + '<updated-code>'.length)
      .replace(/^\n/, '')
      .replace(/\s*$/, '');
  }
  return undefined;
}
