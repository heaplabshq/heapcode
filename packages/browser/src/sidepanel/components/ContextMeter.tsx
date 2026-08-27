/**
 * How much of the model's window the last prompt used.
 *
 * Worth surfacing because on this product the number moves for a reason the
 * user can act on: a page snapshot is by far the largest thing that enters the
 * context, and PRD §8.5 makes token cost an explicit success criterion. Seeing
 * it climb is what makes "why did that cost so much" answerable.
 */
export function ContextMeter({ tokens, window }: { tokens: number; window: number }) {
  if (tokens === 0) return null;
  const share = Math.min(1, tokens / window);
  const percent = Math.round(share * 100);
  return (
    <div
      className="meter"
      title={`${tokens.toLocaleString()} of ~${window.toLocaleString()} tokens`}
      role="img"
      aria-label={`Context ${percent}% full`}
    >
      <div className="meter-bar">
        <div
          className={`meter-fill${share > 0.85 ? ' hot' : ''}`}
          style={{ width: `${Math.max(2, percent)}%` }}
        />
      </div>
      <span>{percent}%</span>
    </div>
  );
}
