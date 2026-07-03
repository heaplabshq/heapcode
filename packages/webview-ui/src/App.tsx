import { useEffect, useMemo, useRef, useState } from 'react';
import type { ConversationMeta, ExtensionToWebview, SlashCommandInfo } from '@cortex/core';
import { postToExtension } from './vscodeApi.js';
import { renderMarkdown } from './markdown.js';

interface UiMessage {
  role: 'user' | 'assistant';
  content: string;
  error?: boolean;
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
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const onMessage = (event: MessageEvent<ExtensionToWebview>) => {
      const msg = event.data;
      switch (msg.type) {
        case 'config':
          setConfig({ profile: msg.profile, model: msg.model, slashCommands: msg.slashCommands });
          break;
        case 'chunk':
          setMessages((prev) => {
            const next = [...prev];
            const last = next[next.length - 1];
            if (last?.role === 'assistant') {
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
            if (last?.role === 'assistant' && last.content === '') {
              next[next.length - 1] = { role: 'assistant', content: msg.message, error: true };
            } else {
              next.push({ role: 'assistant', content: msg.message, error: true });
            }
            return next;
          });
          break;
        case 'history':
          setHistory(msg.items);
          break;
        case 'conversation':
          setMessages(msg.messages.map((m) => ({ role: m.role, content: m.content })));
          setView('chat');
          setStreaming(false);
          break;
        case 'newChatStarted':
          setMessages([]);
          setView('chat');
          setStreaming(false);
          break;
      }
    };
    window.addEventListener('message', onMessage);
    postToExtension({ type: 'ready' });
    return () => window.removeEventListener('message', onMessage);
  }, []);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages]);

  const slashMatches = useMemo(() => {
    if (!config || !input.startsWith('/') || input.includes(' ') || input.includes('\n')) return [];
    const term = input.slice(1).toLowerCase();
    return config.slashCommands.filter((c) => c.command.startsWith(term));
  }, [input, config]);

  const send = () => {
    const text = input.trim();
    if (!text || streaming) return;
    setMessages((prev) => [
      ...prev,
      { role: 'user', content: text },
      { role: 'assistant', content: '' },
    ]);
    setInput('');
    setStreaming(true);
    postToExtension({ type: 'send', text });
  };

  const openHistory = () => {
    postToExtension({ type: 'listHistory' });
    setView('history');
  };

  return (
    <div className="app">
      <header className="header">
        <button
          className="chip"
          title="Switch profile"
          onClick={() => postToExtension({ type: 'runCommand', command: 'selectProfile' })}
        >
          {config?.profile ?? '…'}
        </button>
        <button
          className="chip model"
          title="Select model"
          onClick={() => postToExtension({ type: 'runCommand', command: 'selectModel' })}
        >
          {config?.model || 'no model'}
        </button>
        <span className="spacer" />
        <button
          className="ghost"
          title="History"
          onClick={view === 'history' ? () => setView('chat') : openHistory}
        >
          {view === 'history' ? 'Back' : 'History'}
        </button>
        <button
          className="ghost"
          onClick={() => postToExtension({ type: 'newChat' })}
          disabled={streaming}
        >
          New
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
        <div className="messages" ref={scrollRef}>
          {messages.length === 0 && (
            <div className="empty">
              <p>Ask anything about your code.</p>
              <p className="hint">
                <code>/explain</code>, <code>/fix</code>, <code>/review</code>… for prompts.
                <br />
                <code>@selection</code> <code>@file</code> <code>@problems</code>{' '}
                <code>@folder</code> to attach context.
              </p>
            </div>
          )}
          {messages.map((m, i) => (
            <div key={i} className={`message ${m.role}${m.error ? ' error' : ''}`}>
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
                <div className="user-text">{m.content}</div>
              )}
            </div>
          ))}
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
        <div className="composer-row">
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
            placeholder="Ask Cortex…  ( / for commands, @ to attach context )"
            rows={3}
          />
          {streaming ? (
            <button className="primary" onClick={() => postToExtension({ type: 'stop' })}>
              Stop
            </button>
          ) : (
            <button className="primary" onClick={send} disabled={!input.trim()}>
              Send
            </button>
          )}
        </div>
      </footer>
    </div>
  );
}
