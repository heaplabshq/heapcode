import { useRef, useState, type KeyboardEvent } from 'react';

export function Composer({
  disabled,
  running,
  onSend,
  onStop,
}: {
  disabled: boolean;
  running: boolean;
  onSend: (text: string) => void;
  onStop: () => void;
}): JSX.Element {
  const [text, setText] = useState('');
  const box = useRef<HTMLTextAreaElement>(null);

  const send = (): void => {
    const value = text.trim();
    if (!value || running) return;
    setText('');
    onSend(value);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    // Enter sends, Shift+Enter breaks the line. Escape stops a run — the same
    // key that dismisses everything else, and the one people reach for.
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
      return;
    }
    if (e.key === 'Escape' && running) {
      e.preventDefault();
      onStop();
    }
  };

  return (
    <div className="composer">
      <textarea
        ref={box}
        className="composer-input"
        value={text}
        rows={1}
        placeholder={disabled ? 'Connecting…' : 'Ask about the files in this folder'}
        disabled={disabled}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
        aria-label="Message"
      />
      {running ? (
        <button className="composer-button composer-stop" onClick={onStop}>
          Stop
        </button>
      ) : (
        <button className="composer-button" onClick={send} disabled={disabled || !text.trim()}>
          Send
        </button>
      )}
    </div>
  );
}
