import { useEffect, useMemo, useRef, useState } from 'react';
import type { RpcClient } from '@heapcode/web-ui/rpc';
import { NOTES_METHODS, type InlineAction } from '@heapcode/notes-host/protocol';
import { lineDiff } from './diff.js';
import { fuzzyFilter } from './fuzzy.js';

/**
 * ⌘J (HEAPNOTES_PHASE2_PLAN §2D): a small menu at the selection — pick an
 * action or say what you want — then the result streams in as a diff against
 * the text. Accept replaces it; Discard leaves the note exactly as it was.
 */
export interface InlineTarget {
  from: number;
  to: number;
  text: string;
  before: string;
  after: string;
  rect: { left: number; top: number; bottom: number };
}

const ACTIONS: { action: Exclude<InlineAction, 'custom'>; label: string }[] = [
  { action: 'improve', label: 'Improve writing' },
  { action: 'fix', label: 'Fix spelling & grammar' },
  { action: 'shorten', label: 'Make shorter' },
  { action: 'summarize', label: 'Summarize' },
  { action: 'list', label: 'Turn into a list' },
  { action: 'tasks', label: 'Turn into tasks' },
  { action: 'continue', label: 'Continue writing' },
];

type Phase =
  | { kind: 'menu' }
  | {
      kind: 'running' | 'done';
      action: InlineAction;
      instruction?: string;
      requestId: string;
      text: string;
    }
  | { kind: 'error'; message: string };

export function InlineAI({
  client,
  target,
  onAccept,
  onClose,
}: {
  client: RpcClient;
  target: InlineTarget;
  /** `continue` adds after the target; everything else replaces it. */
  onAccept(text: string, mode: 'replace' | 'after'): void;
  onClose(): void;
}): JSX.Element {
  const [phase, setPhase] = useState<Phase>({ kind: 'menu' });
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  const live = useRef<string>();

  const matches = useMemo(() => fuzzyFilter(query, ACTIONS, (a) => a.label), [query]);
  // A typed instruction is always an option, listed last — or first, when nothing matches.
  const custom = query.trim() ? 1 : 0;
  const total = matches.length + custom;
  useEffect(() => setIndex(0), [query]);

  useEffect(() => {
    client.onNotification(NOTES_METHODS.inlineText, (raw) => {
      const { requestId, chunk } = raw as { requestId: string; chunk: string };
      if (requestId !== live.current) return;
      setPhase((p) =>
        p.kind === 'running' && p.requestId === requestId ? { ...p, text: p.text + chunk } : p,
      );
    });
  }, [client]);

  const run = (action: InlineAction, instruction?: string) => {
    const requestId = crypto.randomUUID();
    live.current = requestId;
    setPhase({
      kind: 'running',
      action,
      ...(instruction ? { instruction } : {}),
      requestId,
      text: '',
    });
    client
      .request<{ text: string }>(NOTES_METHODS.inline, {
        requestId,
        action,
        ...(instruction ? { instruction } : {}),
        selection: target.text,
        before: target.before,
        after: target.after,
      })
      .then(
        (r) => {
          if (live.current !== requestId) return;
          setPhase({
            kind: 'done',
            action,
            ...(instruction ? { instruction } : {}),
            requestId,
            text: r.text,
          });
        },
        (e: Error) => {
          if (live.current === requestId) setPhase({ kind: 'error', message: e.message });
        },
      );
  };

  const choose = (i: number) => {
    const a = matches[i];
    if (a) run(a.action);
    else if (query.trim()) run('custom', query.trim());
  };

  const discard = () => {
    if (live.current)
      void client
        .request(NOTES_METHODS.inlineCancel, { requestId: live.current })
        .catch(() => undefined);
    live.current = undefined;
    onClose();
  };

  const accept = () => {
    if (phase.kind !== 'done' || !phase.text.trim()) return;
    onAccept(phase.text, phase.action === 'continue' ? 'after' : 'replace');
  };

  // Keys for the whole card: Esc discards, Enter accepts a finished result.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        discard();
      } else if (e.key === 'Enter' && phase.kind === 'done' && !e.shiftKey) {
        e.preventDefault();
        accept();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  });

  // Under the target, kept on screen.
  const top = Math.min(target.rect.bottom + 6, window.innerHeight - 200);
  const left = Math.max(8, Math.min(target.rect.left, window.innerWidth - 440));

  return (
    <div
      className="inline-ai"
      ref={box}
      style={{ top, left }}
      role="dialog"
      aria-label="Edit with AI"
    >
      {phase.kind === 'menu' && (
        <>
          <input
            autoFocus
            className="inline-ai-input"
            value={query}
            placeholder="Tell AI what to do, or pick…"
            aria-label="What should the AI do?"
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setIndex((i) => Math.min(i + 1, total - 1));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setIndex((i) => Math.max(i - 1, 0));
              } else if (e.key === 'Enter') {
                e.preventDefault();
                choose(index);
              }
            }}
          />
          <ul className="inline-ai-list" role="listbox">
            {matches.map((a, i) => (
              <li key={a.action}>
                <button
                  className={i === index ? 'inline-ai-item inline-ai-item-on' : 'inline-ai-item'}
                  onMouseEnter={() => setIndex(i)}
                  onClick={() => choose(i)}
                >
                  {a.label}
                </button>
              </li>
            ))}
            {custom > 0 && (
              <li>
                <button
                  className={
                    index === matches.length ? 'inline-ai-item inline-ai-item-on' : 'inline-ai-item'
                  }
                  onMouseEnter={() => setIndex(matches.length)}
                  onClick={() => choose(matches.length)}
                >
                  “{query.trim()}”
                </button>
              </li>
            )}
          </ul>
        </>
      )}
      {(phase.kind === 'running' || phase.kind === 'done') && (
        <>
          <pre className="ask-diff inline-ai-diff">
            {phase.action === 'continue' ? (
              <div className="diff-add">{phase.text || ' '}</div>
            ) : phase.kind === 'running' && !phase.text ? (
              <div className="diff-fold">Writing…</div>
            ) : (
              lineDiff(target.text, phase.text).map((l, i) =>
                l.kind === 'fold' ? (
                  <div key={i} className="diff-fold">
                    ⋯ {l.count} unchanged line{l.count === 1 ? '' : 's'}
                  </div>
                ) : (
                  <div key={i} className={`diff-${l.kind}`}>
                    <span className="diff-mark">
                      {l.kind === 'add' ? '+' : l.kind === 'del' ? '−' : ' '}
                    </span>
                    {l.text || ' '}
                  </div>
                ),
              )
            )}
          </pre>
          <div className="ask-card-actions">
            {phase.kind === 'done' && phase.text.trim() === target.text.trim() && (
              <span className="notes-dim inline-ai-same">No change suggested.</span>
            )}
            <button className="btn btn-quiet btn-sm" onClick={discard}>
              Discard
            </button>
            <button
              className="btn btn-quiet btn-sm"
              disabled={phase.kind === 'running'}
              onClick={() => run(phase.action, phase.instruction)}
            >
              Try again
            </button>
            <button
              className="btn btn-primary btn-sm"
              disabled={phase.kind !== 'done' || !phase.text.trim()}
              onClick={accept}
              title="Enter"
            >
              Accept
            </button>
          </div>
        </>
      )}
      {phase.kind === 'error' && (
        <div className="inline-ai-error">
          <span className="notes-error">{phase.message}</span>
          <button className="btn btn-quiet btn-sm" onClick={onClose}>
            Close
          </button>
        </div>
      )}
    </div>
  );
}
