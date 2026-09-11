import { useEffect, useRef, useState } from 'react';

/**
 * Copy a reply, from a toolbar under it.
 *
 * Copies the markdown the model actually wrote, not the rendered HTML: what
 * someone wants in a commit message, an issue or a document is the source, and
 * pasting rendered markup into any of those is worse than useless.
 *
 * An icon rather than the word, matching every other control in this shell —
 * and the outcome is an icon too, so the button does not change width under
 * the cursor that just clicked it. The accessible name carries the meaning,
 * which is what a screen reader and a tooltip both read.
 */

/** The same stroke icons the panel's tabs use; see Panel.tsx. */
const S = {
  width: 14,
  height: 14,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.7,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
};

/** Two sheets, one behind the other. */
const ICON_COPY = (
  <svg {...S} aria-hidden>
    <rect x="9" y="9" width="12" height="12" rx="2" />
    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
  </svg>
);

const ICON_DONE = (
  <svg {...S} aria-hidden>
    <path d="m5 13 4 4L19 7" />
  </svg>
);

/** A struck-through sheet: it did not go anywhere. */
const ICON_FAILED = (
  <svg {...S} aria-hidden>
    <rect x="9" y="9" width="12" height="12" rx="2" />
    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    <path d="m11 19 8-8" />
  </svg>
);

export function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }): JSX.Element {
  const [state, setState] = useState<'idle' | 'done' | 'failed'>('idle');
  const timer = useRef<ReturnType<typeof setTimeout>>();

  // A component that unmounts while the confirmation is showing — a reply
  // replaced by the next turn — must not set state afterwards.
  useEffect(() => () => clearTimeout(timer.current), []);

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text);
      setState('done');
    } catch {
      setState('failed');
    }
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setState('idle'), 1_400);
  };

  // The only thing saying what this is, now the label is a glyph. It changes
  // with the outcome, or a screen reader announces "Copy" after a failure.
  const name = state === 'failed' ? 'Could not copy' : state === 'done' ? 'Copied' : label;

  return (
    <button
      className="msg-action"
      onClick={() => void copy()}
      aria-label={name}
      title={state === 'failed' ? 'Could not copy — the browser refused clipboard access' : name}
    >
      {state === 'done' ? ICON_DONE : state === 'failed' ? ICON_FAILED : ICON_COPY}
    </button>
  );
}
