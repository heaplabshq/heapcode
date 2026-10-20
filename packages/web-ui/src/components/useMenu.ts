import { useEffect, useRef, type KeyboardEvent, type RefObject } from 'react';

/**
 * The behaviour every drop-down menu here shares: an outside click or Escape
 * closes it (Escape handing focus back to the button, so the keyboard is not
 * left nowhere), the first row takes focus on open, and the arrow keys move
 * between rows.
 */
export function useMenu(
  open: boolean,
  setOpen: (open: boolean) => void,
): {
  root: RefObject<HTMLDivElement>;
  button: RefObject<HTMLButtonElement>;
  onMenuKey(e: KeyboardEvent): void;
} {
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent): void => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: globalThis.KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      setOpen(false);
      button.current?.focus();
    };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [open, setOpen]);

  useEffect(() => {
    if (open) root.current?.querySelector<HTMLElement>('[role^="menuitem"]')?.focus();
  }, [open]);

  const onMenuKey = (e: KeyboardEvent): void => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const rows = [...(root.current?.querySelectorAll<HTMLElement>('[role^="menuitem"]') ?? [])];
    const at = rows.indexOf(document.activeElement as HTMLElement);
    const next = (at + (e.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length;
    rows[next]?.focus();
  };

  return { root, button, onMenuKey };
}
