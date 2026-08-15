import { useState, type ReactNode } from 'react';
import type { UiConversationMeta, UiState } from '@heapcode/web-host/protocol';

export interface SidebarProps {
  /** Collapsed shows the icon rail only; the labels come back on expand. */
  collapsed: boolean;
  onToggleCollapsed(): void;
  conversations: UiConversationMeta[];
  activeConversation?: string;
  onOpen(id: string): void;
  onNew(): void;
  busy: boolean;
  state?: UiState;
  status: 'connecting' | 'open' | 'closed';
  changeCount: number;
  panelOpen: boolean;
  onOpenArtifacts(): void;
  onOpenChanges(): void;
  onOpenFiles(): void;
  onOpenTerminal(): void;
  onOpenSettings(focus?: 'context'): void;
  onOpenPalette(): void;
}

/**
 * The left rail: everything that is not the conversation itself.
 *
 * This replaced a top header bar. The bar had to hold the workspace name, the
 * product name, a connection dot, a context meter, a panel toggle and an
 * overflow menu across one 40px strip, which meant every one of them was
 * small, unlabelled and competing — and it spent the full width of the window
 * to do it. A vertical rail has room for labels, so the same controls stop
 * being icons you have to learn.
 *
 * Nothing here is a section "header" in the heavy sense: the brand is a word,
 * `Recents` is a quiet label over its list, and the groups are separated by
 * space rather than by rules and titles.
 */
export function Sidebar(props: SidebarProps): JSX.Element {
  const { collapsed, state, status } = props;
  const [moreOpen, setMoreOpen] = useState(false);

  return (
    <aside className={`rail ${collapsed ? 'rail-collapsed' : ''}`} aria-label="Navigation">
      <div className="rail-top">
        {!collapsed && <span className="rail-brand">Heap Code</span>}
        <button
          className="icon-btn rail-collapse"
          onClick={props.onToggleCollapsed}
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        >
          <IconPanel />
        </button>
      </div>

      <nav className="rail-nav">
        <RailItem
          icon={<IconPlus />}
          label="New"
          collapsed={collapsed}
          onClick={props.onNew}
          disabled={props.busy}
          hint={props.busy ? 'Stop the current run first' : undefined}
        />
        <RailItem icon={<IconArtifact />} label="Artifacts" collapsed={collapsed} onClick={props.onOpenArtifacts} />
        <RailItem
          icon={<IconDiff />}
          label="Changes"
          collapsed={collapsed}
          onClick={props.onOpenChanges}
          active={props.panelOpen}
          badge={props.changeCount || undefined}
        />
        <RailItem icon={<IconSliders />} label="Customize" collapsed={collapsed} onClick={() => props.onOpenSettings()} />

        {!collapsed && (
          <>
            <button
              className="rail-item rail-more"
              onClick={() => setMoreOpen((v) => !v)}
              aria-expanded={moreOpen}
            >
              <span className="rail-icon">
                <IconChevron open={moreOpen} />
              </span>
              <span className="rail-label">More</span>
            </button>
            {moreOpen && (
              <div className="rail-sub">
                <button className="rail-subitem" onClick={props.onOpenPalette}>
                  Commands <span className="rail-hint">⌘K</span>
                </button>
                <button className="rail-subitem" onClick={() => props.onOpenSettings('context')}>
                  Context &amp; tokens
                </button>
                <button className="rail-subitem" onClick={props.onOpenFiles}>
                  Files
                </button>
                <button className="rail-subitem" onClick={props.onOpenTerminal}>
                  Terminal
                </button>
              </div>
            )}
          </>
        )}
      </nav>

      {!collapsed && (
        <div className="rail-recents">
          <div className="rail-section">Recents</div>
          <ul className="convo-list">
            {props.conversations.length === 0 && <li className="convo-empty">Nothing saved yet.</li>}
            {props.conversations.map((c) => (
              <li key={c.id}>
                <button
                  className={`convo ${c.active ? 'convo-active' : ''}`}
                  onClick={() => props.onOpen(c.id)}
                  disabled={props.busy}
                  title={props.busy ? 'Stop the current run first' : c.title}
                >
                  {/* Filled for the open conversation, hollow otherwise — the
                      list's only ornament, and it says the one thing a glance
                      needs: which of these am I in. */}
                  <span className={`convo-dot ${c.active ? 'convo-dot-on' : ''}`} aria-hidden="true" />
                  <span className="convo-title">{c.title || 'Untitled'}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="rail-foot">
        {!collapsed && (
          <button
            className="rail-profile"
            onClick={() => props.onOpenSettings()}
            title={state?.profile ? `Profile: ${state.profile} — click for settings` : 'Settings'}
          >
            <span className="rail-avatar">{(state?.profile || '?').slice(0, 1).toUpperCase()}</span>
            <span className="rail-profile-name">{state?.profile || 'no profile'}</span>
          </button>
        )}
        <span
          className={`dot dot-${status}`}
          title={`Connection: ${status}`}
          aria-label={`Connection ${status}`}
        />
      </div>
    </aside>
  );
}

function RailItem({
  icon,
  label,
  collapsed,
  onClick,
  disabled,
  active,
  badge,
  hint,
}: {
  icon: ReactNode;
  label: string;
  collapsed: boolean;
  onClick(): void;
  disabled?: boolean;
  active?: boolean;
  badge?: number;
  hint?: string;
}): JSX.Element {
  return (
    <button
      className={`rail-item ${active ? 'rail-item-active' : ''}`}
      onClick={onClick}
      disabled={disabled}
      // Collapsed, the tooltip is the only label there is.
      title={hint ?? (collapsed ? label : undefined)}
      aria-label={collapsed ? label : undefined}
    >
      <span className="rail-icon">{icon}</span>
      {!collapsed && <span className="rail-label">{label}</span>}
      {badge !== undefined && <span className="rail-badge">{badge}</span>}
    </button>
  );
}

/*
 * Stroke icons, inline.
 *
 * Emoji were the alternative and they are worse here: they render as someone
 * else's colour artwork at a size the rest of the rail does not use, and they
 * differ per platform. These inherit `currentColor`, so they follow the theme
 * and the hover state for free.
 */
const S = {
  width: 16,
  height: 16,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.7,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
};

function IconPlus(): JSX.Element {
  return (
    <svg {...S}>
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

function IconPanel(): JSX.Element {
  return (
    <svg {...S}>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M9 4v16" />
    </svg>
  );
}

/** Artifacts: a page with something drawn on it. */
function IconArtifact(): JSX.Element {
  return (
    <svg {...S}>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
      <path d="M14 3v5h5" />
      <path d="M9 13h6M9 17h4" />
    </svg>
  );
}

/** Changes: a plus over a minus, the shape a diff already uses. */
function IconDiff(): JSX.Element {
  return (
    <svg {...S}>
      <path d="M6 4v7M3 7.5h6" />
      <path d="M15 16.5h6" />
      <path d="M18 4 6 20" />
    </svg>
  );
}

function IconSliders(): JSX.Element {
  return (
    <svg {...S}>
      <path d="M4 7h10M18 7h2M4 17h4M12 17h8" />
      <circle cx="16" cy="7" r="2" />
      <circle cx="10" cy="17" r="2" />
    </svg>
  );
}

function IconChevron({ open }: { open: boolean }): JSX.Element {
  return (
    <svg {...S} style={{ transform: open ? 'rotate(0deg)' : 'rotate(-90deg)', transition: 'transform 120ms' }}>
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}
