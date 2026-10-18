import { syntaxTree } from '@codemirror/language';
import { RangeSetBuilder, StateField, type EditorState } from '@codemirror/state';
import { Decoration, EditorView, WidgetType, type DecorationSet } from '@codemirror/view';
import { highlightTree, type Highlighter } from '@lezer/highlight';

/**
 * Code blocks and tables, drawn as what they are once the cursor is
 * elsewhere — a code block without its ``` fences, highlighted and scrolling
 * sideways instead of wrapping; a table as a table. Clicking one, or moving
 * the cursor into it, puts the Markdown back to edit, as Bear does.
 *
 * A state field rather than live.ts's plugin: these replace whole lines,
 * which only a field may do.
 */
export function renderedBlocks(highlighter: Highlighter) {
  const build = (state: EditorState): DecorationSet => buildBlocks(state, highlighter);
  return StateField.define<DecorationSet>({
    create: build,
    update: (deco, tr) =>
      tr.docChanged || tr.selection || syntaxTree(tr.startState) !== syntaxTree(tr.state)
        ? build(tr.state)
        : deco,
    provide: (f) => EditorView.decorations.from(f),
  });
}

type SyntaxNode = ReturnType<typeof syntaxTree>['topNode'];

function editing(state: EditorState, from: number, to: number): boolean {
  return state.selection.ranges.some((r) => r.from <= to && r.to >= from);
}

function buildBlocks(state: EditorState, highlighter: Highlighter): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const tree = syntaxTree(state);
  tree.iterate({
    enter: (node) => {
      if (node.name !== 'FencedCode' && node.name !== 'Table') return;
      const from = state.doc.lineAt(node.from).from;
      const to = state.doc.lineAt(node.to).to;
      if (editing(state, from, to)) return false;
      const widget =
        node.name === 'FencedCode'
          ? codeWidget(state, node.node, highlighter)
          : tableWidget(state, node.node);
      if (widget) builder.add(from, to, Decoration.replace({ widget, block: true }));
      return false;
    },
  });
  return builder.finish();
}

// ── Code ───────────────────────────────────────────────────────────────

interface Span {
  from: number;
  to: number;
  cls: string;
}

function codeWidget(
  state: EditorState,
  node: SyntaxNode,
  highlighter: Highlighter,
): WidgetType | null {
  const marks = node.getChildren('CodeMark');
  const info = node.getChild('CodeInfo');
  const lang = info ? state.sliceDoc(info.from, info.to).trim() : '';
  // The code is everything between the fence lines; an unclosed fence runs to the end.
  const open = state.doc.lineAt(node.from);
  const closed =
    marks.length >= 2 && state.doc.lineAt(marks[marks.length - 1]!.from).number > open.number;
  const start = Math.min(open.to + 1, node.to);
  const end = closed ? state.doc.lineAt(marks[marks.length - 1]!.from).from - 1 : node.to;
  const code = end > start ? state.sliceDoc(start, end) : '';
  const spans: Span[] = [];
  // The language, once loaded, is a tree mounted inside this one.
  highlightTree(
    syntaxTree(state),
    highlighter,
    (f, t, cls) => {
      if (t > start && f < end)
        spans.push({ from: Math.max(f, start) - start, to: Math.min(t, end) - start, cls });
    },
    start,
    end,
  );
  return new CodeWidget(code, lang, spans, start - open.from);
}

class CodeWidget extends WidgetType {
  constructor(
    readonly code: string,
    readonly lang: string,
    readonly spans: Span[],
    /** Where a click puts the cursor: the first line of code. */
    readonly cursor: number,
  ) {
    super();
  }
  override eq(o: CodeWidget): boolean {
    return (
      o.code === this.code &&
      o.lang === this.lang &&
      o.spans.length === this.spans.length &&
      o.spans.every(
        (s, i) =>
          s.from === this.spans[i]!.from &&
          s.cls === this.spans[i]!.cls &&
          s.to === this.spans[i]!.to,
      )
    );
  }
  toDOM(view: EditorView): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'cm-code';
    const head = wrap.appendChild(document.createElement('div'));
    head.className = 'cm-code-head';
    const label = head.appendChild(document.createElement('span'));
    label.className = 'cm-code-lang';
    label.textContent = this.lang;
    // Copying the code is what people want from a code block — not the fences.
    const copy = head.appendChild(document.createElement('button'));
    copy.type = 'button';
    copy.className = 'cm-code-copy';
    copy.textContent = 'Copy';
    copy.setAttribute('aria-label', 'Copy code');
    copy.addEventListener('mousedown', (e) => e.preventDefault());
    copy.addEventListener('click', () => {
      void navigator.clipboard.writeText(this.code).then(
        () => {
          copy.textContent = 'Copied';
          setTimeout(() => (copy.textContent = 'Copy'), 1500);
        },
        () => (copy.textContent = 'Copy failed'),
      );
    });
    const pre = document.createElement('pre');
    let at = 0;
    for (const s of this.spans) {
      if (s.from > at) pre.appendChild(document.createTextNode(this.code.slice(at, s.from)));
      const el = document.createElement('span');
      el.className = s.cls;
      el.textContent = this.code.slice(Math.max(s.from, at), s.to);
      pre.appendChild(el);
      at = Math.max(at, s.to);
    }
    if (at < this.code.length) pre.appendChild(document.createTextNode(this.code.slice(at)));
    // An empty block still takes a line.
    if (!this.code) pre.textContent = '​';
    wrap.appendChild(pre);
    editOnClick(view, wrap, this.cursor);
    return wrap;
  }
  override ignoreEvent(): boolean {
    return true;
  }
}

// ── Tables ─────────────────────────────────────────────────────────────

type Align = 'left' | 'center' | 'right' | '';

function tableWidget(state: EditorState, node: SyntaxNode): WidgetType | null {
  const header = node.getChild('TableHeader');
  if (!header) return null;
  // The delimiter row is a direct child: `|---|:---:|`.
  let aligns: Align[] = [];
  for (let c = node.firstChild; c; c = c.nextSibling) {
    if (c.name === 'TableDelimiter') {
      aligns = splitRow(state.sliceDoc(c.from, c.to)).map((cell) => {
        const t = cell.trim();
        const l = t.startsWith(':');
        const r = t.endsWith(':');
        return l && r ? 'center' : r ? 'right' : l ? 'left' : '';
      });
      break;
    }
  }
  const rows = [header, ...node.getChildren('TableRow')].map((r) =>
    cellsOf(state, r).map((c) => (c ? inline(state, c) : [])),
  );
  return new TableWidget(rows, aligns, state.sliceDoc(node.from, node.to));
}

/** `| a | b |` → [' a ', ' b '], leading and trailing pipes optional. */
function splitRow(text: string): string[] {
  let t = text.trim();
  if (t.startsWith('|')) t = t.slice(1);
  if (t.endsWith('|') && !t.endsWith('\\|')) t = t.slice(0, -1);
  return t.split(/(?<!\\)\|/);
}

/** A row's cells in order, an empty cell as null — the parser leaves no node for one. */
function cellsOf(state: EditorState, row: SyntaxNode): (SyntaxNode | null)[] {
  const slots: (SyntaxNode | null)[][] = [[]];
  for (let c = row.firstChild; c; c = c.nextSibling) {
    if (c.name === 'TableDelimiter') slots.push([]);
    else if (c.name === 'TableCell') slots[slots.length - 1]!.push(c);
  }
  const text = state.sliceDoc(row.from, row.to).trim();
  if (text.startsWith('|')) slots.shift();
  if (text.endsWith('|')) slots.pop();
  return slots.map((s) => s[0] ?? null);
}

/** A cell's text with its bold, italics, code and links — what tables usually hold. */
type Inline = string | { tag: string; kids: Inline[] };

function inline(state: EditorState, node: SyntaxNode): Inline[] {
  const out: Inline[] = [];
  let at = node.from;
  const text = (to: number) => {
    if (to > at) out.push(state.sliceDoc(at, to).replace(/\\\|/g, '|'));
  };
  for (let c = node.firstChild; c; c = c.nextSibling) {
    text(c.from);
    at = c.to;
    if (c.name.endsWith('Mark') || c.name === 'URL' || c.name === 'LinkTitle') continue;
    const tag =
      c.name === 'StrongEmphasis'
        ? 'strong'
        : c.name === 'Emphasis'
          ? 'em'
          : c.name === 'InlineCode'
            ? 'code'
            : c.name === 'Strikethrough'
              ? 's'
              : c.name === 'Link' || c.name === 'WikiLink'
                ? 'u'
                : 'span';
    out.push({ tag, kids: c.firstChild ? inline(state, c) : [state.sliceDoc(c.from, c.to)] });
  }
  text(node.to);
  return out;
}

function draw(parts: Inline[], into: HTMLElement): void {
  for (const p of parts) {
    if (typeof p === 'string') into.appendChild(document.createTextNode(p));
    else draw(p.kids, into.appendChild(document.createElement(p.tag)));
  }
}

class TableWidget extends WidgetType {
  constructor(
    readonly rows: Inline[][][],
    readonly aligns: Align[],
    readonly source: string,
  ) {
    super();
  }
  override eq(o: TableWidget): boolean {
    return o.source === this.source;
  }
  toDOM(view: EditorView): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'cm-table';
    const table = document.createElement('table');
    const columns = Math.max(this.aligns.length, ...this.rows.map((r) => r.length));
    this.rows.forEach((row, i) => {
      const tr = document.createElement('tr');
      for (let col = 0; col < columns; col++) {
        const cell = document.createElement(i === 0 ? 'th' : 'td');
        const align = this.aligns[col];
        if (align) cell.style.textAlign = align;
        draw(row[col] ?? [], cell);
        tr.appendChild(cell);
      }
      if (i === 0) table.appendChild(document.createElement('thead')).appendChild(tr);
      else (table.tBodies[0] ?? table.appendChild(document.createElement('tbody'))).appendChild(tr);
    });
    wrap.appendChild(table);
    editOnClick(view, wrap, 2);
    return wrap;
  }
  override ignoreEvent(): boolean {
    return true;
  }
}

/** A click puts the cursor inside the block, which brings its Markdown back. */
function editOnClick(view: EditorView, el: HTMLElement, offset: number): void {
  el.addEventListener('mousedown', (e) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest('button')) return;
    // A click on a wide block's scrollbar scrolls it.
    const scroller = (e.target as HTMLElement).closest<HTMLElement>('pre, .cm-table');
    if (scroller && e.offsetY > scroller.clientHeight) return;
    e.preventDefault();
    const from = view.posAtDOM(el);
    view.dispatch({ selection: { anchor: Math.min(from + offset, view.state.doc.length) } });
    view.focus();
  });
}
