import type { ReactNode } from 'react';
import type { UiConversationMeta, UiState } from '@heapcode/web-host/protocol';
import { markHue } from '../mark.js';

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
  onOpenArtifacts(): void;
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

  return (
    <aside className={collapsed ? 'rail rail-collapsed' : 'rail'} aria-label="Navigation">
      <div className="rail-top">
        <span className="rail-logo" aria-hidden="true">
          <Logo />
        </span>
        <span className="rail-brand">Heap Code</span>
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
        <RailItem icon={<IconSliders />} label="Customize" collapsed={collapsed} onClick={() => props.onOpenSettings()} />
        {/* Was behind a "More" chevron with one other item. Two entries is not
            a submenu; it is two entries. */}
        <RailItem
          icon={<IconCommand />}
          label="Commands"
          kbd="⌘K"
          collapsed={collapsed}
          onClick={props.onOpenPalette}
        />
      </nav>

      {/* Kept mounted through a collapse so it fades and clips with the rail.
          Unmounting it made the largest block on the screen vanish a frame
          before the width started moving, which is most of what "the collapse
          is not smooth" was. Hidden with `visibility` once the fade is done,
          so nothing invisible stays in the tab order. */}
      <div className="rail-recents">
          {props.conversations.length === 0 && (
            <>
              <div className="rail-section">Recents</div>
              <p className="convo-empty">Nothing saved yet.</p>
            </>
          )}
          {/* Bucketed by when it was last touched. An undivided list of forty
              titles gives no way to tell this morning's work from last
              month's, and the date is the only thing anyone sorts by. */}
          {byAge(props.conversations).map(([when, items]) => (
            <div key={when}>
              <div className="rail-section">{when}</div>
              <ul className="convo-list">
                {items.map((c) => (
                  <li key={c.id}>
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
                  </li>
                ))}
              </ul>
            </div>
          ))}
      </div>

      {/*
        * What is answering, not who is signed in.
        *
        * This used to be a circular avatar holding the profile's initial next
        * to the profile's name, which is the signed-in-user control from every
        * other app on the screen — so `ollama` read as an account. It is a
        * model on an endpoint. The model id leads, in the same monospace the
        * settings page uses for it; the connection is the second line; the
        * mark is a square chip glyph in the connection's own colour rather
        * than a round initial.
        */}
      <div className="rail-foot">
        <button
          className="rail-model"
          onClick={() => props.onOpenSettings('context')}
          title={
            state?.model ? `${state.model} on ${state.profile} — models and context` : 'Choose a model'
          }
          aria-label={collapsed ? 'Models and context' : undefined}
        >
          <span
            className="rail-model-mark"
            style={{ '--mark-h': markHue(state?.profile ?? '') } as React.CSSProperties}
            aria-hidden="true"
          >
            <IconChip />
          </span>
          <span className="rail-model-text">
            <span className="rail-model-name">{state?.model || 'no model'}</span>
            <span className="rail-model-conn">
              on <span className="rail-model-host">{state?.profile || 'no connection'}</span>
            </span>
          </span>
        </button>
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
      <span className="rail-label">{label}</span>
      {kbd && <span className="rail-kbd">{kbd}</span>}
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

function IconSliders(): JSX.Element {
  return (
    <svg {...S}>
      <path d="M4 7h10M18 7h2M4 17h4M12 17h8" />
      <circle cx="16" cy="7" r="2" />
      <circle cx="10" cy="17" r="2" />
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

/** The footer mark: a chip, because what is down there is a model. */
function IconChip(): JSX.Element {
  return (
    <svg {...S} width={13} height={13}>
      <rect x="7" y="7" width="10" height="10" rx="2" />
      <path d="M10 3v4M14 3v4M10 17v4M14 17v4M3 10h4M3 14h4M17 10h4M17 14h4" />
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
