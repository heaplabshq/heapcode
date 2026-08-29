import { useEffect, useState } from 'react';
import type { UiContextResult, UiContextSlice } from '@heapcode/web-host/protocol';

export interface ContextMeterProps {
  used?: number;
  window?: number;
  /**
   * A run is holding the window right now, so `used` is the loop's own live
   * measurement. Idle, `used` is a memory of the last run's peak and the
   * meter prices the next turn from `load` instead.
   */
  live?: boolean;
  /** Bumped when the conversation changes, so an idle meter re-prices. */
  revision?: number;
  load(): Promise<UiContextResult>;
  /** "Change it on the profile" — the modal's one action. */
  onOpenSettings(): void;
}

/** Ring colours, warmest last: the meter should look calm until it is not. */
function colorFor(pct: number): string {
  if (pct > 0.9) return 'var(--danger)';
  if (pct > 0.7) return 'var(--warn)';
  return 'var(--text-dim)';
}

/**
 * The donut beside the composer, and the breakdown behind it.
 *
 * A ring rather than a bar because it lives on a toolbar row where a bar would
 * either be too short to read or too wide to belong. The same shape the
 * extension uses (webview-ui/App.tsx), for the same reason.
 *
 * Clicking opens a modal, not a popover: the answer to "why is my context
 * full" is a table with five rows and a paragraph of caveat, and a 240px
 * popover is where that turns into something nobody reads.
 */
export function ContextMeter({
  used = 0,
  window: win,
  live = false,
  revision,
  load,
  onOpenSettings,
}: ContextMeterProps): JSX.Element | null {
  const [open, setOpen] = useState(false);
  const [idle, setIdle] = useState<number>();

  /**
   * What the next turn will start with — the ring's number while nothing runs.
   *
   * `used` comes from the loop's own per-iteration measurement, so it is the
   * truth during a run and a memory of one afterwards: it holds the last run's
   * peak for as long as the tab stays open. That badly overstates what is
   * actually held, because tool output is not carried between turns
   * (`trimHistoryForAgent` drops every tool result and keeps the last twelve
   * real messages). A run of forty file reads left the ring near half full
   * while the next turn genuinely started near empty — and clicking it opened
   * a breakdown that said 5%, which read as the two contradicting each other.
   *
   * Not fetched during a run: the live figure is the right one then, and this
   * would be asking the host to price a hypothetical at the busiest moment.
   */
  useEffect(() => {
    if (live) return;
    let cancelled = false;
    void load()
      .then((c) => {
        if (cancelled) return;
        setIdle(c.slices.filter((s) => s.key !== 'free').reduce((n, s) => n + s.tokens, 0));
      })
      .catch(() => {
        /* The meter is non-critical; leave the last figure standing. */
      });
    return () => {
      cancelled = true;
    };
  }, [live, load, revision]);

  const shown = live ? used : (idle ?? used);
  if (!win) return null;

  const pct = Math.min(1, shown / Math.max(1, win));

  return (
    <>
      <button
        className="ctx-btn"
        onClick={() => setOpen(true)}
        title={
          live
            ? `Context: ~${fmt(shown)} of ${fmt(win)} tokens (${Math.round(pct * 100)}%) in this run. Click for the breakdown.`
            : `Context: the next turn starts at ~${fmt(shown)} of ${fmt(win)} tokens (${Math.round(pct * 100)}%). Click for the breakdown.`
        }
        aria-label="Context usage"
      >
        <Ring pct={pct} />
        <span className="ctx-pct" style={{ color: colorFor(pct) }}>
          {Math.round(pct * 100)}%
        </span>
      </button>
      {open && (
        <ContextModal live={live} load={load} onClose={() => setOpen(false)} onOpenSettings={onOpenSettings} />
      )}
    </>
  );
}

function Ring({ pct, size = 14 }: { pct: number; size?: number }): JSX.Element {
  const r = size / 2 - 1.75;
  const c = 2 * Math.PI * r;
  const color = colorFor(pct);
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={color} strokeOpacity="0.25" strokeWidth="2.5" />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke={color}
        strokeWidth="2.5"
        strokeDasharray={`${pct * c} ${c}`}
        // Start at twelve o'clock, so a nearly-empty ring reads as a sliver at
        // the top rather than a wedge on the right.
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
      />
    </svg>
  );
}

/**
 * Where the window size came from — worth saying, because only two of these
 * four are a number anyone measured. A preset default is a guess about a whole
 * family of endpoints, and when it is too generous the loop never compacts and
 * the endpoint truncates the prompt instead.
 */
const WINDOW_SOURCE: Record<UiContextResult['windowSource'], string> = {
  profile: 'Window size set on the profile.',
  model: 'Window size reported by the endpoint.',
  preset: "Window size from the preset's default — the endpoint did not report one.",
  default: 'Window size is a conservative fallback — nothing reported one.',
};

/** Distinct fills for the stacked bar and its legend, in slice order. */
const SLICE_COLOR: Record<UiContextSlice['key'], string> = {
  system: 'var(--accent)',
  tools: '#a371f7',
  instructions: '#2ea043',
  conversation: 'var(--warn)',
  free: 'var(--border)',
};

/**
 * A slice's caption, corrected for what the host could not know.
 *
 * The breakdown is built without reference to whether a run is in flight, so
 * "Free — room left for this turn's reply" is wrong exactly when it matters:
 * mid-run the loop's accumulating tool results are spending that space, and
 * none of them appear anywhere above it.
 */
function noteFor(slice: UiContextSlice, live: boolean): string | undefined {
  if (slice.key === 'free' && live) return 'Room for the next turn — the run in flight is using part of it now.';
  return slice.note;
}

function ContextModal({
  live,
  load,
  onClose,
  onOpenSettings,
}: {
  live: boolean;
  load(): Promise<UiContextResult>;
  onClose(): void;
  onOpenSettings(): void;
}): JSX.Element {
  const [data, setData] = useState<UiContextResult>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    void load()
      .then(setData)
      .catch((err: Error) => setError(err.message));
  }, [load]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      onClose();
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  const used = data ? data.slices.filter((s) => s.key !== 'free').reduce((n, s) => n + s.tokens, 0) : 0;
  const pct = data ? used / Math.max(1, data.window) : 0;

  return (
    <div className="modal-scrim" onClick={onClose}>
      <div className="modal modal-sm" role="dialog" aria-label="Context window" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>Context window</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>

        <div className="modal-body">
          {error && <p className="banner-error">{error}</p>}
          {!data && !error && <p className="hint">Measuring…</p>}

          {data && (
            <>
              <div className="ctx-summary">
                <Ring pct={pct} size={64} />
                <div>
                  <div className="ctx-headline">
                    {fmt(used)} / {fmt(data.window)} tokens
                  </div>
                  {/* What this number is, before what it adds up to. The
                      breakdown prices the NEXT turn's prompt — it is not a
                      reading of the run that just finished, and saying so is
                      the difference between "5%" being informative and
                      looking like it contradicts the ring. */}
                  <div className="hint">
                    What the next turn starts with{live ? ', while the run in flight holds more' : ''}.
                  </div>
                  <div className="hint">
                    {Math.round(pct * 100)}% of the window · compacts at{' '}
                    {Math.round(data.compactionThreshold * 100)}%
                  </div>
                  <div className="hint">{WINDOW_SOURCE[data.windowSource]}</div>
                </div>
              </div>

              <div className="ctx-bar">
                {data.slices.map((s) => (
                  <span
                    key={s.key}
                    className="ctx-bar-seg"
                    style={{
                      width: `${(s.tokens / Math.max(1, data.window)) * 100}%`,
                      background: SLICE_COLOR[s.key],
                    }}
                    title={`${s.label}: ${fmt(s.tokens)}`}
                  />
                ))}
              </div>

              <ul className="ctx-legend">
                {data.slices.map((s) => (
                  <li key={s.key}>
                    <span className="ctx-swatch" style={{ background: SLICE_COLOR[s.key] }} aria-hidden="true" />
                    <span className="ctx-legend-label">{s.label}</span>
                    <span className="ctx-legend-num">{fmt(s.tokens)}</span>
                    {noteFor(s, live) && <span className="ctx-legend-note">{noteFor(s, live)}</span>}
                  </li>
                ))}
              </ul>

              {/* Said plainly rather than buried: Heap Code is model-agnostic
                  and ships no tokenizer, so every number above is ~4 chars per
                  token. Directionally right, never exact. */}
              <p className="hint">
                Estimated at roughly 4 characters per token — Heap Code is model-agnostic and carries no tokenizer,
                so treat these as close, not exact.
              </p>

              <button
                className="btn"
                onClick={() => {
                  onClose();
                  onOpenSettings();
                }}
              >
                Change the window size on the profile…
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function fmt(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${Math.round(n / 100) / 10}k`;
  return String(n);
}
