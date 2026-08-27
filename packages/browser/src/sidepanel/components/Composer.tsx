import { useState, type KeyboardEvent } from 'react';

/**
 * The input. Enter sends, Shift+Enter makes a newline — the convention every
 * chat surface in this portfolio already uses.
 *
 * While a reply is streaming the send button becomes Stop rather than going
 * disabled, so cancelling is always one click from wherever the user's hand
 * already is.
 */
export function Composer({
  busy,
  disabled,
  includePage,
  onIncludePageChange,
  onSend,
  onStop,
}: {
  busy: boolean;
  disabled: boolean;
  includePage: boolean;
  onIncludePageChange: (value: boolean) => void;
  onSend: (text: string, includePage: boolean) => void;
  onStop: () => void;
}) {
  const [text, setText] = useState('');

  const submit = () => {
    if (busy || disabled || text.trim().length === 0) return;
    onSend(text, includePage);
    setText('');
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  };

  return (
    <div className="composer-area">
      {/* Reading the page is opt-in and per-message. It is the action that
          sends the contents of whatever the user is looking at to their
          endpoint, so it should never be something that happened silently. */}
      <label className="include-page">
        <input
          type="checkbox"
          checked={includePage}
          onChange={(e) => onIncludePageChange(e.target.checked)}
        />
        Include the current page
      </label>
      <div className="composer">
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder={disabled ? 'Configure a provider first' : 'Ask something…'}
        rows={2}
        disabled={disabled}
      />
        {busy ? (
          <button type="button" className="stop" onClick={onStop}>
            Stop
          </button>
        ) : (
          <button type="button" onClick={submit} disabled={disabled || text.trim().length === 0}>
            Send
          </button>
        )}
      </div>
    </div>
  );
}
