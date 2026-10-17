import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { RpcClient, signedOutMessage, type ConnectionStatus } from '@heapcode/web-ui/rpc';
import { Sidebar } from '@heapcode/web-ui/components/Sidebar';
import { ProductToggle, servedProducts } from '@heapcode/web-ui/components/ProductToggle';
import { WorkspacePicker } from '@heapcode/web-ui/components/WorkspacePicker';
import { parseNote } from '@heapcode/notes-host/parse';
import {
  NOTES_METHODS,
  NOTES_PROTOCOL_VERSION,
  type NoteListItem,
  type NoteOpenResult,
  type NoteSaveResult,
  type NotesChanged,
  type NotesImportKind,
  type NotesSection,
  type NotesState,
  type UiBrowseFoldersResult,
  type UiWorkspacesResult,
} from '@heapcode/notes-host/protocol';
import { Editor, type EditorHandle } from './Editor.js';
import { AskPanel } from './AskPanel.js';
import type { NoteContext } from './editor/live.js';
import {
  ImportDialog,
  InfoPanel,
  NoteList,
  QuickOpen,
  SettingsDialog,
  type Heading,
} from './panels.js';

/**
 * Heapnotes' page, inside `heapcode web` and the desktop app.
 *
 * Bear's three panes: the rail holds the smart
 * sections and the tags, then the note list, then the editor — with ⌃1/⌃2/⌃3
 * to show just the editor, list and editor, or all three. Every note is a
 * Markdown file; the page only edits text and asks the host (notes-host) to
 * save it, the same engine the CLI and the MCP server use.
 */

const RPC_PATH = document.documentElement.dataset.rpcPath ?? '/rpc';
const BASE = RPC_PATH.replace(/\/rpc$/, '');
const RPC_URL = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${RPC_PATH}`;
const HAS_CODE = document.documentElement.dataset.sibling === 'code';
const PRODUCTS = servedProducts();
const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform);
const SAVE_DELAY_MS = 600;

type Selection = { section: NotesSection } | { tag: string };

const SECTIONS: { section: NotesSection; label: string; icon: ReactNode; key: string }[] = [
  { section: 'all', label: 'Notes', icon: <IconNotes />, key: '1' },
  { section: 'untagged', label: 'Untagged', icon: <IconUntagged />, key: '2' },
  { section: 'todo', label: 'Todo', icon: <IconTodo />, key: '3' },
  { section: 'today', label: 'Today', icon: <IconToday />, key: '4' },
  { section: 'pinned', label: 'Pinned', icon: <IconPin />, key: '5' },
  { section: 'archive', label: 'Archive', icon: <IconArchive />, key: '6' },
  { section: 'trash', label: 'Trash', icon: <IconTrash />, key: '7' },
];

interface OpenNote extends NoteOpenResult {
  /** Bumped to make the editor take new text: another note, or a reload. */
  key: string;
  cursor?: number;
}

function remembered(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function remember(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Private window: the choice lasts for this page.
  }
}

export function App(): JSX.Element {
  const [status, setStatus] = useState<ConnectionStatus>('connecting');
  const [state, setState] = useState<NotesState>();
  const [selection, setSelection] = useState<Selection>({ section: 'all' });
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<'modified' | 'created' | 'title'>(
    () => (remembered('heapnotes.sort') as 'modified') ?? 'modified',
  );
  const [notes, setNotes] = useState<NoteListItem[]>([]);
  const [tags, setTags] = useState<{ tag: string; count: number }[]>([]);
  const [titles, setTitles] = useState<{ id: string; title: string; tags: string[] }[]>([]);
  const [open, setOpen] = useState<OpenNote>();
  const [text, setText] = useState('');
  const [saving, setSaving] = useState<'idle' | 'pending' | 'saving' | 'saved'>('idle');
  const [conflict, setConflict] = useState<{ content: string; hash: string }>();
  const [error, setError] = useState<string>();
  const [layout, setLayout] = useState<1 | 2 | 3>(
    () => (Number(remembered('heapnotes.layout')) as 1 | 2 | 3) || 3,
  );
  const [infoOpen, setInfoOpen] = useState(() => remembered('heapnotes.info') === 'open');
  const [railCollapsed, setRailCollapsed] = useState(() => remembered('heap.rail') === 'collapsed');
  const [quick, setQuick] = useState<'notes' | 'tags'>();
  const [dialog, setDialog] = useState<'settings' | 'import'>();
  const [askOpen, setAskOpen] = useState(() => remembered('heapnotes.ask') === 'open');
  const [askQuestion, setAskQuestion] = useState<{ text: string; seq: number }>();
  /** Bumped on every socket (re)connection; the Ask panel says hello again on it. */
  const [connection, setConnection] = useState(0);

  const client = useMemo(() => new RpcClient(RPC_URL, setStatus), []);
  const editor = useRef<EditorHandle>(null);
  const search = useRef<HTMLInputElement>(null);
  const textRef = useRef('');
  const baseRef = useRef<string>();
  const openRef = useRef<OpenNote>();
  const dirty = useRef(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout>>();
  const history = useRef<{ back: string[]; forward: string[] }>({ back: [], forward: [] });
  const seq = useRef(0);
  openRef.current = open;

  const call = useCallback(
    async <T,>(method: string, params?: unknown): Promise<T | undefined> => {
      try {
        return await client.request<T>(method, params);
      } catch (e) {
        setError((e as Error).message);
        return undefined;
      }
    },
    [client],
  );

  // ── Loading ──────────────────────────────────────────────────────────

  const listParams = useMemo(
    () => ({
      ...('section' in selection ? { section: selection.section } : { tag: selection.tag }),
      ...(query.trim() ? { query } : {}),
      sort,
    }),
    [selection, query, sort],
  );

  const loadList = useCallback(async () => {
    const page = await call<{ notes: NoteListItem[]; total: number }>(
      NOTES_METHODS.list,
      listParams,
    );
    if (page) setNotes(page.notes);
  }, [call, listParams]);

  const loadSide = useCallback(async () => {
    const [t, ti] = await Promise.all([
      call<{ tag: string; count: number }[]>(NOTES_METHODS.tags),
      call<typeof titles>(NOTES_METHODS.titles),
    ]);
    if (t) setTags(t);
    if (ti) setTitles(ti);
  }, [call]);

  useEffect(() => {
    void loadList();
  }, [loadList]);

  // ── Saving ───────────────────────────────────────────────────────────

  const flush = useCallback(async () => {
    clearTimeout(saveTimer.current);
    const note = openRef.current;
    if (!note || !dirty.current || note.note.location === 'trash') return;
    const content = textRef.current;
    dirty.current = false;
    setSaving('saving');
    const r = await call<NoteSaveResult>(NOTES_METHODS.save, {
      id: note.note.id,
      content,
      base: baseRef.current,
    });
    if (!r) {
      dirty.current = true;
      setSaving('pending');
      return;
    }
    if (!r.ok) {
      // Changed somewhere else since we loaded it: ask, never overwrite.
      dirty.current = true;
      setConflict({ content: r.content, hash: r.hash });
      setSaving('pending');
      return;
    }
    baseRef.current = r.hash;
    setSaving(dirty.current ? 'pending' : 'saved');
    const titleChanged = r.note.title !== note.note.title || r.note.path !== note.note.path;
    setOpen((o) => (o && o.note.id === r.note.id ? { ...o, note: r.note } : o));
    setNotes((list) => {
      const rest = list.filter((n) => n.id !== r.note.id);
      return sort === 'modified' && !('section' in selection && selection.section === 'pinned')
        ? [r.note, ...rest]
        : list.map((n) => (n.id === r.note.id ? r.note : n));
    });
    if (titleChanged || r.note.tags.join() !== note.note.tags.join()) void loadSide();
  }, [call, loadSide, selection, sort]);

  const onChange = useCallback(
    (next: string) => {
      textRef.current = next;
      setText(next);
      dirty.current = true;
      setSaving('pending');
      clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => void flush(), SAVE_DELAY_MS);
    },
    [flush],
  );

  useEffect(() => {
    const beforeUnload = (e: BeforeUnloadEvent) => {
      if (!dirty.current) return;
      void flush();
      e.preventDefault();
    };
    window.addEventListener('beforeunload', beforeUnload);
    return () => window.removeEventListener('beforeunload', beforeUnload);
  }, [flush]);

  // ── Opening ──────────────────────────────────────────────────────────

  const show = useCallback((r: NoteOpenResult, cursor?: number) => {
    baseRef.current = r.hash;
    textRef.current = r.content;
    dirty.current = false;
    setConflict(undefined);
    setText(r.content);
    setSaving('idle');
    setOpen({
      ...r,
      key: `${r.note.id}:${seq.current++}`,
      ...(cursor !== undefined ? { cursor } : {}),
    });
  }, []);

  const openNote = useCallback(
    async (id: string, opts: { fromHistory?: boolean } = {}) => {
      await flush();
      const current = openRef.current?.note.id;
      const r = await call<NoteOpenResult>(NOTES_METHODS.open, { id });
      if (!r) return;
      if (!opts.fromHistory && current && current !== id) {
        history.current.back.push(current);
        history.current.forward = [];
      }
      show(r);
    },
    [call, flush, show],
  );

  const newNote = useCallback(async () => {
    await flush();
    const tag = 'tag' in selection ? selection.tag : undefined;
    if (
      'section' in selection &&
      (selection.section === 'trash' || selection.section === 'archive')
    )
      setSelection({ section: 'all' });
    const r = await call<NoteOpenResult>(NOTES_METHODS.create, tag ? { tag } : {});
    if (!r) return;
    if (openRef.current) history.current.back.push(openRef.current.note.id);
    show(r, 2);
    setNotes((list) => [r.note, ...list]);
    void loadSide();
    setTimeout(() => editor.current?.focus(), 0);
  }, [call, flush, loadSide, selection, show]);

  const followLink = useCallback(
    async (target: string) => {
      await flush();
      const r = await call<NoteOpenResult>(NOTES_METHODS.followLink, { target });
      if (!r) return;
      if (openRef.current) history.current.back.push(openRef.current.note.id);
      history.current.forward = [];
      show(r);
      void loadList();
      void loadSide();
    },
    [call, flush, loadList, loadSide, show],
  );

  const goBack = useCallback(() => {
    const id = history.current.back.pop();
    if (!id) return;
    if (openRef.current) history.current.forward.push(openRef.current.note.id);
    void openNote(id, { fromHistory: true });
  }, [openNote]);

  const goForward = useCallback(() => {
    const id = history.current.forward.pop();
    if (!id) return;
    if (openRef.current) history.current.back.push(openRef.current.note.id);
    void openNote(id, { fromHistory: true });
  }, [openNote]);

  // ── Connection ───────────────────────────────────────────────────────

  const loadListRef = useRef(loadList);
  loadListRef.current = loadList;
  const loadSideRef = useRef(loadSide);
  loadSideRef.current = loadSide;
  const openNoteRef = useRef(openNote);
  openNoteRef.current = openNote;

  useEffect(() => {
    // An agent's open_note: show it, and bring the window forward if the browser lets us.
    client.onNotification(NOTES_METHODS.focus, (raw) => {
      const { id } = raw as { id: string };
      void openNoteRef.current(id);
      window.focus();
    });
    client.onNotification(NOTES_METHODS.changed, (raw) => {
      const { ids } = raw as NotesChanged;
      void loadListRef.current();
      void loadSideRef.current();
      const o = openRef.current;
      // Edited in another app: take the new text — unless there are unsaved
      // edits here, which the next save turns into the conflict banner.
      if (o && ids.includes(o.note.id) && !dirty.current) {
        void client.request<NoteOpenResult>(NOTES_METHODS.open, { id: o.note.id }).then(
          (r) => {
            if (r.content !== textRef.current) show(r);
          },
          () => setOpen(undefined),
        );
      }
    });
    client.onOpen = () => {
      setConnection((n) => n + 1);
      void client
        .request<{ state: NotesState }>(NOTES_METHODS.hello, {
          protocolVersion: NOTES_PROTOCOL_VERSION,
        })
        .then((hello) => {
          setState(hello.state);
          setError(undefined);
          void loadListRef.current();
          void loadSideRef.current();
        })
        .catch((e: Error) => setError(e.message));
    };
    client.connect();
    return () => client.close();
  }, [client, show]);

  useEffect(() => {
    if (status === 'signed-out') setError(signedOutMessage());
  }, [status]);

  // ── Actions ──────────────────────────────────────────────────────────

  const act = useCallback(
    async (method: string, params: Record<string, unknown>, after?: 'close' | 'reopen') => {
      await flush();
      const r = await call<NoteListItem>(method, params);
      if (r === undefined) return;
      void loadList();
      void loadSide();
      const o = openRef.current;
      if (!o) return;
      if (after === 'close') setOpen(undefined);
      else if (after === 'reopen') void openNote(o.note.id, { fromHistory: true });
    },
    [call, flush, loadList, loadSide, openNote],
  );

  const current = open?.note;
  const inTrash = current?.location === 'trash';
  const pin = () =>
    current && void act(NOTES_METHODS.pin, { id: current.id, pinned: !current.pinned }, 'reopen');
  const trash = () =>
    current && !inTrash && void act(NOTES_METHODS.trash, { id: current.id }, 'close');
  const archive = () => current && void act(NOTES_METHODS.archive, { id: current.id }, 'close');
  const restore = () => current && void act(NOTES_METHODS.restore, { id: current.id }, 'reopen');
  const deleteForever = () => {
    if (!current || !confirm(`Delete “${current.title}” for good? This can't be undone.`)) return;
    void act(NOTES_METHODS.deleteForever, { id: current.id }, 'close');
  };
  const emptyTrash = () => {
    if (!confirm('Delete every note in the trash for good?')) return;
    void call(NOTES_METHODS.emptyTrash).then(() => {
      setOpen(undefined);
      void loadList();
    });
  };
  const duplicate = async () => {
    if (!current) return;
    await flush();
    const r = await call<NoteOpenResult>(NOTES_METHODS.duplicate, { id: current.id });
    if (r) {
      show(r);
      void loadList();
    }
  };
  const copy = (s: string) =>
    void navigator.clipboard
      ?.writeText(s)
      .catch(() => setError('Copying was blocked by the browser.'));

  const setLayoutMode = (n: 1 | 2 | 3) => {
    setLayout(n);
    remember('heapnotes.layout', String(n));
  };
  const showAsk = (on: boolean) => {
    setAskOpen(on);
    remember('heapnotes.ask', on ? 'open' : 'closed');
  };
  const toggleInfo = () =>
    setInfoOpen((v) => {
      remember('heapnotes.info', v ? 'closed' : 'open');
      return !v;
    });

  // ── Shortcuts ───────────────────────────────

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = IS_MAC ? e.metaKey : e.ctrlKey;
      const k = e.key.toLowerCase();
      const inEditor = (e.target as HTMLElement).closest?.('.cm-editor') != null;
      const run = (fn: () => void) => {
        e.preventDefault();
        e.stopPropagation();
        fn();
      };
      if (e.ctrlKey && !e.metaKey && !e.altKey && ['1', '2', '3'].includes(e.key) && IS_MAC)
        return run(() => setLayoutMode(Number(e.key) as 1 | 2 | 3));
      if (!mod) return;
      if (e.altKey && !e.shiftKey && e.code === 'KeyO') return run(() => setQuick('tags'));
      if (e.altKey && e.shiftKey && e.code === 'KeyI')
        return run(() => current && copy(current.id));
      if (e.altKey && e.shiftKey && e.code === 'KeyL')
        return run(() => current && copy(`[[${current.title}]]`));
      if (e.altKey && /^Digit[1-7]$/.test(e.code))
        return run(() => setSelection({ section: SECTIONS[Number(e.code.slice(5)) - 1]!.section }));
      if (e.altKey) return;
      if (!e.shiftKey && k === 'n') return run(() => void newNote());
      if (!e.shiftKey && k === 'o') return run(() => setQuick('notes'));
      if (e.shiftKey && k === 'o') return run(() => setDialog('import'));
      if (e.shiftKey && k === 'f') return run(() => search.current?.focus());
      if (e.shiftKey && k === 'p') return run(pin);
      if (e.shiftKey && k === 'r') return run(restore);
      if (e.shiftKey && (k === 'a' || k === 'b')) return run(toggleInfo);
      if (e.shiftKey && k === 'j' && state?.ask) return run(() => showAsk(!askOpen));
      if (e.shiftKey && k === 'backspace') return run(emptyTrash);
      if (!e.shiftKey && k === 'backspace' && !inEditor) return run(trash);
      if (!e.shiftKey && e.key === '[') return run(goBack);
      if (!e.shiftKey && e.key === ']') return run(goForward);
      if (!e.shiftKey && e.key === 'Enter' && inEditor)
        return run(() => (document.activeElement as HTMLElement)?.blur());
      if (!e.shiftKey && k === 's') return run(() => void flush());
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  });

  // ── Derived ──────────────────────────────────────────────────────────

  const headings: Heading[] = useMemo(
    () => parseNote(text).headings.map((h) => ({ level: h.level, text: h.text, offset: h.start })),
    [text],
  );
  const titleList = useRef<string[]>([]);
  titleList.current = titles.map((t) => t.title);
  const tagList = useRef<string[]>([]);
  tagList.current = tags.map((t) => t.tag);

  const dir = current ? current.path.split('/').slice(0, -1).join('/') : '';
  const context: NoteContext = useMemo(
    () => ({
      dir,
      attachmentBase: state?.attachmentBase ?? `${BASE}/attachment/`,
      openLink: (target) => void followLink(target),
      openTag: (tag) => {
        setQuery('');
        setSelection({ tag });
      },
      openUrl: (url) => window.open(url, '_blank', 'noopener,noreferrer'),
    }),
    [dir, state?.attachmentBase, followLink],
  );

  const onFiles = useCallback(
    async (files: File[]) => {
      const id = openRef.current?.note.id;
      if (!id) return [];
      const out: string[] = [];
      for (const f of files) {
        const base64 = await fileToBase64(f);
        const r = await call<{ markdown: string }>(NOTES_METHODS.attach, {
          id,
          filename: f.name || `pasted-${Date.now()}.png`,
          base64,
        });
        if (r) out.push(r.markdown);
      }
      return out;
    },
    [call],
  );

  const heading =
    'section' in selection
      ? (SECTIONS.find((s) => s.section === selection.section)?.label ?? 'Notes')
      : `#${selection.tag}`;
  const emptyText = query
    ? 'No notes match.'
    : 'section' in selection && selection.section === 'trash'
      ? 'The trash is empty.'
      : 'No notes here yet.';
  const picker = state ? (
    <WorkspacePicker
      current={state.vault}
      busy={false}
      loadWorkspaces={() => client.request<UiWorkspacesResult>(NOTES_METHODS.workspaces)}
      browse={(path) =>
        client.request<UiBrowseFoldersResult>(NOTES_METHODS.browseFolders, { path })
      }
      onPick={async (path) => {
        await flush();
        const next = await client.request<NotesState>(NOTES_METHODS.setVault, { path });
        setState(next);
        setOpen(undefined);
        setSelection({ section: 'all' });
        void loadSide();
        void loadList();
      }}
    />
  ) : null;

  return (
    <div
      className={`app notes-app notes-layout-${layout}`}
      style={{ '--note-font-size': `${state?.fontSize ?? 16}px` } as React.CSSProperties}
    >
      <div className="body">
        {layout === 3 && (
          <Sidebar
            brand="Heapnotes"
            toggle={
              HAS_CODE ? (
                <ProductToggle
                  current="notes"
                  {...(PRODUCTS.includes('chat') ? { chatPath: '/chat/' } : {})}
                  {...(PRODUCTS.includes('qa') ? { qaPath: '/qa/' } : {})}
                  notesPath={`${BASE}/`}
                />
              ) : undefined
            }
            collapsed={railCollapsed}
            onToggleCollapsed={() =>
              setRailCollapsed((v) => {
                remember('heap.rail', v ? 'expanded' : 'collapsed');
                return !v;
              })
            }
            conversations={[]}
            onOpen={() => undefined}
            onNew={() => void newNote()}
            busy={false}
            status={status}
            onOpenSettings={() => setDialog('settings')}
            extraNav={
              <>
                {SECTIONS.map((s) => (
                  <RailRow
                    key={s.section}
                    label={s.label}
                    icon={s.icon}
                    collapsed={railCollapsed}
                    active={'section' in selection && selection.section === s.section}
                    onClick={() => {
                      setQuery('');
                      setSelection({ section: s.section });
                    }}
                  />
                ))}
              </>
            }
            recents={
              <TagTree
                tags={tags}
                active={'tag' in selection ? selection.tag : undefined}
                onPick={(tag) => {
                  setQuery('');
                  setSelection({ tag });
                }}
                onRename={(from) => {
                  const to = prompt(`Rename #${from} (and its subtags) in every note to:`, from);
                  if (to && to !== from)
                    void call(NOTES_METHODS.renameTag, { from, to }).then(() => {
                      void loadSide();
                      void loadList();
                      if ('tag' in selection && selection.tag === from) setSelection({ tag: to });
                      if (openRef.current)
                        void openNote(openRef.current.note.id, { fromHistory: true });
                    });
                }}
              />
            }
            footer={
              <button
                className="notes-foot"
                onClick={() => setDialog('settings')}
                title={state?.vault}
              >
                <span className="notes-foot-name">
                  {state ? state.vault.split(/[\\/]/).pop() : '…'}
                </span>
                <span className="notes-foot-count">{state ? `${state.count} notes` : ''}</span>
              </button>
            }
          />
        )}
        <main className="notes-main">
          {layout >= 2 && (
            <section className="notes-list-pane" aria-label="Note list">
              <div className="notes-list-head">
                <span className="notes-list-title">{heading}</span>
                <span className="notes-list-tools">
                  {'section' in selection && selection.section === 'trash' && notes.length > 0 && (
                    <button className="btn btn-quiet btn-sm" onClick={emptyTrash}>
                      Empty
                    </button>
                  )}
                  <select
                    className="notes-sort"
                    value={sort}
                    aria-label="Sort by"
                    onChange={(e) => {
                      const v = e.target.value as typeof sort;
                      setSort(v);
                      remember('heapnotes.sort', v);
                    }}
                  >
                    <option value="modified">Modified</option>
                    <option value="created">Created</option>
                    <option value="title">Title</option>
                  </select>
                  <button
                    className="btn btn-quiet btn-sm"
                    onClick={() => void newNote()}
                    title={`New note (${IS_MAC ? '⌘' : 'Ctrl+'}N)`}
                    aria-label="New note"
                  >
                    <IconCompose />
                  </button>
                </span>
              </div>
              <div className="notes-search">
                <input
                  ref={search}
                  type="search"
                  value={query}
                  placeholder='Search — #tag, @todo, @today, "phrase"'
                  aria-label="Search notes"
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') {
                      setQuery('');
                      (e.target as HTMLInputElement).blur();
                    } else if (e.key === 'Enter' && query.trim().startsWith('?') && state?.ask) {
                      // `?question` hands the search to Ask.
                      const text = query.trim().slice(1).trim();
                      if (text) {
                        showAsk(true);
                        setAskQuestion({ text, seq: Date.now() });
                        setQuery('');
                      }
                    } else if (e.key === 'Enter' && notes[0]) void openNote(notes[0].id);
                  }}
                />
              </div>
              <NoteList
                notes={notes}
                selected={current?.id}
                onSelect={(id) => void openNote(id)}
                empty={emptyText}
              />
            </section>
          )}
          <section className="notes-editor-pane" aria-label="Editor">
            <div className="notes-toolbar">
              <span className="notes-toolbar-left">
                <button
                  className="btn btn-quiet btn-sm"
                  onClick={() => setLayoutMode(layout === 1 ? 3 : 1)}
                  title={layout === 1 ? 'Show the sidebar and list (⌃3)' : 'Editor only (⌃1)'}
                  aria-label="Toggle panes"
                >
                  <IconPanes />
                </button>
                {current && (
                  <span className="notes-path" title={current.path}>
                    {current.path.replace(/\.md$/i, '')}
                  </span>
                )}
                <span className={`notes-save notes-save-${saving}`}>
                  {saving === 'saving'
                    ? 'Saving…'
                    : saving === 'pending'
                      ? 'Edited'
                      : saving === 'saved'
                        ? 'Saved'
                        : ''}
                </span>
              </span>
              {current && (
                <span className="notes-toolbar-right">
                  {!inTrash && (
                    <button
                      className={
                        current.pinned ? 'btn btn-quiet btn-sm notes-on' : 'btn btn-quiet btn-sm'
                      }
                      onClick={pin}
                      title="Pin (⇧⌘P)"
                      aria-pressed={current.pinned}
                    >
                      {current.pinned ? 'Pinned' : 'Pin'}
                    </button>
                  )}
                  <button
                    className={infoOpen ? 'btn btn-quiet btn-sm notes-on' : 'btn btn-quiet btn-sm'}
                    onClick={toggleInfo}
                    title="Contents and backlinks (⇧⌘A)"
                    aria-pressed={infoOpen}
                  >
                    Info
                  </button>
                  <NoteMenu
                    location={current.location}
                    onDuplicate={() => void duplicate()}
                    onArchive={archive}
                    onTrash={trash}
                    onRestore={restore}
                    onDelete={deleteForever}
                    onCopyMarkdown={() => copy(text)}
                    onCopyLink={() => copy(`[[${current.title}]]`)}
                    onCopyId={() => copy(current.id)}
                  />
                </span>
              )}
              {state?.ask && (
                <button
                  className={askOpen ? 'btn btn-quiet btn-sm notes-on' : 'btn btn-quiet btn-sm'}
                  onClick={() => showAsk(!askOpen)}
                  title="Ask your notes (⇧⌘J) — or type ?question in search"
                  aria-pressed={askOpen}
                >
                  Ask
                </button>
              )}
            </div>
            {error && (
              <div className="notes-banner notes-banner-bad" role="alert">
                <span>{error}</span>
                <button className="btn btn-quiet btn-sm" onClick={() => setError(undefined)}>
                  Dismiss
                </button>
              </div>
            )}
            {conflict && (
              <div className="notes-banner" role="alert">
                <span>This note was changed somewhere else while you were editing.</span>
                <button
                  className="btn btn-sm"
                  onClick={() => {
                    // Keep mine: write over theirs, knowingly.
                    baseRef.current = conflict.hash;
                    setConflict(undefined);
                    dirty.current = true;
                    void flush();
                  }}
                >
                  Keep mine
                </button>
                <button
                  className="btn btn-quiet btn-sm"
                  onClick={() =>
                    current &&
                    void client
                      .request<NoteOpenResult>(NOTES_METHODS.open, { id: current.id })
                      .then((r) => show(r))
                  }
                >
                  Use theirs
                </button>
              </div>
            )}
            {inTrash && (
              <div className="notes-banner">
                <span>In the trash. Restore it to edit.</span>
                <button className="btn btn-sm" onClick={restore}>
                  Restore
                </button>
                <button className="btn btn-quiet btn-sm btn-danger" onClick={deleteForever}>
                  Delete for good
                </button>
              </div>
            )}
            <div className="notes-editor-wrap" hidden={!open}>
              <Editor
                ref={editor}
                docKey={open?.key ?? 'none'}
                text={open?.content ?? ''}
                {...(open?.cursor !== undefined ? { cursor: open.cursor } : {})}
                context={context}
                titles={() => titleList.current}
                tags={() => tagList.current}
                onChange={onChange}
                onFiles={onFiles}
                readOnly={!open || inTrash}
              />
            </div>
            {!open && (
              <div className="notes-blank">
                <p>{notes.length ? 'Pick a note, or start a new one.' : 'No notes yet.'}</p>
                <button className="btn btn-primary" onClick={() => void newNote()}>
                  New note
                </button>
                <p className="notes-dim">
                  {IS_MAC ? '⌘N' : 'Ctrl+N'} new · {IS_MAC ? '⌘O' : 'Ctrl+O'} open ·{' '}
                  {IS_MAC ? '⇧⌘F' : 'Ctrl+Shift+F'} search · ⌃1 ⌃2 ⌃3 layout
                </p>
                {notes.length === 0 && (
                  <button className="btn btn-quiet" onClick={() => setDialog('import')}>
                    Import from Bear, Obsidian or a folder
                  </button>
                )}
              </div>
            )}
          </section>
          {state?.ask && (
            <div className="notes-ask-wrap" hidden={!askOpen}>
              <AskPanel
                client={client}
                connection={connection}
                {...(askQuestion ? { question: askQuestion } : {})}
                onOpenLink={(target) => void followLink(target)}
                onClose={() => showAsk(false)}
              />
            </div>
          )}
          {open && infoOpen && (
            <InfoPanel
              headings={headings}
              backlinks={open.backlinks}
              text={text}
              onJump={(offset) => editor.current?.reveal(offset)}
              onOpen={(id) => void openNote(id)}
              onClose={toggleInfo}
            />
          )}
        </main>
      </div>
      {quick === 'notes' && (
        <QuickOpen
          items={titles}
          label="Open note"
          placeholder="Open a note…"
          text={(t) => t.title}
          detail={(t) => t.tags.map((x) => `#${x}`).join(' ')}
          onPick={(t) => {
            setQuick(undefined);
            void openNote(t.id);
          }}
          onCreate={(title) => {
            setQuick(undefined);
            void followLink(title);
          }}
          onClose={() => setQuick(undefined)}
        />
      )}
      {quick === 'tags' && (
        <QuickOpen
          items={tags}
          label="Open tag"
          placeholder="Go to a tag…"
          text={(t) => t.tag}
          detail={(t) => `${t.count}`}
          onPick={(t) => {
            setQuick(undefined);
            setQuery('');
            setSelection({ tag: t.tag });
          }}
          onClose={() => setQuick(undefined)}
        />
      )}
      {dialog === 'settings' && state && (
        <SettingsDialog
          fontSize={state.fontSize}
          vault={state.vault}
          picker={picker ?? <></>}
          onFontSize={(size) => {
            setState({ ...state, fontSize: size });
            void call<NotesState>(NOTES_METHODS.saveSettings, { fontSize: size });
          }}
          onImport={() => setDialog('import')}
          onClose={() => setDialog(undefined)}
        />
      )}
      {dialog === 'import' && (
        <ImportDialog
          browse={(path) =>
            client.request<UiBrowseFoldersResult>(NOTES_METHODS.browseFolders, { path })
          }
          onImport={async (kind: NotesImportKind, path?: string) => {
            const r = await client.request<{
              notes: number;
              attachments: number;
              skipped: { source: string; reason: string }[];
            }>(NOTES_METHODS.import, { kind, ...(path ? { path } : {}) });
            void loadList();
            void loadSide();
            void client
              .request<{ state: NotesState }>(NOTES_METHODS.hello, {})
              .then((h) => setState(h.state));
            const skipped = r.skipped.length
              ? ` Skipped ${r.skipped.length}: ${r.skipped
                  .slice(0, 3)
                  .map((s) => `${s.source} (${s.reason})`)
                  .join(', ')}${r.skipped.length > 3 ? '…' : ''}`
              : '';
            return `Imported ${r.notes} note${r.notes === 1 ? '' : 's'} and ${r.attachments} attachment${r.attachments === 1 ? '' : 's'}.${skipped}`;
          }}
          onClose={() => setDialog(undefined)}
        />
      )}
    </div>
  );
}

/** Tags as Bear shows them: nested by `/`, children under their parent. */
function TagTree({
  tags,
  active,
  onPick,
  onRename,
}: {
  tags: { tag: string; count: number }[];
  active?: string;
  onPick(tag: string): void;
  onRename(tag: string): void;
}): JSX.Element {
  const [closed, setClosed] = useState<Set<string>>(() => new Set());
  const all = new Set(tags.map((t) => t.tag));
  // A parent that only exists through its children still gets a row.
  for (const t of tags) {
    const parts = t.tag.split('/');
    for (let i = 1; i < parts.length; i++) all.add(parts.slice(0, i).join('/'));
  }
  const sorted = [...all].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
  const count = new Map(tags.map((t) => [t.tag, t.count]));
  const visible = sorted.filter((t) => {
    const parts = t.split('/');
    for (let i = 1; i < parts.length; i++)
      if (closed.has(parts.slice(0, i).join('/'))) return false;
    return true;
  });
  if (sorted.length === 0)
    return <p className="convo-empty">Tags you write — #like-this — show up here.</p>;
  return (
    <>
      <div className="rail-section">Tags</div>
      <ul className="tag-tree">
        {visible.map((t) => {
          const depth = t.split('/').length - 1;
          const hasKids = sorted.some((o) => o.startsWith(`${t}/`));
          const name = t.split('/').pop()!;
          return (
            <li key={t}>
              <button
                className={active === t ? 'convo convo-active tag-row' : 'convo tag-row'}
                style={{ paddingLeft: `${8 + depth * 14}px` }}
                onClick={() => onPick(t)}
                onDoubleClick={() => onRename(t)}
                title={`#${t} — double-click to rename`}
              >
                <span
                  className={hasKids ? 'tag-caret' : 'tag-caret tag-caret-none'}
                  aria-hidden="true"
                  onClick={(e) => {
                    if (!hasKids) return;
                    e.stopPropagation();
                    setClosed((s) => {
                      const n = new Set(s);
                      if (n.has(t)) n.delete(t);
                      else n.add(t);
                      return n;
                    });
                  }}
                >
                  {hasKids ? (closed.has(t) ? '▸' : '▾') : ''}
                </span>
                <span className="convo-title">{name}</span>
                {count.get(t) !== undefined && <span className="tag-count">{count.get(t)}</span>}
              </button>
            </li>
          );
        })}
      </ul>
    </>
  );
}

function NoteMenu(props: {
  location: string;
  onDuplicate(): void;
  onArchive(): void;
  onTrash(): void;
  onRestore(): void;
  onDelete(): void;
  onCopyMarkdown(): void;
  onCopyLink(): void;
  onCopyId(): void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const down = (e: MouseEvent) =>
      box.current && !box.current.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', down);
    return () => document.removeEventListener('mousedown', down);
  }, [open]);
  const item = (label: string, fn: () => void, hint?: string, danger?: boolean) => (
    <button
      className={danger ? 'notes-menu-item notes-menu-danger' : 'notes-menu-item'}
      onClick={() => {
        setOpen(false);
        fn();
      }}
    >
      <span>{label}</span>
      {hint && <kbd>{hint}</kbd>}
    </button>
  );
  const m = IS_MAC;
  return (
    <div className="notes-menu" ref={box}>
      <button
        className="btn btn-quiet btn-sm"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="More"
      >
        •••
      </button>
      {open && (
        <div className="notes-menu-pop" role="menu">
          {item('Copy as Markdown', props.onCopyMarkdown)}
          {item('Copy link', props.onCopyLink, m ? '⌥⇧⌘L' : undefined)}
          {item('Copy ID', props.onCopyId, m ? '⌥⇧⌘I' : undefined)}
          <hr />
          {item('Duplicate', props.onDuplicate)}
          {props.location === 'notes' && item('Archive', props.onArchive)}
          {props.location !== 'notes' && item('Restore', props.onRestore, m ? '⇧⌘R' : undefined)}
          {props.location !== 'trash' &&
            item('Move to trash', props.onTrash, m ? '⌘⌫' : undefined, true)}
          {props.location === 'trash' && item('Delete for good', props.onDelete, undefined, true)}
        </div>
      )}
    </div>
  );
}

function RailRow({
  label,
  icon,
  collapsed,
  active,
  onClick,
}: {
  label: string;
  icon: ReactNode;
  collapsed: boolean;
  active?: boolean;
  onClick(): void;
}): JSX.Element {
  return (
    <button
      className={`rail-item ${active ? 'rail-item-active' : ''}`}
      onClick={onClick}
      aria-label={collapsed ? label : undefined}
      aria-current={active ? 'page' : undefined}
    >
      <span className="rail-icon" aria-hidden="true">
        {icon}
      </span>
      <span className="rail-label">{label}</span>
      {collapsed && (
        <span className="rail-tip" aria-hidden="true">
          {label}
        </span>
      )}
    </button>
  );
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ''));
    r.onerror = () => reject(r.error ?? new Error('Could not read the file.'));
    r.readAsDataURL(file);
  });
}

// ── Icons ────────────────────────────────────────────────────────────────

function Svg({ children }: { children: ReactNode }): JSX.Element {
  return (
    <svg
      viewBox="0 0 16 16"
      width="15"
      height="15"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}
function IconNotes(): JSX.Element {
  return (
    <Svg>
      <path d="M4 2.5h5.5l3 3v8H4z" />
      <path d="M6 8h4.5M6 10.5h3" />
    </Svg>
  );
}
function IconUntagged(): JSX.Element {
  return (
    <Svg>
      <path d="M2.5 8.2V3.5a1 1 0 0 1 1-1h4.7l5.3 5.3-5.7 5.7z" />
      <path d="m3 13 10-10" />
    </Svg>
  );
}
function IconTodo(): JSX.Element {
  return (
    <Svg>
      <rect x="2.5" y="2.5" width="11" height="11" rx="2.5" />
      <path d="m5.5 8 1.8 1.8L10.8 6" />
    </Svg>
  );
}
function IconToday(): JSX.Element {
  return (
    <Svg>
      <rect x="2.5" y="3.5" width="11" height="10" rx="2" />
      <path d="M2.5 6.5h11M5.5 2v3M10.5 2v3" />
    </Svg>
  );
}
function IconPin(): JSX.Element {
  return (
    <Svg>
      <path d="M9.5 2.5 13.5 6.5 11 7.5 8.5 10l.5 3-6-6 3 .5L8.5 5z" />
      <path d="m5.5 10.5-3 3" />
    </Svg>
  );
}
function IconArchive(): JSX.Element {
  return (
    <Svg>
      <rect x="2" y="3" width="12" height="3" rx="1" />
      <path d="M3 6v6.5a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V6M6.5 9h3" />
    </Svg>
  );
}
function IconTrash(): JSX.Element {
  return (
    <Svg>
      <path d="M2.5 4.5h11M6 4.5V3h4v1.5M4 4.5l.7 8.5a1 1 0 0 0 1 .9h4.6a1 1 0 0 0 1-.9l.7-8.5" />
    </Svg>
  );
}
function IconCompose(): JSX.Element {
  return (
    <Svg>
      <path d="M13 8.5V13a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h4.5" />
      <path d="m11.5 2 2.5 2.5L8 10.5H5.5V8z" />
    </Svg>
  );
}
function IconPanes(): JSX.Element {
  return (
    <Svg>
      <rect x="2" y="3" width="12" height="10" rx="1.5" />
      <path d="M6 3v10" />
    </Svg>
  );
}
