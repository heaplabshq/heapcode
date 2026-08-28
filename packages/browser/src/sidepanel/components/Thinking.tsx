import { useState } from 'react';

/**
 * The model thinking, collapsed.
 *
 * Reasoning models produce a great deal of this and none of it is addressed to
 * the user. Rendered as narration it reads as the assistant talking to itself —
 * paragraphs of "wait, let me reconsider" between the user and the answer they
 * asked for.
 *
 * Collapsed rather than hidden, because the times it matters are the times it
 * matters a lot: an agent that did something surprising usually explained why to
 * itself first, and that is the only record of it.
 *
 * It expands while streaming if the user opens it, and never auto-expands —
 * a block that grows on its own pushes the answer off the screen as it arrives.
 */
export function Thinking({ text, streaming }: { text: string; streaming?: boolean }) {
  const [open, setOpen] = useState(false);
  const trimmed = text.trim();
  if (!trimmed) return null;

  return (
    <div className={`thinking${streaming ? ' live' : ''}`}>
      <button
        type="button"
        className="thinking-head"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span className="thinking-glyph" aria-hidden="true" />
        {streaming ? 'Thinking…' : 'Thought'}
        <span className="thinking-caret" aria-hidden="true">
          {open ? '▾' : '▸'}
        </span>
      </button>
      {open && <div className="thinking-body">{trimmed}</div>}
    </div>
  );
}
