import { useEffect, useRef, useState } from 'react';

/**
 * Copy a reply, from a toolbar under it.
 *
 * Deliberately a local copy of `@heapcode/web-ui`'s rather than an import: this
 * package depends on core alone, and pulling the browser UI in for one button
 * would bring its stylesheet and component tree into the webview bundle. Only
 * the class names are shared, and the styling here is this webview's own.
 *
 * Copies the markdown the model wrote, not the rendered HTML — the source is
 * what belongs in a commit message or an issue.
 */
export function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }): JSX.Element {
  const [state, setState] = useState<'idle' | 'done' | 'failed'>('idle');
  const timer = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => () => clearTimeout(timer.current), []);

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text);
      setState('done');
    } catch {
      // A webview can refuse. Saying so beats a button that appears to work.
      setState('failed');
    }
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setState('idle'), 1_400);
  };

  return (
    <button
      className="msg-action"
      onClick={() => void copy()}
      aria-label={state === 'failed' ? 'Could not copy' : state === 'done' ? 'Copied' : label}
      title={state === 'failed' ? 'Could not copy — the editor refused clipboard access' : label}
    >
      {state === 'done' ? 'Copied' : state === 'failed' ? "Couldn't copy" : label}
    </button>
  );
}
