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

export function Panel(props: PanelProps): JSX.Element {
  return (
    <section className="panel" aria-label="Workspace">
      <div className="panel-tabs">
        {(['changes', 'files', 'index', 'terminal', 'preview'] as const).map((t) => (
          <button
            key={t}
            className={`panel-tab ${props.tab === t ? 'panel-tab-active' : ''}`}
            onClick={() => props.onTab(t)}
          >
            {t === 'changes' && `Changes${props.changes.length ? ` (${props.changes.length})` : ''}`}
            {t === 'preview' && `Preview${props.artifacts.length ? ` (${props.artifacts.length})` : ''}`}
            {t !== 'changes' && t !== 'preview' && t}
          </button>
        ))}
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

  const { loadDiff, changes } = props;
  useEffect(() => {
    if (!selected) return setDiff(undefined);
    let live = true;
    // `changes` is a dependency on purpose: after a revert the diff on screen
    // is stale, and refetching is cheaper than reasoning about which files moved.
    void loadDiff(selected).then((d) => live && setDiff(d));
    return () => {
      live = false;
    };
  }, [selected, changes, loadDiff]);

  if (props.changes.length === 0) {
    return (
      <div className="panel-empty">
        <p>No changes yet.</p>
        <p className="hint">Files the agent edits this session show up here, with a diff and a way back.</p>
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
                {diff?.note ? <p className="hint">{diff.note}</p> : diff ? <DiffView diff={diff.diff} /> : <p className="hint">Loading…</p>}
                <button className="link-btn link-btn-danger" onClick={() => props.onRevertFile(f.path)} disabled={props.busy}>
                  Revert this file
                </button>
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
        <span className="cp-count">{total}</span>
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
  const [entries, setEntries] = useState<UiTreeEntry[]>([]);
  const [file, setFile] = useState<UiReadFileResult>();

  const load = useCallback(
    (path: string) => {
      setDir(path);
      setFile(undefined);
      void loadTree(path).then(setEntries);
    },
    [loadTree],
  );

  useEffect(() => {
    void loadTree('').then(setEntries);
  }, [loadTree]);

  // A path clicked in a tool chip opens here.
  useEffect(() => {
    if (openPath) void loadFile(openPath).then(setFile);
  }, [openPath, loadFile]);

  if (file) {
    return (
      <div className="file-view">
        <div className="file-view-head">
          <button className="btn" onClick={() => setFile(undefined)}>
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
        <button className="btn" disabled={!dir} onClick={() => load(dir.split('/').slice(0, -1).join('/'))}>
          ↑
        </button>
        <code>{dir || '/'}</code>
      </div>
      <ul className="file-list">
        {entries.map((e) => (
          <li key={e.path}>
            <button
              className="file-row"
              onClick={() => (e.directory ? load(e.path) : void loadFile(e.path).then(setFile))}
            >
              <span className="tree-icon">{e.directory ? '▸' : '·'}</span>
              <span className="file-path">{e.name}</span>
            </button>
          </li>
        ))}
        {entries.length === 0 && <li className="hint">Empty.</li>}
      </ul>
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
    return (
      <div className="panel-empty">
        <p>No commands yet.</p>
        <p className="hint">Anything the agent runs shows up here with its output.</p>
      </div>
    );
  }
  return (
    <div className="terminal">
      {entries.map((e) => (
        <div key={e.id} className="term-entry">
          <div className={`term-cmd ${e.isError ? 'term-error' : ''}`}>
            <span className="term-prompt">$</span> {e.command}
            {!e.done && <span className="term-running"> running…</span>}
          </div>
          {e.output && <pre className="term-out">{e.output}</pre>}
        </div>
      ))}
    </div>
  );
}
