import { useEffect, useRef, useState } from 'react';
import type { RpcClient } from '@heapcode/web-ui/rpc';
import { MessageList } from '@heapcode/web-ui/components/MessageList';
import { Composer } from '@heapcode/web-ui/components/Composer';
import {
  concat,
  emptyTranscript,
  fromMessages,
  reduce,
  settle,
  withUserMessage,
} from '@heapcode/web-ui/transcript';
import { useTranscript } from '@heapcode/web-ui/useTranscript';
import {
  CHAT_METHODS,
  CHAT_PROTOCOL_VERSION,
  type ChatAskUserParams,
  type ChatEventParams,
  type ChatHelloResult,
  type ChatPermissionParams,
  type ChatPermissionResult,
  type ChatState,
} from '@heapcode/chat-host/protocol';
import { lineDiff } from './diff.js';
import { describeSteps } from './steps.js';

/**
 * "Ask your notes" (HEAPNOTES_PHASE2_PLAN §2A): Heap Chat's conversation, on
 * the same socket as the notes, with Heapnotes' persona on the host. Uses
 * Heap Code's own transcript and composer, so the AI's work — searches,
 * notes read — shows the same way it does there.
 *
 * A change the assistant proposes arrives as a permission request carrying a
 * diff; nothing is written unless Apply is pressed.
 */
interface Props {
  client: RpcClient;
  /** Bumped on every (re)connection: the panel says hello again. */
  connection: number;
  /** A question to send as soon as the panel can — from `?question` in search. */
  question?: { text: string; seq: number };
  onOpenLink(target: string): void;
  onClose(): void;
  /** The open note, when questions are about it ("summarize this"). */
  about?: { title: string };
  onClearAbout?(): void;
}

interface PendingChange {
  params: ChatPermissionParams;
  decide(granted: boolean): void;
}

interface PendingQuestion {
  params: ChatAskUserParams;
  answer(text: string): void;
}

export function AskPanel({
  client,
  connection,
  question,
  onOpenLink,
  onClose,
  about,
  onClearAbout,
}: Props): JSX.Element {
  const seq = useRef(0);
  const { transcript, setTranscript, applyEvent } = useTranscript(emptyTranscript, seq);
  const [state, setState] = useState<ChatState>();
  const [error, setError] = useState<string>();
  const [change, setChange] = useState<PendingChange>();
  const [asked, setAsked] = useState<PendingQuestion>();
  const [startedAt, setStartedAt] = useState<number>();
  const runId = useRef<string>();
  const sentQuestion = useRef(0);

  useEffect(() => {
    client.onNotification(CHAT_METHODS.stateChanged, (raw) => setState(raw as ChatState));
    client.onNotification(CHAT_METHODS.event, (raw) => applyEvent((raw as ChatEventParams).event));
    client.onRequest(
      CHAT_METHODS.permission,
      (raw) =>
        new Promise<ChatPermissionResult>((resolve) =>
          setChange({
            params: raw as ChatPermissionParams,
            decide: (granted) => {
              setChange(undefined);
              resolve({ granted });
            },
          }),
        ),
    );
    client.onRequest(
      CHAT_METHODS.askUser,
      (raw) =>
        new Promise<{ answer: string }>((resolve) =>
          setAsked({
            params: raw as ChatAskUserParams,
            answer: (text) => {
              setAsked(undefined);
              resolve({ answer: text });
            },
          }),
        ),
    );
  }, [client, applyEvent]);

  // Hello on every connection, so a reload or a dropped socket picks the
  // conversation — and a run still going — back up.
  useEffect(() => {
    if (!connection) return;
    client
      .request<ChatHelloResult>(CHAT_METHODS.hello, {
        protocolVersion: CHAT_PROTOCOL_VERSION,
        client: { name: 'heapnotes-web' },
        resumeRunId: runId.current,
        capabilities: { browser: false },
      })
      .then((hello) => {
        setState(hello.state);
        setError(undefined);
        let next = fromMessages(hello.messages);
        if (hello.pending?.length) next = concat(next, fromMessages(hello.pending, 'p'));
        for (const buffered of hello.replay ?? [])
          next = reduce(next, buffered.event, seq.current++);
        setTranscript(next);
        runId.current = hello.activeRunId;
      })
      .catch((e: Error) => setError(e.message));
  }, [client, connection, setTranscript]);

  const busy = Boolean(state?.runId);

  const send = (text: string): void => {
    const id = crypto.randomUUID();
    runId.current = id;
    setStartedAt(Date.now());
    setError(undefined);
    setTranscript((t) => withUserMessage(t, text));
    client
      .request(CHAT_METHODS.sendMessage, { text, runId: id })
      .catch((e: Error) => setError(e.message))
      .finally(() => {
        runId.current = undefined;
        setStartedAt(undefined);
        setTranscript(settle);
      });
  };

  useEffect(() => {
    if (!question || question.seq === sentQuestion.current || !state || busy) return;
    sentQuestion.current = question.seq;
    send(question.text);
  }, [question, state, busy]);

  const newChat = (): void => {
    client
      .request(CHAT_METHODS.newConversation)
      .then(() => setTranscript(emptyTranscript))
      .catch((e: Error) => setError(e.message));
  };

  return (
    <aside
      className="notes-ask"
      aria-label="Ask your notes"
      onClick={(e) => {
        const link = (e.target as HTMLElement).closest<HTMLElement>('a[data-wikilink]');
        if (!link) return;
        e.preventDefault();
        onOpenLink(link.dataset.wikilink ?? '');
      }}
    >
      <div className="notes-ask-head">
        <span>Ask your notes</span>
        <span className="notes-ask-tools">
          <button
            className="btn btn-quiet btn-sm"
            onClick={newChat}
            disabled={busy}
            title="Start a new conversation"
          >
            New
          </button>
          <button className="btn btn-quiet btn-sm" onClick={onClose} aria-label="Close Ask">
            ✕
          </button>
        </span>
      </div>
      {state?.setup && (
        <div className="notes-banner">
          <span>{state.setup} Settings are under Customize in Heap Code.</span>
          <a className="btn btn-sm" href="/">
            Open Heap Code
          </a>
        </div>
      )}
      {error && (
        <div className="notes-banner notes-banner-bad" role="alert">
          <span>{error}</span>
        </div>
      )}
      <div className="notes-ask-body">
        <MessageList
          transcript={transcript}
          busy={busy}
          {...(busy && startedAt ? { runStartedAt: startedAt } : {})}
          wikiLinks
          // The answer up front; the searches and reads behind one line.
          foldSteps={{ describe: describeSteps }}
          empty={{
            title: 'Ask about your notes',
            body: 'It searches your notes by words and by meaning, reads what it finds, and answers with links to the notes it used. It can also draft changes — you see each one and apply it or not. Notes tagged #private are hidden from it.',
          }}
        />
      </div>
      {about && (
        <div className="ask-about" title="Questions like “summarize this” mean this note">
          <span>
            About <strong>{about.title || 'Untitled'}</strong>
          </span>
          {onClearAbout && (
            <button
              className="btn btn-quiet btn-sm"
              onClick={onClearAbout}
              aria-label="Ask about all notes instead"
            >
              ✕
            </button>
          )}
        </div>
      )}
      {change && <ChangeCard pending={change} />}
      {asked && <QuestionCard pending={asked} />}
      <Composer
        onSend={(text) => send(text)}
        onCancel={() => void client.request(CHAT_METHODS.cancel, {}).catch(() => undefined)}
        busy={busy}
        disabled={Boolean(state?.setup) || !state}
        placeholder="Ask your notes…"
        footer={state?.model ? <span className="notes-dim">{state.model}</span> : undefined}
      />
    </aside>
  );
}

function ChangeCard({ pending }: { pending: PendingChange }): JSX.Element {
  const { params } = pending;
  const change = params.change;
  return (
    <div className="ask-card" role="dialog" aria-label="Proposed change">
      <div className="ask-card-title">{change?.title ?? `Run ${params.tool}?`}</div>
      {change && (change.before || change.after) && (
        <pre className="ask-diff">
          {lineDiff(change.before, change.after).map((l, i) =>
            l.kind === 'fold' ? (
              <div key={i} className="diff-fold">
                ⋯ {l.count} unchanged line{l.count === 1 ? '' : 's'}
              </div>
            ) : (
              <div key={i} className={`diff-${l.kind}`}>
                <span className="diff-mark">
                  {l.kind === 'add' ? '+' : l.kind === 'del' ? '−' : ' '}
                </span>
                {l.text || ' '}
              </div>
            ),
          )}
        </pre>
      )}
      {!change && <pre className="ask-diff">{JSON.stringify(params.args, null, 2)}</pre>}
      <div className="ask-card-actions">
        <button className="btn btn-quiet btn-sm" onClick={() => pending.decide(false)}>
          Discard
        </button>
        <button className="btn btn-primary btn-sm" autoFocus onClick={() => pending.decide(true)}>
          {change ? 'Apply' : 'Allow'}
        </button>
      </div>
    </div>
  );
}

function QuestionCard({ pending }: { pending: PendingQuestion }): JSX.Element {
  const [text, setText] = useState('');
  return (
    <div className="ask-card" role="dialog" aria-label="The assistant asks">
      <div className="ask-card-title">{pending.params.question}</div>
      {pending.params.options && (
        <div className="ask-card-options">
          {pending.params.options.map((o) => (
            <button key={o} className="btn btn-sm" onClick={() => pending.answer(o)}>
              {o}
            </button>
          ))}
        </div>
      )}
      <form
        className="ask-card-answer"
        onSubmit={(e) => {
          e.preventDefault();
          if (text.trim()) pending.answer(text.trim());
        }}
      >
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Your answer"
          aria-label="Your answer"
        />
        <button className="btn btn-sm" type="submit" disabled={!text.trim()}>
          Send
        </button>
      </form>
    </div>
  );
}
