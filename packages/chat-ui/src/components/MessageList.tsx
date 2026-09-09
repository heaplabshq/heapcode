import { renderMarkdown } from '@heapcode/web-ui/markdown';
import type { Item, Transcript } from '@heapcode/web-ui/transcript';
import { useEffect, useRef, useState } from 'react';
import { ToolChip } from './ToolChip.js';

function Reasoning({ text, streaming }: { text: string; streaming?: boolean }): JSX.Element {
  // Auto-expanded only while it is arriving: watching it think is worth
  // something, re-reading it afterwards almost never is.
  const [open, setOpen] = useState(Boolean(streaming));
  useEffect(() => {
    if (!streaming) setOpen(false);
  }, [streaming]);
  return (
    <div className="reasoning">
      <button className="reasoning-toggle" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        {streaming ? 'Thinking…' : 'Thought about it'}
      </button>
      {open ? <div className="reasoning-body">{text}</div> : null}
    </div>
  );
}

function Entry({ item }: { item: Item }): JSX.Element | null {
  switch (item.kind) {
    case 'text':
      if (item.role === 'user') {
        return (
          <div className="turn turn-user">
            <div className="bubble">{item.text}</div>
          </div>
        );
      }
      return (
        <div className="turn turn-assistant">
          <div
            className={`prose${item.streaming ? ' prose-streaming' : ''}`}
            // Sanitized by `renderMarkdown` (DOMPurify) before it gets here —
            // the same renderer Heap Code and heapbrowse use, so there is one
            // sanitizer to audit rather than three.
            dangerouslySetInnerHTML={{ __html: renderMarkdown(item.text) }}
          />
        </div>
      );
    case 'tool':
      return <ToolChip item={item} />;
    case 'reasoning':
      return <Reasoning text={item.text} streaming={item.streaming} />;
    case 'plan':
      return <div className="plan">{item.text}</div>;
    case 'notice':
      return <div className={`notice${item.warn ? ' notice-warn' : ''}`}>{item.text}</div>;
    case 'tasks':
      return (
        <ul className="tasks">
          {item.todos.map((t, i) => (
            <li key={i} className={`task task-${t.status}`}>
              {t.content}
            </li>
          ))}
        </ul>
      );
    default:
      return null;
  }
}

export function MessageList({ transcript, empty }: { transcript: Transcript; empty: string }): JSX.Element {
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' });
  }, [transcript.items.length]);

  if (transcript.items.length === 0) {
    return (
      <div className="messages messages-empty">
        <div className="empty">
          <h1>Ask about your files</h1>
          <p>{empty}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="messages">
      {transcript.items.map((item) => (
        <Entry key={item.id} item={item} />
      ))}
      <div ref={end} />
    </div>
  );
}
