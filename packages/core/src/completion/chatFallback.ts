import type { ChatMessage } from '../providers/types.js';

const SYSTEM =
  'You are a code completion engine. Given the code before and after the cursor, ' +
  'reply with ONLY the text to insert at the cursor position. ' +
  'No explanations, no markdown fences, no repetition of code that already exists.';

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
