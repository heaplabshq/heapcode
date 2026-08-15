import { useEffect, useRef, useState } from 'react';

export interface MenuItem {
  label: string;
  /** Right-aligned hint: a shortcut, a count, a state. */
  hint?: string;
  onSelect(): void;
  /** Starts a new group above this item. */
  separated?: boolean;
  danger?: boolean;
}

/**
 * The header's overflow (⋮) menu.
 *
 * Everything that used to sit in the header as its own button lives here.
 * A row of six controls competing with the workspace name is what a header
 * looks like before someone decides which two things matter; the model and
 * permission-mode pickers moved down to the composer, where they describe the
 * message you are about to send rather than the app as a whole.
 */
export function Menu({ items, label = 'More' }: { items: MenuItem[]; label?: string }): JSX.Element {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent): void => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    // Stops at this menu: the window-level Escape handler closes the palette
    // and settings, and a keystroke should only dismiss the topmost thing.
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [open]);

  return (
    <div className="menu" ref={box}>
      <button className="icon-btn" onClick={() => setOpen((v) => !v)} aria-label={label} aria-expanded={open}>
        ⋮
      </button>
      {open && (
        <div className="menu-pop" role="menu">
          {items.map((item) => (
            <button
              key={item.label}
              role="menuitem"
              className={`menu-item ${item.separated ? 'menu-item-sep' : ''} ${item.danger ? 'menu-item-danger' : ''}`}
              onClick={() => {
                setOpen(false);
                item.onSelect();
              }}
            >
              <span>{item.label}</span>
              {item.hint && <span className="menu-hint">{item.hint}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
