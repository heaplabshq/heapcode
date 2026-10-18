import { useState } from 'react';
import type { NoteListItem } from '@heapcode/notes-host/protocol';

/**
 * What the editor shows while several notes are selected — Bear's stacked
 * cards and the actions that make sense for all of them at once.
 */
export type BulkRun =
  | { kind: 'pin' | 'unpin' | 'archive' | 'restore' | 'trash' | 'delete' }
  | { kind: 'addTag'; tag: string }
  | { kind: 'merge' | 'export' | 'copyLinks' | 'clear' };

export function BulkPanel({
  notes,
  onRun,
}: {
  /** The selected notes, in list order. */
  notes: NoteListItem[];
  onRun(run: BulkRun): void;
}): JSX.Element {
  const [tagging, setTagging] = useState(false);
  const [tag, setTag] = useState('');
  const where = new Set(notes.map((n) => n.location));
  const allTrash = where.size === 1 && where.has('trash');
  const anyTrash = where.has('trash');
  const anyArchived = where.has('archive');
  const allPinned = notes.every((n) => n.pinned);
  const shown = notes.slice(0, 6);

  return (
    <div className="bulk" aria-label={`${notes.length} notes selected`}>
      <div className="bulk-stack" aria-hidden="true">
        {notes.slice(0, 3).map((n, i) => (
          <div
            key={n.id}
            className="bulk-card"
            style={{
              top: `${i * 14}px`,
              transform: `rotate(${(i - 1) * 2.5}deg)`,
              zIndex: 3 - i,
            }}
          >
            {n.title || 'Untitled'}
          </div>
        ))}
      </div>
      <div className="bulk-title">{notes.length} notes selected</div>
      <ul className="bulk-list">
        {shown.map((n) => (
          <li key={n.id}>{n.title || 'Untitled'}</li>
        ))}
        {notes.length > shown.length && <li>and {notes.length - shown.length} more</li>}
      </ul>
      {tagging ? (
        <form
          className="bulk-tag"
          onSubmit={(e) => {
            e.preventDefault();
            const t = tag.replace(/^#|#$/g, '').trim();
            if (!t) return;
            onRun({ kind: 'addTag', tag: t });
            setTagging(false);
            setTag('');
          }}
        >
          <input
            autoFocus
            className="card-input"
            value={tag}
            placeholder="#tag"
            aria-label="Tag to add"
            onChange={(e) => setTag(e.target.value)}
            onKeyDown={(e) => e.key === 'Escape' && setTagging(false)}
          />
          <button className="btn btn-sm btn-primary" type="submit" disabled={!tag.trim()}>
            Add
          </button>
        </form>
      ) : (
        <div className="bulk-actions">
          {!anyTrash && (
            <>
              <button
                className="btn btn-sm"
                onClick={() => onRun({ kind: allPinned ? 'unpin' : 'pin' })}
              >
                {allPinned ? 'Unpin' : 'Pin'}
              </button>
              <button className="btn btn-sm" onClick={() => setTagging(true)}>
                Add tag…
              </button>
              <button
                className="btn btn-sm"
                onClick={() => onRun({ kind: 'merge' })}
                title="One note with all of these, in this order; the originals go to the trash"
              >
                Merge
              </button>
            </>
          )}
          <button className="btn btn-sm" onClick={() => onRun({ kind: 'export' })}>
            Export…
          </button>
          <button className="btn btn-sm" onClick={() => onRun({ kind: 'copyLinks' })}>
            Copy links
          </button>
          {(anyTrash || anyArchived) && (
            <button className="btn btn-sm" onClick={() => onRun({ kind: 'restore' })}>
              Restore
            </button>
          )}
          {!anyTrash && !anyArchived && (
            <button className="btn btn-sm" onClick={() => onRun({ kind: 'archive' })}>
              Archive
            </button>
          )}
          {allTrash ? (
            <button
              className="btn btn-sm notes-menu-danger"
              onClick={() => onRun({ kind: 'delete' })}
            >
              Delete for good
            </button>
          ) : (
            !anyTrash && (
              <button
                className="btn btn-sm notes-menu-danger"
                onClick={() => onRun({ kind: 'trash' })}
              >
                Move to trash
              </button>
            )
          )}
          <button className="btn btn-quiet btn-sm" onClick={() => onRun({ kind: 'clear' })}>
            Clear selection
          </button>
        </div>
      )}
    </div>
  );
}
