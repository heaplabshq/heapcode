import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  NoteListItem,
  NotesImportKind,
  UiBrowseFoldersResult,
} from '@heapcode/notes-host/protocol';
import { fuzzyFilter } from './fuzzy.js';

/** "3:41 PM" today, "Yesterday", "Mon", then a date — how a list says when. */
export function when(iso: string, now = new Date()): string {
  const d = new Date(iso);
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((day(now) - day(d)) / 86_400_000);
  if (days === 0) return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  if (days === 1) return 'Yesterday';
  if (days < 7) return d.toLocaleDateString(undefined, { weekday: 'short' });
  return d.toLocaleDateString(
    undefined,
    d.getFullYear() === now.getFullYear()
      ? { month: 'short', day: 'numeric' }
      : { dateStyle: 'medium' },
  );
}

export function NoteList({
  notes,
  related = [],
  selected,
  onSelect,
  empty,
}: {
  notes: NoteListItem[];
  /** Close in meaning to the search, not among its keyword hits (HEAPNOTES_PHASE2_PLAN §2B). */
  related?: NoteListItem[];
  selected?: string;
  onSelect(id: string): void;
  empty: string;
}): JSX.Element {
  const box = useRef<HTMLUListElement>(null);
  useEffect(() => {
    box.current?.querySelector('.note-row-on')?.scrollIntoView({ block: 'nearest' });
  }, [selected]);
  if (notes.length === 0 && related.length === 0) return <p className="notes-empty">{empty}</p>;
  const row = (n: NoteListItem) => (
    <li key={n.id}>
      <button
        className={n.id === selected ? 'note-row note-row-on' : 'note-row'}
        role="option"
        aria-selected={n.id === selected}
        onClick={() => onSelect(n.id)}
      >
        <span className="note-row-top">
          <span className="note-row-title">{n.title || 'Untitled'}</span>
          {n.pinned && <span className="note-pin" title="Pinned" aria-label="Pinned" />}
        </span>
        {n.snippet ? (
          <span className="note-row-sub">{renderSnippet(n.snippet)}</span>
        ) : (
          n.subtitle && <span className="note-row-sub">{n.subtitle}</span>
        )}
        <span className="note-row-meta">
          <span>{when(n.modified)}</span>
          {n.todos > 0 && <span className="note-meta-chip">{n.todos} to do</span>}
          {(n.hasImages || n.hasFiles) && (
            <span className="note-meta-chip">{n.hasImages ? 'image' : 'file'}</span>
          )}
        </span>
      </button>
    </li>
  );
  return (
    <ul className="note-rows" ref={box} role="listbox" aria-label="Notes">
      {notes.map(row)}
      {related.length > 0 && (
        <li className="note-group" role="presentation">
          {notes.length === 0 ? 'No exact matches — close in meaning' : 'Related by meaning'}
        </li>
      )}
      {related.map(row)}
    </ul>
  );
}

/** FTS snippets mark matches with `**`; show them as <mark>. */
function renderSnippet(s: string): JSX.Element[] {
  return s
    .replace(/\s+/g, ' ')
    .split('**')
    .map((part, i) => (i % 2 === 1 ? <mark key={i}>{part}</mark> : <span key={i}>{part}</span>));
}

export interface Heading {
  level: number;
  text: string;
  offset: number;
}

export function InfoPanel({
  headings,
  backlinks,
  text,
  onJump,
  onOpen,
  onClose,
}: {
  headings: Heading[];
  backlinks: { id: string; title: string; subtitle: string }[];
  text: string;
  onJump(offset: number): void;
  onOpen(id: string): void;
  onClose(): void;
}): JSX.Element {
  const words = text.match(/[\p{L}\p{N}][\p{L}\p{N}'’_-]*/gu)?.length ?? 0;
  const top = Math.min(...headings.map((h) => h.level), 6);
  return (
    <aside className="notes-info" aria-label="Note info">
      <div className="notes-info-head">
        <span>Info</span>
        <button className="btn btn-quiet btn-sm" onClick={onClose} aria-label="Close info">
          ✕
        </button>
      </div>
      <section>
        <h3>Contents</h3>
        {headings.length === 0 ? (
          <p className="notes-dim">No headings.</p>
        ) : (
          <ul className="toc">
            {headings.map((h, i) => (
              <li key={i} style={{ paddingLeft: `${(h.level - top) * 12}px` }}>
                <button onClick={() => onJump(h.offset)}>{h.text || 'Untitled'}</button>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section>
        <h3>Backlinks</h3>
        {backlinks.length === 0 ? (
          <p className="notes-dim">No notes link here.</p>
        ) : (
          <ul className="backlinks">
            {backlinks.map((b) => (
              <li key={b.id}>
                <button onClick={() => onOpen(b.id)}>
                  <span className="backlink-title">{b.title}</span>
                  {b.subtitle && <span className="backlink-sub">{b.subtitle}</span>}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section>
        <h3>Statistics</h3>
        <dl className="stats">
          <dt>Words</dt>
          <dd>{words.toLocaleString()}</dd>
          <dt>Characters</dt>
          <dd>{text.length.toLocaleString()}</dd>
          <dt>Reading time</dt>
          <dd>{Math.max(1, Math.round(words / 230))} min</dd>
        </dl>
      </section>
    </aside>
  );
}

/** ⌘O over note titles, ⌥⌘O over tags: type, arrow, Enter. */
export function QuickOpen<T>({
  items,
  label,
  placeholder,
  text,
  detail,
  onPick,
  onCreate,
  onClose,
}: {
  items: T[];
  label: string;
  placeholder: string;
  text(item: T): string;
  detail?(item: T): string;
  onPick(item: T): void;
  /** Offered when nothing matches exactly: make a note with that title. */
  onCreate?(title: string): void;
  onClose(): void;
}): JSX.Element {
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const results = useMemo(() => fuzzyFilter(query, items, text), [query, items, text]);
  const create =
    onCreate &&
    query.trim() &&
    !items.some((i) => text(i).toLowerCase() === query.trim().toLowerCase());
  const total = results.length + (create ? 1 : 0);
  useEffect(() => setIndex(0), [query]);

  const choose = (i: number) => {
    if (i < results.length) onPick(results[i]!);
    else if (create) onCreate!(query.trim());
  };

  return (
    <div className="modal-scrim" onMouseDown={onClose}>
      <div
        className="palette"
        role="dialog"
        aria-modal="true"
        aria-label={label}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <input
          autoFocus
          className="palette-input"
          value={query}
          placeholder={placeholder}
          aria-label={label}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') onClose();
            else if (e.key === 'ArrowDown') {
              e.preventDefault();
              setIndex((i) => Math.min(i + 1, total - 1));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setIndex((i) => Math.max(i - 1, 0));
            } else if (e.key === 'Enter') {
              e.preventDefault();
              choose(index);
            }
          }}
        />
        <ul className="palette-list" role="listbox">
          {total === 0 && <li className="palette-empty">Nothing matches.</li>}
          {results.map((r, i) => (
            <li key={i}>
              <button
                className={i === index ? 'palette-item palette-item-active' : 'palette-item'}
                onMouseEnter={() => setIndex(i)}
                onClick={() => choose(i)}
              >
                <span className="quick-name">{text(r) || 'Untitled'}</span>
                {detail && <span className="palette-desc">{detail(r)}</span>}
              </button>
            </li>
          ))}
          {create && (
            <li>
              <button
                className={
                  index === results.length ? 'palette-item palette-item-active' : 'palette-item'
                }
                onMouseEnter={() => setIndex(results.length)}
                onClick={() => choose(results.length)}
              >
                <span className="quick-name">New note “{query.trim()}”</span>
              </button>
            </li>
          )}
        </ul>
      </div>
    </div>
  );
}

const KINDS: { kind: NotesImportKind | 'bear-export'; label: string; hint: string }[] = [
  {
    kind: 'bear',
    label: 'Bear',
    hint: 'Straight from the Bear app on this Mac, through its bearcli. Pins, archive, trash and images come too.',
  },
  {
    kind: 'bear-export',
    label: 'Bear export',
    hint: 'A folder you exported from Bear (File → Export Notes), as Markdown or TextBundle.',
  },
  {
    kind: 'obsidian',
    label: 'Obsidian vault',
    hint: 'Notes, folders and attachments. .obsidian settings stay behind.',
  },
  {
    kind: 'markdown',
    label: 'Markdown folder',
    hint: 'Any folder of .md files, with the files they link to.',
  },
];

export function ImportDialog({
  browse,
  onImport,
  onClose,
}: {
  browse(path?: string): Promise<UiBrowseFoldersResult>;
  onImport(kind: NotesImportKind, path?: string): Promise<string>;
  onClose(): void;
}): JSX.Element {
  const [kind, setKind] = useState<(typeof KINDS)[number]['kind']>('bear');
  const [listing, setListing] = useState<UiBrowseFoldersResult>();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string>();
  const [error, setError] = useState<string>();
  const needsFolder = kind !== 'bear';

  useEffect(() => {
    if (needsFolder && !listing) browse().then(setListing, (e: Error) => setError(e.message));
  }, [needsFolder, listing, browse]);

  const go = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const real: NotesImportKind = kind === 'bear-export' ? 'bear' : kind;
      setResult(await onImport(real, needsFolder ? listing?.path : undefined));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-scrim" onMouseDown={onClose}>
      <div
        className="modal modal-sm"
        role="dialog"
        aria-modal="true"
        aria-label="Import notes"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.key === 'Escape' && onClose()}
      >
        <div className="modal-head">
          <h2>Import notes</h2>
          <button className="btn btn-quiet btn-sm" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        <div className="modal-body import-body">
          <div className="import-kinds" role="radiogroup" aria-label="From">
            {KINDS.map((k) => (
              <label
                key={k.kind}
                className={kind === k.kind ? 'import-kind import-kind-on' : 'import-kind'}
              >
                <input
                  type="radio"
                  name="kind"
                  checked={kind === k.kind}
                  onChange={() => setKind(k.kind)}
                />
                <span className="import-kind-label">{k.label}</span>
                <span className="import-kind-hint">{k.hint}</span>
              </label>
            ))}
          </div>
          {needsFolder && listing && (
            <div className="folder-browser">
              <div className="folder-path" title={listing.path}>
                {listing.parent && (
                  <button
                    className="btn btn-quiet btn-sm"
                    onClick={() =>
                      browse(listing.parent).then(setListing, (e: Error) => setError(e.message))
                    }
                  >
                    ↑ Up
                  </button>
                )}
                <span>{listing.path}</span>
              </div>
              <ul className="folder-list">
                {listing.entries.map((e) => (
                  <li key={e.path}>
                    <button
                      onClick={() =>
                        browse(e.path).then(setListing, (err: Error) => setError(err.message))
                      }
                    >
                      {e.name}
                    </button>
                  </li>
                ))}
                {listing.entries.length === 0 && <li className="notes-dim">No folders in here.</li>}
              </ul>
            </div>
          )}
          {error && <p className="notes-error">{error}</p>}
          {result && <p className="notes-ok">{result}</p>}
          <div className="import-actions">
            <button className="btn btn-quiet" onClick={onClose}>
              {result ? 'Done' : 'Cancel'}
            </button>
            <button
              className="btn btn-primary"
              disabled={busy || (needsFolder && !listing)}
              onClick={() => void go()}
            >
              {busy ? 'Importing…' : needsFolder ? 'Import this folder' : 'Import from Bear'}
            </button>
          </div>
          <p className="notes-dim">Your originals are copied, never changed.</p>
        </div>
      </div>
    </div>
  );
}

export function SettingsDialog({
  fontSize,
  vault,
  picker,
  onFontSize,
  onImport,
  onClose,
}: {
  fontSize: number;
  vault: string;
  picker: JSX.Element;
  onFontSize(size: number): void;
  onImport(): void;
  onClose(): void;
}): JSX.Element {
  return (
    <div className="modal-scrim" onMouseDown={onClose}>
      <div
        className="modal modal-sm"
        role="dialog"
        aria-modal="true"
        aria-label="Heapnotes settings"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.key === 'Escape' && onClose()}
      >
        <div className="modal-head">
          <h2>Heapnotes</h2>
          <button className="btn btn-quiet btn-sm" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        <div className="modal-body settings-body">
          <div className="setting">
            <span className="setting-label">Notes folder</span>
            <span className="setting-hint">{vault}</span>
            {picker}
          </div>
          <div className="setting">
            <label className="setting-label" htmlFor="font-size">
              Text size — {fontSize}px
            </label>
            <input
              id="font-size"
              type="range"
              min={12}
              max={24}
              value={fontSize}
              onChange={(e) => onFontSize(Number(e.target.value))}
            />
          </div>
          <div className="setting">
            <span className="setting-label">Bring notes in</span>
            <button className="btn" onClick={onImport}>
              Import from Bear, Obsidian or a folder…
            </button>
          </div>
          <p className="notes-dim">
            Notes are plain Markdown files in that folder — open them in any editor. The AI
            connector: <code>heapcode notes mcp</code>.
          </p>
        </div>
      </div>
    </div>
  );
}
