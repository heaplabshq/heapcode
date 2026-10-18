import { syntaxTree } from '@codemirror/language';
import { RangeSetBuilder, StateField, type EditorState } from '@codemirror/state';
import { Decoration, EditorView, WidgetType, type DecorationSet } from '@codemirror/view';
import { highlightTree, type Highlighter } from '@lezer/highlight';
import { mermaidTheme, renderMermaid } from '@heapcode/web-ui/mermaid';
import { TableWidget } from './table.js';

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
          : new TableWidget(state.sliceDoc(from, to));
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
  // A diagram, drawn — the code is a click away, as every block's is.
  if (lang.toLowerCase() === 'mermaid') return new MermaidWidget(code, start - open.from);
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

// ── Diagrams ───

/** Drawn diagrams by source, so scrolling or moving the cursor doesn't redraw them. */
const drawn = new Map<string, { svg?: string; error?: string }>();

class MermaidWidget extends WidgetType {
  constructor(
    readonly code: string,
    readonly cursor: number,
  ) {
    super();
  }
  override eq(o: MermaidWidget): boolean {
    return o.code === this.code;
  }
  override get estimatedHeight(): number {
    return 200;
  }
  toDOM(view: EditorView): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'cm-mermaid';
    const key = `${mermaidTheme()}\n${this.code}`;
    const show = (r: { svg?: string; error?: string }) => {
      wrap.replaceChildren();
      if (r.svg !== undefined) {
        // Strict mode: Mermaid has escaped the labels and dropped scripts and links.
        wrap.innerHTML = r.svg;
      } else {
        wrap.classList.add('cm-mermaid-bad');
        const msg = wrap.appendChild(document.createElement('div'));
        msg.className = 'cm-mermaid-error';
        msg.textContent = `This diagram has a mistake: ${(r.error ?? '').split('\n')[0]}`;
        const pre = wrap.appendChild(document.createElement('pre'));
        pre.textContent = this.code;
      }
      view.requestMeasure();
    };
    const done = drawn.get(key);
    if (done) show(done);
    else {
      wrap.classList.add('cm-mermaid-wait');
      wrap.textContent = 'Drawing the diagram…';
      renderMermaid(this.code).then(
        (svg) => {
          const r = { svg };
          drawn.set(key, r);
          wrap.classList.remove('cm-mermaid-wait');
          show(r);
        },
        (e: unknown) => {
          const r = { error: e instanceof Error ? e.message : String(e) };
          drawn.set(key, r);
          wrap.classList.remove('cm-mermaid-wait');
          show(r);
        },
      );
      if (drawn.size > 200) drawn.delete(drawn.keys().next().value!);
    }
    editOnClick(view, wrap, this.cursor);
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
