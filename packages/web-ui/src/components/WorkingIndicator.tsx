import { useEffect, useState } from 'react';
import type { Activity } from '../transcript.js';

export interface WorkingIndicatorProps {
  activity: Activity;
  /** Millisecond timestamp the run started, for the elapsed counter. */
  startedAt?: number;
}

/**
 * The "it is still working" line — shown only when nothing else is.
 *
 * The gap this fills is the one between visible steps: after a tool returns and
 * before the next token arrives, nothing was on screen at all — no spinner, no
 * text, no chip — and a model taking twenty seconds to decide its next move was
 * indistinguishable from a hung page.
 *
 * That is the *whole* job, so it renders for exactly the two phases that have
 * no representation of their own and nothing otherwise. Thinking already shows
 * an open reasoning block, a reply already shows streaming text and a caret,
 * and a running tool already shows its chip on `◌` — announcing those a second
 * time in a status line is narration of something the user is looking at. The
 * CLI draws the same distinction (ink/App.tsx:1787-1796): its spinner appears
 * only when there is no live text and no live tool.
 *
 * Rendered as a plain dim line rather than a card, matching the extension's
 * `.working-row`. A bordered full-width box gave a transient one-line status
 * the visual weight of a message, so the quietest thing in the transcript was
 * drawn as one of the loudest.
 */
export function WorkingIndicator({ activity, startedAt }: WorkingIndicatorProps): JSX.Element | null {
  const elapsed = useElapsed(startedAt);
  const text = label(activity);
  if (!text) return null;

  return (
    <div className="working" role="status" aria-live="polite">
      <span className="working-spinner" aria-hidden="true" />
      <span>{text}</span>
      {/* Hidden from the live region, not from the screen: this ticks once a
          second, and a polite region containing it re-announces the whole line
          every tick — "Working 1s", "Working 2s", forever. The phase is the
          news; the stopwatch is not. */}
      {elapsed !== undefined && (
        <span className="working-elapsed" aria-hidden="true">
          {formatElapsed(elapsed)}
        </span>
      )}
    </div>
  );
}

/** The label, or null for the phases that already show themselves. */
function label(activity: Activity): string | null {
  switch (activity.phase) {
    case 'writing-call':
      // Arguments streaming out of the model — a large edit is written as one
      // long JSON string, and nothing is on screen until the call is complete,
      // so this is the phase where silence most looks like a stall.
      return `Writing a tool call… ${activity.writingCallK}k`;
    case 'working':
      return 'Working…';
    // thinking → the reasoning block is open; responding → text is streaming;
    // tool → the chip is spinning. All three speak for themselves.
    default:
      return null;
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
