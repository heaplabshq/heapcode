import { useEffect, useState } from 'react';
import type { Activity } from '../transcript.js';

export interface WorkingIndicatorProps {
  activity: Activity;
  /** Millisecond timestamp the run started, for the elapsed counter. */
  startedAt?: number;
}

/**
 * The "it is still working" line, shown for the whole duration of a run.
 *
 * The gap this fills is the one between visible steps: after a tool returns and
 * before the next token arrives, nothing was on screen at all — no spinner, no
 * text, no chip — and a model taking twenty seconds to decide its next move was
 * indistinguishable from a hung page. The CLI never had that problem because
 * its status line is always up (Ink's `Spinner`); this is the browser's version
 * of the same guarantee: while `busy`, something is always moving.
 *
 * Elapsed time is the other half of it. "Working…" alone still leaves you
 * guessing whether it has been five seconds or five minutes, which is the
 * actual question behind "is this stuck".
 *
 * Informational only — no Stop button. The composer sits directly below this
 * with one already, and Escape does the same thing; a third control an inch
 * from the other two would be clutter, not reassurance.
 */
export function WorkingIndicator({ activity, startedAt }: WorkingIndicatorProps): JSX.Element {
  const elapsed = useElapsed(startedAt);

  return (
    <div className="working" role="status" aria-live="polite">
      <span className="working-spinner" aria-hidden="true" />
      <span className="working-label">{label(activity)}</span>
      {elapsed !== undefined && <span className="working-elapsed">{formatElapsed(elapsed)}</span>}
    </div>
  );
}

function label(activity: Activity): string {
  switch (activity.phase) {
    case 'thinking':
      return 'Thinking…';
    case 'responding':
      return 'Responding…';
    case 'tool':
      // The streamed size only appears once there is some, so a fast tool
      // doesn't flash "0k" on its way past.
      return activity.streamedK
        ? `Running ${activity.tool} — ${activity.streamedK}k of output…`
        : `Running ${activity.tool}…`;
    default:
      return 'Working…';
  }
}

/**
 * Seconds since the run started, ticking once a second.
 *
 * A one-second interval rather than an animation frame: this renders a number
 * that changes once a second, and spinning the render loop at 60fps to draw the
 * same digits is the kind of cost that shows up on a laptop battery, not on a
 * benchmark.
 */
function useElapsed(startedAt?: number): number | undefined {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (startedAt === undefined) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [startedAt]);
  if (startedAt === undefined) return undefined;
  return Math.max(0, Math.floor((now - startedAt) / 1000));
}

function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`;
}
