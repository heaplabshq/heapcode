import { useEffect, useState } from 'react';
import type { ChatMemoryResult } from '@heapcode/chat-host/protocol';

/**
 * What the assistant has been told to remember, and the button that undoes it.
 *
 * The list exists because `remember` is not confirmed before it runs — asking
 * "shall I remember what you just told me to remember" is noise. The control
 * that actually helps is being able to see everything it holds and delete any
 * of it, which is this.
 */
export function MemoryPanel({
  load,
  forget,
  onClose,
}: {
  load: () => Promise<ChatMemoryResult>;
  forget: (id: string) => Promise<void>;
  onClose: () => void;
}): JSX.Element {
  const [entries, setEntries] = useState<ChatMemoryResult['entries']>();

  const refresh = (): void => {
    load()
      .then((r) => setEntries(r.entries))
      .catch(() => setEntries([]));
  };

  useEffect(refresh, []);

  return (
    <div className="modal-scrim" onClick={onClose}>
      <div className="modal modal-sm" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="Memory">
        <header className="modal-head">
          <h2>What I remember about you</h2>
          <button className="btn" onClick={onClose} aria-label="Close">
            ×
          </button>
        </header>

        {entries === undefined ? (
          <p className="empty-state">Loading…</p>
        ) : entries.length === 0 ? (
          <p className="empty-state">
            Nothing yet. Say “remember that…” in a chat and it will be kept across every folder.
          </p>
        ) : (
          // `rows`/`row`, the same list every other panel in both products is
          // built from. The `memory-*` classes this used had no rule anywhere,
          // so the list rendered as bare <li>s — the one screen in Heap Chat
          // that looked like it belonged to a different application.
          <ul className="rows">
            {entries.map((e) => (
              <li key={e.id} className="row">
                <span className="memory-text">{e.text}</span>
                <span className="hint memory-when">{e.at.slice(0, 10)}</span>
                <div className="row-actions">
                  <button
                    className="btn btn-ghost-danger"
                    onClick={() => {
                      void forget(e.id).then(refresh);
                    }}
                    aria-label={`Forget: ${e.text}`}
                  >
                    Forget
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
