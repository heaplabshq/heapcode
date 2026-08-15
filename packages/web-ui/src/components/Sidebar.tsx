import type { UiConversationMeta } from '@heapcode/web-host/protocol';

export interface SidebarProps {
  open: boolean;
  conversations: UiConversationMeta[];
  onOpen(id: string): void;
  onNew(): void;
  busy: boolean;
}

export function Sidebar({ open, conversations, onOpen, onNew, busy }: SidebarProps): JSX.Element | null {
  if (!open) return null;
  return (
    <aside className="sidebar" aria-label="Conversations">
      <button className="btn btn-primary sidebar-new" onClick={onNew} disabled={busy}>
        New chat
      </button>
      <ul className="convo-list">
        {conversations.length === 0 && <li className="convo-empty">No saved conversations yet.</li>}
        {conversations.map((c) => (
          <li key={c.id}>
            <button
              className={`convo ${c.active ? 'convo-active' : ''}`}
              onClick={() => onOpen(c.id)}
              disabled={busy}
              title={busy ? 'Stop the current run first' : undefined}
            >
              <span className="convo-title">{c.title || 'Untitled'}</span>
              <span className="convo-date">{when(c.updatedAt)}</span>
            </button>
          </li>
        ))}
      </ul>
    </aside>
  );
}

function when(ts: number): string {
  const diff = Date.now() - ts;
  const mins = Math.round(diff / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return new Date(ts).toLocaleDateString();
}
