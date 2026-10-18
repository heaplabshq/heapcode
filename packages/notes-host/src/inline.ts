import type { ChatMessage } from '@heapcode/core';
import type { InlineAction } from './protocol.js';

/**
 * ⌘J: a quick model edit of selected text (HEAPNOTES_PHASE2_PLAN §2D) —
 * Apple's Writing Tools set (rewrite, shorten, proofread, summarize) plus
 * continue, list and translate, and a free instruction. The model returns
 * only the replacement; the page shows it as a diff and nothing changes until
 * it is accepted.
 */
export const INLINE_ACTIONS: Record<
  Exclude<InlineAction, 'custom'>,
  { label: string; instruction: string }
> = {
  improve: {
    label: 'Improve writing',
    instruction: 'Improve the writing: clearer and smoother, same meaning, similar length.',
  },
  shorten: { label: 'Make shorter', instruction: 'Make it shorter, keeping every fact and name.' },
  fix: {
    label: 'Fix spelling & grammar',
    instruction:
      'Fix spelling, grammar and punctuation only. Change nothing else — not word choice, not tone, not formatting.',
  },
  summarize: {
    label: 'Summarize',
    instruction: 'Replace it with a short summary of what it says.',
  },
  list: {
    label: 'Turn into a list',
    instruction: 'Turn it into a Markdown bulleted list, one point per line.',
  },
  tasks: {
    label: 'Turn into tasks',
    instruction: 'Turn it into a Markdown task list ("- [ ] …"), one action per line.',
  },
  continue: {
    label: 'Continue writing',
    instruction:
      'Write what comes next, a few sentences, continuing from the end of the selection in the same voice. Return only the new text.',
  },
};

const SYSTEM = `You edit part of a Markdown note for its author. You get the note around the passage for context, the passage itself (SELECTION), and what to do.

Return only the text that replaces the SELECTION — no preamble, no explanation, no quotes around it, no code fence around it. Keep Markdown, #tags, [[links]] and the author's voice and language unless told otherwise. If the instruction can't apply, return the SELECTION unchanged.`;

/** The model's messages for one ⌘J request. */
export function inlineMessages(req: {
  action: InlineAction;
  instruction?: string;
  selection: string;
  before: string;
  after: string;
}): ChatMessage[] {
  const what =
    req.action === 'custom'
      ? (req.instruction ?? '').trim() || 'Improve it.'
      : INLINE_ACTIONS[req.action].instruction;
  const user = [
    `NOTE BEFORE THE SELECTION:\n${clipStart(req.before, 1500)}`,
    `NOTE AFTER THE SELECTION:\n${clipEnd(req.after, 1000)}`,
    `WHAT TO DO: ${what}`,
    `SELECTION:\n${req.selection}`,
  ].join('\n\n');
  return [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: user },
  ];
}

/**
 * What the model said, as replacement text: a fence or quotes it wrapped the
 * answer in come off, and so does a "Here is…" line before it. The trailing
 * line break follows the selection's, so a replaced paragraph keeps its spacing.
 */
export function cleanInline(text: string, selection: string): string {
  let out = text.replace(/\r\n/g, '\n').trim();
  const fence = /^```[\w-]*\n([\s\S]*?)\n```$/.exec(out);
  if (fence) out = fence[1]!;
  out = out.replace(/^(?:here(?:'s| is)[^\n]*:|sure[^\n]*:)\s*\n/i, '');
  if (/^"[\s\S]*"$/.test(out) && !/^"[\s\S]*"$/.test(selection.trim())) out = out.slice(1, -1);
  const tail = /\n+$/.exec(selection)?.[0] ?? '';
  return out.trim() + tail;
}

function clipStart(s: string, n: number): string {
  return s.length > n ? `…${s.slice(-n)}` : s;
}

function clipEnd(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}
