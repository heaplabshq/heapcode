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
  type DecorationSet,
  type ViewUpdate,
} from '@codemirror/view';
import { toggleTaskAt } from './commands.js';
import { wikiTarget } from './markup.js';

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

class ImageWidget extends WidgetType {
  constructor(readonly src: string) {
    super();
  }
  override eq(other: ImageWidget): boolean {
    return other.src === this.src;
  }
  toDOM(): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'cm-image';
    const img = document.createElement('img');
    img.src = this.src;
    img.alt = '';
    img.loading = 'lazy';
    img.onerror = () => wrap.classList.add('cm-image-broken');
    wrap.appendChild(img);
    return wrap;
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
            out.push(Decoration.line({ class: 'cm-codeblock' }).range(line.from));
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
              Decoration.mark({ class: 'cm-link', attributes: { 'data-href': href } }).range(
                textFrom,
                textTo,
              ),
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
    tr.startState.facet(noteContext) !== tr.state.facet(noteContext) ||
    syntaxTree(tr.startState) !== syntaxTree(tr.state)
      ? buildImages(tr.state)
      : deco,
  provide: (f) => EditorView.decorations.from(f),
});

function buildImages(state: EditorState): DecorationSet {
  const ctx = state.facet(noteContext);
  const builder = new RangeSetBuilder<Decoration>();
  const found: { at: number; src: string }[] = [];
  syntaxTree(state).iterate({
    enter: (node) => {
      if (node.name === 'Image') {
        const url = node.node.getChild('URL');
        const src = url ? imageSrc(state.sliceDoc(url.from, url.to), ctx) : null;
        if (src) found.push({ at: state.doc.lineAt(node.to).to, src });
        return false;
      }
      if (node.name === 'WikiLink' && state.sliceDoc(node.from, node.from + 1) === '!') {
        const target = wikiTarget(state.sliceDoc(node.from, node.to));
        if (/\.(png|jpe?g|gif|webp|svg|avif)$/i.test(target))
          found.push({
            at: state.doc.lineAt(node.to).to,
            src: ctx.attachmentBase + encodeURIComponent(target),
          });
      }
      return;
    },
  });
  found.sort((a, b) => a.at - b.at);
  for (const f of found)
    builder.add(
      f.at,
      f.at,
      Decoration.widget({ widget: new ImageWidget(f.src), block: true, side: 1 }),
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

export function liveRendering(): Extension {
  return [inlinePlugin, images, clicks];
}
