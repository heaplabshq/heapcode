import { useEffect, useRef, useState } from 'react';
import type { NotesImportKind, UiBrowseFoldersResult } from '@heapcode/notes-host/protocol';

/**
 * Bringing notes in: pick where from, pick the folder or .zip, import, then
 * see where they went. One screen at a time — the choice, the picker, the
 * result — so a long file name or a long list never pushes the rest away.
 */
export interface ImportOutcome {
  notes: number;
  attachments: number;
  skipped: { source: string; reason: string }[];
  /** Top-level tags the notes were filed under (Notion's nesting). */
  tags?: string[];
}

type Kind = NotesImportKind | 'bear-export';

const KINDS: {
  kind: Kind;
  label: string;
  short: string;
  hint: string;
  zip?: boolean;
  start?: string;
}[] = [
  {
    kind: 'bear',
    label: 'Bear',
    short: 'From the app',
    hint: 'Straight from the Bear app on this Mac. Pins, archive, trash and images come too.',
  },
  {
    kind: 'bear-export',
    label: 'Bear export',
    short: 'Exported folder',
    hint: 'A folder exported from Bear (File → Export Notes), as Markdown or TextBundle.',
  },
  {
    kind: 'notion',
    label: 'Notion',
    short: '.zip or folder',
    hint: 'Notion’s export as Markdown & CSV (Settings → Export, or a page’s ••• → Export). Subpages nest under tags, links become [[links]], databases become tables.',
    zip: true,
    start: '~/Downloads',
  },
  {
    kind: 'obsidian',
    label: 'Obsidian',
    short: 'A vault',
    hint: 'An Obsidian vault: notes, folders and attachments. Its .obsidian settings stay behind.',
  },
  {
    kind: 'markdown',
    label: 'Markdown',
    short: 'Any folder',
    hint: 'Any folder of .md files, with the files they link to.',
  },
];

/** `abcdef…uvwxyz.zip`: long export names keep both ends, which tell them apart. */
function middle(name: string, max = 46): string {
  if (name.length <= max) return name;
  const keep = Math.floor((max - 1) / 2);
  return `${name.slice(0, keep)}…${name.slice(-keep)}`;
}

export function ImportDialog({
  browse,
  onImport,
  onShowTag,
  onClose,
}: {
  /** `zips`: list .zip files as well as folders. */
  browse(path?: string, zips?: boolean): Promise<UiBrowseFoldersResult>;
  onImport(kind: NotesImportKind, path?: string): Promise<ImportOutcome>;
  /** Open a tag the import filed notes under. */
  onShowTag(tag: string): void;
  onClose(): void;
}): JSX.Element {
  const [kind, setKind] = useState<Kind>('notion');
  const spec = KINDS.find((k) => k.kind === kind)!;
  const needsPath = kind !== 'bear';
  const [listing, setListing] = useState<UiBrowseFoldersResult>();
  /** A .zip chosen in the list; otherwise the folder being shown is the source. */
  const [zip, setZip] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [done, setDone] = useState<ImportOutcome>();

  const browseRef = useRef(browse);
  browseRef.current = browse;
  const open = (path?: string) => {
    setZip(undefined);
    setError(undefined);
    browseRef.current(path, spec.zip).then(setListing, () =>
      // A start folder that isn't there (no ~/Downloads): home instead.
      browseRef.current(undefined, spec.zip).then(setListing, (e: Error) => setError(e.message)),
    );
  };
  // A new kind starts where its files usually are, and lists .zip files if it takes them.
  useEffect(() => {
    if (needsPath) open(spec.start ?? listing?.path);
  }, [kind]);

  const source = zip ?? listing?.path;
  const go = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const real: NotesImportKind = kind === 'bear-export' ? 'bear' : kind;
      setDone(await onImport(real, needsPath ? source : undefined));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-scrim" onMouseDown={() => !busy && onClose()}>
      <div
        className="modal imp"
        role="dialog"
        aria-modal="true"
        aria-label="Import notes"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.key === 'Escape' && !busy && onClose()}
      >
        <div className="modal-head">
          <h2>Import notes</h2>
          <button
            className="btn btn-quiet btn-sm"
            onClick={onClose}
            aria-label="Close"
            disabled={busy}
          >
            ✕
          </button>
        </div>

        {done ? (
          <div className="imp-done">
            <div className="imp-done-mark" aria-hidden="true">
              ✓
            </div>
            <p className="imp-done-title">
              Imported {done.notes} note{done.notes === 1 ? '' : 's'}
              {done.attachments
                ? ` and ${done.attachments} file${done.attachments === 1 ? '' : 's'}`
                : ''}
              .
            </p>
            {done.tags?.length ? (
              <p className="notes-dim">
                Nested as in {spec.label}, under {done.tags.length === 1 ? 'the tag' : 'the tags'}{' '}
                {done.tags.map((t, i) => (
                  <span key={t}>
                    {i > 0 && ', '}
                    <strong>#{t}</strong>
                  </span>
                ))}{' '}
                in the sidebar.
              </p>
            ) : null}
            {done.skipped.length > 0 && (
              <details className="imp-skipped">
                <summary>
                  {done.skipped.length} left out
                  {done.skipped.every((s) => s.reason === 'already imported')
                    ? ' — already imported'
                    : ''}
                </summary>
                <ul>
                  {done.skipped.map((s, i) => (
                    <li key={i}>
                      <span>{s.source}</span> <span className="notes-dim">{s.reason}</span>
                    </li>
                  ))}
                </ul>
              </details>
            )}
            <div className="imp-actions">
              <button className="btn btn-quiet" onClick={() => setDone(undefined)}>
                Import more
              </button>
              {done.tags?.[0] ? (
                <button
                  className="btn btn-primary"
                  onClick={() => {
                    onShowTag(done.tags![0]!);
                    onClose();
                  }}
                >
                  Show them
                </button>
              ) : (
                <button className="btn btn-primary" onClick={onClose}>
                  Done
                </button>
              )}
            </div>
          </div>
        ) : (
          <div className="imp-body">
            <div className="imp-kinds" role="radiogroup" aria-label="Import from">
              {KINDS.map((k) => (
                <button
                  key={k.kind}
                  role="radio"
                  aria-checked={kind === k.kind}
                  className={kind === k.kind ? 'imp-kind imp-kind-on' : 'imp-kind'}
                  onClick={() => setKind(k.kind)}
                  disabled={busy}
                >
                  <span className="imp-kind-label">{k.label}</span>
                  <span className="imp-kind-short">{k.short}</span>
                </button>
              ))}
            </div>
            <p className="imp-hint">{spec.hint}</p>

            {needsPath && (
              <div className="imp-picker">
                <div className="imp-where">
                  <button
                    className="btn btn-quiet btn-sm"
                    disabled={!listing?.parent || busy}
                    onClick={() => open(listing?.parent)}
                    aria-label="Up one folder"
                    title="Up one folder"
                  >
                    ←
                  </button>
                  <span className="imp-path" title={listing?.path}>
                    {/* Trimmed from the left, keeping the end in view; bdi keeps the slashes where they belong. */}
                    <bdi>{listing?.path ?? 'Loading…'}</bdi>
                  </span>
                </div>
                <ul className="imp-list">
                  {listing?.entries.map((e) => {
                    const isZip = /\.zip$/i.test(e.name);
                    const on = zip === e.path;
                    return (
                      <li key={e.path}>
                        <button
                          className={on ? 'imp-entry imp-entry-on' : 'imp-entry'}
                          title={e.name}
                          aria-pressed={isZip ? on : undefined}
                          disabled={busy}
                          onClick={() => (isZip ? setZip(on ? undefined : e.path) : open(e.path))}
                          onDoubleClick={() => isZip && void go()}
                        >
                          <span
                            className={isZip ? 'imp-icon imp-icon-zip' : 'imp-icon'}
                            aria-hidden="true"
                          >
                            {isZip ? 'ZIP' : ''}
                          </span>
                          <span className="imp-entry-name">{e.name}</span>
                          {!isZip && (
                            <span className="imp-chevron" aria-hidden="true">
                              ›
                            </span>
                          )}
                        </button>
                      </li>
                    );
                  })}
                  {listing && listing.entries.length === 0 && (
                    <li className="imp-empty">
                      {spec.zip ? 'No folders or .zip files here.' : 'No folders here.'}
                    </li>
                  )}
                </ul>
              </div>
            )}

            {error && (
              <p className="imp-error" role="alert">
                {error}
              </p>
            )}

            <div className="imp-foot">
              <span className="imp-source" title={source}>
                {!needsPath ? (
                  'From the Bear app on this Mac.'
                ) : zip ? (
                  <>
                    From <strong>{middle(zip.split(/[\\/]/).pop()!)}</strong>
                  </>
                ) : (
                  <>
                    From this folder:{' '}
                    <strong>
                      {middle(listing?.path.split(/[\\/]/).pop() || listing?.path || '…')}
                    </strong>
                  </>
                )}
              </span>
              <span className="imp-actions">
                <button className="btn btn-quiet" onClick={onClose} disabled={busy}>
                  Cancel
                </button>
                <button
                  className="btn btn-primary"
                  disabled={busy || (needsPath && !source)}
                  onClick={() => void go()}
                >
                  {busy ? 'Importing…' : 'Import'}
                </button>
              </span>
            </div>
            <p className="imp-note">Your originals are copied, never changed.</p>
          </div>
        )}
      </div>
    </div>
  );
}
