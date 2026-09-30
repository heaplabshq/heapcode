import { useEffect, useState, type ReactNode } from 'react';
import { Empty } from '@heapcode/web-ui/components/Empty';
import { Preview } from '@heapcode/web-ui/components/Preview';
import type {
  ChatArtifactMeta,
  ChatArtifactResult,
  ChatIndexStatus,
  ChatReadFileResult,
} from '@heapcode/chat-host/protocol';
import type { Grounding } from '@heapcode/chat-host';

export type ChatPanelTab = 'made' | 'sources' | 'file' | 'index';

export interface ChatPanelProps {
  tab: ChatPanelTab;
  onClose(): void;
  /** Dragged width in px; undefined falls back to the stylesheet default. */
  width?: number;
  loadFile(path: string): Promise<ChatReadFileResult>;
  /** A path clicked in a tool chip or a source row; shown by the `file` view. */
  openPath?: string;
  onOpenPath(path: string): void;
  artifacts: ChatArtifactMeta[];
  selectedArtifact?: string;
  onSelectArtifact(id: string): void;
  loadArtifact(id: string, version?: number): Promise<ChatArtifactResult>;
  onSaveArtifact(id: string, path: string, version?: number): void;
  grounding?: Grounding;
  indexStatus?: ChatIndexStatus;
  onReindex(): void;
}

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

/**
 * Every view, with what the toolbar shows for it.
 *
 * No folder browser. This product reads a folder rather than working in it,
 * so browsing its tree was a second file manager with nothing to do in it —
 * what a person actually opens is a file the answer pointed at, and that
 * arrives by clicking it (`file`). Index is status, not content, so it sits
 * behind ⋮.
 */
export const CHAT_VIEWS: Record<ChatPanelTab, { label: string; icon: JSX.Element }> = {
  made: {
    label: 'Made',
    icon: (
      <svg {...S}>
        <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
        <path d="M14 3v5h5" />
        <path d="M9 13h6M9 17h4" />
      </svg>
    ),
  },
  sources: {
    label: 'Sources',
    icon: (
      <svg {...S}>
        <path d="M4 5.5A1.5 1.5 0 0 1 5.5 4H10a2 2 0 0 1 2 2v14a1.5 1.5 0 0 0-1.5-1.5h-5A1.5 1.5 0 0 1 4 17z" />
        <path d="M20 5.5A1.5 1.5 0 0 0 18.5 4H14a2 2 0 0 0-2 2v14a1.5 1.5 0 0 1 1.5-1.5h5a1.5 1.5 0 0 0 1.5-1.5z" />
      </svg>
    ),
  },
  file: {
    label: 'File',
    icon: (
      <svg {...S}>
        <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
        <path d="M14 3v5h5" />
      </svg>
    ),
  },
  index: {
    label: 'Index',
    icon: (
      <svg {...S}>
        <path d="m12 3 9 4.5-9 4.5-9-4.5z" />
        <path d="m3 12.5 9 4.5 9-4.5" />
        <path d="m3 17 9 4.5 9-4.5" />
      </svg>
    ),
  },
};

/**
 * The right-hand panel, with Heap Code's classes but views of its own.
 *
 * Not `web-ui`'s `Panel`: that one is built around changes, diffs,
 * checkpoints, a terminal and a repo map, and this product has none of those
 * by design — nothing here edits the folder, so there is nothing to diff and
 * nothing to revert. What it has instead is what the assistant made, and
 * where the last answer came from.
 */
export function ChatPanel(props: ChatPanelProps): JSX.Element {
  const view = CHAT_VIEWS[props.tab];
  return (
    <aside className="panel" aria-label={view.label} style={props.width ? { width: props.width } : undefined}>
      <header className="panel-head">
        <span className="panel-head-icon">{view.icon}</span>
        <h2 className="panel-title">{view.label}</h2>
        <button className="icon-btn panel-close" onClick={props.onClose} aria-label="Close panel">
          ✕
        </button>
      </header>

      <div className="panel-body">
        {props.tab === 'file' && <FileView loadFile={props.loadFile} path={props.openPath} />}
        {props.tab === 'made' && (
          <Preview
            artifacts={props.artifacts}
            selectedId={props.selectedArtifact}
            onSelect={props.onSelectArtifact}
            loadArtifact={props.loadArtifact}
            onSave={props.onSaveArtifact}
          />
        )}
        {props.tab === 'sources' && <Sources grounding={props.grounding} onOpenPath={props.onOpenPath} />}
        {props.tab === 'index' && <IndexState status={props.indexStatus} onReindex={props.onReindex} />}
      </div>
    </aside>
  );
}

/**
 * Reading one file the conversation pointed at.
 *
 * A PDF or a .docx opens as the text the assistant sees, not as its bytes —
 * the host converts it on the way out. A file with nothing readable says so
 * rather than showing an empty pane, because "no text layer" and "empty file"
 * are different facts about a scan.
 */
function FileView({ loadFile, path }: { loadFile: ChatPanelProps['loadFile']; path?: string }): JSX.Element {
  const [file, setFile] = useState<ChatReadFileResult>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    setFile(undefined);
    setError(undefined);
    if (!path) return;
    let live = true;
    void loadFile(path)
      .then((f) => live && setFile(f))
      .catch((e: Error) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [path, loadFile]);

  if (!path) return <Empty>Click a file in an answer or in Sources to read it here.</Empty>;
  return (
    <div className="file-view">
      <div className="file-view-head">
        <code>{path}</code>
      </div>
      {error ? (
        <p className="panel-error">{error}</p>
      ) : !file ? (
        <p className="hint">Loading…</p>
      ) : file.note ? (
        <p className="hint">{file.note}</p>
      ) : (
        <pre className="file-body">{file.content}</pre>
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
function Sources({ grounding, onOpenPath }: { grounding?: Grounding; onOpenPath(path: string): void }): JSX.Element {
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
            <button className="file-row" onClick={() => onOpenPath(s)} title={`Read ${s}`}>
              <span className="tree-icon">·</span>
              <span className="file-path">{s}</span>
            </button>
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
