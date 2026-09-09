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
import { Sidebar } from '@heapcode/web-ui/components/Sidebar';
import { Composer } from '@heapcode/web-ui/components/Composer';
import { MessageList } from '@heapcode/web-ui/components/MessageList';
import { ProductToggle } from '@heapcode/web-ui/components/ProductToggle';
import { CHAT_METHODS, CHAT_PROTOCOL_VERSION } from '@heapcode/chat-host/protocol';
import type {
  ChatAskUserParams,
  ChatBrowseFoldersResult,
  ChatConversationMeta,
  ChatEventParams,
  ChatGroundingParams,
  ChatHelloResult,
  ChatIndexStatus,
  ChatMemoryResult,
  ChatRecentFoldersResult,
  ChatSendMessageResult,
  ChatState,
} from '@heapcode/chat-host/protocol';
import { FolderPicker } from './components/FolderPicker.js';
import { GroundingBadge } from './components/GroundingBadge.js';
import { MemoryPanel } from './components/MemoryPanel.js';

/**
 * Heap Chat's shell.
 *
 * Deliberately the same shell as Heap Code's: the rail, the composer, the
 * transcript and the stylesheet are `@heapcode/web-ui`'s, used rather than
 * imitated. An earlier version of this file had its own stylesheet and its own
 * components, on the reasoning that heapbrowse does the same — but heapbrowse
 * is a browser side panel with a different shape, and these two sit behind one
 * switcher on one origin. Two look-alike shells behind a tab is exactly where
 * a design system gets noticed for being absent.
 *
 * What stays this product's own: which tools the agent has, what it is told it
 * is, the folder picker, the grounding badge and memory. The shell is shared;
 * the product is not.
 */

/**
 * Where this page's socket is, and whether Heap Code is served beside it.
 *
 * Both are stamped on `<html>` by the host, because the page genuinely cannot
 * work them out: served by `heapcode chat` it sits at the root with its socket
 * at `/rpc`, and mounted inside `heapcode web` it sits under `/chat` with its
 * socket at `/chat/rpc`. Assuming either one breaks the other.
 *
 * The defaults are the standalone case, so a page served without the stamp
 * still connects.
 */
const RPC_PATH = document.documentElement.dataset.rpcPath ?? '/rpc';
const HAS_CODE = document.documentElement.dataset.sibling === 'code';
/** The mount prefix, derived from the socket path — `/chat/rpc` → `/chat`. */
const BASE = RPC_PATH.replace(/\/rpc$/, '');

const RPC_URL = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${RPC_PATH}`;

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
  const [notice, setNotice] = useState<string>();
  const [picking, setPicking] = useState(false);
  const [showMemory, setShowMemory] = useState(false);
  const [ask, setAsk] = useState<Pending>();
  const [grounding, setGrounding] = useState<ChatGroundingParams['grounding']>();
  const [railCollapsed, setRailCollapsed] = useState(
    () => localStorage.getItem('heapchat.rail') === 'collapsed',
  );
  const [runStartedAt, setRunStartedAt] = useState<number>();

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
    // Replace, never merge: the host sends the whole state, and merging would
    // make `runId` unclearable.
    client.onNotification(CHAT_METHODS.stateChanged, (raw) => setState(raw as ChatState));
    client.onNotification(CHAT_METHODS.indexChanged, (raw) => setIndex(raw as ChatIndexStatus));
    client.onNotification(CHAT_METHODS.grounding, (raw) =>
      setGrounding((raw as ChatGroundingParams).grounding),
    );

    client.onNotification(CHAT_METHODS.event, (raw) => {
      const { event } = raw as ChatEventParams;
      setTranscript((t) => reduce(t, event, seq.current++));
    });

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

  const busy = Boolean(state?.runId);

  const send = (text: string): void => {
    const id = crypto.randomUUID();
    runId.current = id;
    setRunStartedAt(Date.now());
    setTranscript((t) => withUserMessage(t, text));
    setError(undefined);
    setGrounding(undefined);
    client
      .request<ChatSendMessageResult>(CHAT_METHODS.sendMessage, { text, runId: id })
      .catch((e: Error) => setError(e.message))
      .finally(() => {
        runId.current = undefined;
        setRunStartedAt(undefined);
        setTranscript(settle);
        refreshConversations();
      });
  };

  const cancel = (): void => {
    client.notify(CHAT_METHODS.cancel, { runId: runId.current ?? '' });
  };

  const newConversation = (): void => {
    client
      .request<{ id: string }>(CHAT_METHODS.newConversation)
      .then(() => {
        setTranscript(emptyTranscript);
        setGrounding(undefined);
        refreshConversations();
      })
      .catch((e: Error) => setError(e.message));
  };

  const openConversation = (id: string): void => {
    client
      .request<{ messages: Parameters<typeof fromMessages>[0] }>(CHAT_METHODS.openConversation, { id })
      .then((r) => {
        setTranscript(fromMessages(r.messages));
        setGrounding(undefined);
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
        setGrounding(undefined);
        refreshConversations();
        refreshIndex();
      })
      .catch((e: Error) => setError(e.message));
  };

  return (
    <div className="app">
      <div className="body">
        <Sidebar
          brand="Heap Chat"
          // Absent when Heap Code is not served here: a switcher with one
          // working half teaches people the control is broken.
          toggle={HAS_CODE ? <ProductToggle current="chat" chatPath={`${BASE}/`} /> : undefined}
          collapsed={railCollapsed}
          onToggleCollapsed={() =>
            setRailCollapsed((v) => {
              localStorage.setItem('heapchat.rail', v ? 'expanded' : 'collapsed');
              return !v;
            })
          }
          conversations={conversations}
          onOpen={openConversation}
          onNew={newConversation}
          busy={busy}
          state={state}
          status={status}
          // No artifacts and no command palette here: neither exists in this
          // product, and a rail row that opens nothing is worse than its
          // absence.
          onOpenSettings={() => setShowMemory(true)}
        />

        <main className="chat">
          {state?.lan && (
            <div className="banner banner-warn" role="alert">
              <strong>Exposed to your network.</strong>
              <span>
                Anyone who can reach this address and holds the launch token can read every file in{' '}
                {state.folderName || 'this folder'}.
              </span>
            </div>
          )}
          {status === 'closed' && <div className="banner">Disconnected — reconnecting…</div>}
          {error && <div className="banner banner-error">{error}</div>}
          {index?.missingParsers?.length ? (
            // Load-bearing: a skipped file type and an empty folder look
            // identical to whoever asked the question.
            <div className="banner banner-warn">
              Not reading {index.missingParsers.join(', ')} — parser not installed.
            </div>
          ) : null}
          {notice && (
            <div className="banner" onClick={() => setNotice(undefined)} role="status">
              {notice}
            </div>
          )}

          <MessageList
            transcript={transcript}
            busy={busy}
            runStartedAt={runStartedAt}
            empty={{
              title: 'Heap Chat',
              body: state?.folder
                ? `Ask about the files in ${state.folderName}. Every answer says which file it came from.`
                : 'Choose a folder to get started.',
              hint: (
                <>
                  <span>Documents, spreadsheets, PDFs and photos</span>
                  <span>
                    <span className="empty-sep" aria-hidden>
                      ·
                    </span>
                    Nothing here changes your files
                  </span>
                </>
              ),
            }}
          />

          {ask && (
            <div className="card" role="alertdialog" aria-label="Question">
              <div className="card-body">{ask.params.question}</div>
              <div className="card-actions">
                {(ask.params.options ?? []).map((o) => (
                  <button key={o} className="btn btn-primary" onClick={() => ask.answer(o)}>
                    {o}
                  </button>
                ))}
                {!ask.params.options?.length && <AskFreeform onAnswer={ask.answer} />}
              </div>
            </div>
          )}

          {grounding && !busy ? <GroundingBadge grounding={grounding} /> : null}

          <Composer
            onSend={send}
            onCancel={cancel}
            onReject={setNotice}
            busy={busy}
            disabled={status !== 'open'}
            footer={
              <>
                {/* Same classes as Heap Code's workspace picker, so the two
                    composer bars sit at the same height with the same weight. */}
                <button
                  className="btn picker-btn"
                  onClick={() => setPicking(true)}
                  disabled={busy}
                  title={state?.folder ?? 'Choose a folder'}
                >
                  <IconFolder />
                  <span className="picker-value">{state?.folderName ?? 'no folder'}</span>
                </button>
                <span className="composer-bar-right">
                  <span className="bar-select" aria-live="polite">
                    {index?.state === 'indexing' && index.progress
                      ? `indexing ${index.progress.embedded}/${index.progress.total}`
                      : index?.files
                        ? `${index.files} files searchable`
                        : ''}
                  </span>
                </span>
              </>
            }
          />
        </main>
      </div>

      {showMemory ? (
        <MemoryPanel
          load={() => client.request<ChatMemoryResult>(CHAT_METHODS.memory)}
          forget={(id) => client.request<null>(CHAT_METHODS.forget, { id }).then(() => undefined)}
          onClose={() => setShowMemory(false)}
        />
      ) : null}

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

function IconFolder(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden="true">
      <path d="M2 4.2A1.2 1.2 0 0 1 3.2 3h2.5l1.2 1.5h5.9A1.2 1.2 0 0 1 14 5.7v6.1A1.2 1.2 0 0 1 12.8 13H3.2A1.2 1.2 0 0 1 2 11.8z" strokeLinejoin="round" />
    </svg>
  );
}

function AskFreeform({ onAnswer }: { onAnswer: (text: string) => void }): JSX.Element {
  const [text, setText] = useState('');
  return (
    <>
      <input
        className="card-input"
        value={text}
        autoFocus
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && text.trim()) onAnswer(text.trim());
        }}
        aria-label="Your answer"
      />
      <button className="btn btn-primary" onClick={() => text.trim() && onAnswer(text.trim())}>
        Answer
      </button>
    </>
  );
}
