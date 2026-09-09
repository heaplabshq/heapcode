import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { RpcClient } from '@heapcode/web-ui/rpc';
import {
  concat,
  emptyTranscript,
  fromMessages,
  reduce,
  settle,
  withUserMessage,
  type Transcript,
} from '@heapcode/web-ui/transcript';
import { CHAT_METHODS, CHAT_PROTOCOL_VERSION } from '@heapcode/chat-host/protocol';
import type {
  ChatAskUserParams,
  ChatBrowseFoldersResult,
  ChatConversationMeta,
  ChatEventParams,
  ChatHelloResult,
  ChatIndexStatus,
  ChatRecentFoldersResult,
  ChatSendMessageResult,
  ChatState,
} from '@heapcode/chat-host/protocol';
import { Composer } from './components/Composer.js';
import { FolderPicker } from './components/FolderPicker.js';
import { MessageList } from './components/MessageList.js';

const RPC_URL = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/rpc`;

interface Pending {
  params: ChatAskUserParams;
  answer: (text: string) => void;
}

export function App(): JSX.Element {
  const [status, setStatus] = useState<'connecting' | 'open' | 'closed'>('connecting');
  const [state, setState] = useState<ChatState>();
  const [transcript, setTranscript] = useState<Transcript>(emptyTranscript);
  const [conversations, setConversations] = useState<ChatConversationMeta[]>([]);
  const [index, setIndex] = useState<ChatIndexStatus>();
  const [error, setError] = useState<string>();
  const [picking, setPicking] = useState(false);
  const [ask, setAsk] = useState<Pending>();

  const seq = useRef(0);
  const runId = useRef<string>();

  const client = useMemo(() => new RpcClient(RPC_URL, setStatus), []);

  const refreshConversations = useCallback(() => {
    client
      .request<ChatConversationMeta[]>(CHAT_METHODS.conversations)
      .then(setConversations)
      .catch(() => undefined);
  }, [client]);

  const refreshIndex = useCallback(() => {
    client.request<ChatIndexStatus>(CHAT_METHODS.indexStatus).then(setIndex).catch(() => undefined);
  }, [client]);

  useEffect(() => {
    // Replace, never merge: the host sends the whole state (see
    // ChatStateChangedParams), and merging would make `runId` unclearable.
    client.onNotification(CHAT_METHODS.stateChanged, (raw) => setState(raw as ChatState));

    client.onNotification(CHAT_METHODS.indexChanged, (raw) => setIndex(raw as ChatIndexStatus));

    client.onNotification(CHAT_METHODS.event, (raw) => {
      const { event } = raw as ChatEventParams;
      setTranscript((t) => reduce(t, event, seq.current++));
    });

    // The host asks; the person answers. A run waiting on this is blocked, so
    // the card takes over the composer rather than sitting somewhere in the
    // scrollback where it can be missed.
    client.onRequest(CHAT_METHODS.askUser, async (raw) => {
      const params = raw as ChatAskUserParams;
      return new Promise<{ answer: string }>((resolve) => {
        setAsk({
          params,
          answer: (text) => {
            setAsk(undefined);
            resolve({ answer: text });
          },
        });
      });
    });

    client.onOpen = () => {
      client
        .request<ChatHelloResult>(CHAT_METHODS.hello, {
          protocolVersion: CHAT_PROTOCOL_VERSION,
          client: { name: 'heapchat-web' },
          resumeRunId: runId.current,
        })
        .then((hello) => {
          setState(hello.state);
          setError(undefined);
          // History, then the turn still in flight, then whatever events the
          // host buffered while no tab was attached — in that order, because
          // that is the order they happened.
          let next = fromMessages(hello.messages);
          if (hello.pending?.length) next = concat(next, fromMessages(hello.pending, 'p'));
          for (const buffered of hello.replay ?? []) next = reduce(next, buffered.event, seq.current++);
          setTranscript(next);
          runId.current = hello.activeRunId;
          refreshConversations();
          refreshIndex();
        })
        .catch((e: Error) => setError(e.message));
    };

    client.connect();
    return () => client.close();
  }, [client, refreshConversations, refreshIndex]);

  const send = (text: string): void => {
    const id = crypto.randomUUID();
    runId.current = id;
    setTranscript((t) => withUserMessage(t, text));
    setError(undefined);
    client
      .request<ChatSendMessageResult>(CHAT_METHODS.sendMessage, { text, runId: id })
      .catch((e: Error) => setError(e.message))
      .finally(() => {
        runId.current = undefined;
        setTranscript(settle);
        refreshConversations();
      });
  };

  const stop = (): void => {
    client.notify(CHAT_METHODS.cancel, { runId: runId.current ?? '' });
  };

  const newChat = (): void => {
    client
      .request<{ id: string }>(CHAT_METHODS.newConversation)
      .then(() => {
        setTranscript(emptyTranscript);
        refreshConversations();
      })
      .catch((e: Error) => setError(e.message));
  };

  const open = (id: string): void => {
    client
      .request<{ messages: Parameters<typeof fromMessages>[0] }>(CHAT_METHODS.openConversation, { id })
      .then((r) => {
        setTranscript(fromMessages(r.messages));
        refreshConversations();
      })
      .catch((e: Error) => setError(e.message));
  };

  const chooseFolder = (path: string): void => {
    setPicking(false);
    client
      .request<{ state: ChatState }>(CHAT_METHODS.setFolder, { path })
      .then((r) => {
        setState(r.state);
        setTranscript(emptyTranscript);
        refreshConversations();
        refreshIndex();
      })
      .catch((e: Error) => setError(e.message));
  };

  const running = Boolean(state?.runId);

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">Heap Chat</div>
        <button className="primary block" onClick={newChat} disabled={running}>
          New chat
        </button>
        <nav className="conversations">
          {conversations.map((c) => (
            <button
              key={c.id}
              className={`conversation${c.active ? ' active' : ''}`}
              onClick={() => open(c.id)}
              disabled={running}
            >
              {c.title}
            </button>
          ))}
        </nav>
        <footer className="sidebar-foot">
          <button className="folder" onClick={() => setPicking(true)} disabled={running}>
            <span className="folder-name">{state?.folderName ?? '…'}</span>
            <span className="folder-hint">Change folder</span>
          </button>
          {index ? (
            <div className="index-status">
              {index.state === 'indexing' && index.progress
                ? `Indexing ${index.progress.embedded}/${index.progress.total}`
                : index.state === 'ready'
                  ? `${index.files} files searchable`
                  : index.state === 'unconfigured'
                    ? 'No embeddings model — text search only'
                    : index.message ?? index.state}
            </div>
          ) : null}
        </footer>
      </aside>

      <main className="main">
        <header className="topbar">
          <span className="model">{state?.model ?? ''}</span>
          {state?.lan ? (
            <span className="lan-warning">
              Reachable from your network — anyone with the link can read this folder
            </span>
          ) : null}
          {status !== 'open' ? <span className="link-status">{status}</span> : null}
        </header>

        <MessageList
          transcript={transcript}
          empty={
            state?.folder
              ? `Reading ${state.folder}. Ask what is in it, and every answer will say which file it came from.`
              : 'Choose a folder to get started.'
          }
        />

        {error ? <div className="notice notice-warn">{error}</div> : null}

        {ask ? (
          <div className="ask">
            <p className="ask-question">{ask.params.question}</p>
            <div className="ask-options">
              {(ask.params.options ?? []).map((o) => (
                <button key={o} className="primary" onClick={() => ask.answer(o)}>
                  {o}
                </button>
              ))}
              {!ask.params.options?.length ? (
                <AskFreeform onAnswer={ask.answer} />
              ) : null}
            </div>
          </div>
        ) : (
          <Composer disabled={status !== 'open'} running={running} onSend={send} onStop={stop} />
        )}
      </main>

      {picking ? (
        <FolderPicker
          browse={(path) => client.request<ChatBrowseFoldersResult>(CHAT_METHODS.browseFolders, { path })}
          recent={() => client.request<ChatRecentFoldersResult>(CHAT_METHODS.recentFolders)}
          onChoose={chooseFolder}
          onClose={() => setPicking(false)}
        />
      ) : null}
    </div>
  );
}

function AskFreeform({ onAnswer }: { onAnswer: (text: string) => void }): JSX.Element {
  const [text, setText] = useState('');
  return (
    <div className="composer">
      <textarea
        className="composer-input"
        rows={1}
        value={text}
        autoFocus
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            if (text.trim()) onAnswer(text.trim());
          }
        }}
        aria-label="Your answer"
      />
      <button className="composer-button" onClick={() => text.trim() && onAnswer(text.trim())}>
        Answer
      </button>
    </div>
  );
}
