import type { UiState } from '@heapcode/web-host/protocol';
import { Menu } from './Menu.js';

export interface HeaderProps {
  state?: UiState;
  status: 'connecting' | 'open' | 'closed';
  usedTokens?: number;
  windowTokens?: number;
  onToggleSidebar(): void;
  onNewChat(): void;
  onOpenSettings(focus?: 'context'): void;
  onOpenPalette(): void;
  onTogglePanel(): void;
  onOpenArtifacts(): void;
  panelOpen: boolean;
  changeCount: number;
}

/**
 * Workspace on the left, two controls on the right.
 *
 * The model and permission-mode pickers moved to the composer bar: they belong
 * to the message you are about to send, and they were crowding the one thing a
 * header has to answer — which workspace am I in.
 */
export function Header(props: HeaderProps): JSX.Element {
  const { state, status } = props;
  // The live run's window when there is one, else the profile's — so the meter
  // reads the same number the next turn will actually use.
  const ctxWindow = props.windowTokens || state?.contextWindow;
  const used = props.usedTokens ?? 0;
  const pct = used && ctxWindow ? Math.min(100, Math.round((used / ctxWindow) * 100)) : 0;

  return (
    <header className="header">
      <button className="icon-btn" onClick={props.onToggleSidebar} aria-label="Toggle conversations" title="Conversations">
        ☰
      </button>
      <span className="workspace" title={state?.root}>
        {state?.workspaceName ?? '…'}
      </span>
      <span className="brand-badge">heapcode</span>
      <span
        className={`dot dot-${status}`}
        title={`Connection: ${status}`}
        aria-label={`Connection ${status}`}
      />

      <div className="header-right">
        {ctxWindow ? (
          <button
            className="meter"
            onClick={() => props.onOpenSettings('context')}
            title={`Context: ${used.toLocaleString()} / ${ctxWindow.toLocaleString()} tokens — click to change it on the profile`}
          >
            <span className="meter-fill" style={{ width: `${pct}%` }} />
            <span className="meter-label">
              {pct}% of {fmt(ctxWindow)}
            </span>
          </button>
        ) : null}

        <button
          className={`icon-btn ${props.panelOpen ? 'icon-btn-on' : ''}`}
          onClick={props.onTogglePanel}
          aria-label="Toggle workspace panel"
          title="Workspace panel"
        >
          ▤{props.changeCount ? <span className="icon-badge">{props.changeCount}</span> : null}
        </button>

        <Menu
          items={[
            { label: 'New chat', hint: '/new', onSelect: props.onNewChat },
            { label: 'Conversations', onSelect: props.onToggleSidebar },
            { label: 'Artifacts', onSelect: props.onOpenArtifacts },
            { label: 'Commands', hint: '⌘K', separated: true, onSelect: props.onOpenPalette },
            { label: 'Context & tokens', onSelect: () => props.onOpenSettings('context') },
            { label: 'Settings', onSelect: () => props.onOpenSettings() },
          ]}
        />
      </div>
    </header>
  );
}

function fmt(n: number): string {
  return n >= 1000 ? `${Math.round(n / 1000)}k` : String(n);
}
