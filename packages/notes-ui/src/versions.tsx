import { useEffect, useState } from 'react';
import type { NoteVersion } from '@heapcode/notes-host/protocol';
import { lineDiff } from './diff.js';
import { ago, fullDate } from './time.js';

/** Who replaced a version, in words — the row's second line. */
const BY: Record<string, string> = {
  ask: 'Before a change by Ask',
  mcp: 'Before a change by an AI app',
  terminal: 'Before a change from the terminal',
  restore: 'Before a restore',
};

/**
 * A note's earlier versions: pick one, see what restoring it would change,
 * put it back. Restoring keeps what's there now as a version, so it can be
 * undone from here too.
 */
export function VersionsDialog({
  title,
  current,
  list,
  read,
  onRestore,
  onClose,
}: {
  title: string;
  /** The note's text now, to compare against. */
  current: string;
  list(): Promise<NoteVersion[]>;
  read(version: string): Promise<string>;
  onRestore(version: string): Promise<void>;
  onClose(): void;
}): JSX.Element {
  const [versions, setVersions] = useState<NoteVersion[]>();
  const [picked, setPicked] = useState<string>();
  const [text, setText] = useState<string>();
  const [view, setView] = useState<'changes' | 'text'>('changes');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    list().then(
      (v) => {
        setVersions(v);
        setPicked(v[0]?.version);
      },
      (e: Error) => setError(e.message),
    );
  }, [list]);

  useEffect(() => {
    if (!picked) return;
    setText(undefined);
    read(picked).then(setText, (e: Error) => setError(e.message));
  }, [picked, read]);

  const restore = async () => {
    if (!picked) return;
    setBusy(true);
    try {
      await onRestore(picked);
      onClose();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  const diff = text === undefined ? [] : lineDiff(current, text);
  const same = text !== undefined && text === current;

  return (
    <div className="modal-scrim" onMouseDown={onClose}>
      <div
        className="modal modal-wide versions"
        role="dialog"
        aria-modal="true"
        aria-label={`Version history of ${title || 'Untitled'}`}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.key === 'Escape' && onClose()}
      >
        <nav className="versions-list" aria-label="Versions">
          <div className="versions-list-head">Version history</div>
          {versions === undefined && !error && <p className="notes-dim">Looking…</p>}
          {versions?.length === 0 && (
            <p className="notes-dim versions-none">
              No earlier versions yet. One is kept every few minutes while you write, and before Ask
              or another app changes the note.
            </p>
          )}
          {versions?.map((v) => (
            <button
              key={v.version}
              className={v.version === picked ? 'versions-row versions-row-on' : 'versions-row'}
              onClick={() => setPicked(v.version)}
              title={fullDate(v.at)}
            >
              <span className="versions-when">{ago(v.at)}</span>
              <span className="versions-by">{(v.by && BY[v.by]) ?? fullDate(v.at)}</span>
            </button>
          ))}
        </nav>
        <section className="versions-main">
          <div className="modal-head">
            <h2>{title || 'Untitled'}</h2>
            <span className="versions-tabs" role="tablist">
              <button
                role="tab"
                aria-selected={view === 'changes'}
                className={view === 'changes' ? 'btn btn-sm notes-on' : 'btn btn-quiet btn-sm'}
                onClick={() => setView('changes')}
              >
                Changes
              </button>
              <button
                role="tab"
                aria-selected={view === 'text'}
                className={view === 'text' ? 'btn btn-sm notes-on' : 'btn btn-quiet btn-sm'}
                onClick={() => setView('text')}
              >
                This version
              </button>
            </span>
            <button className="btn btn-quiet btn-sm" onClick={onClose} aria-label="Close">
              ✕
            </button>
          </div>
          <div className="modal-body versions-body">
            {error && (
              <div className="notes-banner notes-banner-bad" role="alert">
                <span>{error}</span>
              </div>
            )}
            {picked && text === undefined && !error && <p className="notes-dim">Loading…</p>}
            {text !== undefined && view === 'changes' && (
              <>
                <p className="notes-dim">
                  {same
                    ? 'The same as the note now.'
                    : 'What restoring this version would change in the note as it is now.'}
                </p>
                {!same && (
                  <pre className="ask-diff versions-diff">
                    {diff.map((l, i) =>
                      l.kind === 'fold' ? (
                        <div key={i} className="diff-fold">
                          ⋯ {l.count} unchanged line{l.count === 1 ? '' : 's'}
                        </div>
                      ) : (
                        <div key={i} className={`diff-${l.kind}`}>
                          <span className="diff-mark">
                            {l.kind === 'add' ? '+' : l.kind === 'del' ? '−' : ' '}
                          </span>
                          {l.text || ' '}
                        </div>
                      ),
                    )}
                  </pre>
                )}
              </>
            )}
            {text !== undefined && view === 'text' && <pre className="versions-text">{text}</pre>}
          </div>
          <div className="versions-foot">
            <button className="btn btn-quiet btn-sm" onClick={onClose}>
              Cancel
            </button>
            <button
              className="btn btn-primary btn-sm"
              disabled={!picked || text === undefined || same || busy}
              onClick={() => void restore()}
            >
              Restore this version
            </button>
          </div>
        </section>
      </div>
    </div>
  );
}
