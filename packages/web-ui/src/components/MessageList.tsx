import { useEffect, useRef, useState } from 'react';
import { renderMarkdown } from '../markdown.js';
import { activityOf, type Item, type Transcript } from '../transcript.js';
import { ToolChip } from './ToolChip.js';
import { WorkingIndicator } from './WorkingIndicator.js';

export interface MessageListProps {
  transcript: Transcript;
  /** Clicking a path in a tool chip opens it in the workspace panel. */
  onOpenPath?(path: string): void;
  /** A run is in flight — the working indicator sits under the last message. */
  busy?: boolean;
  /** When the run started, for the indicator's elapsed counter. */
  runStartedAt?: number;
}

export function MessageList({ transcript, onOpenPath, busy, runStartedAt }: MessageListProps): JSX.Element {
  const end = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const [pinned, setPinned] = useState(true);

  // Follow the stream, but stop fighting the user the moment they scroll up to
  // read something — and resume when they come back to the bottom.
  useEffect(() => {
    if (pinned) end.current?.scrollIntoView({ block: 'end' });
  }, [transcript, pinned, busy]);

  return (
    <div
      className="messages"
      ref={scroller}
      onScroll={() => {
        const el = scroller.current;
        if (!el) return;
        setPinned(el.scrollHeight - el.scrollTop - el.clientHeight < 60);
      }}
    >
      {transcript.items.length === 0 && (
        <div className="empty">
          <h1>Heap Code</h1>
          <p>Ask for a change, a fix, or an explanation. The agent works in this workspace.</p>
        </div>
      )}
      {transcript.items.map((item) => (
        <Row key={item.id} item={item} onOpenPath={onOpenPath} />
      ))}
      {transcript.compacted && (
        <div className="notice">
          Context compacted — {fmt(transcript.compacted.before)} → {fmt(transcript.compacted.after)} tokens
        </div>
      )}
      {busy && <WorkingIndicator activity={activityOf(transcript)} startedAt={runStartedAt} />}
      <div ref={end} />
    </div>
  );
}

function Row({ item, onOpenPath }: { item: Item; onOpenPath?(path: string): void }): JSX.Element | null {
  switch (item.kind) {
    case 'text':
      return (
        <div className={`msg msg-${item.role}`}>
          <div
            className="msg-body"
            // Sanitized in renderMarkdown — model output is untrusted, and this
            // page holds the socket that runs commands.
            dangerouslySetInnerHTML={{ __html: renderMarkdown(item.text) }}
          />
          {item.streaming && <span className="caret" aria-hidden="true" />}
        </div>
      );
    case 'tool':
      return <ToolChip tool={item} onOpenPath={onOpenPath} />;
    case 'plan':
      return (
        <div className="plan">
          <div className="plan-title">Plan</div>
          <div dangerouslySetInnerHTML={{ __html: renderMarkdown(item.text) }} />
        </div>
      );
    case 'reasoning':
      return <Reasoning text={item.text} streaming={item.streaming} />;
    default:
      return null;
  }
}

/**
 * Open while the model is thinking, collapsed once it stops.
 *
 * Collapsed-by-default was wrong in practice: during a run there was nothing
 * on screen at all, which reads as the app having hung. Watching it think is
 * the reassurance; keeping it open afterwards is the noise.
 */
function Reasoning({ text, streaming }: { text: string; streaming?: boolean }): JSX.Element {
  const [manual, setManual] = useState<boolean>();
  const open = manual ?? Boolean(streaming);
  return (
    <div className="reasoning">
      <button className="reasoning-toggle" onClick={() => setManual(!open)} aria-expanded={open}>
        {open ? '▾' : '▸'} thinking{streaming ? '…' : ''}
      </button>
      {open && <pre className="reasoning-body">{text}</pre>}
    </div>
  );
}

function fmt(n: number): string {
  return n >= 1000 ? `${Math.round(n / 100) / 10}k` : String(n);
}
