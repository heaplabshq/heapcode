import { useEffect, useRef, useState } from 'react';
import { matchCommands, type Command } from '../commands.js';
import { useModal } from '../modal.js';

export interface PaletteProps {
  onClose(): void;
  onPick(command: Command): void;
}

/** ⌘K / Ctrl+K. Also what `/help` opens, so there is one list to maintain. */
export function Palette({ onClose, onPick }: PaletteProps): JSX.Element {
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const dialog = useRef<HTMLDivElement>(null);
  const results = matchCommands(query);

  useModal(dialog, onClose);
  useEffect(() => setIndex(0), [query]);

  return (
    <div className="modal-scrim" onClick={onClose}>
      <div
        className="palette"
        ref={dialog}
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        onClick={(e) => e.stopPropagation()}
      >
        <input
          data-autofocus
          className="palette-input"
          value={query}
          placeholder="Type a command…"
          aria-label="Command"
          // The list is the thing being navigated, so the input owns it via
          // aria-activedescendant rather than moving real focus row to row.
          role="combobox"
          aria-expanded="true"
          aria-controls="palette-list"
          aria-activedescendant={results[index] ? `palette-${results[index].name.slice(1)}` : undefined}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setIndex((i) => Math.min(i + 1, results.length - 1));
            }
            if (e.key === 'ArrowUp') {
              e.preventDefault();
              setIndex((i) => Math.max(i - 1, 0));
            }
            if (e.key === 'Enter') {
              e.preventDefault();
              const picked = results[index];
              if (picked) onPick(picked);
            }
          }}
        />
        <ul className="palette-list" id="palette-list" role="listbox" aria-label="Commands">
          {results.length === 0 && <li className="palette-empty">No matching command</li>}
          {results.map((c, i) => (
            <li key={c.name} role="option" id={`palette-${c.name.slice(1)}`} aria-selected={i === index}>
              <button
                className={`palette-item ${i === index ? 'palette-item-active' : ''}`}
                tabIndex={-1}
                onMouseEnter={() => setIndex(i)}
                onClick={() => onPick(c)}
              >
                <span className="palette-name">{c.name}</span>
                <span className="palette-desc">{c.description}</span>
                {c.kind === 'pending' && <span className="badge badge-off">{c.milestone}</span>}
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
