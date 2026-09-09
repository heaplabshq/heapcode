import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Empty } from '@heapcode/web-ui/components/Empty';
import { Preview } from '@heapcode/web-ui/components/Preview';
import type {
  ChatArtifactMeta,
  ChatArtifactResult,
  ChatFileTreeResult,
  ChatIndexStatus,
  ChatReadFileResult,
  ChatTreeEntry,
} from '@heapcode/chat-host/protocol';
import type { Grounding } from '@heapcode/chat-host';

export type ChatPanelTab = 'files' | 'made' | 'sources' | 'index';

export interface ChatPanelProps {
  tab: ChatPanelTab;
  onTab(tab: ChatPanelTab): void;
  onClose(): void;
  loadTree(path: string): Promise<ChatFileTreeResult>;
  loadFile(path: string): Promise<ChatReadFileResult>;
  /** A path clicked in a tool chip or a source row opens here. */
  openPath?: string;
  artifacts: ChatArtifactMeta[];
  selectedArtifact?: string;
  onSelectArtifact(id: string): void;
  loadArtifact(id: string, version?: number): Promise<ChatArtifactResult>;
  onSaveArtifact(id: string, path: string, version?: number): void;
  grounding?: Grounding;
  indexStatus?: ChatIndexStatus;
  onReindex(): void;
}

/**
 * The right-hand panel, in the shape Heap Code's has and with its classes —
 * but four tabs of its own, because this product has different things to
 * show.
 *
 * Not `web-ui`'s `Panel`: that one is built around changes, diffs,
 * checkpoints, a terminal and a repo map, and this product has none of those
 * by design — nothing here edits the folder, so there is nothing to diff and
 * nothing to revert. What it has instead is the folder itself, what the
 * assistant made from it, and where the last answer came from.
 */
export function ChatPanel(props: ChatPanelProps): JSX.Element {
  const tabs: Array<{ id: ChatPanelTab; label: string; count?: number }> = [
    { id: 'files', label: 'Files' },
    { id: 'made', label: 'Made', count: props.artifacts.length || undefined },
    { id: 'sources', label: 'Sources', count: props.grounding?.sources.length || undefined },
    { id: 'index', label: 'Index' },
  ];

  return (
    <aside className="panel" aria-label="Folder">
      <div className="panel-tabs" role="tablist">
        {tabs.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={props.tab === t.id}
            className={props.tab === t.id ? 'panel-tab panel-tab-active' : 'panel-tab'}
            onClick={() => props.onTab(t.id)}
          >
            {t.label}
            {t.count ? <span className="panel-tab-count">{t.count}</span> : null}
          </button>
        ))}
        <button className="icon-btn panel-close" onClick={props.onClose} aria-label="Close panel">
          ×
        </button>
      </div>

      <div className="panel-body">
        {props.tab === 'files' && (
          <FileTree loadTree={props.loadTree} loadFile={props.loadFile} openPath={props.openPath} />
        )}
        {props.tab === 'made' && (
          <Preview
            artifacts={props.artifacts}
            selectedId={props.selectedArtifact}
            onSelect={props.onSelectArtifact}
            loadArtifact={props.loadArtifact}
            onSave={props.onSaveArtifact}
          />
        )}
        {props.tab === 'sources' && <Sources grounding={props.grounding} />}
        {props.tab === 'index' && <IndexState status={props.indexStatus} onReindex={props.onReindex} />}
      </div>
    </aside>
  );
}

/**
 * Browsing the folder, and reading a file in it.
 *
 * A PDF or a .docx opens as the text the assistant sees, not as its bytes —
 * the host converts it on the way out. A file with nothing readable says so
 * rather than showing an empty pane, because "no text layer" and "empty file"
 * are different facts about a scan.
 */
function FileTree({
  loadTree,
  loadFile,
  openPath,
}: Pick<ChatPanelProps, 'loadTree' | 'loadFile' | 'openPath'>): JSX.Element {
  const [dir, setDir] = useState('');
  const [entries, setEntries] = useState<ChatTreeEntry[]>();
  const [file, setFile] = useState<ChatReadFileResult>();
  const [error, setError] = useState<string>();

  const load = useCallback(
    (path: string) => {
      setDir(path);
      setFile(undefined);
      // Undefined until a listing lands, so "loading" and "genuinely empty"
      // stay different states.
      setEntries(undefined);
      setError(undefined);
      void loadTree(path)
        .then((r) => setEntries(r.entries))
        .catch((e: Error) => setError(e.message));
    },
    [loadTree],
  );

  const open = useCallback(
    (path: string) => {
      setError(undefined);
      void loadFile(path)
        .then(setFile)
        .catch((e: Error) => setError(e.message));
    },
    [loadFile],
  );

  useEffect(() => load(''), [load]);
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
      {error && <p className="panel-error">{error}</p>}
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
              <Empty>Nothing here.</Empty>
            </li>
          )}
        </ul>
      )}
    </div>
  );
}

/**
 * Where the last answer came from — the badge, opened out.
 *
 * The badge under the message is a summary; this is the evidence. Each traced
 * number sits next to the line it was found in, in the file it was found in,
 * which is the claim the whole feature exists to make precisely.
 */
function Sources({ grounding }: { grounding?: Grounding }): JSX.Element {
  if (!grounding) {
    return <Empty>No answer yet. Ask something, and what it was based on shows up here.</Empty>;
  }
  const { sources, provenance, verdict, issues } = grounding;
  return (
    <div className="sources">
      {verdict && verdict !== 'supported' && (
        <p className={verdict === 'unsupported' ? 'panel-error' : 'hint'}>
          {verdict === 'unsupported'
            ? 'The check could not find support for the main claim in these files.'
            : 'Partly supported — some claims check out and some do not.'}
        </p>
      )}

      <div className="panel-section">Files used</div>
      <ul className="file-list">
        {sources.map((s) => (
          <li key={s}>
            <span className="file-row">
              <span className="tree-icon">·</span>
              <span className="file-path">{s}</span>
            </span>
          </li>
        ))}
        {sources.length === 0 && (
          <li>
            <Empty>Answered from general knowledge, not from these files.</Empty>
          </li>
        )}
      </ul>

      {provenance.length > 0 && (
        <>
          <div className="panel-section">Where each figure came from</div>
          <ul className="file-list">
            {provenance.map((p) => (
              <li key={`${p.value}-${p.source}`} className="prov-row">
                <code className="prov-value">{p.value}</code>
                <span className="prov-where">
                  <span className="file-path">{p.source}</span>
                  <span className="prov-snippet">{p.snippet}</span>
                </span>
              </li>
            ))}
          </ul>
        </>
      )}

      {issues?.length ? (
        <>
          <div className="panel-section">Not supported</div>
          <ul className="prov-issues">
            {issues.map((i) => (
              <li key={i}>{i}</li>
            ))}
          </ul>
        </>
      ) : null}
    </div>
  );
}

function IndexState({ status, onReindex }: { status?: ChatIndexStatus; onReindex(): void }): JSX.Element {
  const line = ((): ReactNode => {
    if (!status) return 'Not started.';
    if (status.state === 'indexing') {
      return status.progress ? `Indexing ${status.progress.embedded}/${status.progress.total}…` : 'Indexing…';
    }
    if (status.state === 'unconfigured') return 'No embeddings model configured — text search only.';
    return `${status.files} files · ${status.chunks} chunks searchable.`;
  })();

  return (
    <div className="index-view">
      <p className="hint">{line}</p>
      {status?.missingParsers?.length ? (
        <p className="panel-error">Not reading {status.missingParsers.join(', ')} — parser not installed.</p>
      ) : null}
      {status?.message ? <p className="hint">{status.message}</p> : null}
      <button className="btn" onClick={onReindex} disabled={status?.state === 'indexing'}>
        Rebuild index
      </button>
    </div>
  );
}
