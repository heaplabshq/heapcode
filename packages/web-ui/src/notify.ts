import { useEffect, useRef } from 'react';

/**
 * A desktop notification when a run finishes and you are not looking.
 *
 * The point of a browser host is that you can start something slow and go do
 * something else. Without this, "go do something else" means coming back every
 * two minutes to check — which is the tab-switching version of watching a
 * progress bar.
 *
 * Three rules, all of them about not being obnoxious:
 *
 * - **Only when hidden.** If the tab is on screen, the transcript already said
 *   so; a notification on top of that is noise.
 * - **Only for runs worth waiting on.** A three-second turn that finished while
 *   you blinked does not warrant an OS-level alert.
 * - **Permission is asked on the first qualifying finish**, never on load. A
 *   permission prompt before the app has done anything is the request everyone
 *   denies, and a denial is permanent.
 */

/** Runs shorter than this finish before you have gone anywhere. */
const MIN_RUN_MS = 20_000;

export function useFinishNotification(busy: boolean, startedAt: number | undefined, title: string): void {
  const wasBusy = useRef(false);
  // The start time survives here because `startedAt` is cleared at the same
  // moment `busy` goes false — reading it in the same effect would always find
  // it already undefined.
  const startedRef = useRef<number>();

  useEffect(() => {
    if (busy) startedRef.current = startedAt ?? Date.now();
  }, [busy, startedAt]);

  useEffect(() => {
    const finished = wasBusy.current && !busy;
    wasBusy.current = busy;
    if (!finished) return;

    const began = startedRef.current;
    startedRef.current = undefined;
    if (!began || Date.now() - began < MIN_RUN_MS) return;
    if (typeof Notification === 'undefined') return;
    if (document.visibilityState !== 'hidden') return;

    const show = (): void => {
      // Checked again: the user may have come back while the permission prompt
      // was up, and notifying someone who is already looking at the answer is
      // the exact thing this is trying to avoid.
      if (document.visibilityState !== 'hidden') return;
      try {
        const n = new Notification('Heap Code', { body: `Finished in ${title}.`, tag: 'heapcode-run' });
        n.onclick = () => {
          window.focus();
          n.close();
        };
      } catch {
        /* Some browsers throw for notifications outside a service worker — no
           fallback is worth building; the tab title is not our alerting story. */
      }
    };

    if (Notification.permission === 'granted') show();
    else if (Notification.permission === 'default') void Notification.requestPermission().then(show);
  }, [busy, title]);
}
