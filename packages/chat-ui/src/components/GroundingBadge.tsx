import type { Grounding } from '@heapcode/chat-host';

/**
 * What the answer above is standing on — as a line, not a drawer.
 *
 * It used to expand in place, which put a table of snippets between the answer
 * and the composer and pushed the conversation around. The evidence belongs in
 * the panel beside the transcript, where a file list and a preview already
 * live; this is the summary, and clicking it opens that.
 *
 * Only drawn for answers that actually used the folder. A general-knowledge
 * reply carries no badge, and that absence is the point: a badge that appears
 * on everything says nothing when it appears.
 */
export function GroundingBadge({
  grounding,
  onOpen,
}: {
  grounding: Grounding;
  onOpen(): void;
}): JSX.Element {
  const { sources, verdict } = grounding;
  const tone = verdict === 'unsupported' ? 'bad' : verdict === 'partial' ? 'mixed' : 'good';
  const label =
    verdict === 'unsupported'
      ? 'Not supported by these files'
      : verdict === 'partial'
        ? 'Partly supported'
        : 'Grounded';

  return (
    <div className={`grounding grounding-${tone}`}>
      <button className="grounding-line" onClick={onOpen} title="Show the evidence in the panel">
        <span className="grounding-mark" aria-hidden="true">
          {tone === 'good' ? '✓' : tone === 'mixed' ? '~' : '!'}
        </span>
        <span>
          {label} · {sources.length} source{sources.length === 1 ? '' : 's'}
        </span>
      </button>
    </div>
  );
}
