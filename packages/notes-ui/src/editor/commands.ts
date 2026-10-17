import {
  EditorSelection,
  type ChangeSpec,
  type EditorState,
  type StateCommand,
  type Transaction,
} from '@codemirror/state';

/**
 * The formatting commands behind Bear's shortcuts.
 * State-only — no view — so each is a pure function of the text and the
 * selection, and is tested that way.
 */

/** Wrap each selection in `marker`, or unwrap it when it already is. */
export function toggleInline(marker: string): StateCommand {
  return ({ state, dispatch }) => {
    const n = marker.length;
    const tr = state.changeByRange((range) => {
      const before = state.sliceDoc(range.from - n, range.from);
      const after = state.sliceDoc(range.to, range.to + n);
      if (before === marker && after === marker) {
        return {
          changes: [
            { from: range.from - n, to: range.from },
            { from: range.to, to: range.to + n },
          ],
          range: EditorSelection.range(range.from - n, range.to - n),
        };
      }
      const text = state.sliceDoc(range.from, range.to);
      if (text.length >= 2 * n && text.startsWith(marker) && text.endsWith(marker)) {
        return {
          changes: { from: range.from, to: range.to, insert: text.slice(n, -n) },
          range: EditorSelection.range(range.from, range.to - 2 * n),
        };
      }
      return {
        changes: [
          { from: range.from, insert: marker },
          { from: range.to, insert: marker },
        ],
        range: EditorSelection.range(range.from + n, range.to + n),
      };
    });
    dispatch(state.update(tr, { scrollIntoView: true, userEvent: 'input.format' }));
    return true;
  };
}

type LineKind =
  | { kind: 'heading'; level: number }
  | { kind: 'bullet' }
  | { kind: 'ordered' }
  | { kind: 'quote' }
  | { kind: 'todo' };

const PREFIX = /^(\s*)(#{1,6} |> |[-*+] \[[ xX]\] |[-*+] |\d+[.)] )?/;

function prefixFor(k: LineKind, n: number): string {
  switch (k.kind) {
    case 'heading':
      return `${'#'.repeat(k.level)} `;
    case 'bullet':
      return '- ';
    case 'ordered':
      return `${n}. `;
    case 'quote':
      return '> ';
    case 'todo':
      return '- [ ] ';
  }
}

function sameKind(existing: string, k: LineKind): boolean {
  switch (k.kind) {
    case 'heading':
      return existing === `${'#'.repeat(k.level)} `;
    case 'bullet':
      return /^[-*+] $/.test(existing);
    case 'ordered':
      return /^\d+[.)] $/.test(existing);
    case 'quote':
      return existing === '> ';
    case 'todo':
      return /^[-*+] \[[ xX]\] $/.test(existing);
  }
}

/**
 * Make every selected line this kind — or plain again, when they all already
 * are. A line's old prefix is replaced, so a bullet becomes a heading rather
 * than `# - item`.
 */
export function setLineKind(k: LineKind): StateCommand {
  return ({ state, dispatch }) => {
    const lines = selectedLines(state);
    const all = lines.every((l) => sameKind(PREFIX.exec(l.text)![2] ?? '', k));
    const changes: ChangeSpec[] = [];
    lines.forEach((line, i) => {
      const m = PREFIX.exec(line.text)!;
      const indent = m[1]!;
      const old = m[2] ?? '';
      // Headings don't indent.
      const lead = k.kind === 'heading' ? '' : indent;
      const insert = all ? indent : lead + prefixFor(k, i + 1);
      changes.push({ from: line.from, to: line.from + indent.length + old.length, insert });
    });
    dispatch(state.update({ changes, scrollIntoView: true, userEvent: 'input.format' }));
    return true;
  };
}

/** ⌘. — tick or untick a task; a line that isn't one becomes one. */
export const toggleTask: StateCommand = ({ state, dispatch }) => {
  const changes: ChangeSpec[] = [];
  for (const line of selectedLines(state)) {
    const m = /^(\s*(?:>\s*)*(?:[-*+]|\d+[.)]) \[)([ xX])\]/.exec(line.text);
    if (m) {
      const at = line.from + m[1]!.length;
      changes.push({ from: at, to: at + 1, insert: m[2] === ' ' ? 'x' : ' ' });
    } else {
      const lead = PREFIX.exec(line.text)!;
      const indent = lead[1]!;
      const old = lead[2] ?? '';
      changes.push({
        from: line.from + indent.length,
        to: line.from + indent.length + (old.startsWith('#') ? 0 : old.length),
        insert: '- [ ] ',
      });
    }
  }
  dispatch(state.update({ changes, userEvent: 'input.format' }));
  return true;
};

/** Flip the task on one line — the checkbox click. */
export function toggleTaskAt(state: EditorState, pos: number): Transaction | null {
  const line = state.doc.lineAt(pos);
  const m = /^(\s*(?:>\s*)*(?:[-*+]|\d+[.)]) \[)([ xX])\]/.exec(line.text);
  if (!m) return null;
  const at = line.from + m[1]!.length;
  return state.update({
    changes: { from: at, to: at + 1, insert: m[2] === ' ' ? 'x' : ' ' },
    userEvent: 'input.format',
  });
}

/** Insert text at each selection, putting the cursor `cursorBack` characters before its end. */
export function insertText(
  text: string | ((selected: string) => string),
  cursorBack = 0,
): StateCommand {
  return ({ state, dispatch }) => {
    const tr = state.changeByRange((range) => {
      const insert = typeof text === 'function' ? text(state.sliceDoc(range.from, range.to)) : text;
      return {
        changes: { from: range.from, to: range.to, insert },
        range: EditorSelection.cursor(range.from + insert.length - cursorBack),
      };
    });
    dispatch(state.update(tr, { scrollIntoView: true, userEvent: 'input' }));
    return true;
  };
}

/** ⌘K: `[selection](|)`, or `[|](url)` when the selection is a URL. */
export const insertLink: StateCommand = ({ state, dispatch }) => {
  const tr = state.changeByRange((range) => {
    const sel = state.sliceDoc(range.from, range.to);
    if (/^https?:\/\/\S+$/.test(sel)) {
      return {
        changes: { from: range.from, to: range.to, insert: `[](${sel})` },
        range: EditorSelection.cursor(range.from + 1),
      };
    }
    const insert = `[${sel}]()`;
    return {
      changes: { from: range.from, to: range.to, insert },
      range: EditorSelection.cursor(range.from + insert.length - 1),
    };
  });
  dispatch(state.update(tr, { scrollIntoView: true, userEvent: 'input' }));
  return true;
};

/** ⌘D: `[[selection]]`, the cursor inside when there is no selection. */
export const insertWikiLink: StateCommand = ({ state, dispatch }) => {
  const tr = state.changeByRange((range) => {
    const sel = state.sliceDoc(range.from, range.to);
    const insert = `[[${sel}]]`;
    return {
      changes: { from: range.from, to: range.to, insert },
      range: sel
        ? EditorSelection.cursor(range.from + insert.length)
        : EditorSelection.cursor(range.from + 2),
    };
  });
  dispatch(state.update(tr, { scrollIntoView: true, userEvent: 'input' }));
  return true;
};

/** ⌃⌘C: a fenced block around the selected lines, or an empty one. */
export const insertCodeBlock: StateCommand = ({ state, dispatch }) => {
  const range = state.selection.main;
  const from = state.doc.lineAt(range.from);
  const to = state.doc.lineAt(range.to);
  const body = state.sliceDoc(from.from, to.to);
  const insert = `\`\`\`\n${body}\n\`\`\``;
  dispatch(
    state.update({
      changes: { from: from.from, to: to.to, insert },
      selection: EditorSelection.cursor(body ? from.from + insert.length : from.from + 4),
      scrollIntoView: true,
      userEvent: 'input.format',
    }),
  );
  return true;
};

/** Bear's date shortcuts: ⇧⌘8 date, ⌥⇧⌘8 ISO, ⇧⌘9 short, ⇧⌘7 date and time, ⇧⌘0 time. */
export function formatDate(
  kind: 'long' | 'iso' | 'short' | 'datetime' | 'time',
  now = new Date(),
): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  switch (kind) {
    case 'iso':
      return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
    case 'short':
      return now.toLocaleDateString(undefined, { dateStyle: 'short' });
    case 'datetime':
      return now.toLocaleString(undefined, { dateStyle: 'long', timeStyle: 'short' });
    case 'time':
      return now.toLocaleTimeString(undefined, { timeStyle: 'short' });
    default:
      return now.toLocaleDateString(undefined, { dateStyle: 'long' });
  }
}

function selectedLines(state: EditorState): { from: number; to: number; text: string }[] {
  const seen = new Set<number>();
  const out: { from: number; to: number; text: string }[] = [];
  for (const r of state.selection.ranges) {
    for (let pos = r.from; pos <= r.to;) {
      const line = state.doc.lineAt(pos);
      if (!seen.has(line.from)) {
        seen.add(line.from);
        out.push({ from: line.from, to: line.to, text: line.text });
      }
      if (line.to + 1 > r.to) break;
      pos = line.to + 1;
    }
  }
  return out;
}
