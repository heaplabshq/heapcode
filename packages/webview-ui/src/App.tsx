import { useEffect, useRef, useState } from 'react';
import type { ExtensionToWebview } from '@cortex/core';
import { postToExtension } from './vscodeApi.js';
import { renderMarkdown } from './markdown.js';

interface UiMessage {
  role: 'user' | 'assistant';
  content: string;
  error?: boolean;
}

export function App() {
  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [config, setConfig] = useState<{ baseUrl: string; model: string } | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onMessage = (event: MessageEvent<ExtensionToWebview>) => {
      const msg = event.data;
      switch (msg.type) {
        case 'config':
          setConfig({ baseUrl: msg.baseUrl, model: msg.model });
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
            // Replace the empty assistant placeholder, or append.
            if (last?.role === 'assistant' && last.content === '') {
              next[next.length - 1] = { role: 'assistant', content: msg.message, error: true };
            } else {
              next.push({ role: 'assistant', content: msg.message, error: true });
            }
            return next;
          });
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

  const send = () => {
    const text = input.trim();
    if (!text || streaming) return;
    setMessages((prev) => [...prev, { role: 'user', content: text }, { role: 'assistant', content: '' }]);
    setInput('');
    setStreaming(true);
    postToExtension({ type: 'send', text });
  };

  const stop = () => postToExtension({ type: 'stop' });

  const clear = () => {
    if (streaming) return;
    setMessages([]);
    postToExtension({ type: 'clear' });
  };

  return (
    <div className="app">
      <header className="header">
        <span className="title">Cortex</span>
        <span className="model" title={config?.baseUrl ?? ''}>
          {config?.model ?? '…'}
        </span>
        <button className="ghost" onClick={clear} disabled={streaming || messages.length === 0}>
          New chat
        </button>
      </header>

      <div className="messages" ref={scrollRef}>
        {messages.length === 0 && (
          <div className="empty">
            <p>Ask anything about your code.</p>
            <p className="hint">
              Configure the endpoint via <code>cortex.baseUrl</code> / <code>cortex.model</code>{' '}
              settings, and <em>Cortex: Set API Key</em> if the provider needs one.
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

      <footer className="composer">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
          placeholder="Ask Cortex… (Enter to send, Shift+Enter for newline)"
          rows={3}
        />
        {streaming ? (
          <button className="primary" onClick={stop}>
            Stop
          </button>
        ) : (
          <button className="primary" onClick={send} disabled={!input.trim()}>
            Send
          </button>
        )}
      </footer>
    </div>
  );
}
