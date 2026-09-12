import type { ReactNode } from 'react';
import { memo, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { CopyButton } from './CopyButton.js';
import { ICON_EDIT, ICON_RESTORE } from './icons.js';
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
  /** Edit a sent prompt: loads it into the composer; sending truncates + resends. */
  onEdit?(ordinal: number, text: string, images?: string[]): void;
  /** Restore the workspace to the checkpoint before this turn (conversation stays). */
  onRestore?(ordinal: number): void;
  /**
   * The task card `TaskBar` is currently drawing above this list, so it is not
   * drawn twice. Decided by App, which owns the rule for when a list is
   * pinned; unset means nothing is pinned and every card renders here.
   */
  hideTaskId?: string;
  /**
   * The empty state, when the product it belongs to is not Heap Code.
   *
   * Parameterized rather than duplicated: an empty transcript is the first
   * thing anyone sees, and two copies of this block would be two places for
   * the layout to drift while the rest of the shell stayed identical.
   */
  empty?: { title: string; body: string; hint?: ReactNode };
}

export function MessageList({
  transcript,
  onOpenPath,
  busy,
  runStartedAt,
  onEdit,
  onRestore,
  hideTaskId,
  empty,
}: MessageListProps): JSX.Element {
  const end = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const top = useRef<HTMLDivElement>(null);
  const [pinned, setPinned] = useState(true);
  const [visible, setVisible] = useState(WINDOW);

  const total = transcript.items.length;
  const hidden = Math.max(0, total - visible);
  const windowed = hidden > 0 ? transcript.items.slice(hidden) : transcript.items;
  // While a run is live its task list is drawn by `TaskBar` above this
  // scroller, so it is skipped here rather than drawn twice. Every other
  // card stays — including this one once the run ends and the bar goes away,
  // because the transcript is the record of what each turn set out to do.
  const shown = hideTaskId ? windowed.filter((item) => item.id !== hideTaskId) : windowed;

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
      // Flex only while it is empty, so `.empty` can centre itself with
      // `margin: auto`. The populated scroller stays a plain block — turning
      // every message into a flex item to solve a layout problem the empty
      // state has would be a wide change for a narrow reason.
      className={total === 0 ? 'messages messages-empty' : 'messages'}
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
          <h1>{empty?.title ?? 'Heap Code'}</h1>
          <p>{empty?.body ?? 'Ask for a change, a fix, or an explanation. The agent works in this workspace.'}</p>
          {/* One clause per span, separated rather than run together. As a
              single sentence it wrapped mid-phrase — "Paste a screenshot /
              straight into the box" — because the break landed wherever the
              measure ran out. Each separator sits INSIDE the clause it
              precedes so it wraps with it: as a sibling it could end a wrapped
              line, leaving the hint trailing off in a dangling "·". The dots
              are decoration between clauses a reader already hears as
              separate, so they stay out of the accessibility tree. */}
          <p className="empty-hint">
            {empty ? (
              empty.hint
            ) : (
              <>
            <span>
              Press <kbd>⌘K</kbd> for commands
            </span>
            <span>
              <span className="empty-sep" aria-hidden>
                ·
              </span>
              <kbd>?</kbd> for shortcuts
            </span>
            <span>
              <span className="empty-sep" aria-hidden>
                ·
              </span>
              Paste a screenshot straight into the box
            </span>
              </>
            )}
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
        <Row key={item.id} item={item} onOpenPath={onOpenPath} busy={busy} onEdit={onEdit} onRestore={onRestore} />
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
  busy,
  onEdit,
  onRestore,
}: {
  item: Item;
  onOpenPath?(path: string): void;
  busy?: boolean;
  onEdit?(ordinal: number, text: string, images?: string[]): void;
  onRestore?(ordinal: number): void;
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
          {/* The reply's own toolbar. Assistant turns only: a user turn already
              has Edit, and copying back what you just typed is not a thing
              anyone needs. Hidden while streaming — half a reply is not what
              someone means to copy. */}
          {item.role === 'assistant' && !item.streaming && item.text.trim() && (
            <div className="msg-actions msg-actions-reply">
              <CopyButton text={item.text} />
            </div>
          )}
          {/* Edit/restore a sent prompt. Only a real user turn carries an
              ordinal, and only one with a checkpoint can be rewound — so the
              buttons key off those, and hide while a run is in flight (the
              host refuses them then anyway). */}
          {item.role === 'user' && item.ordinal !== undefined && !busy && (onEdit || onRestore) && (
            <div className="msg-actions">
              {onEdit && (
                <button
                  className="msg-action"
                  // Icons, as everywhere else in these toolbars. The title and
                  // the accessible name carry the meaning the word used to —
                  // and say more than "Edit" did, since what this does to the
                  // conversation is not obvious from the glyph.
                  aria-label="Edit this message"
                  title="Edit this message — reverts the code and conversation to this point and resends"
                  // The attachments go back with the text: editing a turn that
                  // carried a screenshot used to resend the question without it.
                  onClick={() => onEdit(item.ordinal!, item.text, item.images)}
                >
                  {ICON_EDIT}
                </button>
              )}
              {onRestore && item.checkpoint && (
                <button
                  className="msg-action restore-msg"
                  aria-label="Restore workspace files to before this message"
                  title="Restore workspace files to the state before this message ran (conversation stays)"
                  onClick={() => onRestore(item.ordinal!)}
                >
                  {ICON_RESTORE}
                </button>
              )}
            </div>
          )}
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
                {/* The span is load-bearing: `.task-completed .task-text` is
                    what strikes a finished item through, and without it the
                    rule had no element to match. */}
                <span className="task-text">{t.content}</span>
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
