import { useEffect, useRef } from 'react';
import { renderMarkdown } from '@heapcode/web-ui/markdown';
import type { Step, Turn } from '../useChat.js';
import { RunSteps } from './RunSteps.js';
import { DataTable } from './DataTable.js';
import { SavedTaskChips } from './Tasks.js';

/**
 * The steps worth rendering, which is not quite all of them.
 *
 * A model that streams its answer and then repeats it as the finish summary
 * puts the same text on screen twice — once as raw narration and once
 * rendered — and so does a run with no summary at all, where the narration is
 * promoted to *be* the answer and then still shown above it.
 *
 * `settle` in `useChat` resolves both when a turn ends, and this is the same
 * rule applied at render. Deliberately in both places: the state version is
 * what gets checkpointed to session storage, and this one cannot be reached
 * around by a path that forgets to call it. It costs a string compare per turn.
 */
function visibleSteps(turn: Turn): Step[] {
  const steps = turn.steps ?? [];
  const answer = turn.content.trim();
  if (!answer) return steps;
  const normalized = normalize(answer);
  return steps.filter((step) => step.kind !== 'note' || normalize(step.text) !== normalized);
}

function normalize(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase();
}

/** The steps that belong behind the fold: everything except collected rows. */
function hidden(turn: Turn): Step[] {
  return visibleSteps(turn).filter((step) => step.kind !== 'data');
}

/**
 * Things worth asking on a page you have just landed on.
 *
 * They lived in the last onboarding step, which is a screen each user sees
 * exactly once. A blank panel is the screen they see most, and it is the moment
 * the question "what do I even type" is actually being asked — so the answers
 * belong here, as things to press rather than things to read.
 */
const SUGGESTIONS = [
  'What can I do on this page?',
  'Summarise this in five points',
  'Compare these on price',
];

/**
 * The transcript.
 *
 * Markdown goes through `@heapcode/web-ui`'s renderer rather than a local copy.
 * That module already sanitizes with a hardened DOMPurify config, and it is
 * hardened in exactly one place today — the VS Code webview has its own,
 * weaker copy, and a security fix landed in only one of them (REUSE.md §4.1c).
 * Adding a third copy here is the failure state PLAN guardrail 6 names, so this
 * imports the hardened one. When `@heaplabs/chat-ui` is extracted after M2 this
 * import moves; the sanitization must not.
 *
 * It matters more here than anywhere else in the portfolio: from M1 this panel
 * renders text that originated on an arbitrary web page, and it does so inside
 * an extension origin that holds the user's provider key.
 */
export function MessageList({
  turns,
  ready,
  onRun,
}: {
  turns: Turn[];
  /** Whether there is a provider to send to. No suggestions if there is not. */
  ready: boolean;
  onRun: (prompt: string) => void;
}) {
  const end = useRef<HTMLDivElement>(null);

  // Follow the stream, but only from the bottom — yanking the view down while
  // someone is reading back through the transcript is worse than not following.
  useEffect(() => {
    const container = end.current?.parentElement;
    if (!container) return;
    const nearBottom =
      container.scrollHeight - container.scrollTop - container.clientHeight < 120;
    if (nearBottom) end.current?.scrollIntoView({ block: 'end' });
  }, [turns]);

  if (turns.length === 0) {
    return (
      <div className="empty">
        <span className="empty-mark" aria-hidden="true" />
        <h2 className="empty-title">Ask about the page you are on.</h2>
        <p className="empty-sub">
          heapbrowse reads the page only when a question needs it, and shows you every action
          before it takes one.
        </p>
        {ready && (
          <>
            <div className="empty-group">
              <span className="empty-label">Try</span>
              <div className="pills">
                {SUGGESTIONS.map((prompt) => (
                  <button key={prompt} type="button" className="pill" onClick={() => onRun(prompt)}>
                    {prompt}
                  </button>
                ))}
              </div>
            </div>
            <SavedTaskChips onRun={onRun} />
          </>
        )}
      </div>
    );
  }

  return (
    <div className="transcript">
      {turns.map((turn, i) => (
        <article key={i} className={`turn ${turn.role}`}>
          {turn.role === 'user' ? (
            <p className="user-text">{turn.content}</p>
          ) : (
            <>
              {/* Everything it did, behind one line. The answer is what the
                  user asked for; the run is what they may want to check. */}
              <RunSteps steps={hidden(turn)} streaming={turn.streaming} />
              {/* Except the rows it collected, which are not a step at all --
                  they are the deliverable for a comparison task, and the whole
                  point of collecting them was to stop the answer being prose
                  the model wrote about a table. Behind a fold they would be
                  worse than the prose. */}
              {visibleSteps(turn)
                .filter((step) => step.kind === 'data')
                .map((step, s) =>
                  step.kind === 'data' ? (
                    <DataTable key={`data-${s}`} dataset={step.dataset} />
                  ) : null,
                )}
              {turn.content && (
                <div
                  className="assistant-text"
                  dangerouslySetInnerHTML={{ __html: renderMarkdown(turn.content) }}
                />
              )}
            </>
          )}
          {turn.streaming && <span className="cursor" aria-label="responding" />}
          {turn.error && <p className="turn-error">{turn.error}</p>}
        </article>
      ))}
      <div ref={end} />
    </div>
  );
}
