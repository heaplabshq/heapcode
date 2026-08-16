import { useRef } from 'react';
import { useModal } from '../modal.js';

/**
 * The keyboard map, and the single place it is written down.
 *
 * Both this overlay and `App`'s handler read from this list, so a binding
 * cannot exist without appearing here — the failure mode being a shortcut that
 * works and that nobody knows about.
 */
export interface Shortcut {
  keys: string;
  description: string;
  group: 'Chat' | 'Navigation' | 'Workspace';
}

export const SHORTCUTS: Shortcut[] = [
  { keys: 'Enter', description: 'Send the message', group: 'Chat' },
  { keys: 'Shift + Enter', description: 'New line', group: 'Chat' },
  { keys: 'Esc', description: 'Stop the run', group: 'Chat' },
  { keys: '⌘/Ctrl + V', description: 'Attach a pasted image', group: 'Chat' },

  { keys: '⌘/Ctrl + K', description: 'Command palette', group: 'Navigation' },
  { keys: '?', description: 'This list', group: 'Navigation' },
  { keys: '⌘/Ctrl + ,', description: 'Settings', group: 'Navigation' },
  { keys: '/', description: 'Focus the composer', group: 'Navigation' },
  { keys: 'Esc', description: 'Close whatever is open', group: 'Navigation' },

  { keys: '⌘/Ctrl + B', description: 'Toggle the workspace panel', group: 'Workspace' },
  { keys: '⌘/Ctrl + Shift + N', description: 'New conversation', group: 'Workspace' },
  { keys: '⌘/Ctrl + \\', description: 'Collapse or expand the rail', group: 'Workspace' },
];

const GROUPS: Shortcut['group'][] = ['Chat', 'Navigation', 'Workspace'];

export function Shortcuts({ onClose }: { onClose(): void }): JSX.Element {
  const dialog = useRef<HTMLDivElement>(null);
  useModal(dialog, onClose);

  return (
    <div className="modal-scrim" onClick={onClose}>
      <div
        className="shortcuts"
        ref={dialog}
        role="dialog"
        aria-modal="true"
        aria-label="Keyboard shortcuts"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="shortcuts-head">
          <h2>Keyboard shortcuts</h2>
          <button className="btn btn-quiet" data-autofocus onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
        <div className="shortcuts-groups">
          {GROUPS.map((group) => (
            <section key={group}>
              <h3>{group}</h3>
              <dl>
                {SHORTCUTS.filter((s) => s.group === group).map((s) => (
                  <div className="shortcut" key={`${group}-${s.keys}-${s.description}`}>
                    <dt>
                      <kbd>{s.keys}</kbd>
                    </dt>
                    <dd>{s.description}</dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
