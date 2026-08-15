import { useEffect, useRef, useState } from 'react';
import { matchCommands, type Command } from '../commands.js';

export interface PaletteProps {
  onClose(): void;
  onPick(command: Command): void;
}

/** ⌘K / Ctrl+K. Also what `/help` opens, so there is one list to maintain. */
export function Palette({ onClose, onPick }: PaletteProps): JSX.Element {
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const results = matchCommands(query);

  useEffect(() => input.current?.focus(), []);
  useEffect(() => setIndex(0), [query]);

  return (
    <div className="modal-scrim" onClick={onClose}>
      <div className="palette" role="dialog" aria-label="Command palette" onClick={(e) => e.stopPropagation()}>
        <input
          ref={input}
          className="palette-input"
          value={query}
          placeholder="Type a command…"
          aria-label="Command"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') return onClose();
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
        <ul className="palette-list">
          {results.length === 0 && <li className="palette-empty">No matching command</li>}
          {results.map((c, i) => (
            <li key={c.name}>
              <button
                className={`palette-item ${i === index ? 'palette-item-active' : ''}`}
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
