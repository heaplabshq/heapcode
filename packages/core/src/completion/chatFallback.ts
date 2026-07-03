import type { ChatMessage } from '../providers/types.js';

const SYSTEM =
  'You are a code completion engine, not a chat assistant. ' +
  'The user\'s code is split at the cursor into BEFORE and AFTER sections. ' +
  'Output ONLY the new characters that belong exactly at the cursor — the text a ' +
  'programmer would type next. Rules:\n' +
  '- NEVER repeat any line from BEFORE or AFTER.\n' +
  '- NEVER re-print the file, imports, or earlier code.\n' +
  '- No markdown, no code fences, no explanations, no comments about the task.\n' +
  '- Usually 1-6 lines. If nothing sensible fits, output nothing.';

/** Completion prompt for models without a FIM format. */
export function buildChatCompletionMessages(opts: {
  prefix: string;
  suffix: string;
  languageId: string;
}): ChatMessage[] {
  return [
    { role: 'system', content: SYSTEM },
    {
      role: 'user',
      content:
        `Language: ${opts.languageId}\n` +
        `<CODE_BEFORE_CURSOR>\n${opts.prefix}\n</CODE_BEFORE_CURSOR>\n` +
        `<CODE_AFTER_CURSOR>\n${opts.suffix}\n</CODE_AFTER_CURSOR>\n` +
        'Insert at cursor:',
    },
  ];
}
