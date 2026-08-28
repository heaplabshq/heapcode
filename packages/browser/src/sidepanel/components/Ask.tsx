import { useState, type KeyboardEvent } from 'react';
import type { AgentQuestion } from '../useAsk.js';
import { Icon } from './Icon.js';

/**
 * The agent asking for something only the user knows.
 *
 * Distinct from the permission confirmation on purpose. That one asks may I,
 * and its safe answer is no; this one asks what, and has no safe default at
 * all -- which is why "Skip" says plainly what it will cause rather than
 * looking like a dismissal.
 */
export function Ask({
  question,
  onAnswer,
}: {
  question: AgentQuestion;
  onAnswer: (answer: string | undefined) => void;
}) {
  const [text, setText] = useState('');

  const submit = () => {
    if (text.trim().length === 0) return;
    onAnswer(text.trim());
    setText('');
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      submit();
    }
  };

  return (
    <div className="prompt-sheet" role="dialog" aria-label="The agent has a question">
      <p className="confirm-head">
        <Icon name="ask" size={13} />
        heapbrowse is asking
      </p>
      <p className="ask-question">{question.question}</p>

      {question.options && question.options.length > 0 && (
        <div className="pills ask-options">
          {question.options.map((option) => (
            <button key={option} type="button" className="pill" onClick={() => onAnswer(option)}>
              {option}
            </button>
          ))}
        </div>
      )}

      <div className="ask-entry">
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Type your answer"
          autoFocus
        />
        <button type="button" className="primary" onClick={submit} disabled={!text.trim()}>
          Send
        </button>
      </div>

      {/* Never offered for a question the model flagged as gating an action:
          letting that resolve without an answer turns "may I?" into a yes. */}
      {!question.blocksAction && (
        <button type="button" className="ghost ask-skip" onClick={() => onAnswer(undefined)}>
          Skip — let it decide
        </button>
      )}
    </div>
  );
}
