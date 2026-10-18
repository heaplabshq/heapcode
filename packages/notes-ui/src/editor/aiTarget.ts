import { StateEffect, StateField, type EditorState } from '@codemirror/state';
import { Decoration, EditorView, type DecorationSet } from '@codemirror/view';

/**
 * What ⌘J works on, and keeping it visible while the menu has the focus —
 * a selection vanishes the moment focus leaves the editor, and an AI edit of
 * text you can no longer see is an edit you can't judge.
 */

/**
 * The selection, or with nothing selected, the paragraph the cursor is in
 * (lines up to the blank lines around it). Never the title line: rewriting
 * the title renames the note. Undefined when there's nothing to work on.
 */
export function targetRange(state: EditorState): { from: number; to: number } | undefined {
  const { from, to } = state.selection.main;
  const doc = state.doc;
  if (from !== to) {
    // Off the title, if the selection starts on it.
    const start = doc.lineAt(from).number === 1 ? Math.min(doc.line(1).to + 1, doc.length) : from;
    return start < to ? { from: start, to } : undefined;
  }
  const here = doc.lineAt(from);
  if (here.number === 1 || here.text.trim() === '') return undefined;
  let first = here;
  while (first.number > 2 && doc.line(first.number - 1).text.trim() !== '')
    first = doc.line(first.number - 1);
  let last = here;
  while (last.number < doc.lines && doc.line(last.number + 1).text.trim() !== '')
    last = doc.line(last.number + 1);
  return { from: first.from, to: last.to };
}

export const setAiTarget = StateEffect.define<{ from: number; to: number } | null>();

const mark = Decoration.mark({ class: 'cm-ai-target' });

/** The highlighted target, mapped through edits so it stays on the same text. */
export const aiTarget = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    let next = deco.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(setAiTarget))
        next =
          e.value && e.value.to > e.value.from
            ? Decoration.set([mark.range(e.value.from, e.value.to)])
            : Decoration.none;
    }
    return next;
  },
  provide: (f) => EditorView.decorations.from(f),
});
