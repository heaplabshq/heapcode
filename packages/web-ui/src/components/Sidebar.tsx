import type { ReactNode } from 'react';
import type { UiConversationMeta } from '@heapcode/web-host/protocol';
import type { ConnectionStatus } from '../rpc.js';
import { ProductToggle, type Product } from './ProductToggle.js';

export interface SidebarProps {
  /** Collapsed shows the icon rail only; the labels come back on expand. */
  collapsed: boolean;
  onToggleCollapsed(): void;
  conversations: UiConversationMeta[];
  activeConversation?: string;
  onOpen(id: string): void;
  onNew(): void;
  /** Delete a saved conversation. Absent, rows offer no delete. */
  onDelete?(id: string): void;
  busy: boolean;
  status: ConnectionStatus;
  /** Which product this rail belongs to: its name heads the rail and opens the product menu. */
  product?: Product;
  /** Omitted by a product with no artifacts of its own — the row is then absent. */
  onOpenArtifacts?(): void;
  onOpenSettings(): void;
  /** A second line under Settings — Heapnotes names its folder there. */
  settingsDetail?: string;
  /** Omitted by a product with no command palette — the row is then absent. */
  onOpenPalette?(): void;
  /** The product's own rows, under the shared ones. */
  extraNav?: ReactNode;
  /**
   * The scrolling list under the rows, in place of Recents — Heapnotes puts
   * its tags here. `conversations` is ignored when this is given.
   */
  recents?: ReactNode;
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
 *
 * Every product lays it out the same way — New and the shared rows, then the
 * product's own, then Recents, then Settings pinned to the foot — so moving
 * between products never means relearning where things are. Only `extraNav`
 * and `recents` differ.
 */
export function Sidebar(props: SidebarProps): JSX.Element {
  const { collapsed, status } = props;

  return (
    <aside className={collapsed ? 'rail rail-collapsed' : 'rail'} aria-label="Navigation">
      <div className="rail-top">
        <span className="rail-logo" aria-hidden="true">
          <Logo />
        </span>
        <ProductToggle current={props.product ?? 'code'} />
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
        {/* Was behind a "More" chevron with one other item. Two entries is not
            a submenu; it is two entries. */}
        {props.onOpenPalette && (
          <RailItem
            icon={<IconCommand />}
            label="Commands"
            kbd="⌘K"
            collapsed={collapsed}
            onClick={props.onOpenPalette}
          />
        )}
        {props.onOpenArtifacts && (
          <RailItem icon={<IconArtifact />} label="Artifacts" collapsed={collapsed} onClick={props.onOpenArtifacts} />
        )}
        {props.extraNav}
      </nav>

      {/* Kept mounted through a collapse so it fades and clips with the rail.
          Unmounting it made the largest block on the screen vanish a frame
          before the width started moving, which is most of what "the collapse
          is not smooth" was. Hidden with `visibility` once the fade is done,
          so nothing invisible stays in the tab order. */}
      <div className="rail-recents">
          {props.recents}
          {props.recents === undefined && props.conversations.length === 0 && (
            <>
              <div className="rail-section">Recents</div>
              <p className="convo-empty">Nothing saved yet.</p>
            </>
          )}
          {/* Bucketed by when it was last touched. An undivided list of forty
              titles gives no way to tell this morning's work from last
              month's, and the date is the only thing anyone sorts by. */}
          {props.recents === undefined && byAge(props.conversations).map(([when, items]) => (
            <div key={when}>
              <div className="rail-section">{when}</div>
              <ul className="convo-list">
                {items.map((c) => (
                  <li key={c.id} className="convo-row">
                    <button
                      className={c.active ? 'convo convo-active' : 'convo'}
                      onClick={() => props.onOpen(c.id)}
                      disabled={props.busy}
                      title={props.busy ? 'Stop the current run first' : c.title}
                    >
                      {/* Filled for the open conversation, hollow otherwise —
                          the list's only ornament, and it says the one thing a
                          glance needs: which of these am I in. */}
                      <span className={c.active ? 'convo-dot convo-dot-on' : 'convo-dot'} aria-hidden="true" />
                      <span className="convo-title">{c.title || 'Untitled'}</span>
                    </button>
                    {props.onDelete && (
                      <button
                        className="convo-delete"
                        aria-label={`Delete ${c.title || 'Untitled'}`}
                        title="Delete"
                        // The open conversation is the one a run writes to.
                        disabled={props.busy && c.active}
                        onClick={() => {
                          // Asked, because there is no undo: the store keeps
                          // no trash, and one stray click on a row would
                          // otherwise lose a long conversation.
                          if (window.confirm(`Delete “${c.title || 'Untitled'}”? This can’t be undone.`)) {
                            props.onDelete!(c.id);
                          }
                        }}
                      >
                        <IconTrash />
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ))}
      </div>

      {/* Settings, at the foot in every product — where people look for it.
          What is answering is not repeated here: the composer's model picker
          already says, beside the message it will answer. */}
      <div className="rail-foot">
        <RailItem
          icon={<IconGear />}
          label="Settings"
          detail={props.settingsDetail}
          collapsed={collapsed}
          onClick={() => props.onOpenSettings()}
        />
        {/* Only when something is wrong. A green dot that is green all day is
            not a status, it is decoration — and it sat next to the model like
            a presence indicator. Connecting and closed still say so. */}
        {status !== 'open' && (
          <span
            className={`dot dot-${status}`}
            title={`Connection: ${status}`}
            aria-label={`Connection ${status}`}
          />
        )}
      </div>
    </aside>
  );
}

/**
 * Recents, in the four buckets people actually sort them into.
 *
 * Calendar days rather than elapsed hours: something saved at 11pm last night
 * belongs under Yesterday all through today, not under Today until 11pm.
 */
function byAge(list: UiConversationMeta[]): [string, UiConversationMeta[]][] {
  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);
  const t0 = midnight.getTime();
  const day = 86_400_000;
  const buckets: [string, UiConversationMeta[]][] = [
    ['Today', []],
    ['Yesterday', []],
    ['Previous 7 days', []],
    ['Older', []],
  ];
  for (const c of list) {
    const i = c.updatedAt >= t0 ? 0 : c.updatedAt >= t0 - day ? 1 : c.updatedAt >= t0 - 7 * day ? 2 : 3;
    buckets[i]![1].push(c);
  }
  return buckets.filter(([, items]) => items.length > 0);
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
  kbd,
  detail,
}: {
  icon: ReactNode;
  label: string;
  collapsed: boolean;
  onClick(): void;
  disabled?: boolean;
  active?: boolean;
  badge?: number;
  hint?: string;
  /** Shown at the row's right edge, when there is a shortcut for it. */
  kbd?: string;
  /** A quieter second line under the label. */
  detail?: string;
}): JSX.Element {
  const tip = hint ?? label;
  return (
    <button
      className={`rail-item ${active ? 'rail-item-active' : ''}`}
      onClick={onClick}
      disabled={disabled}
      // Collapsed, the tooltip is the only label there is. The native title is
      // unreliable in embedded webviews (long delay, often suppressed), so a
      // custom tooltip element carries it instead — see `.rail-tip` in styles.
      title={collapsed ? undefined : hint}
      aria-label={collapsed ? label : undefined}
    >
      <span className="rail-icon">{icon}</span>
      {detail ? (
        <span className="rail-label rail-label-two">
          <span>{label}</span>
          <span className="rail-label-sub">{detail}</span>
        </span>
      ) : (
        <span className="rail-label">{label}</span>
      )}
      {kbd && <span className="rail-kbd">{kbd}</span>}
      {badge !== undefined && <span className="rail-badge">{badge}</span>}
      {collapsed && (
        <span className="rail-tip" aria-hidden="true">
          {tip}
        </span>
      )}
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

function IconTrash(): JSX.Element {
  return (
    <svg {...S}>
      <path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3" />
    </svg>
  );
}

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

/** Settings: a gear, the glyph people already look for. */
function IconGear(): JSX.Element {
  return (
    <svg {...S}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}

function IconCommand(): JSX.Element {
  return (
    <svg {...S}>
      <path d="M9 6a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3z" />
    </svg>
  );
}

/** The product mark — `packages/vscode/media/icon.svg`, the one the extension ships. */
function Logo(): JSX.Element {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 3a4.5 4.5 0 0 0-4.4 3.5A4 4 0 0 0 5 14a3.5 3.5 0 0 0 3 5h1" />
      <path d="M12 3a4.5 4.5 0 0 1 4.4 3.5A4 4 0 0 1 19 14a3.5 3.5 0 0 1-3 5h-1" />
      <path d="M12 3v18" />
      <path d="M9 9.5h-1.5" />
      <path d="M15 9.5h1.5" />
      <path d="M9 14.5H7.5" />
      <path d="M15 14.5h1.5" />
    </svg>
  );
}
