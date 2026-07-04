import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  ConversationMeta,
  ExtensionToWebview,
  FileEditInfo,
  PermissionChoice,
  SlashCommandInfo,
} from '@cortex/core';
import { postToExtension } from './vscodeApi.js';
import { renderMarkdown } from './markdown.js';

interface ToolChip {
  id: string;
  name: string;
  description: string;
  done: boolean;
  ok?: boolean;
  summary?: string;
  label?: string;
  fileEdit?: FileEditInfo;
}

interface PermissionCard {
  id: string;
  description: string;
  permission: string;
  allowPersist: boolean;
  decided?: PermissionChoice;
}

interface UiMessage {
  role: 'user' | 'assistant';
  content: string;
  error?: boolean;
  tool?: ToolChip;
  plan?: boolean;
  permission?: PermissionCard;
  agentStatus?: { state: string; changedFiles: string[] };
  attachedFiles?: string[];
}

interface ModelMenu {
  loading: boolean;
  profiles: Array<{ name: string; active: boolean }>;
  models: string[];
}

interface Config {
  profile: string;
  model: string;
  slashCommands: SlashCommandInfo[];
}

export function App() {
  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [config, setConfig] = useState<Config | null>(null);
  const [view, setView] = useState<'chat' | 'history'>('chat');
  const [history, setHistory] = useState<ConversationMeta[]>([]);
  const [mode, setMode] = useState<'chat' | 'agent'>('chat');
  const [agentRunning, setAgentRunning] = useState(false);
  const [attached, setAttached] = useState<string[]>([]);
  const [currentFile, setCurrentFile] = useState<string | null>(null);
  const [includeCurrentFile, setIncludeCurrentFile] = useState(true);
  const [modelMenu, setModelMenu] = useState<ModelMenu | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const nearBottomRef = useRef(true);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const modelPickerRef = useRef<HTMLDivElement>(null);

  // Model menu dismissal: Esc anywhere, or clicking outside the picker.
  useEffect(() => {
    if (!modelMenu) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setModelMenu(null);
    };
    const onMouseDown = (e: MouseEvent) => {
      if (!modelPickerRef.current?.contains(e.target as Node)) setModelMenu(null);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onMouseDown);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onMouseDown);
    };
  }, [modelMenu]);

  useEffect(() => {
    const onMessage = (event: MessageEvent<ExtensionToWebview>) => {
      const msg = event.data;
      switch (msg.type) {
        case 'config':
          setConfig({ profile: msg.profile, model: msg.model, slashCommands: msg.slashCommands });
          break;
        case 'activeFile':
          setCurrentFile(msg.path);
          break;
        case 'chunk':
          setMessages((prev) => {
            const next = [...prev];
            const last = next[next.length - 1];
            if (last?.role === 'assistant' && !last.tool && !last.agentStatus) {
              next[next.length - 1] = { ...last, content: last.content + msg.text };
            }
            return next;
          });
          break;
        case 'done':
          setStreaming(false);
          break;
        case 'error':
          setStreaming(false);
          setMessages((prev) => {
            const next = [...prev];
            const last = next[next.length - 1];
            if (last?.role === 'assistant' && last.content === '' && !last.tool) {
              next[next.length - 1] = { role: 'assistant', content: msg.message, error: true };
            } else {
              next.push({ role: 'assistant', content: msg.message, error: true });
            }
            return next;
          });
          break;
        case 'userMessage':
          setView('chat');
          setStreaming(true);
          setMessages((prev) => [
            ...prev,
            { role: 'user', content: msg.text },
            { role: 'assistant', content: '' },
          ]);
          break;
        case 'history':
          setHistory(msg.items);
          break;
        case 'conversation':
          setMessages(
            msg.messages.map((m): UiMessage => {
              if (m.tool) {
                return {
                  role: 'assistant',
                  content: '',
                  tool: { id: '', done: true, ...m.tool },
                };
              }
              if (m.status) {
                return {
                  role: 'assistant',
                  content: '',
                  agentStatus: { state: m.status.state, changedFiles: [] },
                };
              }
              return { role: m.role, content: m.content, plan: m.plan };
            }),
          );
          setView('chat');
          setStreaming(false);
          break;
        case 'newChatStarted':
          setMessages([]);
          setView('chat');
          setStreaming(false);
          break;
        case 'contextFiles':
          setAttached((prev) => [...new Set([...prev, ...msg.files])]);
          break;
        case 'models':
          setModelMenu({ loading: false, profiles: msg.profiles, models: msg.models });
          break;
        case 'permissionRequest':
          setMessages((prev) => [
            ...prev,
            {
              role: 'assistant',
              content: '',
              permission: {
                id: msg.id,
                description: msg.description,
                permission: msg.permission,
                allowPersist: msg.allowPersist,
              },
            },
          ]);
          break;
        case 'agentText':
          setMessages((prev) => [...prev, { role: 'assistant', content: msg.text }]);
          break;
        case 'agentPlan':
          setMessages((prev) => [...prev, { role: 'assistant', content: msg.text, plan: true }]);
          break;
        case 'agentToolCall':
          setMessages((prev) => [
            ...prev,
            {
              role: 'assistant',
              content: '',
              tool: { id: msg.id, name: msg.name, description: msg.description, done: false },
            },
          ]);
          break;
        case 'agentToolResult':
          setMessages((prev) =>
            prev.map((m) =>
              m.tool && m.tool.id === msg.id && !m.tool.done
                ? {
                    ...m,
                    tool: {
                      ...m.tool,
                      done: true,
                      ok: msg.ok,
                      summary: msg.summary,
                      label: msg.label,
                      fileEdit: msg.fileEdit,
                    },
                  }
                : m,
            ),
          );
          break;
        case 'agentStatus':
          setAgentRunning(msg.status === 'running');
          if (msg.status !== 'running') {
            setMessages((prev) => {
              const next = [...prev];
              const last = next[next.length - 1];
              if (last?.agentStatus) {
                next[next.length - 1] = {
                  ...last,
                  agentStatus: { state: msg.status, changedFiles: msg.changedFiles },
                };
                return next;
              }
              return [
                ...next,
                {
                  role: 'assistant',
                  content: '',
                  agentStatus: { state: msg.status, changedFiles: msg.changedFiles },
                },
              ];
            });
          }
          break;
      }
    };
    window.addEventListener('message', onMessage);
    postToExtension({ type: 'ready' });
    return () => window.removeEventListener('message', onMessage);
  }, []);

  // Auto-scroll only while the reader is already at the bottom — scrolling up
  // to read pauses following, scrolling back down resumes it.
  useEffect(() => {
    if (nearBottomRef.current) {
      scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
    }
  }, [messages]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    nearBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  const slashMatches = useMemo(() => {
    if (!config || !input.startsWith('/') || input.includes(' ') || input.includes('\n')) return [];
    const term = input.slice(1).toLowerCase();
    return config.slashCommands.filter((c) => c.command.startsWith(term));
  }, [input, config]);

  const contextFiles = (): string[] | undefined => {
    const files = [
      ...(includeCurrentFile && currentFile ? [currentFile] : []),
      ...attached.filter((f) => f !== currentFile),
    ];
    return files.length > 0 ? files : undefined;
  };

  const send = () => {
    const text = input.trim();
    if (!text || streaming || agentRunning) return;
    nearBottomRef.current = true;
    const files = contextFiles();
    setAttached([]); // attachments are per-message, like Copilot
    if (mode === 'agent') {
      setMessages((prev) => [...prev, { role: 'user', content: text, attachedFiles: files }]);
      setInput('');
      postToExtension({ type: 'agentStart', task: text, files });
      return;
    }
    setMessages((prev) => [
      ...prev,
      { role: 'user', content: text, attachedFiles: files },
      { role: 'assistant', content: '' },
    ]);
    setInput('');
    setStreaming(true);
    postToExtension({ type: 'send', text, files });
  };

  const openHistory = () => {
    postToExtension({ type: 'listHistory' });
    setView('history');
  };

  /** Delegated handler for Copy/Insert/Apply buttons injected into code blocks. */
  const onMessagesClick = (e: React.MouseEvent) => {
    const button = (e.target as HTMLElement).closest('button[data-action]');
    if (!button) return;
    const code = button.closest('.codeblock')?.querySelector('pre code')?.textContent ?? '';
    if (!code) return;
    const action = button.getAttribute('data-action');
    if (action === 'copy') {
      void navigator.clipboard.writeText(code);
      button.textContent = 'Copied';
      setTimeout(() => (button.textContent = 'Copy'), 1200);
    } else if (action === 'insert') {
      postToExtension({ type: 'insertCode', code });
    } else if (action === 'apply') {
      postToExtension({ type: 'applyCode', code });
    }
  };

  const busy = streaming || agentRunning;

  return (
    <div className="app">
      <header className="header">
        <span className="spacer" />
        <button
          className="ghost"
          title="History"
          onClick={view === 'history' ? () => setView('chat') : openHistory}
        >
          {view === 'history' ? 'Back' : 'History'}
        </button>
        <button className="ghost" onClick={() => postToExtension({ type: 'newChat' })} disabled={busy}>
          New chat
        </button>
      </header>

      {view === 'history' ? (
        <div className="history">
          {history.length === 0 && <div className="empty">No previous conversations.</div>}
          {history.map((item) => (
            <div key={item.id} className="history-item">
              <button
                className="history-open"
                onClick={() => postToExtension({ type: 'openConversation', id: item.id })}
              >
                <span className="history-title">{item.title || 'Untitled'}</span>
                <span className="history-date">{new Date(item.updatedAt).toLocaleString()}</span>
              </button>
              <button
                className="ghost danger"
                title="Delete"
                onClick={() => postToExtension({ type: 'deleteConversation', id: item.id })}
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      ) : (
        <div className="messages" ref={scrollRef} onScroll={onScroll} onClick={onMessagesClick}>
          {messages.length === 0 && (
            <div className="empty">
              <p>Ask about your code, or switch to Agent for autonomous tasks.</p>
              <p className="hint">
                <code>/</code> for commands · <code>@selection</code> <code>@file</code>{' '}
                <code>@problems</code> <code>@workspace</code> for context · 📎 to attach files
              </p>
            </div>
          )}
          {messages.map((m, i) => {
            if (m.tool) {
              const t = m.tool;
              if (t.fileEdit) {
                return (
                  <button
                    key={i}
                    className="file-edit-card"
                    title="Show diff"
                    onClick={() => postToExtension({ type: 'agentDiffFile', path: t.fileEdit!.path })}
                  >
                    <span className="file-edit-name">{t.fileEdit.path}</span>
                    <span className="diff-added">+{t.fileEdit.added}</span>
                    <span className="diff-removed">−{t.fileEdit.removed}</span>
                  </button>
                );
              }
              return (
                <div key={i} className={`tool-chip${t.done ? (t.ok ? ' ok' : ' fail') : ''}`}>
                  <span className="tool-icon">{t.done ? (t.ok ? '✓' : '✗') : '⏳'}</span>
                  <span className="tool-desc" title={t.summary ?? ''}>
                    {t.description}
                  </span>
                  {t.label && <span className="tool-label">{t.label}</span>}
                </div>
              );
            }
            if (m.permission) {
              const p = m.permission;
              const decide = (choice: PermissionChoice) => {
                postToExtension({ type: 'permissionResponse', id: p.id, choice });
                setMessages((prev) =>
                  prev.map((x) =>
                    x.permission?.id === p.id
                      ? { ...x, permission: { ...x.permission, decided: choice } }
                      : x,
                  ),
                );
              };
              return (
                <div key={i} className={`permission-card${p.permission === 'destructive' ? ' destructive' : ''}`}>
                  <div className="permission-head">
                    <span className="permission-badge">{p.permission}</span>
                    Cortex wants to:
                  </div>
                  <code className="permission-desc">{p.description}</code>
                  {p.decided ? (
                    <div className="permission-decided">
                      {p.decided === 'deny' ? '✗ Denied' : `✓ Allowed${p.decided === 'session' ? ' (session)' : p.decided === 'always' ? ' (always)' : ''}`}
                    </div>
                  ) : (
                    <div className="permission-actions">
                      <button className="primary" onClick={() => decide('allow')}>
                        Allow
                      </button>
                      {p.allowPersist && (
                        <>
                          <button className="ghost" onClick={() => decide('session')}>
                            Session
                          </button>
                          <button className="ghost" onClick={() => decide('always')}>
                            Always
                          </button>
                        </>
                      )}
                      <button className="ghost danger" onClick={() => decide('deny')}>
                        Deny
                      </button>
                    </div>
                  )}
                </div>
              );
            }
            if (m.plan) {
              return (
                <div key={i} className="plan-card">
                  <div className="plan-title">Plan</div>
                  <div
                    className="markdown"
                    dangerouslySetInnerHTML={{ __html: renderMarkdown(m.content) }}
                  />
                </div>
              );
            }
            if (m.agentStatus) {
              const { state, changedFiles } = m.agentStatus;
              return (
                <div key={i} className={`agent-banner ${state === 'done' ? 'ok' : 'warn'}`}>
                  <div className="banner-head">
                    <span>
                      Agent {state === 'done' ? 'finished' : state}
                      {changedFiles.length > 0 && ` — review ${changedFiles.length} changed file(s)`}
                    </span>
                    {changedFiles.length > 0 && (
                      <button className="ghost" onClick={() => postToExtension({ type: 'agentRevert' })}>
                        Revert all
                      </button>
                    )}
                  </div>
                  {changedFiles.map((f) => (
                    <div key={f} className="changed-file">
                      <button
                        className="file-link"
                        title="Show diff"
                        onClick={() => postToExtension({ type: 'agentDiffFile', path: f })}
                      >
                        {f}
                      </button>
                      <button
                        className="ghost"
                        title="Keep this file's changes"
                        onClick={() => postToExtension({ type: 'agentKeepFile', path: f })}
                      >
                        Keep
                      </button>
                      <button
                        className="ghost danger"
                        title="Revert this file"
                        onClick={() => postToExtension({ type: 'agentRevertFile', path: f })}
                      >
                        Revert
                      </button>
                    </div>
                  ))}
                </div>
              );
            }
            return (
              <div key={i} className={`turn ${m.role}${m.error ? ' error' : ''}`}>
                <div className="turn-author">{m.role === 'user' ? 'You' : 'Cortex'}</div>
                {m.role === 'assistant' ? (
                  m.content === '' && streaming && i === messages.length - 1 ? (
                    <span className="thinking">…</span>
                  ) : (
                    <div
                      className="markdown"
                      dangerouslySetInnerHTML={{ __html: renderMarkdown(m.content) }}
                    />
                  )
                ) : (
                  <>
                    <div className="user-text">{m.content}</div>
                    {m.attachedFiles && (
                      <div className="attach-note">📎 {m.attachedFiles.join(', ')}</div>
                    )}
                  </>
                )}
              </div>
            );
          })}
          {agentRunning && (
            <div className="agent-banner running">
              <span>Agent running — executing tools until the task is done (Stop to abort)…</span>
            </div>
          )}
        </div>
      )}

      <footer className="composer">
        {slashMatches.length > 0 && (
          <div className="slash-menu">
            {slashMatches.map((c) => (
              <button
                key={c.command}
                className="slash-item"
                onClick={() => {
                  setInput(`/${c.command} `);
                  inputRef.current?.focus();
                }}
              >
                <code>/{c.command}</code>
                <span>{c.title}</span>
              </button>
            ))}
          </div>
        )}
        <div className="composer-box">
          <div className="context-row">
            <button
              className="ghost attach-btn"
              title="Attach files as context"
              onClick={() => postToExtension({ type: 'pickContextFiles' })}
            >
              📎
            </button>
            {currentFile && (
              <button
                className={`attach-chip current${includeCurrentFile ? '' : ' off'}`}
                title={
                  includeCurrentFile
                    ? `${currentFile} is included as context — click to exclude`
                    : `${currentFile} excluded — click to include`
                }
                onClick={() => setIncludeCurrentFile((v) => !v)}
              >
                {currentFile.split('/').pop()}
                <span className="chip-tag">current file</span>
              </button>
            )}
            {attached.map((f) => (
              <span key={f} className="attach-chip" title={f}>
                {f.split('/').pop()}
                <button
                  className="attach-remove"
                  onClick={() => setAttached((prev) => prev.filter((x) => x !== f))}
                >
                  ✕
                </button>
              </span>
            ))}
          </div>
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                if (slashMatches.length === 1 && input.trim() === `/${slashMatches[0]!.command}`) {
                  setInput(`/${slashMatches[0]!.command} `);
                  return;
                }
                send();
              }
            }}
            placeholder={
              mode === 'agent' ? 'Describe a task for the agent…' : 'Ask Cortex…'
            }
            rows={3}
          />
          <div className="composer-footer">
            <select
              className="mode-select"
              value={mode}
              onChange={(e) => setMode(e.target.value as 'chat' | 'agent')}
              disabled={busy}
              title="Mode"
            >
              <option value="chat">Ask</option>
              <option value="agent">Agent</option>
            </select>
            <div className="model-picker" ref={modelPickerRef}>
              {modelMenu && (
                <div className="model-menu">
                  <div className="menu-section">Provider</div>
                  {modelMenu.profiles.map((p) => (
                    <button
                      key={p.name}
                      className={`menu-item${p.active ? ' active' : ''}`}
                      onClick={() => {
                        postToExtension({ type: 'setProfile', name: p.name });
                        setModelMenu({ loading: true, profiles: [], models: [] });
                        postToExtension({ type: 'listModels' });
                      }}
                    >
                      {p.active ? '✓ ' : ''}
                      {p.name}
                    </button>
                  ))}
                  <div className="menu-section">Model</div>
                  {modelMenu.loading && <div className="menu-note">Loading…</div>}
                  {!modelMenu.loading && modelMenu.models.length === 0 && (
                    <div className="menu-note">Could not list models</div>
                  )}
                  {modelMenu.models.map((id) => (
                    <button
                      key={id}
                      className={`menu-item${id === config?.model ? ' active' : ''}`}
                      onClick={() => {
                        postToExtension({ type: 'setModel', model: id });
                        setModelMenu(null);
                      }}
                    >
                      {id === config?.model ? '✓ ' : ''}
                      {id}
                    </button>
                  ))}
                  <div className="menu-section" />
                  <button
                    className="menu-item"
                    onClick={() => {
                      setModelMenu(null);
                      postToExtension({ type: 'runCommand', command: 'selectModel' });
                    }}
                  >
                    Model roles (edit/apply/autocomplete…) →
                  </button>
                </div>
              )}
              <button
                className="model-chip"
                title="Provider & model"
                onClick={() => {
                  if (modelMenu) {
                    setModelMenu(null);
                  } else {
                    setModelMenu({ loading: true, profiles: [], models: [] });
                    postToExtension({ type: 'listModels' });
                  }
                }}
              >
                {config ? `${config.profile} · ${config.model || 'no model'}` : '…'} ▾
              </button>
            </div>
            <span className="spacer" />
            {busy ? (
              <button
                className="primary send"
                onClick={() =>
                  postToExtension(agentRunning ? { type: 'agentStop' } : { type: 'stop' })
                }
              >
                ◼ Stop
              </button>
            ) : (
              <button className="primary send" onClick={send} disabled={!input.trim()}>
                ➤
              </button>
            )}
          </div>
        </div>
      </footer>
    </div>
  );
}
