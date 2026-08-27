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
  onSend,
  onStop,
}: {
  busy: boolean;
  disabled: boolean;
  onSend: (text: string) => void;
  onStop: () => void;
}) {
  const [text, setText] = useState('');

  const submit = () => {
    if (busy || disabled || text.trim().length === 0) return;
    onSend(text);
    setText('');
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  };

  return (
    // Reading the page is no longer a per-message choice: the agent decides
    // when a question needs the page. What gates it is the per-site grant, which
    // is shown in the header and is the thing that actually controls exposure.
    <div className="composer-area">
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
