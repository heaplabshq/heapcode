import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
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
  type NotesListGroup,
  type NotesSection,
  type NotesState,
  type NoteVersion,
  type RelatedNote,
  type UiBrowseFoldersResult,
  type UiWorkspacesResult,
} from '@heapcode/notes-host/protocol';
import { Editor, type EditorHandle } from './Editor.js';
import { AskPanel } from './AskPanel.js';
import { InlineAI, type InlineTarget } from './InlineAI.js';
import { imageSrc, type NoteContext } from './editor/live.js';
import { InfoPanel, NoteList, NotesSettingsPage, QuickOpen, type Heading } from './panels.js';
import { IconChevron } from './icons.js';
import { ImportDialog, type ImportOutcome } from './importDialog.js';
import { ContextMenu, type MenuEntry, type MenuState } from './menu.js';
import { BulkPanel, type BulkRun } from './bulk.js';
import { VersionsDialog } from './versions.js';
import { base64Blob, download, noteHtml, printHtml } from './exporting.js';
import { ago, fullDate, useNow } from './time.js';
import { clampListWidth, savedListWidth } from './layout.js';
import { ListSplitter } from './ListSplitter.js';
import { Settings } from '@heapcode/web-ui/components/Settings';
import {
  CHAT_METHODS,
  type ChatMcpSignInResult,
  type ChatSettings,
} from '@heapcode/chat-host/protocol';

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

const MAX_FILE_BYTES = 50 * 1024 * 1024;

export function App(): JSX.Element {
  const [status, setStatus] = useState<ConnectionStatus>('connecting');
  const [state, setState] = useState<NotesState>();
  const [selection, setSelection] = useState<Selection>({ section: 'all' });
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<'smart' | 'modified' | 'created' | 'title'>(
    () => (remembered('heapnotes.sort') as 'smart') ?? 'smart',
  );
  /** Smart order's subtag headings, when the list is a tag with subtags. */
  const [groups, setGroups] = useState<NotesListGroup[]>();
  const [notes, setNotes] = useState<NoteListItem[]>([]);
  const [related, setRelated] = useState<NoteListItem[]>([]);
  /** The open note's related notes, for the Info panel; undefined while loading. */
  const [relatedTo, setRelatedTo] = useState<RelatedNote[]>();
  const notesRef = useRef<NoteListItem[]>([]);
  notesRef.current = notes;
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
  /** The note list's width, dragged at its right edge. */
  const [listWidth, setListWidth] = useState(() =>
    savedListWidth(remembered('heapnotes.listWidth')),
  );
  const mainRef = useRef<HTMLElement | null>(null);
  // The room the list and editor share, followed as the window changes: the
  // width you chose is kept, and what's shown is what fits right now — so a
  // narrower window doesn't overwrite it, and widening again brings it back.
  // Watched from when <main> exists — the app shows a loading screen first,
  // so an effect run on mount would find nothing to watch.
  const [mainEl, setMainEl] = useState<HTMLElement | null>(null);
  const [mainWidth, setMainWidth] = useState<number>();
  useEffect(() => {
    if (!mainEl || typeof ResizeObserver === 'undefined') return;
    const watch = new ResizeObserver(() => setMainWidth(mainEl.clientWidth));
    watch.observe(mainEl);
    return () => watch.disconnect();
  }, [mainEl]);
  const setMain = useCallback((el: HTMLElement | null) => {
    mainRef.current = el;
    setMainEl(el);
  }, []);
  const shownListWidth = mainWidth ? clampListWidth(listWidth, mainWidth) : listWidth;
  const [infoOpen, setInfoOpen] = useState(() => remembered('heapnotes.info') === 'open');
  const [railCollapsed, setRailCollapsed] = useState(() => remembered('heap.rail') === 'collapsed');
  const [quick, setQuick] = useState<'notes' | 'tags' | 'templates'>();
  /** Notes chosen with ⌘/⇧-click; two or more puts the list in bulk mode. */
  const [picked, setPicked] = useState<string[]>([]);
  const anchor = useRef<string>();
  const [menu, setMenu] = useState<MenuState>();
  const closeMenu = useCallback(() => setMenu(undefined), []);
  const [templates, setTemplates] = useState<{ id: string; title: string; tags: string[] }[]>([]);
  const [dialog, setDialog] = useState<'settings' | 'import' | 'versions'>();
  /** The shared Settings' contents (connections, roles, connectors), read when it opens. */
  const [settings, setSettings] = useState<ChatSettings>();
  const [settingsPage, setSettingsPage] = useState('notes');
  /** Bumped after each settings edit, so Ask re-reads its model. */
  const [settingsVersion, setSettingsVersion] = useState(0);
  /** A note whose "About" chip was dismissed — Ask is then about all notes until another opens. */
  const [aboutDismissed, setAboutDismissed] = useState<string>();
  const [scopeDismissed, setScopeDismissed] = useState<string>();
  /** ⌘J's target while its menu is up. */
  const [inline, setInline] = useState<InlineTarget>();
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

  const setAutoApply = useCallback(
    (on: boolean) => {
      setState((s) => (s ? { ...s, autoApply: on } : s));
      void call<NotesState>(NOTES_METHODS.saveSettings, { autoApply: on }).then(
        (next) => next && setState(next),
      );
    },
    [call],
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
    const page = await call<{ notes: NoteListItem[]; total: number; groups?: NotesListGroup[] }>(
      NOTES_METHODS.list,
      listParams,
    );
    if (page) {
      setNotes(page.notes);
      setGroups(page.groups && page.groups.length > 1 ? page.groups : undefined);
    }
  }, [call, listParams]);

  // Related notes for the Info panel (HEAPNOTES_PHASE2_PLAN §2C): on opening
  // a note, and again once its text has settled — the meaning of a note
  // changes as it's written, and one look per pause costs one embedding.
  const openId = open?.note.id;
  // Which note "this" means in Ask: the open one, unless its chip was dismissed.
  const aboutId =
    openId && aboutDismissed !== openId && open?.note.location !== 'trash' ? openId : undefined;
  // Ask over a tag: the tag you're in, unless its chip was dismissed.
  const askTag = 'tag' in selection && scopeDismissed !== selection.tag ? selection.tag : undefined;
  useEffect(() => {
    if (!state?.ask) return;
    void client
      .request(NOTES_METHODS.askAbout, {
        ...(aboutId ? { id: aboutId } : {}),
        ...(askTag ? { tag: askTag } : {}),
      })
      .catch(() => undefined);
  }, [aboutId, askTag, state?.ask, client, connection]);
  // A ⌘J menu belongs to the note it was opened on.
  useEffect(() => setInline(undefined), [openId]);
  /** The note the related list was last loaded for: a different one loads at once. */
  const relatedFor = useRef<string>();
  useEffect(() => {
    if (!openId || !infoOpen) return;
    const first = relatedFor.current !== openId;
    if (first) setRelatedTo(undefined);
    const timer = setTimeout(
      () => {
        relatedFor.current = openId;
        void client
          .request<RelatedNote[]>(NOTES_METHODS.relatedTo, { id: openId })
          .then(setRelatedTo, () => setRelatedTo([]));
      },
      first ? 0 : 3000,
    );
    return () => clearTimeout(timer);
    // Re-runs as the text changes: the 3s pause after typing is the point.
  }, [openId, infoOpen, text, client]);

  // Search by meaning (HEAPNOTES_PHASE2_PLAN §2B): once typing pauses, the
  // notes close in meaning to the words — tokens like #tag and @today are
  // filters, not meaning, so they stay out of it.
  useEffect(() => {
    setRelated([]);
    const words = query
      .replace(/(^|\s)[@#-]\S*/g, ' ')
      .replace(/["?]/g, ' ')
      .trim();
    if (!state?.ask || words.length < 3 || query.trim().startsWith('?')) return;
    const timer = setTimeout(() => {
      void client
        .request<NoteListItem[]>(NOTES_METHODS.related, {
          query: words,
          exclude: notesRef.current.map((n) => n.id),
        })
        .then(setRelated, () => setRelated([]));
    }, 450);
    return () => clearTimeout(timer);
    // The keyword hits are read when the pause ends (by then they're this
    // query's); re-asking on every list refresh would re-embed the same words.
  }, [query, state?.ask, client]);

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
      // An edit moves a note to the top only where the list is by date.
      const byDate = sort === 'modified' || (sort === 'smart' && !('tag' in selection));
      return byDate && !('section' in selection && selection.section === 'pinned')
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
      if (o && ids.includes(o.note.id)) {
        void client.request<NoteOpenResult>(NOTES_METHODS.open, { id: o.note.id }).then(
          (r) => {
            if (!dirty.current && r.content !== textRef.current) show(r);
            // Same text, new details — a settled rename moved the file.
            else
              setOpen((cur) =>
                cur && cur.note.id === r.note.id
                  ? { ...cur, note: r.note, backlinks: r.backlinks }
                  : cur,
              );
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
  const now = useNow();
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
  const dir = current ? current.path.split('/').slice(0, -1).join('/') : '';
  const copy = (s: string) =>
    void navigator.clipboard
      ?.writeText(s)
      .catch(() => setError('Copying was blocked by the browser.'));

  /** A note (or, with no id, the whole vault) as its files: .md alone, else .zip. */
  const exportFiles = async (id?: string) => {
    if (id) await flush();
    const r = await call<{ filename: string; base64: string }>(
      NOTES_METHODS.exportNotes,
      id ? { id } : {},
    );
    if (r)
      download(
        r.filename,
        base64Blob(r.base64, r.filename.endsWith('.zip') ? 'application/zip' : 'text/markdown'),
      );
  };
  const exportPage = async (as: 'html' | 'pdf') => {
    if (!current) return;
    const html = await noteHtml(current.title, textRef.current, {
      dir,
      attachmentBase: state?.attachmentBase ?? `${BASE}/attachment/`,
    });
    if (as === 'pdf') printHtml(html);
    else download(`${current.title || 'Untitled'}.html`, new Blob([html], { type: 'text/html' }));
  };

  const versionsOf = open?.note.id;
  const listVersions = useCallback(
    () =>
      client
        .request<{ versions: NoteVersion[] }>(NOTES_METHODS.versions, { id: versionsOf })
        .then((r) => r.versions),
    [client, versionsOf],
  );
  const readVersion = useCallback(
    (version: string) =>
      client
        .request<{ content: string }>(NOTES_METHODS.version, { id: versionsOf, version })
        .then((r) => r.content),
    [client, versionsOf],
  );

  const pickTemplate = useCallback(() => {
    void call<{ templates: { id: string; title: string; tags: string[] }[] }>(
      NOTES_METHODS.templates,
    ).then((r) => {
      setTemplates(r?.templates ?? []);
      setQuick('templates');
    });
  }, [call]);
  const fromTemplate = async (id: string) => {
    await flush();
    const tag = 'tag' in selection && selection.tag !== 'template' ? selection.tag : undefined;
    const r = await call<NoteOpenResult>(NOTES_METHODS.fromTemplate, {
      id,
      ...(tag ? { tag } : {}),
    });
    if (!r) return;
    if (openRef.current) history.current.back.push(openRef.current.note.id);
    show(r);
    void loadList();
    void loadSide();
  };
  const isTemplate =
    current?.tags.some((t) => t === 'template' || t.startsWith('template/')) ?? false;

  // ── Several notes at once (Bear's ⌘/⇧-click) ────────────────────────

  const listed = useMemo(() => [...notes, ...related], [notes, related]);
  const pickedSet = useMemo(() => new Set(picked), [picked]);
  const bulkMode = picked.length > 1;
  // A different list is a different selection.
  useEffect(() => setPicked([]), [listParams]);

  const select = (id: string, how: { toggle: boolean; range: boolean }) => {
    const order = listed.map((n) => n.id);
    if (how.range) {
      const from = anchor.current ?? current?.id;
      const a = from ? order.indexOf(from) : -1;
      const b = order.indexOf(id);
      if (a >= 0 && b >= 0) {
        const range = order.slice(Math.min(a, b), Math.max(a, b) + 1);
        if (range.length > 1) return setPicked(range);
      }
    } else if (how.toggle) {
      const base = picked.length ? picked : current ? [current.id] : [];
      const next = base.includes(id) ? base.filter((x) => x !== id) : [...base, id];
      anchor.current = id;
      if (next.length > 1) return setPicked(order.filter((x) => next.includes(x)));
      setPicked([]);
      if (next[0] && next[0] !== current?.id) void openNote(next[0]);
      return;
    }
    anchor.current = id;
    setPicked([]);
    void openNote(id);
  };

  const pickedNotes = listed.filter((n) => pickedSet.has(n.id));
  const report = (r: { done: number; failed: { id: string; reason: string }[] } | undefined) => {
    if (r?.failed.length)
      setError(
        `${r.failed.length} note${r.failed.length === 1 ? '' : 's'} couldn't be changed: ${r.failed[0]!.reason}`,
      );
  };
  const runBulk = async (run: BulkRun, ids = picked) => {
    if (run.kind === 'clear') return setPicked([]);
    const chosen = listed.filter((n) => ids.includes(n.id));
    if (run.kind === 'copyLinks') return copy(chosen.map((n) => `[[${n.title}]]`).join('\n'));
    await flush();
    if (run.kind === 'export') {
      const r = await call<{ filename: string; base64: string }>(NOTES_METHODS.exportNotes, {
        ids,
      });
      if (r) download(r.filename, base64Blob(r.base64, 'application/zip'));
      return;
    }
    if (run.kind === 'merge') {
      const r = await call<NoteOpenResult>(NOTES_METHODS.merge, { ids: chosen.map((n) => n.id) });
      if (!r) return;
      setPicked([]);
      show(r);
      void loadList();
      void loadSide();
      return;
    }
    if (
      run.kind === 'delete' &&
      !confirm(`Delete ${ids.length} notes for good? This can't be undone.`)
    )
      return;
    const r = await call<{ done: number; failed: { id: string; reason: string }[] }>(
      NOTES_METHODS.bulk,
      { ids, action: run.kind, ...(run.kind === 'addTag' ? { tag: run.tag } : {}) },
    );
    report(r);
    // What leaves the list leaves the selection; a tag or a pin keeps it.
    if (['archive', 'restore', 'trash', 'delete'].includes(run.kind)) setPicked([]);
    void loadList();
    void loadSide();
    const o = openRef.current;
    if (o && ids.includes(o.note.id)) {
      if (run.kind === 'delete') setOpen(undefined);
      else void openNote(o.note.id, { fromHistory: true });
    }
  };

  // ── Right-click menus ───────────────────────────────────────────────

  const at = (e: { clientX: number; clientY: number }) => ({ x: e.clientX, y: e.clientY });
  const m = IS_MAC;

  /** One action on one note from its menu: the open note follows as it would from •••. */
  const onNote = (id: string, method: string, params: Record<string, unknown>, leaves: boolean) =>
    void act(
      method,
      { id, ...params },
      id === current?.id ? (leaves ? 'close' : 'reopen') : undefined,
    );

  const noteMenu = (n: NoteListItem, e: { clientX: number; clientY: number }) => {
    if (bulkMode && pickedSet.has(n.id)) return bulkMenu(e);
    const isTpl = n.tags.some((t) => t === 'template' || t.startsWith('template/'));
    const items: MenuEntry[] = [
      { label: 'Open', run: () => select(n.id, { toggle: false, range: false }) },
      'separator',
    ];
    if (n.location !== 'trash')
      items.push(
        {
          label: n.pinned ? 'Unpin' : 'Pin to top',
          run: () => onNote(n.id, NOTES_METHODS.pin, { pinned: !n.pinned }, false),
        },
        {
          label: isTpl ? 'Stop using as template' : 'Use as template',
          run: () => onNote(n.id, NOTES_METHODS.setTemplate, { on: !isTpl }, false),
        },
      );
    items.push(
      { label: 'Copy link', run: () => copy(`[[${n.title}]]`) },
      { label: 'Copy ID', run: () => copy(n.id) },
      {
        label: 'Copy as Markdown',
        run: () =>
          void call<NoteOpenResult>(NOTES_METHODS.open, { id: n.id }).then(
            (r) => r && copy(r.content),
          ),
      },
      'separator',
      {
        label: 'Duplicate',
        run: () =>
          void flush()
            .then(() => call<NoteOpenResult>(NOTES_METHODS.duplicate, { id: n.id }))
            .then((r) => {
              if (!r) return;
              show(r);
              void loadList();
            }),
      },
      {
        label: 'Version history…',
        run: () => void openNote(n.id).then(() => setDialog('versions')),
      },
      { label: 'Export as Markdown', run: () => void exportFiles(n.id) },
      'separator',
    );
    if (n.location === 'notes')
      items.push(
        { label: 'Archive', run: () => onNote(n.id, NOTES_METHODS.archive, {}, true) },
        {
          label: 'Move to trash',
          hint: n.id === current?.id && m ? '⌘⌫' : undefined,
          danger: true,
          run: () => onNote(n.id, NOTES_METHODS.trash, {}, true),
        },
      );
    else
      items.push({
        label: 'Restore',
        run: () => onNote(n.id, NOTES_METHODS.restore, {}, false),
      });
    if (n.location === 'archive')
      items.push({
        label: 'Move to trash',
        danger: true,
        run: () => onNote(n.id, NOTES_METHODS.trash, {}, true),
      });
    if (n.location === 'trash')
      items.push({
        label: 'Delete for good…',
        danger: true,
        run: () => {
          if (confirm(`Delete “${n.title || 'Untitled'}” for good? This can't be undone.`))
            onNote(n.id, NOTES_METHODS.deleteForever, {}, true);
        },
      });
    setMenu({ ...at(e), label: `${n.title || 'Untitled'} actions`, items });
  };

  const bulkMenu = (e: { clientX: number; clientY: number }) => {
    const chosen = pickedNotes;
    const anyTrash = chosen.some((n) => n.location === 'trash');
    const allTrash = chosen.every((n) => n.location === 'trash');
    const allPinned = chosen.every((n) => n.pinned);
    const go = (run: BulkRun) => () => void runBulk(run);
    const items: MenuEntry[] = [];
    if (!anyTrash)
      items.push(
        {
          label: allPinned ? 'Unpin' : 'Pin to top',
          run: go({ kind: allPinned ? 'unpin' : 'pin' }),
        },
        { label: `Merge ${chosen.length} notes`, run: go({ kind: 'merge' }) },
        'separator',
      );
    items.push(
      { label: 'Copy links', run: go({ kind: 'copyLinks' }) },
      { label: `Export ${chosen.length} notes…`, run: go({ kind: 'export' }) },
      'separator',
    );
    if (chosen.some((n) => n.location !== 'notes'))
      items.push({ label: 'Restore', run: go({ kind: 'restore' }) });
    if (!anyTrash && chosen.every((n) => n.location === 'notes'))
      items.push({ label: 'Archive', run: go({ kind: 'archive' }) });
    if (allTrash)
      items.push({ label: 'Delete for good…', danger: true, run: go({ kind: 'delete' }) });
    else if (!anyTrash)
      items.push({ label: 'Move to trash', danger: true, run: go({ kind: 'trash' }) });
    items.push('separator', { label: 'Clear selection', hint: 'Esc', run: go({ kind: 'clear' }) });
    setMenu({ ...at(e), label: `${chosen.length} notes`, items });
  };

  const renameTag = (from: string) => {
    const to = prompt(`Rename #${from} (and its subtags) in every note to:`, from);
    if (to && to !== from)
      void call(NOTES_METHODS.renameTag, { from, to }).then(() => {
        void loadSide();
        void loadList();
        if ('tag' in selection && selection.tag === from) setSelection({ tag: to });
        if (openRef.current) void openNote(openRef.current.note.id, { fromHistory: true });
      });
  };

  const tagMenu = (tag: string, e: { clientX: number; clientY: number }) => {
    const goTag = () => {
      setQuery('');
      setSelection({ tag });
    };
    const items: MenuEntry[] = [
      { label: 'Show notes', run: goTag },
      {
        label: 'New note in this tag',
        run: () =>
          void flush()
            .then(() => call<NoteOpenResult>(NOTES_METHODS.create, { tag }))
            .then((r) => {
              if (!r) return;
              goTag();
              show(r);
            }),
      },
    ];
    if (state?.ask)
      items.push({
        label: 'Ask about this tag…',
        run: () => {
          goTag();
          setScopeDismissed(undefined);
          showAsk(true);
        },
      });
    items.push(
      'separator',
      { label: 'Rename…', run: () => renameTag(tag) },
      {
        label: 'Export notes with this tag…',
        run: () =>
          void call<{ notes: NoteListItem[] }>(NOTES_METHODS.list, { tag }).then(
            (page) =>
              page?.notes.length &&
              void runBulk(
                { kind: 'export' },
                page.notes.map((n) => n.id),
              ),
          ),
      },
      'separator',
      {
        label: 'Remove tag from all notes…',
        danger: true,
        run: () => {
          if (!confirm(`Take #${tag} off every note? The notes stay; only the tag goes.`)) return;
          void call(NOTES_METHODS.deleteTag, { tag }).then(() => {
            if ('tag' in selection && selection.tag === tag) setSelection({ section: 'all' });
            void loadList();
            void loadSide();
            const o = openRef.current;
            if (o) void openNote(o.note.id, { fromHistory: true });
          });
        },
      },
    );
    setMenu({ ...at(e), label: `#${tag} actions`, items });
  };

  const sectionMenu = (section: string, e: { clientX: number; clientY: number }) => {
    const items: MenuEntry[] = [
      {
        label: 'Show',
        run: () => {
          setQuery('');
          setSelection({ section: section as NotesSection });
        },
      },
    ];
    if (section === 'trash')
      items.push('separator', { label: 'Empty trash…', danger: true, run: emptyTrash });
    else items.push({ label: 'New note', hint: m ? '⌘N' : 'Ctrl+N', run: () => void newNote() });
    setMenu({ ...at(e), label: 'Section actions', items });
  };

  const setLayoutMode = (n: 1 | 2 | 3) => {
    setLayout(n);
    remember('heapnotes.layout', String(n));
  };
  const startInline = () => {
    if (!state?.ask || !open || open.note.location === 'trash') return;
    const hidden = state.aiHiddenTags.find((h) =>
      open.note.tags.some(
        (t) =>
          t.toLowerCase() === h.toLowerCase() || t.toLowerCase().startsWith(`${h.toLowerCase()}/`),
      ),
    );
    if (hidden) {
      setError(
        `This note is tagged #${hidden}, which keeps AI out of it. Change that in Settings.`,
      );
      return;
    }
    const t = editor.current?.aiTarget();
    if (t) setInline({ ...t, noteId: open.note.id });
  };
  const closeInline = () => {
    editor.current?.clearTarget();
    setInline(undefined);
    editor.current?.focus();
  };
  const acceptInline = (result: string, mode: 'replace' | 'after') => {
    const t = inline;
    if (!t || !editor.current) return;
    const ok =
      mode === 'replace'
        ? editor.current.replaceRange(t.from, t.to, t.text, result)
        : editor.current.replaceRange(
            t.to,
            t.to,
            '',
            (/\s$/.test(t.text) ? '' : ' ') + result.replace(/^\s+/, ''),
          );
    if (!ok)
      setError('The text changed while the AI was writing, so nothing was replaced. Try ⌘J again.');
    setInline(undefined);
  };

  /** Re-read after every edit, so the dialog shows what was actually saved. */
  const refreshSettings = useCallback(() => {
    if (!state?.ask) return;
    client
      .request<ChatSettings>(CHAT_METHODS.settings)
      .then(setSettings)
      .catch(() => undefined);
  }, [client, state?.ask]);
  const openSettings = (page: string) => {
    refreshSettings();
    setSettingsPage(page);
    setDialog('settings');
  };
  const editSettings = (method: string, params: unknown): void => {
    client
      .request(method, params)
      .then(() => {
        refreshSettings();
        setSettingsVersion((n) => n + 1);
      })
      .catch((e: Error) => setError(e.message));
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
      const typing =
        inEditor || /^(INPUT|TEXTAREA|SELECT)$/.test((e.target as HTMLElement).tagName);
      if (e.key === 'Escape' && bulkMode && !typing && !menu) return run(() => setPicked([]));
      if (!mod) return;
      // ⌘A in the list: every note in it, as Bear does. In text it's still select-all text.
      if (!e.shiftKey && !e.altKey && k === 'a' && !typing && listed.length > 1)
        return run(() => setPicked(listed.map((n) => n.id)));
      if (e.altKey && !e.shiftKey && e.code === 'KeyO') return run(() => setQuick('tags'));
      if (e.altKey && e.shiftKey && e.code === 'KeyI')
        return run(() => current && copy(current.id));
      if (e.altKey && e.shiftKey && e.code === 'KeyL')
        return run(() => current && copy(`[[${current.title}]]`));
      if (e.altKey && !e.shiftKey && e.code === 'KeyN') return run(pickTemplate);
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
      // The note, not the whole app around it.
      if (!e.shiftKey && k === 'p' && current) return run(() => void exportPage('pdf'));
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

  const context: NoteContext = useMemo(
    () => ({
      dir,
      attachmentBase: state?.attachmentBase ?? `${BASE}/attachment/`,
      openLink: (target) => void followLink(target),
      openTag: (tag) => {
        setQuery('');
        setSelection({ tag });
      },
      openUrl: (url) => {
        // A web link opens as one; a link to a file in the vault opens that file.
        if (/^[a-z][a-z0-9+.-]*:/i.test(url))
          return void window.open(url, '_blank', 'noopener,noreferrer');
        let path = url;
        try {
          path = decodeURIComponent(url);
        } catch {
          // Literal.
        }
        if (/\.md$/i.test(path))
          return void followLink(path.split('/').pop()!.replace(/\.md$/i, ''));
        const src = imageSrc(url, {
          dir,
          attachmentBase: state?.attachmentBase ?? `${BASE}/attachment/`,
        });
        if (src) window.open(src, '_blank', 'noopener,noreferrer');
      },
      peek: (target) =>
        client.request<{ title: string; path: string; content: string; more: boolean } | null>(
          NOTES_METHODS.peek,
          { target },
        ),
    }),
    [dir, state?.attachmentBase, followLink, client],
  );

  const onFiles = useCallback(
    async (files: File[]) => {
      const id = openRef.current?.note.id;
      if (!id) return [];
      const out: string[] = [];
      for (const f of files) {
        // The page sends files as text over its connection, which takes ~100 MB a message.
        if (f.size > MAX_FILE_BYTES) {
          setError(`${f.name || 'That file'} is over 50 MB — too large to add to a note.`);
          continue;
        }
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
        {/* Never gone, only narrowed: in the editor-focused layouts the rail
            stays as its icon strip, so sections and New are a click away. */}
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
          collapsed={layout < 3 || railCollapsed}
          onToggleCollapsed={() => {
            // Expanding from a focused layout brings the whole view back.
            if (layout < 3) {
              setLayoutMode(3);
              setRailCollapsed(false);
              remember('heap.rail', 'expanded');
              return;
            }
            setRailCollapsed((v) => {
              remember('heap.rail', v ? 'expanded' : 'collapsed');
              return !v;
            });
          }}
          conversations={[]}
          onOpen={() => undefined}
          onNew={() => void newNote()}
          busy={false}
          status={status}
          onOpenSettings={() => openSettings('notes')}
          extraNav={
            <>
              {SECTIONS.map((s) => (
                <RailRow
                  key={s.section}
                  label={s.label}
                  icon={s.icon}
                  collapsed={layout < 3 || railCollapsed}
                  active={'section' in selection && selection.section === s.section}
                  onClick={() => {
                    setQuery('');
                    setSelection({ section: s.section });
                  }}
                  onMenu={(e) => sectionMenu(s.section, e)}
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
              onRename={renameTag}
              onMenu={tagMenu}
            />
          }
          footer={
            // Says what a click does — settings — with the folder's name as the detail.
            <button
              className="notes-foot"
              onClick={() => openSettings('notes')}
              title={state ? `Notes folder, text size and AI — ${state.vault}` : undefined}
              aria-label="Notes settings"
            >
              <span className="notes-foot-icon">
                <IconFolder />
              </span>
              <span className="notes-foot-text">
                <span className="notes-foot-name">Notes settings</span>
                <span className="notes-foot-count">
                  {state
                    ? `${state.count} note${state.count === 1 ? '' : 's'} · ${state.vault.split(/[\\/]/).pop()}`
                    : ''}
                </span>
              </span>
            </button>
          }
        />
        <main
          className="notes-main"
          ref={setMain}
          style={{ '--notes-list-w': `${shownListWidth}px` } as CSSProperties}
        >
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
                    <option
                      value="smart"
                      title="In a tag: its page first, then the order it links them; elsewhere, newest first"
                    >
                      Smart
                    </option>
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
                  <button
                    className="btn btn-quiet btn-sm"
                    onClick={pickTemplate}
                    title={`New from template (${IS_MAC ? '⌥⌘' : 'Ctrl+Alt+'}N)`}
                    aria-label="New from template"
                  >
                    <IconTemplate />
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
                related={related}
                selected={current?.id}
                picked={pickedSet}
                {...(groups && !query.trim() ? { groups } : {})}
                onSelect={select}
                onMenu={noteMenu}
                empty={emptyText}
              />
            </section>
          )}
          {layout >= 2 && (
            <ListSplitter
              width={shownListWidth}
              getMainWidth={() => mainRef.current?.clientWidth ?? 900}
              onResize={setListWidth}
              onCommit={(w) => remember('heapnotes.listWidth', String(w))}
            />
          )}
          <section className="notes-editor-pane" aria-label="Editor">
            <div className="notes-toolbar">
              <span className="notes-toolbar-left">
                <button
                  className="btn btn-quiet btn-sm"
                  onClick={() => setLayoutMode(layout === 1 ? 3 : 1)}
                  title={
                    layout === 1 ? 'Show the note list and sidebar (⌃3)' : 'Focus on the note (⌃1)'
                  }
                  aria-label="Toggle panes"
                >
                  <IconPanes />
                </button>
                {bulkMode && <span className="notes-path">{picked.length} notes selected</span>}
                {current && !bulkMode && (
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
                {current && !bulkMode && saving === 'idle' && (
                  <span className="notes-edited" title={`Modified ${fullDate(current.modified)}`}>
                    Edited {ago(current.modified, now)}
                  </span>
                )}
              </span>
              {/* One group, in order of use: the note's own state, then the
                  panels, then everything else behind •••. */}
              <span className="notes-toolbar-right" hidden={bulkMode}>
                {current && !inTrash && (
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
                {current && (
                  <button
                    className={infoOpen ? 'btn btn-quiet btn-sm notes-on' : 'btn btn-quiet btn-sm'}
                    onClick={toggleInfo}
                    title="Contents, backlinks and related notes (⇧⌘A)"
                    aria-pressed={infoOpen}
                  >
                    Info
                  </button>
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
                {current && (
                  <NoteMenu
                    location={current.location}
                    {...(state?.ask && !inTrash ? { onEditWithAi: startInline } : {})}
                    onDuplicate={() => void duplicate()}
                    onArchive={archive}
                    onTrash={trash}
                    onRestore={restore}
                    onDelete={deleteForever}
                    onCopyMarkdown={() => copy(text)}
                    onCopyLink={() => copy(`[[${current.title}]]`)}
                    onCopyId={() => copy(current.id)}
                    onVersions={() => void flush().then(() => setDialog('versions'))}
                    isTemplate={isTemplate}
                    onTemplate={() =>
                      void act(
                        NOTES_METHODS.setTemplate,
                        { id: current.id, on: !isTemplate },
                        'reopen',
                      )
                    }
                    onExport={(as) =>
                      void (as === 'markdown' ? exportFiles(current.id) : exportPage(as))
                    }
                  />
                )}
              </span>
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
            {bulkMode && <BulkPanel notes={pickedNotes} onRun={(r) => void runBulk(r)} />}
            <div className="notes-editor-wrap" hidden={!open || bulkMode}>
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
                onAi={startInline}
                readOnly={!open || inTrash}
              />
            </div>
            {!open && !bulkMode && (
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
                onOpenSettings={() => openSettings('providers')}
                settingsVersion={settingsVersion}
                {...(aboutId && open ? { about: { title: open.note.title } } : {})}
                onClearAbout={() => setAboutDismissed(openId)}
                {...(askTag ? { scopeTag: askTag } : {})}
                onClearScope={() => setScopeDismissed(askTag)}
                autoApply={state?.autoApply ?? false}
                onAutoApply={setAutoApply}
              />
            </div>
          )}
          {open && infoOpen && (
            <InfoPanel
              note={{
                created: open.note.created,
                modified: open.note.modified,
                ...(open.source ? { source: open.source } : {}),
              }}
              headings={headings}
              backlinks={open.backlinks}
              {...(relatedTo ? { related: relatedTo } : {})}
              {...(inTrash
                ? {}
                : {
                    onLink: (title: string) => {
                      editor.current?.insert(`[[${title}]]`);
                      setRelatedTo((list) => list?.filter((r) => r.title !== title));
                    },
                  })}
              text={text}
              onJump={(offset) => editor.current?.reveal(offset)}
              onOpen={(id) => void openNote(id)}
              onClose={toggleInfo}
            />
          )}
        </main>
      </div>
      {inline && (
        <InlineAI client={client} target={inline} onAccept={acceptInline} onClose={closeInline} />
      )}
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
      {menu && (
        <ContextMenu key={`${menu.x},${menu.y},${menu.label}`} menu={menu} onClose={closeMenu} />
      )}
      {quick === 'templates' && (
        <QuickOpen
          items={templates}
          label="New from template"
          placeholder="New note from a template…"
          text={(t) => t.title}
          detail={(t) =>
            t.tags
              .filter((x) => !x.startsWith('template'))
              .map((x) => `#${x}`)
              .join(' ')
          }
          empty="No templates yet. Tag a note #template — or choose “Use as template” in its ••• menu — and it shows up here."
          onPick={(t) => {
            setQuick(undefined);
            void fromTemplate(t.id);
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
        <Settings
          settings={settings}
          onClose={() => setDialog(undefined)}
          initialPage={settingsPage}
          // What Heapnotes shares with the other products — connections and
          // model roles, web search, MCP connectors (which Ask can use) — and
          // its own page first. Edits go through Ask's session, which answers
          // Heap Chat's settings requests on this same socket.
          pages={state.ask ? ['providers', 'search', 'connectors'] : []}
          extraPages={[
            {
              id: 'notes',
              group: 'Heapnotes',
              label: 'Notes',
              icon: <IconNotes />,
              keywords: 'folder vault text size font import bear obsidian private hidden ai tags',
              render: (go) => (
                <NotesSettingsPage
                  vault={state.vault}
                  picker={picker ?? <></>}
                  fontSize={state.fontSize}
                  onFontSize={(size) => {
                    setState({ ...state, fontSize: size });
                    void call<NotesState>(NOTES_METHODS.saveSettings, { fontSize: size });
                  }}
                  {...(state.ask ? { hiddenTags: state.aiHiddenTags } : {})}
                  onHiddenTags={(tags) => {
                    void call<NotesState>(NOTES_METHODS.saveSettings, { aiHiddenTags: tags }).then(
                      (next) => next && setState(next),
                    );
                  }}
                  autoApply={state.autoApply}
                  onAutoApply={setAutoApply}
                  onImport={() => setDialog('import')}
                  onExportAll={() => void exportFiles()}
                  onChangeModel={() => go('providers')}
                />
              ),
            },
          ]}
          onSaveProfile={(profile, apiKey) =>
            editSettings(CHAT_METHODS.saveProfile, { profile, apiKey })
          }
          onDeleteProfile={(name) => editSettings(CHAT_METHODS.deleteProfile, { name })}
          onUseProfile={(name) => editSettings(CHAT_METHODS.useProfile, { name })}
          onSetRole={(role, assignment) => editSettings(CHAT_METHODS.setRole, { role, assignment })}
          onSetWebSearch={(patch) => editSettings(CHAT_METHODS.setWebSearch, patch)}
          listConnectionModels={(connection) =>
            client
              .request<{ models: string[] }>(CHAT_METHODS.listConnectionModels, { connection })
              .then((r) => r.models)
          }
          listModels={(profileName) =>
            client
              .request<{ models: Array<{ id: string }> }>(CHAT_METHODS.listModels, { profileName })
              .then((r) => r.models.map((m) => m.id))
          }
          probeProvider={(params) => client.request(CHAT_METHODS.probeProvider, params)}
          // Not on the pages offered here, but required by the props.
          onSetPersona={() => {}}
          onToggleSubAgents={() => {}}
          onToggleNativeTools={() => {}}
          onResetPermissions={() => {}}
          onSaveMcpServer={(name, spec, env) =>
            editSettings(CHAT_METHODS.saveMcpServer, { name, spec, env })
          }
          onDeleteMcpServer={(name) => editSettings(CHAT_METHODS.deleteMcpServer, { name })}
          onSignInMcpServer={async (name) => {
            const res = (await client.request(CHAT_METHODS.signInMcpServer, {
              name,
            })) as ChatMcpSignInResult;
            return res.authorizationUrl;
          }}
          onSignOutMcpServer={(name) => editSettings(CHAT_METHODS.signOutMcpServer, { name })}
          onForgetMcpTrust={(name) => editSettings(CHAT_METHODS.forgetMcpTrust, { name })}
        />
      )}
      {dialog === 'versions' && open && (
        <VersionsDialog
          title={open.note.title}
          current={textRef.current}
          list={listVersions}
          read={readVersion}
          onRestore={async (version) => {
            const r = await client.request<NoteOpenResult>(NOTES_METHODS.restoreVersion, {
              id: open.note.id,
              version,
            });
            show(r);
            void loadList();
          }}
          onClose={() => setDialog(undefined)}
        />
      )}
      {dialog === 'import' && (
        <ImportDialog
          browse={(path, zips) =>
            client.request<UiBrowseFoldersResult>(NOTES_METHODS.browseFolders, {
              path,
              ...(zips ? { zips: true } : {}),
            })
          }
          onImport={async (kind: NotesImportKind, path?: string) => {
            const r = await client.request<ImportOutcome>(NOTES_METHODS.import, {
              kind,
              ...(path ? { path } : {}),
            });
            void loadList();
            void loadSide();
            void client
              .request<{ state: NotesState }>(NOTES_METHODS.hello, {})
              .then((h) => setState(h.state));
            return r;
          }}
          onShowTag={(tag) => {
            setQuery('');
            setSelection({ tag });
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
  onMenu,
}: {
  tags: { tag: string; count: number }[];
  active?: string;
  onPick(tag: string): void;
  onRename(tag: string): void;
  onMenu?(tag: string, e: { clientX: number; clientY: number }): void;
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
                onContextMenu={
                  onMenu &&
                  ((e) => {
                    e.preventDefault();
                    onMenu(t, e);
                  })
                }
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
                  {hasKids && <IconChevron open={!closed.has(t)} />}
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
  /** ⌘J on the selection or the paragraph — only when AI is available here. */
  onEditWithAi?(): void;
  onDuplicate(): void;
  onArchive(): void;
  onTrash(): void;
  onRestore(): void;
  onDelete(): void;
  onCopyMarkdown(): void;
  onCopyLink(): void;
  onCopyId(): void;
  onExport(as: 'markdown' | 'html' | 'pdf'): void;
  onVersions(): void;
  isTemplate: boolean;
  onTemplate(): void;
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
          {props.onEditWithAi && (
            <>
              {item('Edit with AI…', props.onEditWithAi, m ? '⌘J' : 'Ctrl+J')}
              <hr />
            </>
          )}
          {item('Copy as Markdown', props.onCopyMarkdown)}
          {item('Copy link', props.onCopyLink, m ? '⌥⇧⌘L' : undefined)}
          {item('Copy ID', props.onCopyId, m ? '⌥⇧⌘I' : undefined)}
          <hr />
          {item('Export as Markdown', () => props.onExport('markdown'))}
          {item('Export as HTML', () => props.onExport('html'))}
          {item('Print or save as PDF…', () => props.onExport('pdf'), m ? '⌘P' : 'Ctrl+P')}
          <hr />
          {item('Version history…', props.onVersions)}
          {props.location !== 'trash' &&
            item(props.isTemplate ? 'Stop using as template' : 'Use as template', props.onTemplate)}
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
  onMenu,
}: {
  label: string;
  icon: ReactNode;
  collapsed: boolean;
  active?: boolean;
  onClick(): void;
  onMenu?(e: { clientX: number; clientY: number }): void;
}): JSX.Element {
  return (
    <button
      className={`rail-item ${active ? 'rail-item-active' : ''}`}
      onClick={onClick}
      onContextMenu={
        onMenu &&
        ((e) => {
          e.preventDefault();
          onMenu(e);
        })
      }
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
function IconFolder(): JSX.Element {
  return (
    <Svg>
      <path d="M2 4.5a1 1 0 0 1 1-1h3.3l1.5 1.5H13a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1z" />
    </Svg>
  );
}
function IconTemplate(): JSX.Element {
  return (
    <Svg>
      <rect x="3" y="2.5" width="10" height="11" rx="1.5" strokeDasharray="2 1.6" />
      <path d="M5.5 6h5M5.5 8.5h3" />
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
