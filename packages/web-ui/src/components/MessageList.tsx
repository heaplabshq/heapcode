import { memo, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { renderMarkdown } from '../markdown.js';
import { activityOf, type Item, type Transcript } from '../transcript.js';
import { ToolChip } from './ToolChip.js';
import { WorkingIndicator } from './WorkingIndicator.js';

/**
 * How much of a long conversation is mounted at once, and how much more each
 * time you scroll back past the top of it.
 *
 * Chat is the one shape where windowing is easy to get right: what matters is
 * always at the bottom, and history is reached by scrolling up. So rather than
 * measuring rows to fake a scrollbar, this mounts the tail and grows upward
 * when you actually go looking — the same thing Slack and iMessage do, and it
 * keeps the scroll position honest because nothing below ever unmounts.
 */
const WINDOW = 60;
const STEP = 60;

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
  const top = useRef<HTMLDivElement>(null);
  const [pinned, setPinned] = useState(true);
  const [visible, setVisible] = useState(WINDOW);

  const total = transcript.items.length;
  const hidden = Math.max(0, total - visible);
  const shown = hidden > 0 ? transcript.items.slice(hidden) : transcript.items;

  // Follow the stream, but stop fighting the user the moment they scroll up to
  // read something — and resume when they come back to the bottom.
  useEffect(() => {
    if (pinned) end.current?.scrollIntoView({ block: 'end' });
  }, [transcript, pinned, busy]);

  // Opening a different conversation is a different transcript; the window has
  // to start at its tail rather than inheriting however far back the last one
  // had been expanded. Keyed off the first item's id, which only changes when
  // the whole list is replaced.
  const firstId = transcript.items[0]?.id;
  useEffect(() => setVisible(WINDOW), [firstId]);

  // Reveal more when the top sentinel comes into view. An observer rather than
  // a scroll handler because it fires once per crossing instead of per frame.
  useEffect(() => {
    const sentinel = top.current;
    const root = scroller.current;
    if (!sentinel || !root || hidden === 0) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) setVisible((v) => v + STEP);
      },
      { root, rootMargin: '200px 0px 0px 0px' },
    );
    io.observe(sentinel);
    return () => io.disconnect();
  }, [hidden]);

  // Prepending rows pushes everything down by their height, which would yank
  // the reader away from the line they were on. Measure before paint and add
  // the difference back, so revealing history looks like nothing moved.
  const prevHeight = useRef(0);
  const prevVisible = useRef(visible);
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    if (visible > prevVisible.current && prevHeight.current > 0) {
      el.scrollTop += el.scrollHeight - prevHeight.current;
    }
    prevVisible.current = visible;
    prevHeight.current = el.scrollHeight;
  }, [visible, shown.length]);

  return (
    <div
      className="messages"
      ref={scroller}
      // A log, not a live region: the reader is told about run transitions by
      // `Announcer` and can then walk this at their own pace. Marking it live
      // would read every streamed token aloud over whatever they were doing.
      role="log"
      aria-label="Conversation"
      aria-live="off"
      onScroll={() => {
        const el = scroller.current;
        if (!el) return;
        setPinned(el.scrollHeight - el.scrollTop - el.clientHeight < 60);
      }}
    >
      {total === 0 && (
        <div className="empty">
          <h1>Heap Code</h1>
          <p>Ask for a change, a fix, or an explanation. The agent works in this workspace.</p>
          <p className="empty-hint">
            Press <kbd>⌘K</kbd> for commands, <kbd>?</kbd> for shortcuts. Paste a screenshot straight into the box.
          </p>
        </div>
      )}
      {hidden > 0 && (
        <div className="earlier" ref={top}>
          <button className="btn btn-quiet" onClick={() => setVisible((v) => v + STEP)}>
            Show earlier ({hidden} more)
          </button>
        </div>
      )}
      {shown.map((item) => (
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

/**
 * Memoized on the item's identity.
 *
 * The reducer returns a new object only for the entry that changed, so during a
 * streaming reply exactly one row re-renders. Without this every text delta
 * re-ran `renderMarkdown` — highlight.js and all — for every message on screen,
 * which is what made a long conversation stutter while the model typed.
 */
const Row = memo(function Row({
  item,
  onOpenPath,
}: {
  item: Item;
  onOpenPath?(path: string): void;
}): JSX.Element | null {
  switch (item.kind) {
    case 'text':
      return (
        <div className={`msg msg-${item.role}`}>
          {item.images && item.images.length > 0 && (
            <div className="msg-images">
              {item.images.map((src, i) => (
                <img key={`${i}-${src.slice(24, 48)}`} src={src} alt={`Attached image ${i + 1}`} />
              ))}
            </div>
          )}
          <div
            className="msg-body"
            // Sanitized in renderMarkdown — model output is untrusted, and this
            // page holds the socket that runs commands.
            dangerouslySetInnerHTML={{ __html: renderMarkdown(item.text) }}
          />
          {/* Three pulsing dots, not a text caret. A blinking accent-coloured
              block is the shape of an editor cursor, which in a read-only
              transcript reads as "type here" — and it borrowed the accent
              colour, so the quietest thing on screen was drawn in the loudest
              one. Dots say "more is coming" and nothing else. */}
          {item.streaming && (
            <span className="typing" aria-label="still writing">
              <i />
              <i />
              <i />
            </span>
          )}
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
    case 'tasks':
      // One card that updates in place, beside the plan: the list answers
      // "what is left", and a stack of stale copies would answer it five
      // times, all wrong but the last.
      return (
        <div className="tasks">
          <div className="plan-title">Tasks</div>
          <ul className="tasks-list">
            {item.todos.map((t, i) => (
              // `key` by index, not content: the list is replaced whole, so
              // an item's identity is its position, not what it says.
              <li key={i} className={`task task-${t.status}`}>
                <span className="task-mark" aria-hidden>
                  {t.status === 'completed' ? '✔' : t.status === 'in_progress' ? '▸' : '·'}
                </span>
                {t.content}
              </li>
            ))}
          </ul>
        </div>
      );
    case 'reasoning':
      return <Reasoning text={item.text} streaming={item.streaming} />;
    case 'notice':
      // role="status" so a reader that has scrolled away is still told the run
      // ended in something other than a finished job.
      return (
        <div className={item.warn ? 'notice notice-warn' : 'notice'} role="status">
          {item.text}
        </div>
      );
    default:
      return null;
  }
});

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
