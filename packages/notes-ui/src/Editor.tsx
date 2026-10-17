import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import {
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
  completionKeymap,
  type CompletionContext,
  type CompletionResult,
} from '@codemirror/autocomplete';
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentLess,
  indentMore,
  moveLineDown,
  moveLineUp,
} from '@codemirror/commands';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { languages } from '@codemirror/language-data';
import { highlightSelectionMatches, search, searchKeymap } from '@codemirror/search';
import {
  Compartment,
  EditorSelection,
  EditorState,
  type Extension,
  type StateCommand,
} from '@codemirror/state';
import {
  drawSelection,
  dropCursor,
  EditorView,
  highlightSpecialChars,
  keymap,
  placeholder,
} from '@codemirror/view';
import { formatTag } from '@heapcode/notes-host/parse';
import {
  formatDate,
  insertCodeBlock,
  insertLink,
  insertText,
  insertWikiLink,
  setLineKind,
  toggleInline,
  toggleTask,
} from './editor/commands.js';
import { liveRendering, noteContext, type NoteContext } from './editor/live.js';
import { heapnotesMarkdown } from './editor/markup.js';
import { heapnotesTheme } from './editor/theme.js';

export interface EditorHandle {
  focus(): void;
  /** Put the cursor at a body offset and bring it into view — the outline's jump. */
  reveal(offset: number): void;
  /** Type text at the cursor, as if typed — "Link it" from the Info panel. On the title line, at the end instead. */
  insert(text: string): void;
}

export interface EditorProps {
  /** A new key replaces the text (another note, or a reload); the same key leaves the editor alone. */
  docKey: string;
  text: string;
  /** Where the cursor goes when the text is replaced. Default: the end of the first line. */
  cursor?: number;
  context: NoteContext;
  /** Read at completion time, so the lists are always current. */
  titles(): string[];
  tags(): string[];
  onChange(text: string): void;
  /** Save pasted or dropped files; returns the Markdown that links each. */
  onFiles(files: File[]): Promise<string[]>;
  readOnly?: boolean;
}

const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

/** Bear's shortcuts, with Ctrl for ⌘ off the Mac. ⌘J stays free for AI. */
function formattingKeymap() {
  const cmd = (run: StateCommand) => (view: EditorView) =>
    run({ state: view.state, dispatch: view.dispatch });
  const ctrlCmd = IS_MAC ? 'Ctrl-Mod' : 'Shift-Alt-Mod';
  return keymap.of([
    { key: 'Mod-b', run: cmd(toggleInline('**')) },
    { key: 'Mod-i', run: cmd(toggleInline('*')) },
    { key: 'Mod-u', run: cmd(toggleInline('~')) },
    { key: 'Shift-Mod-u', run: cmd(toggleInline('~~')) },
    { key: 'Shift-Mod-m', run: cmd(toggleInline('==')) },
    { key: 'Alt-Mod-c', run: cmd(toggleInline('`')) },
    { key: `${ctrlCmd}-c`, run: cmd(insertCodeBlock) },
    { key: 'Mod-k', run: cmd(insertLink) },
    { key: 'Mod-d', run: cmd(insertWikiLink) },
    ...[1, 2, 3, 4, 5, 6].map((level) => ({
      key: `Mod-${level}`,
      run: cmd(setLineKind({ kind: 'heading', level })),
    })),
    { key: 'Mod-l', run: cmd(setLineKind({ kind: 'bullet' })) },
    { key: 'Shift-Mod-l', run: cmd(setLineKind({ kind: 'ordered' })) },
    { key: 'Shift-Mod-t', run: cmd(setLineKind({ kind: 'quote' })) },
    { key: 'Mod-t', run: cmd(setLineKind({ kind: 'todo' })) },
    { key: 'Mod-.', run: cmd(toggleTask) },
    { key: 'Alt-Mod-s', run: cmd(insertText('\n---\n')) },
    { key: 'Alt-Mod-ArrowUp', run: moveLineUp },
    { key: 'Alt-Mod-ArrowDown', run: moveLineDown },
    { key: 'Alt-Mod-ArrowRight', run: indentMore },
    { key: 'Alt-Mod-ArrowLeft', run: indentLess },
    { key: 'Tab', run: indentMore, shift: indentLess },
    { key: 'Shift-Mod-8', run: cmd(insertText(() => formatDate('long'))) },
    { key: 'Alt-Shift-Mod-8', run: cmd(insertText(() => formatDate('iso'))) },
    { key: 'Shift-Mod-9', run: cmd(insertText(() => formatDate('short'))) },
    { key: 'Shift-Mod-7', run: cmd(insertText(() => formatDate('datetime'))) },
    { key: 'Shift-Mod-0', run: cmd(insertText(() => formatDate('time'))) },
  ]);
}

export const Editor = forwardRef<EditorHandle, EditorProps>(function Editor(props, ref) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView>();
  const latest = useRef(props);
  latest.current = props;
  const ctxSlot = useRef(new Compartment());
  const roSlot = useRef(new Compartment());
  const extensions = useRef<() => Extension[]>();
  const freshState = (text: string, cursor?: number) =>
    EditorState.create({
      doc: text,
      selection: EditorSelection.cursor(Math.min(cursor ?? firstLineEnd(text), text.length)),
      extensions: extensions.current!(),
    });

  useImperativeHandle(ref, () => ({
    focus: () => view.current?.focus(),
    reveal: (offset) => {
      const v = view.current;
      if (!v) return;
      const pos = Math.min(offset, v.state.doc.length);
      v.dispatch({
        selection: EditorSelection.cursor(pos),
        effects: EditorView.scrollIntoView(pos, { y: 'start', yMargin: 24 }),
      });
      v.focus();
    },
    insert: (text) => {
      const v = view.current;
      if (!v) return;
      let { from, to } = v.state.selection.main;
      let insert: string;
      if (v.state.doc.lineAt(from).number === 1) {
        // The cursor still on the title — where a note opens — is not a place
        // anyone chose; a link there would rename the note. Add it at the end.
        from = to = v.state.doc.length;
        const tail = v.state.sliceDoc(Math.max(0, from - 2), from);
        insert =
          (tail.endsWith('\n\n') || from === 0 ? '' : tail.endsWith('\n') ? '\n' : '\n\n') + text;
      } else {
        // Never glued onto the end of a word.
        const before = v.state.sliceDoc(from - 1, from);
        insert = (before && !/\s/.test(before) ? ' ' : '') + text;
      }
      v.dispatch({
        changes: { from, to, insert },
        selection: EditorSelection.cursor(from + insert.length),
        scrollIntoView: true,
        userEvent: 'input',
      });
      v.focus();
    },
  }));

  useEffect(() => {
    const wiki = (cx: CompletionContext): CompletionResult | null => {
      const m = cx.matchBefore(/\[\[[^\]\n]*$/);
      if (!m) return null;
      const closed = cx.state.sliceDoc(cx.pos, cx.pos + 2) === ']]';
      return {
        from: m.from + 2,
        options: latest.current
          .titles()
          .map((title) => ({ label: title, type: 'text', apply: closed ? title : `${title}]]` })),
        validFor: /^[^\]\n]*$/,
      };
    };
    const tag = (cx: CompletionContext): CompletionResult | null => {
      const m = cx.matchBefore(/(?:^|\s)#[^\s#]*$/);
      if (
        !m ||
        (m.text.trim() === '#' && !cx.explicit && /^\s*#$/.test(cx.state.doc.lineAt(cx.pos).text))
      )
        return null;
      const from = m.from + m.text.indexOf('#');
      return {
        from,
        options: latest.current
          .tags()
          .map((t) => ({ label: `#${t}`, type: 'keyword', apply: `${formatTag(t)} ` })),
        validFor: /^#[^\s#]*$/,
      };
    };

    const p = latest.current;
    extensions.current = () => [
      ctxSlot.current.of(noteContext.of(latest.current.context)),
      roSlot.current.of(EditorState.readOnly.of(latest.current.readOnly === true)),
      formattingKeymap(),
      history(),
      drawSelection(),
      dropCursor(),
      highlightSpecialChars(),
      closeBrackets(),
      EditorView.lineWrapping,
      markdown({ base: markdownLanguage, codeLanguages: languages, extensions: heapnotesMarkdown }),
      liveRendering(),
      heapnotesTheme(),
      search({ top: true }),
      highlightSelectionMatches(),
      autocompletion({ override: [wiki, tag], icons: false }),
      placeholder('Start with a title…'),
      keymap.of([
        ...closeBracketsKeymap,
        ...completionKeymap,
        ...searchKeymap,
        ...historyKeymap,
        ...defaultKeymap,
      ]),
      EditorView.updateListener.of((u) => {
        if (u.docChanged) latest.current.onChange(u.state.doc.toString());
      }),
      EditorView.domEventHandlers({
        paste(e, v) {
          const files = [...(e.clipboardData?.files ?? [])];
          if (files.length === 0) return false;
          e.preventDefault();
          void insertFiles(v, files, v.state.selection.main.head);
          return true;
        },
        drop(e, v) {
          const files = [...(e.dataTransfer?.files ?? [])];
          if (files.length === 0) return false;
          e.preventDefault();
          const pos = v.posAtCoords({ x: e.clientX, y: e.clientY }) ?? v.state.selection.main.head;
          void insertFiles(v, files, pos);
          return true;
        },
      }),
    ];
    const v = new EditorView({ parent: host.current!, state: freshState(p.text, p.cursor) });
    const insertFiles = async (v: EditorView, files: File[], at: number) => {
      const links = await latest.current.onFiles(files);
      if (links.length === 0) return;
      const insert = links.join('\n');
      v.dispatch({
        changes: { from: at, insert },
        selection: EditorSelection.cursor(at + insert.length),
      });
    };
    view.current = v;
    return () => v.destroy();
    // One view for the component's life; text and settings flow in below.
  }, []);

  // Another note, or a reload: a fresh state, so undo can't step back into
  // the previous note's text, and onChange isn't told.
  useEffect(() => {
    const v = view.current;
    if (!v || !extensions.current) return;
    v.setState(freshState(props.text, props.cursor));
    v.scrollDOM.scrollTop = 0;
  }, [props.docKey]);

  useEffect(() => {
    view.current?.dispatch({ effects: ctxSlot.current.reconfigure(noteContext.of(props.context)) });
  }, [props.context]);

  useEffect(() => {
    view.current?.dispatch({
      effects: roSlot.current.reconfigure(EditorState.readOnly.of(props.readOnly === true)),
    });
  }, [props.readOnly]);

  return <div className="note-editor" ref={host} />;
});

function firstLineEnd(text: string): number {
  const nl = text.indexOf('\n');
  return nl === -1 ? text.length : nl;
}
