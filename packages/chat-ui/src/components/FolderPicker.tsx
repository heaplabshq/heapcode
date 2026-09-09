import { useEffect, useState } from 'react';
import type { ChatBrowseFoldersResult, ChatRecentFoldersResult } from '@heapcode/chat-host/protocol';

/**
 * Choosing what Heap Chat reads.
 *
 * Heap Code's equivalent is a *workspace* picker and defaults to the folder
 * the terminal was in. This one opens on your home directory and remembers
 * where you have been, because the thing being chosen is a place you keep
 * documents, not a checkout.
 */
export function FolderPicker({
  browse,
  recent,
  onChoose,
  onClose,
}: {
  browse: (path?: string) => Promise<ChatBrowseFoldersResult>;
  recent: () => Promise<ChatRecentFoldersResult>;
  onChoose: (path: string) => void;
  onClose: () => void;
}): JSX.Element {
  const [view, setView] = useState<ChatBrowseFoldersResult>();
  const [places, setPlaces] = useState<ChatRecentFoldersResult>();
  const [error, setError] = useState<string>();

  const go = (path?: string): void => {
    browse(path)
      .then(setView)
      .catch((e: Error) => setError(e.message));
  };

  // Mount only: the picker opens on the current folder and is driven by clicks
  // after that, so re-running this on every render of its callbacks would
  // reset the browse position out from under whoever is using it.
  useEffect(() => {
    go(undefined);
    recent().then(setPlaces).catch(() => undefined);
  }, []);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Choose a folder">
        <header className="modal-head">
          <h2>Choose a folder</h2>
          <button className="ghost" onClick={onClose} aria-label="Close">
            ×
          </button>
        </header>

        {places && places.recent.length > 0 ? (
          <div className="picker-recent">
            <h3>Recent</h3>
            {places.recent.slice(0, 5).map((r) => (
              <button key={r.path} className="picker-row" onClick={() => onChoose(r.path)}>
                {r.path}
              </button>
            ))}
          </div>
        ) : null}

        <div className="picker-path">{view?.path ?? '…'}</div>
        {error ? <div className="notice notice-warn">{error}</div> : null}

        <div className="picker-list">
          {view?.parent ? (
            <button className="picker-row" onClick={() => go(view.parent)}>
              ../
            </button>
          ) : null}
          {(view?.entries ?? []).map((e) => (
            <button key={e.path} className="picker-row" onClick={() => go(e.path)}>
              {e.name}/
            </button>
          ))}
        </div>

        <footer className="modal-foot">
          <button className="primary" onClick={() => view && onChoose(view.path)} disabled={!view}>
            Read this folder
          </button>
        </footer>
      </div>
    </div>
  );
}
