import { useEffect, useRef, useState } from 'react';
import type { Activity } from '../transcript.js';

export interface AnnouncerProps {
  busy: boolean;
  activity: Activity;
  /** A run just ended; its closing message is what gets announced. */
  lastReply?: string;
  /**
   * The run ended in something other than a finished job (cut off at the step
   * limit, interrupted, never really acted). Announced INSTEAD of the reply's
   * opening: "Finished" plus a confident-sounding summary is exactly the
   * wrong thing to hear about a run that was cut off mid-task.
   */
  ending?: string;
}

/**
 * What a screen reader hears while the agent works.
 *
 * The transcript itself is deliberately NOT a live region. Marking it one
 * announces every streamed token, which for a model writing three paragraphs
 * means the reader is talked over continuously and cannot navigate away. What
 * someone actually needs is the *shape* of the run — it started, it is running
 * a tool, it finished, here is the first line of the answer — and then the
 * ability to go read the transcript at their own pace, which `role="log"` on
 * the list gives them.
 *
 * So this announces transitions only, and never the same one twice.
 */
export function Announcer({ busy, activity, lastReply, ending }: AnnouncerProps): JSX.Element {
  const [message, setMessage] = useState('');
  const wasBusy = useRef(false);
  const lastPhase = useRef<string>();

  useEffect(() => {
    if (busy && !wasBusy.current) {
      setMessage('Working.');
      lastPhase.current = undefined;
    } else if (!busy && wasBusy.current) {
      if (ending) {
        setMessage(ending);
      } else {
        // The reply's opening is the useful part: enough to know whether to go
        // read it, short enough not to be a second recitation of the whole thing.
        const opening = lastReply?.trim().slice(0, 160);
        setMessage(opening ? `Finished. ${opening}` : 'Finished.');
      }
    }
    wasBusy.current = busy;
  }, [busy, lastReply, ending]);

  // Tool starts are worth hearing — they are the run doing something to the
  // workspace — but only once per tool, not once per render.
  useEffect(() => {
    if (!busy) return;
    const phase = activity.phase === 'tool' ? `tool:${activity.tool}` : activity.phase;
    if (phase === lastPhase.current) return;
    lastPhase.current = phase;
    if (activity.phase === 'tool' && activity.tool) setMessage(`Running ${activity.tool}.`);
  }, [busy, activity]);

  return (
    <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
      {message}
    </div>
  );
}
