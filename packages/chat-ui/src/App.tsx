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
import { Settings } from '@heapcode/web-ui/components/Settings';
import { WorkspacePicker } from '@heapcode/web-ui/components/WorkspacePicker';
import { ModelPicker } from '@heapcode/web-ui/components/ModelPicker';
import { CHAT_METHODS, CHAT_PROTOCOL_VERSION } from '@heapcode/chat-host/protocol';
import type {
  ChatAskUserParams,
  ChatBrowseFoldersResult,
  ChatConversationMeta,
  ChatEventParams,
  ChatGroundingParams,
  ChatHelloResult,
  ChatIndexStatus,
  ChatMcpSignInResult,
  ChatMemoryResult,
  ChatRecentFoldersResult,
  ChatArtifactMeta,
  ChatArtifactResult,
  ChatArtifactsResult,
  ChatFileTreeResult,
  ChatReadFileResult,
  ChatSendMessageResult,
  ChatSettings,
  ChatState,
} from '@heapcode/chat-host/protocol';
import { GroundingBadge } from './components/GroundingBadge.js';
import { ChatPanel, type ChatPanelTab } from './components/Panel.js';
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
  const [settings, setSettings] = useState<ChatSettings>();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [showMemory, setShowMemory] = useState(false);
  const [ask, setAsk] = useState<Pending>();
  const [grounding, setGrounding] = useState<ChatGroundingParams['grounding']>();
  const [railCollapsed, setRailCollapsed] = useState(
    () => localStorage.getItem('heapchat.rail') === 'collapsed',
  );
  const [runStartedAt, setRunStartedAt] = useState<number>();
  const [panelOpen, setPanelOpen] = useState(false);
  const [panelTab, setPanelTab] = useState<ChatPanelTab>('files');
  const [artifacts, setArtifacts] = useState<ChatArtifactMeta[]>([]);
  const [selectedArtifact, setSelectedArtifact] = useState<string>();
  const [openPath, setOpenPath] = useState<string>();

  const seq = useRef(0);
  const runId = useRef<string>();

  const client = useMemo(() => new RpcClient(RPC_URL, setStatus), []);

  const refreshConversations = useCallback(() => {
    client
      .request<ChatConversationMeta[]>(CHAT_METHODS.conversations)
      .then(setConversations)
      .catch(() => undefined);
  }, [client]);

  const refreshArtifacts = useCallback(() => {
    client
      .request<ChatArtifactsResult>(CHAT_METHODS.artifacts)
      .then((r) => setArtifacts(r.artifacts))
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

    // Something was made — show it, and open the panel on it. An artifact the
    // person has to go looking for may as well have been pasted into the chat.
    client.onNotification(CHAT_METHODS.artifactChanged, (raw) => {
      const meta = raw as ChatArtifactMeta;
      refreshArtifacts();
      setSelectedArtifact(meta.id);
      setPanelTab('made');
      setPanelOpen(true);
    });

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
          refreshArtifacts();
        })
        .catch((e: Error) => setError(e.message));
    };

    client.connect();
    return () => client.close();
  }, [client, refreshConversations, refreshIndex, refreshArtifacts]);

  const busy = Boolean(state?.runId);

  /** Re-read after every edit, so the dialog shows what was actually saved. */
  const refreshSettings = useCallback(() => {
    client.request<ChatSettings>(CHAT_METHODS.settings).then(setSettings).catch(() => undefined);
  }, [client]);

  const openSettings = (): void => {
    refreshSettings();
    setSettingsOpen(true);
  };

  /** Every settings mutation: send it, then re-read. */
  const edit = (method: string, params?: unknown): void => {
    client
      .request(method, params)
      .then(refreshSettings)
      .catch((e: Error) => setError(e.message));
  };

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
    // A request, not a notification. The host registers `chat/cancel` as a
    // request handler, and RpcPeer routes notifications only to notification
    // handlers (rpc.ts:155) — so a notify here reached nothing at all, and
    // Stop did not stop anything.
    void client.request(CHAT_METHODS.cancel, {}).catch(() => undefined);
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

  const chooseFolder = async (path: string): Promise<void> => {
    const r = await client.request<{ state: ChatState }>(CHAT_METHODS.setFolder, { path });
    setState(r.state);
    setTranscript(emptyTranscript);
    setGrounding(undefined);
    refreshConversations();
    refreshIndex();
    // Artifacts are per folder — the host rebuilds its store on a switch, but
    // the page holds the previous folder's list until it asks again. Without
    // this the panel showed another folder's documents, which is a worse lie
    // than showing none: they look like they belong to the folder you just
    // opened. The selection goes too, or it names an id the new store has
    // never heard of.
    setSelectedArtifact(undefined);
    refreshArtifacts();
    // Same reason: the last folder's file listing must not linger.
    setOpenPath(undefined);
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
          onOpenSettings={openSettings}
          extraNav={<MemoryRailItem collapsed={railCollapsed} onClick={() => setShowMemory(true)} />}
        />

        <main className="chat">
          <div className="chat-tools">
            {/* Icon only, and the artifact glyph rather than a panel outline:
                what the panel is mostly for here is the documents this has
                made, and "Made" is the tab a person comes back to. The count
                sits on it so an artifact does not need the panel open to be
                noticed. */}
            <button
              className={`chat-tool chat-tool-icon ${panelOpen ? 'chat-tool-on' : ''}`}
              onClick={() => setPanelOpen((v) => !v)}
              aria-pressed={panelOpen}
              aria-label={panelOpen ? 'Hide the panel' : 'Show the panel'}
              title={panelOpen ? 'Hide the panel' : 'Files, what has been made, and where answers came from'}
            >
              <IconArtifact />
              {artifacts.length > 0 && <span className="chat-tool-badge">{artifacts.length}</span>}
            </button>
          </div>

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
            // A path in a tool chip opens in the panel, the same gesture Heap
            // Code has — here it reads a document rather than showing a diff.
            onOpenPath={(path) => {
              setOpenPath(path);
              setPanelTab('files');
              setPanelOpen(true);
            }}
            // What it can actually do, rather than the narrowest thing it
            // does. "Ask about the files in X" described a file Q&A tool; the
            // roster is read + web search + memory + producing documents, and
            // two cases in the eval exist to prove general questions are
            // answered rather than refused.
            //
            // The read-only constraint is stated as a reason to use it, not
            // as an apology. It is why you would point this at six years of
            // records.
            empty={{
              title: 'Heap Chat',
              body: state?.folder
                ? `Work with what is in ${state.folderName} — read it, search it, ask about it, and draft from it. Anything grounded in your files says which one it came from.`
                : 'Choose a folder to get started.',
              hint: (
                <>
                  <span>Documents, spreadsheets, PDFs and photos</span>
                  <span>
                    <span className="empty-sep" aria-hidden>
                      ·
                    </span>
                    The web when your files fall short
                  </span>
                  <span>
                    <span className="empty-sep" aria-hidden>
                      ·
                    </span>
                    It writes new documents, never over yours
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

          {grounding && !busy ? (
            <GroundingBadge
              grounding={grounding}
              onOpen={() => {
                setPanelTab('sources');
                setPanelOpen(true);
              }}
            />
          ) : null}

          <Composer
            onSend={send}
            onCancel={cancel}
            onReject={setNotice}
            busy={busy}
            disabled={status !== 'open'}
            footer={
              <>
                {/* Heap Code's own picker and model switcher, not lookalikes:
                    the folder chip on the left and the model on the right sit
                    exactly where they do in the other product. What is between
                    them differs — Heap Code has a permission mode there, and
                    this roster has nothing to gate — so the slot carries the
                    index state instead, which is the thing worth knowing here. */}
                <WorkspacePicker
                  current={state?.folder ?? ''}
                  busy={busy}
                  loadWorkspaces={() => client.request<ChatRecentFoldersResult>(CHAT_METHODS.recentFolders)}
                  browse={(path) => client.request<ChatBrowseFoldersResult>(CHAT_METHODS.browseFolders, { path })}
                  onPick={chooseFolder}
                />

                <span className="bar-select" aria-live="polite">
                  {index?.state === 'indexing' && index.progress
                    ? `indexing ${index.progress.embedded}/${index.progress.total}`
                    : index?.files
                      ? `${index.files} files searchable`
                      : ''}
                </span>

                <span className="composer-bar-right">
                  <ModelPicker
                    current={state?.model ?? ''}
                    placement="up"
                    listModels={() =>
                      client
                        .request<{ models: Array<{ id: string }> }>(CHAT_METHODS.listModels)
                        .then((r) => r.models)
                    }
                    onPick={(model) => {
                      void client.request(CHAT_METHODS.setModel, { model }).catch(() => undefined);
                    }}
                  />
                </span>
              </>
            }
          />
        </main>

        {panelOpen && (
          <ChatPanel
            tab={panelTab}
            onTab={setPanelTab}
            onClose={() => setPanelOpen(false)}
            loadTree={(path) => client.request<ChatFileTreeResult>(CHAT_METHODS.fileTree, { path })}
            loadFile={(path) => client.request<ChatReadFileResult>(CHAT_METHODS.readFile, { path })}
            openPath={openPath}
            artifacts={artifacts}
            selectedArtifact={selectedArtifact}
            onSelectArtifact={setSelectedArtifact}
            loadArtifact={(id, version) =>
              client.request<ChatArtifactResult>(CHAT_METHODS.artifact, { id, version })
            }
            onSaveArtifact={(id, path, version) => {
              client
                .request(CHAT_METHODS.saveArtifact, { id, path, version })
                .then(() => setNotice(`Saved to ${path}`))
                .catch((e: Error) => setError(e.message));
            }}
            grounding={grounding}
            indexStatus={index}
            onReindex={() => {
              void client.request(CHAT_METHODS.reindex).catch(() => undefined);
              refreshIndex();
            }}
          />
        )}
      </div>

      {showMemory ? (
        <MemoryPanel
          load={() => client.request<ChatMemoryResult>(CHAT_METHODS.memory)}
          forget={(id) => client.request<null>(CHAT_METHODS.forget, { id }).then(() => undefined)}
          onClose={() => setShowMemory(false)}
        />
      ) : null}

      {settingsOpen ? (
        <Settings
          settings={settings}
          onClose={() => setSettingsOpen(false)}
          // Only the pages whose subject is genuinely shared config. The rest
          // are Heap Code's: personas, permissions, MCP, skills — and Memory,
          // which there means the project instructions in HEAPCODE.md. This
          // product's memory is about the person, not the folder, so it gets
          // its own rail row rather than a page whose description would be
          // false here.
          pages={['providers', 'search', 'connectors']}
          onSaveProfile={(profile, apiKey) => edit(CHAT_METHODS.saveProfile, { profile, apiKey })}
          onDeleteProfile={(name) => edit(CHAT_METHODS.deleteProfile, { name })}
          onUseProfile={(name) => edit(CHAT_METHODS.useProfile, { name })}
          onSetRole={(role, assignment) => edit(CHAT_METHODS.setRole, { role, assignment })}
          onSetWebSearch={(patch) => edit(CHAT_METHODS.setWebSearch, patch)}
          listConnectionModels={(connection) =>
            client
              .request<{ models: string[] }>(CHAT_METHODS.listConnectionModels, { connection })
              .then((r) => r.models)
          }
          listModels={(profileName) =>
            client
              .request<{ models: Array<{ id: string }> }>(CHAT_METHODS.listModels, { profileName })
              .then((r) => r.models.map((m) => m.id))
          }
          probeProvider={(params) => client.request(CHAT_METHODS.probeProvider, params)}
          // Not offered on these pages, but required by the props: no persona,
          // no sub-agents, no permission grants here.
          onSetPersona={() => {}}
          onToggleSubAgents={() => {}}
          onToggleNativeTools={() => {}}
          onResetPermissions={() => {}}
          onSaveMcpServer={(name, spec) => edit(CHAT_METHODS.saveMcpServer, { name, spec })}
          onDeleteMcpServer={(name) => edit(CHAT_METHODS.deleteMcpServer, { name })}
          onSignInMcpServer={async (name) => {
            const res = (await client.request(CHAT_METHODS.signInMcpServer, { name })) as ChatMcpSignInResult;
            return res.authorizationUrl;
          }}
          onSignOutMcpServer={(name) => edit(CHAT_METHODS.signOutMcpServer, { name })}
        />
      ) : null}
    </div>
  );
}

/** A document with lines on it — the same glyph the rail uses for Artifacts. */
function IconArtifact(): JSX.Element {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
      <path d="M14 3v5h5" />
      <path d="M9 13h6M9 17h4" />
    </svg>
  );
}

/** A rail row for memory, drawn like the rest of them. */
function MemoryRailItem({ collapsed, onClick }: { collapsed: boolean; onClick: () => void }): JSX.Element {
  return (
    <button className="rail-item" onClick={onClick} title="What I remember about you">
      <span className="rail-icon" aria-hidden="true">
        <IconBook />
      </span>
      {!collapsed && <span className="rail-label">Memory</span>}
    </button>
  );
}

function IconBook(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden="true">
      <path d="M3 3.5h4.2c.7 0 1.3.6 1.3 1.3V13a1 1 0 0 0-1-1H3z" strokeLinejoin="round" />
      <path d="M13 3.5H8.8c-.7 0-1.3.6-1.3 1.3V13a1 1 0 0 1 1-1H13z" strokeLinejoin="round" />
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
