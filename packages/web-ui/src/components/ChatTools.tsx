import { useEffect, useRef, useState, type ReactNode } from 'react';
import { desktopBridge } from '../desktop.js';

/**
 * The chat pane's top-right control strip: one icon per view of the side
 * panel, and a ⋮ menu for the views you reach for less often.
 *
 * It used to be a single "Workspace" button opening a panel with a tab strip
 * of five. That made every view one click deeper than it needed to be, and it
 * gave both products the same panel shape even though they have different
 * things to show — Heap Chat has no diffs and no terminal, Heap Code has no
 * sources. Each product now passes its own `views`, and each icon *is* the
 * tab: click it to open the panel on that view, click it again to close it.
 *
 * Top-right because that is where a view toggle belongs relative to the view
 * it toggles, and because it is the one corner the reading column never
 * reaches.
 */
export interface ToolView {
  id: string;
  label: string;
  icon: JSX.Element;
  /** A number badges the icon; `true` is a dot (something is happening). */
  badge?: number | boolean;
  /** Shown in the tooltip, or beside the row in the ⋮ menu. */
  shortcut?: string;
}

export interface ChatToolsProps {
  /** Icons in the strip. */
  views: ToolView[];
  /** Rows in the ⋮ menu. Omitted or empty and there is no menu. */
  more?: ToolView[];
  /** The view the panel is open on; undefined when it is closed. */
  active?: string;
  onSelect(id: string): void;
}

export function ChatTools({ views, more = [], active, onSelect }: ChatToolsProps): JSX.Element {
  const keepAwake = desktopBridge()?.keepAwake;
  const hasMenu = more.length > 0 || Boolean(keepAwake);

  return (
    <div className="chat-tools" role="toolbar" aria-label="Panel views">
      {views.map((v) => (
        <button
          key={v.id}
          className={`chat-tool chat-tool-icon ${active === v.id ? 'chat-tool-on' : ''}`}
          onClick={() => onSelect(v.id)}
          aria-pressed={active === v.id}
          aria-label={v.label}
          title={v.shortcut ? `${v.label} (${v.shortcut})` : v.label}
        >
          {v.icon}
          {typeof v.badge === 'number' && v.badge > 0 && <span className="chat-tool-badge">{v.badge}</span>}
          {v.badge === true && <span className="chat-tool-dot" aria-hidden="true" />}
        </button>
      ))}
      {hasMenu && <MoreMenu items={more} active={active} onSelect={onSelect} keepAwake={keepAwake} />}
    </div>
  );
}

function MoreMenu({
  items,
  active,
  onSelect,
  keepAwake,
}: {
  items: ToolView[];
  active?: string;
  onSelect(id: string): void;
  keepAwake?: (on: boolean) => Promise<boolean>;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);

  // Outside click and Escape close it, the way every menu does. Escape also
  // gives focus back to the button, so the keyboard is not left nowhere.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent): void => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      setOpen(false);
      button.current?.focus();
    };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [open]);

  // Focus the first row on open, so arrow keys work straight away.
  useEffect(() => {
    if (open) root.current?.querySelector<HTMLElement>('[role^="menuitem"]')?.focus();
  }, [open]);

  const onMenuKey = (e: React.KeyboardEvent): void => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const rows = [...(root.current?.querySelectorAll<HTMLElement>('[role^="menuitem"]') ?? [])];
    const at = rows.indexOf(document.activeElement as HTMLElement);
    const next = (at + (e.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length;
    rows[next]?.focus();
  };

  const anyActive = items.some((i) => i.id === active);

  return (
    <div className="tool-menu-wrap" ref={root}>
      <button
        ref={button}
        className={`chat-tool chat-tool-icon ${open || anyActive ? 'chat-tool-on' : ''}`}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="More"
        title="More"
      >
        <IconMore />
      </button>
      {open && (
        <div className="tool-menu" role="menu" onKeyDown={onMenuKey}>
          {items.map((i) => (
            <button
              key={i.id}
              role="menuitem"
              className={`tool-menu-item ${active === i.id ? 'tool-menu-item-on' : ''}`}
              onClick={() => {
                setOpen(false);
                onSelect(i.id);
              }}
            >
              <span className="tool-menu-icon">{i.icon}</span>
              <span className="tool-menu-label">{i.label}</span>
              {i.shortcut && <kbd className="tool-menu-kbd">{i.shortcut}</kbd>}
            </button>
          ))}
          {keepAwake && (
            <>
              {items.length > 0 && <div className="tool-menu-sep" role="separator" />}
              <KeepAwake toggle={keepAwake} />
            </>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Stops the machine sleeping while a long run is going — desktop app only,
 * because a web page cannot hold a system power assertion. The main process
 * owns the state, so it survives this menu closing and ends when the app quits.
 */
function KeepAwake({ toggle }: { toggle(on: boolean): Promise<boolean> }): JSX.Element {
  const [on, setOn] = useState(() => desktopBridge()?.keepAwakeState?.() ?? false);
  const flip = (): void => {
    void toggle(!on).then(setOn);
  };
  return (
    <button role="menuitemcheckbox" aria-checked={on} className="tool-menu-item tool-menu-toggle" onClick={flip}>
      <span className="tool-menu-text">
        <span className="tool-menu-label">Keep computer awake</span>
        <span className="tool-menu-sub">Only for this session</span>
      </span>
      <Switch on={on} />
    </button>
  );
}

function Switch({ on }: { on: boolean }): ReactNode {
  return (
    <span className={`switch ${on ? 'switch-on' : ''}`} aria-hidden="true">
      <span className="switch-knob" />
    </span>
  );
}

function IconMore(): JSX.Element {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <circle cx="12" cy="5" r="1.7" />
      <circle cx="12" cy="12" r="1.7" />
      <circle cx="12" cy="19" r="1.7" />
    </svg>
  );
}
