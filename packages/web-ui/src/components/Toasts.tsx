import { useEffect, useRef } from 'react';

/**
 * Things that just happened, said near where they happened.
 *
 * The distinction this draws is between a *condition* and an *event*. "Exposed
 * to your network", "Disconnected", "not reading .docx — parser not installed"
 * describe what this page IS right now: they belong at the top, they stay
 * while they are true, and the LAN one is deliberately not dismissible.
 *
 * An error or a confirmation is neither of those. "Could not locate that
 * message to edit" is over the moment it is read, and putting it in the same
 * strip as the standing warnings made it look like another thing that was
 * wrong with the page — while it sat there until something else replaced it.
 *
 * So these sit above the composer, where the action was, and go away: an error
 * lasts longer than a confirmation because it is worth reading twice, and
 * either can be dismissed by clicking it.
 */

/** Long enough to read a sentence twice. */
const ERROR_MS = 10_000;
/** A confirmation of something you just did needs less. */
const NOTICE_MS = 6_000;

export interface ToastsProps {
  error?: string;
  onDismissError?(): void;
  notice?: string;
  onDismissNotice?(): void;
}

export function Toasts({ error, onDismissError, notice, onDismissNotice }: ToastsProps): JSX.Element | null {
  useAutoDismiss(error, ERROR_MS, onDismissError);
  useAutoDismiss(notice, NOTICE_MS, onDismissNotice);

  if (!error && !notice) return null;
  return (
    // aria-live on the container rather than the message: the region has to
    // exist before the text lands in it, or a screen reader has nothing to
    // notice changing.
    <div className="toasts" aria-live="polite">
      {error && (
        <button className="toast toast-error" role="alert" onClick={onDismissError} title="Dismiss">
          {error}
        </button>
      )}
      {notice && (
        <button className="toast" role="status" onClick={onDismissNotice} title="Dismiss">
          {notice}
        </button>
      )}
    </div>
  );
}

/**
 * Clear `value` after `ms`, restarting whenever it changes.
 *
 * Keyed on the text so the same message raised twice re-arms the timer rather
 * than expiring on the first one's schedule.
 */
function useAutoDismiss(value: string | undefined, ms: number, dismiss?: () => void): void {
  const onDismiss = useRef(dismiss);
  onDismiss.current = dismiss;

  useEffect(() => {
    if (!value) return;
    const timer = setTimeout(() => onDismiss.current?.(), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
}
