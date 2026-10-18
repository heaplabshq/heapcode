import { syntaxTree } from '@codemirror/language';
import {
  Facet,
  RangeSetBuilder,
  StateField,
  type EditorState,
  type Extension,
  type Range,
} from '@codemirror/state';
import {
  Decoration,
  EditorView,
  ViewPlugin,
  WidgetType,
  hoverTooltip,
  type DecorationSet,
  type ViewUpdate,
} from '@codemirror/view';
import { renderMarkdown } from '@heapcode/web-ui/markdown';
import { toggleTaskAt } from './commands.js';
import { wikiTarget } from './markup.js';
import { imagesInLine, withWidth } from './images.js';

/**
 * Live rendering, the way Bear does it: Markdown stays the text, but away from
 * the cursor its markup gets out of the way — `**`, `#`, `==` and link URLs
 * hide, tasks become checkboxes, bullets become dots, images show. On the
 * line being edited everything is back, so nothing is ever hidden while you
 * type it.
 */
export interface NoteContext {
  /** The note's folder in the vault, `/`-separated ('' at the top). */
  dir: string;
  /** Prefix for vault files, e.g. `/notes/attachment/`. */
  attachmentBase: string;
  openLink(target: string): void;
  openTag(tag: string): void;
  openUrl(url: string): void;
  /** The note a [[link]] points at, for its hover preview; null when there's none. */
  peek?(
    target: string,
  ): Promise<{ title: string; path: string; content: string; more: boolean } | null>;
}

export const noteContext = Facet.define<NoteContext, NoteContext>({
  combine: (values) =>
    values[0] ?? {
      dir: '',
      attachmentBase: '',
      openLink: () => undefined,
      openTag: () => undefined,
      openUrl: () => undefined,
    },
});

/** Inline marks that hide once the cursor leaves their span. */
const HIDE_WHEN_IDLE = new Set([
  'EmphasisMark',
  'StrikethroughMark',
  'HighlightMark',
  'UnderlineMark',
  'WikiLinkMark',
]);

/**
 * Whether the cursor or a selection is in `from..to` (ends included), while
 * the editor has focus. Markup shows only for the element being edited — as
 * in Bear, Obsidian's live preview and Typora — so `### ` turns into a
 * heading as soon as you type its first letter, not when you leave the line.
 */
function touching(state: EditorState, focused: boolean, from: number, to: number): boolean {
  if (!focused) return false;
  return state.selection.ranges.some((r) => r.from <= to && r.to >= from);
}

/** The mark plus the one space after it — `### `, `- `, `> `. */
function withSpace(state: EditorState, to: number): number {
  return state.sliceDoc(to, to + 1) === ' ' ? to + 1 : to;
}

class CheckboxWidget extends WidgetType {
  constructor(readonly checked: boolean) {
    super();
  }
  override eq(other: CheckboxWidget): boolean {
    return other.checked === this.checked;
  }
  toDOM(view: EditorView): HTMLElement {
    const box = document.createElement('span');
    box.className = this.checked ? 'cm-task cm-task-on' : 'cm-task';
    box.setAttribute('role', 'checkbox');
    box.setAttribute('aria-checked', String(this.checked));
    box.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const tr = toggleTaskAt(view.state, view.posAtDOM(box));
      if (tr) view.dispatch(tr);
    });
    return box;
  }
  override ignoreEvent(): boolean {
    return true;
  }
}

/** `###` as Bear shows it: a small "H3" in the margin, beside the heading. */
class HeadingLabel extends WidgetType {
  constructor(readonly level: number) {
    super();
  }
  override eq(other: HeadingLabel): boolean {
    return other.level === this.level;
  }
  toDOM(): HTMLElement {
    const s = document.createElement('span');
    s.className = 'cm-hlabel';
    s.textContent = `H${this.level}`;
    s.setAttribute('aria-hidden', 'true');
    return s;
  }
}

class BulletWidget extends WidgetType {
  override eq(): boolean {
    return true;
  }
  toDOM(): HTMLElement {
    const s = document.createElement('span');
    s.className = 'cm-bullet';
    s.textContent = '•';
    return s;
  }
}

class RuleWidget extends WidgetType {
  override eq(): boolean {
    return true;
  }
  toDOM(): HTMLElement {
    const s = document.createElement('span');
    s.className = 'cm-rule';
    return s;
  }
}

/** Widths the image bar offers; none means the image's own size, up to the page. */
const IMAGE_SIZES: { label: string; width?: number; title: string }[] = [
  { label: 'S', width: 240, title: 'Small — 240px wide' },
  { label: 'M', width: 420, title: 'Medium — 420px wide' },
  { label: 'L', width: 640, title: 'Large — 640px wide' },
  { label: 'Fit', title: 'Its own size, up to the page width' },
];

class ImageWidget extends WidgetType {
  constructor(
    readonly src: string,
    /** Which image on its line, for finding its Markdown when a button is used. */
    readonly nth: number,
    readonly width: number | undefined,
    /** False in a read-only note (trash): no bar. `editable` is WidgetType's own. */
    readonly canChange: boolean,
  ) {
    super();
  }
  override eq(other: ImageWidget): boolean {
    return (
      other.src === this.src &&
      other.nth === this.nth &&
      other.width === this.width &&
      other.canChange === this.canChange
    );
  }
  toDOM(view: EditorView): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'cm-image';
    const frame = wrap.appendChild(document.createElement('div'));
    frame.className = 'cm-image-frame';
    const img = frame.appendChild(document.createElement('img'));
    img.src = this.src;
    img.alt = '';
    img.loading = 'lazy';
    if (this.width) img.style.width = `${this.width}px`;
    img.onerror = () => wrap.classList.add('cm-image-broken');
    if (!this.canChange) return wrap;

    // Size and remove, on hover — the only other way out was undo.
    const bar = frame.appendChild(document.createElement('div'));
    bar.className = 'cm-image-bar';
    const button = (label: string, title: string, run: () => void, on = false) => {
      const b = bar.appendChild(document.createElement('button'));
      b.type = 'button';
      b.textContent = label;
      b.title = title;
      if (on) b.className = 'cm-image-on';
      b.addEventListener('mousedown', (e) => {
        e.preventDefault();
        run();
      });
    };
    for (const size of IMAGE_SIZES)
      button(
        size.label,
        size.title,
        () => this.resize(view, wrap, size.width),
        size.width === this.width,
      );
    button('Remove', 'Remove the image from the note', () => this.remove(view, wrap));
    return wrap;
  }

  /** Its Markdown now: the widget sits at the end of the image's line. */
  private markup(view: EditorView, wrap: HTMLElement) {
    const line = view.state.doc.lineAt(view.posAtDOM(wrap));
    const found = imagesInLine(line.text)[this.nth];
    return found && { line, from: line.from + found.start, to: line.from + found.end };
  }

  private resize(view: EditorView, wrap: HTMLElement, width: number | undefined): void {
    const m = this.markup(view, wrap);
    if (!m) return;
    const insert = withWidth(view.state.sliceDoc(m.from, m.to), width);
    view.dispatch({ changes: { from: m.from, to: m.to, insert }, userEvent: 'input.image' });
  }

  private remove(view: EditorView, wrap: HTMLElement): void {
    const m = this.markup(view, wrap);
    if (!m) return;
    const rest = m.line.text.slice(0, m.from - m.line.from) + m.line.text.slice(m.to - m.line.from);
    // Alone on its line: the line goes too, and the blank line after it,
    // so the paragraphs either side close up instead of leaving a gap.
    const doc = view.state.doc;
    let from = m.from;
    let to = m.to;
    if (rest.trim() === '') {
      const { line } = m;
      if (line.number === doc.lines) {
        from = line.number > 1 ? line.from - 1 : line.from;
        to = line.to;
      } else {
        const next = doc.line(line.number + 1);
        from = line.from;
        to = next.text.trim() === '' ? Math.min(next.to + 1, doc.length) : next.from;
      }
    }
    view.dispatch({ changes: { from, to }, userEvent: 'delete.image' });
  }

  override ignoreEvent(): boolean {
    return true;
  }
}

const hidden = Decoration.replace({});

function buildInline(view: EditorView): DecorationSet {
  const { state } = view;
  const out: Range<Decoration>[] = [];
  const editing = (from: number, to: number) => touching(state, view.hasFocus, from, to);

  for (const { from, to } of view.visibleRanges) {
    syntaxTree(state).iterate({
      from,
      to,
      enter: (node) => {
        const name = node.name;
        const heading = /^ATXHeading(\d)$/.exec(name);
        if (heading) {
          out.push(
            Decoration.line({ class: `cm-h cm-h${heading[1]}` }).range(
              state.doc.lineAt(node.from).from,
            ),
          );
          return;
        }
        if (name === 'HeaderMark' && node.node.parent?.name.startsWith('ATXHeading')) {
          // Only the closing `###` some write after a heading has text before it.
          if (node.from > state.doc.lineAt(node.from).from) {
            if (!editing(node.from, node.to)) out.push(hidden.range(node.from, node.to));
            return;
          }
          const end = withSpace(state, node.to);
          // Raw while the cursor is in `### ` itself; otherwise a margin label.
          if (end > node.to && !editing(node.from, end)) {
            const level = Number(/^ATXHeading(\d)$/.exec(node.node.parent.name)?.[1] ?? 1);
            out.push(Decoration.replace({ widget: new HeadingLabel(level) }).range(node.from, end));
          }
          return;
        }
        if (name === 'QuoteMark') {
          const end = withSpace(state, node.to);
          if (!editing(node.from, end)) out.push(hidden.range(node.from, end));
          return;
        }
        if (HIDE_WHEN_IDLE.has(name)) {
          // The whole span counts: inside `**bold**` the stars show, past it they go.
          const span = node.node.parent ?? node.node;
          if (!editing(span.from, span.to)) out.push(hidden.range(node.from, node.to));
          return;
        }
        if (name === 'CodeMark' && node.node.parent?.name === 'InlineCode') {
          const span = node.node.parent;
          if (!editing(span.from, span.to)) out.push(hidden.range(node.from, node.to));
          return;
        }
        if (name === 'Blockquote') {
          for (let pos = node.from; pos <= node.to;) {
            const line = state.doc.lineAt(pos);
            out.push(Decoration.line({ class: 'cm-quote' }).range(line.from));
            pos = line.to + 1;
          }
          return;
        }
        if (name === 'Table') {
          // Being edited (blocks.ts draws it otherwise): columns line up in mono.
          for (let pos = node.from; pos <= node.to;) {
            const line = state.doc.lineAt(pos);
            out.push(Decoration.line({ class: 'cm-tablesrc' }).range(line.from));
            pos = line.to + 1;
          }
          return false;
        }
        if (name === 'FencedCode') {
          for (let pos = node.from; pos <= node.to;) {
            const line = state.doc.lineAt(pos);
            // A wrapped line carries on under its own indent, not at the margin.
            const indent = /^[ \t]*/.exec(line.text)![0].replace(/\t/g, '    ').length;
            out.push(
              Decoration.line(
                indent
                  ? {
                      class: 'cm-codeblock',
                      attributes: {
                        style: `padding-left: calc(12px + ${indent}ch) !important; text-indent: -${indent}ch`,
                      },
                    }
                  : { class: 'cm-codeblock' },
              ).range(line.from),
            );
            pos = line.to + 1;
          }
          return false;
        }
        if (name === 'Hashtag') {
          const tag = state.sliceDoc(node.from + 1, node.to).replace(/#$/, '');
          out.push(
            Decoration.mark({ class: 'cm-tag', attributes: { 'data-tag': tag } }).range(
              node.from,
              node.to,
            ),
          );
          return;
        }
        if (name === 'WikiLink') {
          const target = wikiTarget(state.sliceDoc(node.from, node.to));
          out.push(
            Decoration.mark({ class: 'cm-wikilink', attributes: { 'data-target': target } }).range(
              node.from,
              node.to,
            ),
          );
          return;
        }
        if (name === 'Link') {
          const url = node.node.getChild('URL');
          const href = url ? state.sliceDoc(url.from, url.to) : '';
          const marks = node.node.getChildren('LinkMark');
          const textFrom = marks[0]?.to ?? node.from;
          const textTo = marks[1]?.from ?? node.to;
          if (textTo > textFrom)
            out.push(
              Decoration.mark({
                // A file in the vault (a PDF, a sheet) reads as one, not as a web link.
                class: isVaultFile(href) ? 'cm-link cm-filelink' : 'cm-link',
                attributes: { 'data-href': href },
              }).range(textFrom, textTo),
            );
          if (!editing(node.from, node.to) && marks.length >= 2) {
            out.push(hidden.range(node.from, textFrom));
            out.push(hidden.range(textTo, node.to));
          }
          return false;
        }
        if (name === 'Image') {
          if (!editing(node.from, node.to)) out.push(hidden.range(node.from, node.to));
          return false;
        }
        if (name === 'TaskMarker') {
          const checked = /x/i.test(state.sliceDoc(node.from, node.to));
          out.push(
            Decoration.replace({ widget: new CheckboxWidget(checked) }).range(node.from, node.to),
          );
          if (checked)
            out.push(
              Decoration.line({ class: 'cm-task-done' }).range(state.doc.lineAt(node.from).from),
            );
          return;
        }
        if (name === 'ListMark') {
          const item = node.node.parent;
          const isTask = item?.getChild('Task') != null;
          const bullet = /^[-*+]$/.test(state.sliceDoc(node.from, node.to));
          const end = withSpace(state, node.to);
          if (isTask) {
            if (!editing(node.from, end)) out.push(hidden.range(node.from, end));
          } else if (bullet && !editing(node.from, end)) {
            out.push(Decoration.replace({ widget: new BulletWidget() }).range(node.from, node.to));
          }
          return;
        }
        if (name === 'HorizontalRule') {
          if (!editing(node.from, node.to))
            out.push(Decoration.replace({ widget: new RuleWidget() }).range(node.from, node.to));
          return;
        }
        return;
      },
    });
  }
  return Decoration.set(out, true);
}

const inlinePlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = buildInline(view);
    }
    update(u: ViewUpdate): void {
      if (
        u.docChanged ||
        u.viewportChanged ||
        u.selectionSet ||
        u.focusChanged ||
        syntaxTree(u.startState) !== syntaxTree(u.state)
      ) {
        this.decorations = buildInline(u.view);
      }
    }
  },
  { decorations: (v) => v.decorations },
);

/** A link to a file beside the notes — not a web address, an anchor or another note. */
export function isVaultFile(href: string): boolean {
  const h = href.replace(/^<|>$/g, '').trim();
  return !!h && !/^[a-z][a-z0-9+.-]*:/i.test(h) && !h.startsWith('#') && !/\.md$/i.test(h);
}

/** Where an image's `src` points: a vault file through the host, or an https URL. */
export function imageSrc(
  url: string,
  ctx: Pick<NoteContext, 'dir' | 'attachmentBase'>,
): string | null {
  const raw = url.replace(/^<|>$/g, '').trim();
  if (/^https:\/\//i.test(raw)) return raw;
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith('/')) return null;
  let decoded = raw;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    // Literal.
  }
  const parts: string[] = ctx.dir ? ctx.dir.split('/') : [];
  for (const p of decoded.split('/')) {
    if (p === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else if (p && p !== '.') parts.push(p);
  }
  return ctx.attachmentBase + parts.map(encodeURIComponent).join('/');
}

/** Images as blocks under their line — a state field, since block widgets can't come from a plugin. */
const images = StateField.define<DecorationSet>({
  create: (state) => buildImages(state),
  update: (deco, tr) =>
    tr.docChanged ||
    tr.startState.readOnly !== tr.state.readOnly ||
    tr.startState.facet(noteContext) !== tr.state.facet(noteContext) ||
    syntaxTree(tr.startState) !== syntaxTree(tr.state)
      ? buildImages(tr.state)
      : deco,
  provide: (f) => EditorView.decorations.from(f),
});

function buildImages(state: EditorState): DecorationSet {
  const ctx = state.facet(noteContext);
  const builder = new RangeSetBuilder<Decoration>();
  const editable = !state.readOnly;
  const found: { at: number; src: string; nth: number; width?: number }[] = [];
  // Which image on its line this node is, and the width its Markdown asks for.
  const place = (from: number) => {
    const line = state.doc.lineAt(from);
    const all = imagesInLine(line.text);
    const nth = all.findIndex((i) => i.start === from - line.from);
    return { at: line.to, nth, width: all[nth]?.width };
  };
  syntaxTree(state).iterate({
    enter: (node) => {
      if (node.name === 'Image') {
        const url = node.node.getChild('URL');
        const src = url ? imageSrc(state.sliceDoc(url.from, url.to), ctx) : null;
        const where = place(node.from);
        if (src && where.nth >= 0) found.push({ ...where, src });
        return false;
      }
      if (node.name === 'WikiLink' && state.sliceDoc(node.from, node.from + 1) === '!') {
        const target = wikiTarget(state.sliceDoc(node.from, node.to));
        const where = place(node.from);
        if (/\.(png|jpe?g|gif|webp|svg|avif)$/i.test(target) && where.nth >= 0)
          found.push({ ...where, src: ctx.attachmentBase + encodeURIComponent(target) });
      }
      return;
    },
  });
  found.sort((a, b) => a.at - b.at);
  for (const f of found)
    builder.add(
      f.at,
      f.at,
      Decoration.widget({
        widget: new ImageWidget(f.src, f.nth, f.width, editable),
        block: true,
        side: 1,
      }),
    );
  return builder.finish();
}

/**
 * A rendered tag, link or wiki link opens on a click; while the cursor is
 * inside it, it takes ⌘/Ctrl-click, so a click there still places the cursor.
 */
const clicks = EditorView.domEventHandlers({
  mousedown(e, view) {
    const el = (e.target as HTMLElement).closest<HTMLElement>('.cm-tag, .cm-wikilink, .cm-link');
    if (!el || e.button !== 0) return false;
    const pos = view.posAtDOM(el);
    // Inside the link itself a click places the cursor (⌘/Ctrl-click still
    // opens it); anywhere else — even on the same line — it opens.
    const editing = touching(view.state, view.hasFocus, pos, pos + (el.textContent?.length ?? 0));
    if (editing && !(e.metaKey || e.ctrlKey)) return false;
    const ctx = view.state.facet(noteContext);
    e.preventDefault();
    if (el.dataset.tag !== undefined) ctx.openTag(el.dataset.tag);
    else if (el.dataset.target !== undefined) ctx.openLink(el.dataset.target);
    else if (el.dataset.href) ctx.openUrl(el.dataset.href);
    return true;
  },
});

/**
 * Hover a [[link]] and the note it points at shows under it — Obsidian's
 * page preview — so you can check what a link says without leaving.
 */
const linkPreview = hoverTooltip(
  async (view, pos) => {
    const ctx = view.state.facet(noteContext);
    if (!ctx.peek) return null;
    let node = syntaxTree(view.state).resolveInner(pos, 1);
    while (node.parent && node.name !== 'WikiLink') node = node.parent;
    if (node.name !== 'WikiLink' || view.state.sliceDoc(node.from, node.from + 1) === '!')
      return null;
    const target = wikiTarget(view.state.sliceDoc(node.from, node.to));
    const note = await ctx.peek(target).catch(() => null);
    return {
      pos: node.from,
      end: node.to,
      above: false,
      create: () => {
        const dom = document.createElement('div');
        dom.className = 'cm-peek';
        if (!note) {
          dom.classList.add('cm-peek-none');
          dom.textContent = `No note “${target}” yet — click to make it.`;
          return { dom };
        }
        const body = document.createElement('div');
        body.className = 'cm-peek-body';
        body.innerHTML = renderMarkdown(note.content + (note.more ? '\n\n…' : ''), {
          highlight: false,
          wikiLinks: true,
        });
        const dir = note.path.split('/').slice(0, -1).join('/');
        for (const img of body.querySelectorAll('img')) {
          const src = imageSrc(img.getAttribute('src') ?? '', {
            dir,
            attachmentBase: ctx.attachmentBase,
          });
          if (src) img.src = src;
          else img.remove();
        }
        dom.appendChild(body);
        return { dom };
      },
    };
  },
  { hoverTime: 350 },
);

export function liveRendering(): Extension {
  return [inlinePlugin, images, clicks, linkPreview];
}
