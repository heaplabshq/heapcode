import { useEffect, useRef, useState, type ReactNode } from 'react';

export interface ComposerProps {
  onSend(text: string): void;
  onCancel(): void;
  busy: boolean;
  disabled?: boolean;
  /** The bar under the input: permission mode on the left, model on the right. */
  footer?: ReactNode;
}

/**
 * The input.
 *
 * Enter sends, Shift+Enter and Option/Alt+Enter insert a newline, Escape
 * cancels a run in flight — the same protocol the terminal UI uses, so muscle
 * memory carries between the two.
 */
export function Composer({ onSend, onCancel, busy, disabled, footer }: ComposerProps): JSX.Element {
  const [text, setText] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null);

  // Grow with the content, up to a cap, instead of scrolling a two-line box.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`;
  }, [text]);

  useEffect(() => {
    if (!busy) ref.current?.focus();
  }, [busy]);

  const send = (): void => {
    const value = text.trim();
    if (!value || busy || disabled) return;
    onSend(value);
    setText('');
  };

  return (
    <div className="composer">
      <div className="composer-box">
        <textarea
          ref={ref}
          className="composer-input"
          rows={1}
          value={text}
          disabled={disabled}
          placeholder={disabled ? 'Connecting…' : busy ? 'Running — Esc to stop' : 'Ask anything, / for commands'}
          aria-label="Message"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape' && busy) {
              e.preventDefault();
              onCancel();
              return;
            }
            if (e.key === 'Enter' && !e.shiftKey && !e.altKey && !e.metaKey && !e.ctrlKey) {
              e.preventDefault();
              send();
            }
          }}
        />
        <div className="composer-actions">
          {busy ? (
            <button className="btn btn-danger" onClick={onCancel}>
              Stop
            </button>
          ) : (
            <button className="btn btn-primary" onClick={send} disabled={!text.trim() || disabled}>
              Send
            </button>
          )}
        </div>
      </div>
      {footer && <div className="composer-bar">{footer}</div>}
    </div>
  );
}
