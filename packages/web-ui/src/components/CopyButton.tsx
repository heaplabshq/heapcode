import { useEffect, useRef, useState } from 'react';
import { ICON_COPY, ICON_COPY_FAILED, ICON_DONE } from './icons.js';

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
      {state === 'done' ? ICON_DONE : state === 'failed' ? ICON_COPY_FAILED : ICON_COPY}
    </button>
  );
}
