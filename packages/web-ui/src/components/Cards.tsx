import { useEffect, useRef, useState } from 'react';
import type { UiAskUserParams, UiPermissionRequestParams } from '@heapcode/web-host/protocol';

export interface PendingPermission extends UiPermissionRequestParams {
  resolve(choice: 'allow' | 'session' | 'always' | 'deny'): void;
}

export interface PendingAsk extends UiAskUserParams {
  resolve(answer: string): void;
}

/**
 * The permission prompt.
 *
 * Renders `description` — the host's own rendering of what the call does, the
 * same sentence the CLI prompts with. It is not a summary the browser invented:
 * the browser must never be able to describe an action as something milder than
 * what the host is about to run.
 */
export function PermissionCard({ pending }: { pending: PendingPermission }): JSX.Element {
  const first = useRef<HTMLButtonElement>(null);
  useEffect(() => first.current?.focus(), []);

  return (
    <div className="card card-permission" role="alertdialog" aria-label="Permission required">
      <div className="card-title">
        <span className="card-badge">{pending.permission}</span>
        Allow this action?
      </div>
      <div className="card-body">{pending.description}</div>
      <div className="card-actions">
        <button ref={first} className="btn btn-primary" onClick={() => pending.resolve('allow')}>
          Allow once
        </button>
        <button className="btn" onClick={() => pending.resolve('session')}>
          Allow this session
        </button>
        {pending.allowPersist && (
          <button className="btn" onClick={() => pending.resolve('always')}>
            Always allow
          </button>
        )}
        <button className="btn btn-danger" onClick={() => pending.resolve('deny')}>
          Deny
        </button>
      </div>
    </div>
  );
}

/** The `ask_user` prompt: a question the model is blocked on. */
export function AskUserCard({ pending }: { pending: PendingAsk }): JSX.Element {
  const [text, setText] = useState('');
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);

  const submit = (value: string): void => pending.resolve(value);

  return (
    <div className="card card-ask" role="alertdialog" aria-label="The agent has a question">
      <div className="card-title">
        {pending.blocksAction && <span className="card-badge">gating</span>}
        The agent asks
      </div>
      <div className="card-body">{pending.question}</div>
      {pending.options?.length ? (
        <div className="card-actions">
          {pending.options.map((opt) => (
            <button key={opt} className="btn" onClick={() => submit(opt)}>
              {opt}
            </button>
          ))}
        </div>
      ) : (
        <form
          className="card-actions"
          onSubmit={(e) => {
            e.preventDefault();
            if (text.trim()) submit(text);
          }}
        >
          <input
            ref={input}
            className="card-input"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Your answer…"
            aria-label="Your answer"
          />
          <button className="btn btn-primary" type="submit" disabled={!text.trim()}>
            Answer
          </button>
        </form>
      )}
    </div>
  );
}
