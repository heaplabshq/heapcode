import { useEffect, useState } from 'react';
import type { UiContextResult, UiContextSlice } from '@heapcode/web-host/protocol';

export interface ContextMeterProps {
  used?: number;
  window?: number;
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
export function ContextMeter({ used = 0, window: win, load, onOpenSettings }: ContextMeterProps): JSX.Element | null {
  const [open, setOpen] = useState(false);
  if (!win) return null;

  const pct = Math.min(1, used / Math.max(1, win));

  return (
    <>
      <button
        className="ctx-btn"
        onClick={() => setOpen(true)}
        title={`Context: ~${fmt(used)} of ${fmt(win)} tokens (${Math.round(pct * 100)}%). Click for the breakdown.`}
        aria-label="Context usage"
      >
        <Ring pct={pct} />
        <span className="ctx-pct" style={{ color: colorFor(pct) }}>
          {Math.round(pct * 100)}%
        </span>
      </button>
      {open && <ContextModal load={load} onClose={() => setOpen(false)} onOpenSettings={onOpenSettings} />}
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

/** Distinct fills for the stacked bar and its legend, in slice order. */
const SLICE_COLOR: Record<UiContextSlice['key'], string> = {
  system: 'var(--accent)',
  tools: '#a371f7',
  instructions: '#2ea043',
  conversation: 'var(--warn)',
  free: 'var(--border)',
};

function ContextModal({
  load,
  onClose,
  onOpenSettings,
}: {
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
                  <div className="hint">
                    {Math.round(pct * 100)}% of the window · compacts at{' '}
                    {Math.round(data.compactionThreshold * 100)}%
                  </div>
                  <div className="hint">
                    Window size from the {data.windowSource === 'profile' ? 'profile' : "preset's default"}.
                  </div>
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
                    {s.note && <span className="ctx-legend-note">{s.note}</span>}
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
