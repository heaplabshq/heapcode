import { useCallback, useEffect, useState } from 'react';
import type {
  UiArtifactMeta,
  UiIndexStatus,
  UiRepoMapResult,
  UiArtifactResult,
  UiChangedFile,
  UiCheckpoint,
  UiDiffResult,
  UiReadFileResult,
  UiTreeEntry,
} from '@heapcode/web-host/protocol';
import { DiffView } from './DiffView.js';
import { Empty } from './Empty.js';
import { Preview } from './Preview.js';
import { IndexView } from './IndexView.js';

export type PanelTab = 'changes' | 'files' | 'index' | 'terminal' | 'preview';

export interface TerminalEntry {
  id: string;
  command: string;
  output?: string;
  isError?: boolean;
  done: boolean;
}

export interface PanelProps {
  tab: PanelTab;
  onTab(tab: PanelTab): void;
  onClose(): void;

  changes: UiChangedFile[];
  checkpoints: UiCheckpoint[];
  terminal: TerminalEntry[];
  busy: boolean;

  loadDiff(path: string): Promise<UiDiffResult>;
  loadTree(path: string): Promise<UiTreeEntry[]>;
  loadFile(path: string): Promise<UiReadFileResult>;
  onRevertFile(path: string): void;
  onRevertAll(): void;
  onKeepAll(): void;
  onRewind(hash: string): void;
  /** Set by the chat pane when the user clicks a path in a tool chip. */
  openPath?: string;

  /** Both indexes, live — see IndexView. */
  indexStatus?: UiIndexStatus;
  loadRepoMap(query: string): Promise<UiRepoMapResult>;
  onReindex(): void;
  onClearIndex(): void;
  /** Opening a path from the map switches to Files, like a tool chip does. */
  onOpenPath(path: string): void;

  artifacts: UiArtifactMeta[];
  selectedArtifact?: string;
  onSelectArtifact(id: string): void;
  loadArtifact(id: string, version?: number): Promise<UiArtifactResult>;
  onSaveArtifact(id: string, path: string, version?: number): void;
}

/*
 * Tab icons, inline and stroked from `currentColor` — the same 24-unit grid
 * and weight the rail uses, so a tab and a nav row are recognisably the same
 * kind of control.
 */
const S = {
  width: 15,
  height: 15,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.7,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
};

/** A file with a plus and a minus in it: what changed. */
const ICON_CHANGES = (
  <svg {...S}>
    <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
    <path d="M14 3v5h5" />
    <path d="M9 13h4M11 11v4" />
    <path d="M9 18h4" />
  </svg>
);
const ICON_FILES = (
  <svg {...S}>
    <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
  </svg>
);
/** Stacked layers: the index is the repository, flattened. */
const ICON_INDEX = (
  <svg {...S}>
    <path d="m12 3 9 4.5-9 4.5-9-4.5z" />
    <path d="m3 12.5 9 4.5 9-4.5" />
    <path d="m3 17 9 4.5 9-4.5" />
  </svg>
);
const ICON_TERMINAL = (
  <svg {...S}>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="m7 9 3 3-3 3M13 15h4" />
  </svg>
);
/** A window with something rendered in it. */
const ICON_PREVIEW = (
  <svg {...S}>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="M3 9h18" />
    <path d="m7 16 3-3 2 2 2-2.5 3 3.5" />
  </svg>
);

/** The tab strip, in the order the work tends to flow. */
const TABS: { id: PanelTab; label: string; icon: JSX.Element }[] = [
  { id: 'changes', label: 'Changes', icon: ICON_CHANGES },
  { id: 'files', label: 'Files', icon: ICON_FILES },
  { id: 'index', label: 'Index', icon: ICON_INDEX },
  { id: 'terminal', label: 'Terminal', icon: ICON_TERMINAL },
  { id: 'preview', label: 'Preview', icon: ICON_PREVIEW },
];

export function Panel(props: PanelProps): JSX.Element {
  return (
    <section className="panel" aria-label="Workspace">
      <div className="panel-tabs" role="tablist">
        {TABS.map(({ id, label, icon }) => {
          // The count is a badge rather than "(4)" in the label, so the tab
          // name stays the same width whether or not there is anything in it.
          const count = id === 'changes' ? props.changes.length : id === 'preview' ? props.artifacts.length : 0;
          return (
            <button
              key={id}
              role="tab"
              aria-selected={props.tab === id}
              className={props.tab === id ? 'panel-tab panel-tab-active' : 'panel-tab'}
              onClick={() => props.onTab(id)}
            >
              <span className="panel-tab-icon">{icon}</span>
              {label}
              {count > 0 && <span className="panel-tab-count">{count}</span>}
            </button>
          );
        })}
        <button className="icon-btn panel-close" onClick={props.onClose} aria-label="Close panel">
          ✕
        </button>
      </div>

      <div className="panel-body">
        {props.tab === 'changes' && <Changes {...props} />}
        {props.tab === 'files' && <Files {...props} />}
        {props.tab === 'index' && (
          <IndexView
            status={props.indexStatus}
            loadMap={props.loadRepoMap}
            onRebuild={props.onReindex}
            onClear={props.onClearIndex}
            busy={props.busy}
            onOpenPath={props.onOpenPath}
          />
        )}
        {props.tab === 'terminal' && <Terminal entries={props.terminal} />}
        {props.tab === 'preview' && (
          <Preview
            artifacts={props.artifacts}
            selectedId={props.selectedArtifact}
            onSelect={props.onSelectArtifact}
            loadArtifact={props.loadArtifact}
            onSave={props.onSaveArtifact}
          />
        )}
      </div>
    </section>
  );
}

function Changes(props: PanelProps): JSX.Element {
  const [selected, setSelected] = useState<string>();
  const [diff, setDiff] = useState<UiDiffResult>();
  const [diffError, setDiffError] = useState<string>();

  const { loadDiff, changes } = props;
  useEffect(() => {
    setDiffError(undefined);
    if (!selected) return setDiff(undefined);
    let live = true;
    setDiff(undefined);
    // `changes` is a dependency on purpose: after a revert the diff on screen
    // is stale, and refetching is cheaper than reasoning about which files moved.
    void loadDiff(selected)
      .then((d) => live && setDiff(d))
      // A failure here used to be an unhandled rejection and a row that stayed
      // on "Loading…" forever — indistinguishable from a slow diff.
      .catch((err: Error) => live && setDiffError(err.message));
    return () => {
      live = false;
    };
  }, [selected, changes, loadDiff]);

  if (props.changes.length === 0) {
    return (
      <div className="changes">
        <Empty>Nothing edited yet. Files the agent changes appear here, with a diff and a way back.</Empty>
        {props.checkpoints.length > 0 && <Checkpoints {...props} />}
      </div>
    );
  }

  const totals = props.changes.reduce(
    (acc, f) => ({ added: acc.added + f.added, removed: acc.removed + f.removed }),
    { added: 0, removed: 0 },
  );

  return (
    <div className="changes">
      {/* Count and totals on the left, the two whole-session actions on the
          right. They used to be a pair of full-size buttons sitting between
          the file list and the checkpoints, which read as a divider and put
          "Revert all" — the most destructive thing here — directly under the
          cursor's path down the list. */}
      <header className="changes-head">
        <span className="changes-count">
          {props.changes.length} file{props.changes.length === 1 ? '' : 's'}
        </span>
        <span className="stat stat-add">+{totals.added}</span>
        <span className="stat stat-del">−{totals.removed}</span>
        <span className="changes-head-actions">
          <button className="link-btn" onClick={props.onKeepAll} disabled={props.busy}>
            Keep all
          </button>
          <button className="link-btn link-btn-danger" onClick={props.onRevertAll} disabled={props.busy}>
            Revert all
          </button>
        </span>
      </header>


      <ul className="file-list">
        {props.changes.map((f) => (
          <li key={f.path}>
            <button
              className={`file-row ${selected === f.path ? 'file-row-active' : ''}`}
              onClick={() => setSelected(selected === f.path ? undefined : f.path)}
            >
              <span className="file-path" title={f.path}>
                {f.path}
              </span>
              {f.created && <span className="badge badge-ok">new</span>}
              {f.deleted && <span className="badge badge-off">deleted</span>}
              {f.reverted && <span className="badge badge-off">reverted</span>}
              <span className="stat stat-add">+{f.added}</span>
              <span className="stat stat-del">−{f.removed}</span>
            </button>
            {selected === f.path && (
              <div className="file-detail">
                {diffError ? (
                  <p className="panel-error">Could not load the diff — {diffError}</p>
                ) : diff?.note ? (
                  <p className="hint">{diff.note}</p>
                ) : diff ? (
                  <DiffView diff={diff.diff} />
                ) : (
                  <Skeleton lines={5} />
                )}
                {/* In its own bar under the diff, the way a form's commit
                    control sits under the form — not loose against the next
                    file's row. */}
                <div className="file-detail-actions">
                  <button
                    className="link-btn link-btn-danger"
                    onClick={() => props.onRevertFile(f.path)}
                    disabled={props.busy}
                  >
                    Revert this file
                  </button>
                </div>
              </div>
            )}
          </li>
        ))}
      </ul>

      <Checkpoints {...props} />
    </div>
  );
}

/** Beyond this many, the list is opened on request rather than by default. */
const CHECKPOINTS_COLLAPSE_ABOVE = 5;
/** And even then it shows a window, not the whole history, until asked. */
const CHECKPOINTS_PAGE = 8;

/**
 * The rewind history.
 *
 * Was a stack of bordered cards, each carrying its own full-size "Rewind here"
 * button — so a session with a dozen snapshots turned the Changes tab into a
 * wall of buttons that dwarfed the changed files above it, which is the thing
 * the tab is actually about. Now: a collapsible section, a compact row per
 * snapshot with the time first so a long list can be scanned down one column,
 * and a quiet Rewind that only asserts itself on hover.
 *
 * Collapsed only once the list is long enough to be the problem. A section
 * that hides three items behind a click is worse than one that shows them.
 */
function Checkpoints(props: PanelProps): JSX.Element | null {
  const total = props.checkpoints.length;
  const [open, setOpen] = useState(total <= CHECKPOINTS_COLLAPSE_ABOVE);
  const [all, setAll] = useState(false);
  if (total === 0) return null;

  const shown = all ? props.checkpoints : props.checkpoints.slice(0, CHECKPOINTS_PAGE);

  return (
    <section className="checkpoints">
      <button className="cp-toggle" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <span className="cp-caret">{open ? '▾' : '▸'}</span>
        Checkpoints
        <span className="badge cp-count">{total}</span>
      </button>

      {open && (
        <>
          <p className="hint cp-note">
            A snapshot is taken before each change. Rewinding restores the whole workspace.
          </p>
          <ul className="cp-list">
            {shown.map((c) => (
              <li key={c.hash} className="cp">
                <time className="cp-time" dateTime={new Date(c.date).toISOString()}>
                  {new Date(c.date).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </time>
                <span className="cp-label" title={c.label}>
                  {c.label}
                </span>
                <button className="cp-rewind" onClick={() => props.onRewind(c.hash)} disabled={props.busy}>
                  Rewind
                </button>
              </li>
            ))}
          </ul>
          {!all && total > CHECKPOINTS_PAGE && (
            <button className="link-btn" onClick={() => setAll(true)}>
              Show all {total}
            </button>
          )}
        </>
      )}
    </section>
  );
}

function Files({ loadTree, loadFile, openPath }: PanelProps): JSX.Element {
  const [dir, setDir] = useState('');
  const [entries, setEntries] = useState<UiTreeEntry[]>();
  const [file, setFile] = useState<UiReadFileResult>();
  const [error, setError] = useState<string>();
  const [opening, setOpening] = useState<string>();

  // `entries` starts undefined and only becomes an array once a listing
  // arrives, so "still loading" and "genuinely empty" are different states.
  // They used to be the same one, which meant every slow or failed listing
  // rendered the word "Empty."
  const load = useCallback(
    (path: string) => {
      setDir(path);
      setFile(undefined);
      setEntries(undefined);
      setError(undefined);
      void loadTree(path)
        .then(setEntries)
        .catch((err: Error) => setError(err.message));
    },
    [loadTree],
  );

  const open = useCallback(
    (path: string) => {
      setOpening(path);
      setError(undefined);
      void loadFile(path)
        .then(setFile)
        .catch((err: Error) => setError(err.message))
        .finally(() => setOpening(undefined));
    },
    [loadFile],
  );

  useEffect(() => {
    load('');
  }, [load]);

  // A path clicked in a tool chip opens here.
  useEffect(() => {
    if (openPath) open(openPath);
  }, [openPath, open]);

  if (file) {
    return (
      <div className="file-view">
        <div className="file-view-head">
          <button className="btn btn-ghost" onClick={() => setFile(undefined)}>
            ← Back
          </button>
          <code>{file.path}</code>
        </div>
        {file.note ? <p className="hint">{file.note}</p> : <pre className="file-body">{file.content}</pre>}
      </div>
    );
  }

  return (
    <div className="tree">
      <div className="tree-head">
        <button
          className="btn btn-ghost tree-up"
          disabled={!dir}
          aria-label="Parent folder"
          onClick={() => load(dir.split('/').slice(0, -1).join('/'))}
        >
          ↑
        </button>
        <code>{dir || '/'}</code>
      </div>
      {error && (
        <p className="panel-error">
          {error}{' '}
          <button className="link-btn" onClick={() => load(dir)}>
            Try again
          </button>
        </p>
      )}
      {opening && <Skeleton lines={6} />}
      {!opening && entries === undefined && !error && <Skeleton lines={8} />}
      {entries !== undefined && (
        <ul className="file-list">
          {entries.map((e) => (
            <li key={e.path}>
              <button className="file-row" onClick={() => (e.directory ? load(e.path) : open(e.path))}>
                <span className="tree-icon">{e.directory ? '▸' : '·'}</span>
                <span className="file-path">{e.name}</span>
              </button>
            </li>
          ))}
          {entries.length === 0 && (
            <li>
              <Empty>Nothing here — the folder is empty, or entirely ignored.</Empty>
            </li>
          )}
        </ul>
      )}
    </div>
  );
}

/**
 * Placeholder rows while something loads.
 *
 * Preferred over the word "Loading…" for anything that replaces a list or a
 * block of text: it holds the space the content will take, so the panel does
 * not jump when it arrives, and it makes a stalled fetch look stalled rather
 * than finished-and-empty.
 */
function Skeleton({ lines }: { lines: number }): JSX.Element {
  return (
    <div className="skeleton" aria-hidden="true">
      {Array.from({ length: lines }, (_, i) => (
        <div className="skeleton-line" key={i} style={{ width: `${90 - ((i * 13) % 45)}%` }} />
      ))}
    </div>
  );
}

/**
 * Command output, grouped per call.
 *
 * Read-only in v1 — the agent runs commands and the user watches. An
 * interactive terminal is a separate decision (§12 Q4), not a small addition.
 */
function Terminal({ entries }: { entries: TerminalEntry[] }): JSX.Element {
  if (entries.length === 0) {
    return <Empty>No commands yet. Anything the agent runs appears here, with its output.</Empty>;
  }
  return (
    <div className="terminal">
      {entries.map((e) => (
        // A card per call, so where one command's output ends and the next
        // begins is a border rather than a guess about vertical rhythm.
        <div key={e.id} className="term-entry">
          <div className={e.isError ? 'term-cmd term-error' : 'term-cmd'}>
            <span className="term-prompt">$</span>
            <span className="term-text">{e.command}</span>
            {!e.done && <span className="badge badge-off term-running">running</span>}
            {e.isError && <span className="badge term-failed">failed</span>}
          </div>
          {e.output && <pre className="term-out">{e.output}</pre>}
        </div>
      ))}
    </div>
  );
}
