import { useEffect, useRef, type RefObject } from 'react';

/**
 * Focus management for a modal layer.
 *
 * Three things, all of which were missing and all of which a keyboard user
 * notices immediately:
 *
 * 1. **Focus moves in.** Opening a dialog and leaving focus behind it means the
 *    first Tab lands somewhere invisible under the scrim.
 * 2. **Focus stays in.** Tab and Shift+Tab wrap at the ends instead of walking
 *    out into the page the dialog is covering.
 * 3. **Focus comes back.** Closing returns it to whatever opened the dialog, so
 *    ⌘K → Escape leaves you exactly where you were rather than at the top of
 *    the document.
 *
 * Escape is handled here too, so every layer closes the same way.
 *
 * The container is queried on each Tab rather than cached: dialogs here grow
 * and shrink as you type (the palette's result list, the settings pages), and a
 * list captured at mount goes stale the moment that happens.
 *
 * Moving focus in happens ONCE, on mount, and deliberately does not depend on
 * `onClose`. Every caller passes an inline arrow, so `onClose` is a new
 * function on every render of the component that owns the dialog — and while
 * the focus move lived in the same effect as the key handler, any state change
 * behind the dialog re-ran it and yanked the caret back to the dialog's entry
 * point. In Settings that entry point is the search box, so typing into a field
 * that saves as you type moved focus after the first character, every time.
 */
export function useModal(container: RefObject<HTMLElement>, onClose: () => void): void {
  // Captured before the effect that moves focus runs, so it is the element that
  // actually opened this — not something the dialog itself focused.
  const opener = useRef<Element | null>(null);
  if (opener.current === null) opener.current = document.activeElement;

  // Read through a ref by the key handler below, so a fresh `onClose` on every
  // render does not re-subscribe anything or disturb focus.
  const close = useRef(onClose);
  close.current = onClose;

  useEffect(() => {
    const root = container.current;
    if (!root) return;

    // Whatever the dialog marked as its own entry point wins; otherwise the
    // first thing you could tab to; otherwise the dialog itself.
    const initial =
      root.querySelector<HTMLElement>('[data-autofocus]') ?? focusable(root)[0] ?? root;
    initial.focus();

    return () => {
      const back = opener.current;
      if (back instanceof HTMLElement && document.contains(back)) back.focus();
    };
    // Mount only, deliberately. `container` is a ref (stable) and `onClose` is
    // read through `close` below; depending on either here re-focuses the
    // dialog on every render of its parent, which is the bug this shape fixes.
  }, []);

  useEffect(() => {
    const root = container.current;
    if (!root) return;

    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        close.current();
        return;
      }
      if (e.key !== 'Tab') return;
      const items = focusable(root);
      if (items.length === 0) return;
      const first = items[0]!;
      const last = items[items.length - 1]!;
      const active = document.activeElement;
      if (e.shiftKey && (active === first || !root.contains(active))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };

    root.addEventListener('keydown', onKey);
    return () => root.removeEventListener('keydown', onKey);
  }, [container]);
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function focusable(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    // `offsetParent` is null for anything display:none — which is how the
    // collapsed halves of these dialogs are hidden, and tabbing into one is
    // indistinguishable from focus vanishing.
    (el) => el.offsetParent !== null || el === document.activeElement,
  );
}
