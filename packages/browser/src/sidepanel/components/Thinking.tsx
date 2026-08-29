import { useState } from 'react';
import { Icon } from './Icon.js';

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
 * The trailing dots on "Thinking" are drawn in CSS rather than written here, so
 * the label is one stable word for a screen reader and still visibly alive.
 */
export function Thinking({ text, streaming }: { text: string; streaming?: boolean }) {
  const [open, setOpen] = useState(false);
  const trimmed = text.trim();
  if (!trimmed) return null;

  return (
    <div className={`thinking${streaming ? ' live' : ''}`} data-open={open}>
      <button
        type="button"
        className="thinking-head"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span className="thinking-glyph" aria-hidden="true" />
        <span className="thinking-label">{streaming ? 'Thinking' : 'Thought'}</span>
        <Icon name="chevron" size={12} className="thinking-caret" />
      </button>
      {open && <div className="thinking-body">{trimmed}</div>}
    </div>
  );
}
