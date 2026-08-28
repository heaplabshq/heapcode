import { useEffect, useRef } from 'react';
import { renderMarkdown } from '@heapcode/web-ui/markdown';
import type { Turn } from '../useChat.js';
import { ToolChip } from './ToolChip.js';
import { DataTable } from './DataTable.js';

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
export function MessageList({ turns }: { turns: Turn[] }) {
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
      <div className="transcript empty">
        <p>Ask about the page you are on.</p>
        <p className="muted">
          It reads the page itself when a question needs it. Allow the site first, then ask
          something like &ldquo;what can I do here?&rdquo; or &ldquo;compare these on price&rdquo;.
        </p>
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
              {/* The run, in the order it happened: what the agent said, and
                  what it did, interleaved. The narration usually explains the
                  call that follows it, so the order carries meaning. */}
              {turn.steps?.map((step, s) => {
                if (step.kind === 'tool') return <ToolChip key={step.tool.id} tool={step.tool} />;
                if (step.kind === 'data') {
                  return <DataTable key={`data-${s}`} dataset={step.dataset} />;
                }
                if (step.kind === 'view') {
                  return (
                    <img
                      key={`view-${s}`}
                      className="view"
                      src={step.dataUrl}
                      alt="What the agent is looking at"
                    />
                  );
                }
                return (
                  <p key={`note-${s}`} className="note">
                    {step.text}
                  </p>
                );
              })}
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
