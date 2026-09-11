import { useEffect, useRef, useState } from 'react';

/**
 * Copy a reply, from a toolbar under it.
 *
 * Copies the markdown the model actually wrote, not the rendered HTML: what
 * someone wants in a commit message, an issue or a document is the source, and
 * pasting rendered markup into any of those is worse than useless.
 *
 * The state is worth having rather than a silent success — a copy button that
 * does nothing visible is indistinguishable from one that failed, and
 * `navigator.clipboard` does fail: an insecure origin, a denied permission, a
 * webview with a policy of its own. A failure says so instead of pretending.
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

  return (
    <button
      className="msg-action"
      onClick={() => void copy()}
      // The label changes, so the accessible name has to change with it —
      // otherwise a screen reader announces "Copy" after a failure.
      aria-label={state === 'failed' ? 'Could not copy' : state === 'done' ? 'Copied' : label}
      title={state === 'failed' ? 'Could not copy — the browser refused clipboard access' : label}
    >
      {state === 'done' ? 'Copied' : state === 'failed' ? "Couldn't copy" : label}
    </button>
  );
}
