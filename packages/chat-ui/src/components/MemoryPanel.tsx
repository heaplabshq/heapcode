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
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Memory">
        <header className="modal-head">
          <h2>What I remember about you</h2>
          <button className="ghost" onClick={onClose} aria-label="Close">
            ×
          </button>
        </header>

        {entries === undefined ? (
          <p className="folder-hint">Loading…</p>
        ) : entries.length === 0 ? (
          <p className="folder-hint">
            Nothing yet. Say “remember that…” in a chat and it will be kept across every folder.
          </p>
        ) : (
          <ul className="memory-list">
            {entries.map((e) => (
              <li key={e.id}>
                <span className="memory-text">{e.text}</span>
                <span className="memory-date">{e.at.slice(0, 10)}</span>
                <button
                  className="ghost memory-forget"
                  onClick={() => {
                    void forget(e.id).then(refresh);
                  }}
                  aria-label={`Forget: ${e.text}`}
                >
                  Forget
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
