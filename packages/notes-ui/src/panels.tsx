import {
  Fragment,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from 'react';
import type { NoteListItem, NotesListGroup, RelatedNote } from '@heapcode/notes-host/protocol';
import { fuzzyFilter } from './fuzzy.js';
import { IconChevron } from './icons.js';
import { ago, fullDate, sourceLabel, useNow } from './time.js';
import {
  SettingsGroup,
  SettingsRow,
  SettingsSection,
  SettingsToggle,
} from '@heapcode/web-ui/components/Settings';

export function NoteList({
  notes,
  related = [],
  selected,
  picked,
  groups,
  onSelect,
  onMenu,
  empty,
}: {
  notes: NoteListItem[];
  /** Subtag headings, smart order inside a tag: notes carry the `group` they're under. */
  groups?: NotesListGroup[];
  /** Several notes chosen with ⌘/⇧-click; the open note stays `selected`. */
  picked?: ReadonlySet<string>;
  /** Right-click on a row. */
  onMenu?(note: NoteListItem, e: ReactMouseEvent): void;
  /** Close in meaning to the search, not among its keyword hits (HEAPNOTES_PHASE2_PLAN §2B). */
  related?: NoteListItem[];
  selected?: string;
  /** `toggle`: ⌘-click (Ctrl elsewhere); `range`: ⇧-click. */
  onSelect(id: string, how: { toggle: boolean; range: boolean }): void;
  empty: string;
}): JSX.Element {
  const now = useNow();
  const [folded, setFolded] = useState<ReadonlySet<string>>(() => new Set());
  const box = useRef<HTMLUListElement>(null);
  useEffect(() => {
    box.current?.querySelector('.note-row-on')?.scrollIntoView({ block: 'nearest' });
  }, [selected]);
  if (notes.length === 0 && related.length === 0) return <p className="notes-empty">{empty}</p>;
  const row = (n: NoteListItem) => (
    <li key={n.id}>
      <button
        className={
          picked && picked.size > 1
            ? picked.has(n.id)
              ? 'note-row note-row-picked'
              : 'note-row'
            : n.id === selected
              ? 'note-row note-row-on'
              : 'note-row'
        }
        role="option"
        aria-selected={picked && picked.size > 1 ? picked.has(n.id) : n.id === selected}
        onClick={(e) =>
          onSelect(n.id, {
            toggle: /Mac|iPhone|iPad/.test(navigator.platform) ? e.metaKey : e.ctrlKey,
            range: e.shiftKey,
          })
        }
        // ⇧-click selects a range, not the text between.
        onMouseDown={(e) => e.shiftKey && e.preventDefault()}
        onContextMenu={
          onMenu &&
          ((e) => {
            e.preventDefault();
            onMenu(n, e);
          })
        }
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
          <span title={`Modified ${fullDate(n.modified)}`}>{ago(n.modified, now)}</span>
          {n.todos > 0 && <span className="note-meta-chip">{n.todos} to do</span>}
          {(n.hasImages || n.hasFiles) && (
            <span className="note-meta-chip">{n.hasImages ? 'image' : 'file'}</span>
          )}
        </span>
      </button>
    </li>
  );
  return (
    <ul
      className="note-rows"
      ref={box}
      role="listbox"
      aria-label="Notes"
      aria-multiselectable="true"
    >
      {groups
        ? notes.map((n, i) => {
            // A heading where a subtag's notes begin; the tag's own notes need none.
            const g = n.group ?? '';
            const starts = (i === 0 || notes[i - 1]!.group !== n.group) && g !== groups[0]!.tag;
            const info = groups.find((x) => x.tag === g);
            const shut = folded.has(g);
            return (
              <Fragment key={n.id}>
                {starts && (
                  <li className="note-group note-subtag" role="presentation">
                    <button
                      aria-expanded={!shut}
                      onClick={() =>
                        setFolded((f) => {
                          const next = new Set(f);
                          if (next.has(g)) next.delete(g);
                          else next.add(g);
                          return next;
                        })
                      }
                      title={`#${g}`}
                    >
                      <span className="note-subtag-caret" aria-hidden="true">
                        <IconChevron open={!shut} />
                      </span>
                      <span className="note-subtag-name">{g.split('/').pop()}</span>
                      {info && <span className="note-subtag-count">{info.count}</span>}
                    </button>
                  </li>
                )}
                {!shut && row(n)}
              </Fragment>
            );
          })
        : notes.map(row)}
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
  related,
  text,
  onJump,
  onOpen,
  onLink,
  onClose,
  note,
}: {
  /** The open note's dates and where it came from. */
  note: { created: string; modified: string; source?: string };
  headings: Heading[];
  backlinks: { id: string; title: string; subtitle: string }[];
  /** Undefined while loading. */
  related?: RelatedNote[];
  /** Put a [[link]] to this note at the cursor. */
  onLink?(title: string): void;
  text: string;
  onJump(offset: number): void;
  onOpen(id: string): void;
  onClose(): void;
}): JSX.Element {
  const now = useNow();
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
        <h3>Related</h3>
        {related === undefined ? (
          <p className="notes-dim">Looking…</p>
        ) : related.length === 0 ? (
          <p className="notes-dim">Nothing related that isn’t already linked.</p>
        ) : (
          <ul className="backlinks related">
            {related.map((r) => (
              <li key={r.id} className="related-row">
                <button onClick={() => onOpen(r.id)} title={r.subtitle}>
                  <span className="backlink-title">{r.title}</span>
                  <span className="backlink-sub">{r.reason}</span>
                </button>
                {onLink && (
                  <button
                    className="btn btn-quiet btn-sm related-link"
                    onClick={() => onLink(r.title)}
                    title={`Insert [[${r.title}]] at the cursor`}
                  >
                    Link it
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
      <section>
        <h3>Details</h3>
        <dl className="stats">
          <dt>Created</dt>
          <dd title={ago(note.created, now)}>{fullDate(note.created)}</dd>
          <dt>Modified</dt>
          <dd title={fullDate(note.modified)}>{ago(note.modified, now)}</dd>
          {sourceLabel(note.source) && (
            <>
              <dt>Source</dt>
              <dd>{sourceLabel(note.source)}</dd>
            </>
          )}
        </dl>
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
  empty = 'Nothing matches.',
}: {
  /** What an empty list says. */
  empty?: string;
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
          {total === 0 && (
            <li className="palette-empty">{items.length === 0 ? empty : 'Nothing matches.'}</li>
          )}
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

/**
 * Heapnotes' own page in the shared Settings dialog — beside the pages it
 * shares with Heap Code, Heap Chat and Heap QA (connections, model roles,
 * web search, MCP connectors), so nothing needs setting up elsewhere.
 */
export function NotesSettingsPage({
  vault,
  picker,
  fontSize,
  hiddenTags,
  autoApply,
  onFontSize,
  onHiddenTags,
  onAutoApply,
  onImport,
  onExportAll,
  onChangeModel,
}: {
  vault: string;
  picker: JSX.Element;
  fontSize: number;
  /** Undefined when this host runs no AI — the AI rows are then absent. */
  hiddenTags?: string[];
  autoApply: boolean;
  onFontSize(size: number): void;
  onHiddenTags(tags: string[]): void;
  onAutoApply(on: boolean): void;
  onImport(): void;
  onExportAll(): void;
  onChangeModel(): void;
}): JSX.Element {
  return (
    <SettingsSection description="Your notes are plain Markdown files in one folder — open them in any editor. These settings are this computer's.">
      <SettingsGroup label="Notes">
        <SettingsRow label="Notes folder" hint={vault} stacked>
          {picker}
        </SettingsRow>
        <SettingsRow label={`Text size — ${fontSize}px`}>
          <input
            type="range"
            min={12}
            max={24}
            value={fontSize}
            aria-label="Text size"
            onChange={(e) => onFontSize(Number(e.target.value))}
          />
        </SettingsRow>
        <SettingsRow
          label="Bring notes in"
          hint="From the Bear app, a Bear export, an Obsidian vault or any Markdown folder. Your originals are copied, never changed."
        >
          <button className="btn btn-sm" onClick={onImport}>
            Import…
          </button>
        </SettingsRow>
        <SettingsRow
          label="Export all notes"
          hint="Every note as a Markdown file, with its images, in one .zip — the trash left out. Folders and front matter as they are, so any Markdown app can open it."
        >
          <button className="btn btn-sm" onClick={onExportAll}>
            Export…
          </button>
        </SettingsRow>
      </SettingsGroup>
      {hiddenTags && (
        <SettingsGroup label="AI">
          <SettingsRow
            label="Model"
            hint="Ask and ⌘J use your chat model; ⌘J the edit model when one is set. Shared with Heap Code and Heap Chat."
          >
            <button className="btn btn-sm" onClick={onChangeModel}>
              Connections and models
            </button>
          </SettingsRow>
          <SettingsToggle
            label="Apply Ask's changes automatically"
            hint="Off: each change Ask makes to a note shows as a diff to apply or discard. On: they're made straight away, without a diff to check first."
            checked={autoApply}
            onChange={onAutoApply}
          />
          <HiddenTagsSetting tags={hiddenTags} onSave={onHiddenTags} />
        </SettingsGroup>
      )}
      <p className="hint">
        For an AI app outside Heapnotes (Claude Desktop and others): <code>heapcode notes mcp</code>
        .
      </p>
    </SettingsSection>
  );
}

/** The tags that keep notes away from every AI feature, as one editable line. */
function HiddenTagsSetting({
  tags,
  onSave,
}: {
  tags: string[];
  onSave(tags: string[]): void;
}): JSX.Element {
  const [text, setText] = useState(tags.map((t) => `#${t}`).join(' '));
  const parsed = text
    .split(/[\s,]+/)
    .map((t) => t.replace(/^#|#$/g, '').trim())
    .filter(Boolean);
  const changed = parsed.join(' ') !== tags.join(' ');
  return (
    <SettingsRow
      label="Hidden from AI"
      hint="Notes with these tags never reach a model: Ask can't find them, ⌘J won't run on them, and they're kept out of the search index."
      stacked
    >
      <form
        className="hidden-tags"
        onSubmit={(e) => {
          e.preventDefault();
          onSave(parsed);
        }}
      >
        <input
          className="card-input"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="#private"
          aria-label="Hidden from AI"
        />
        <button className="btn btn-sm" type="submit" disabled={!changed}>
          Save
        </button>
      </form>
    </SettingsRow>
  );
}
