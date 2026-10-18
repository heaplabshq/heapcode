import { useEffect, useLayoutEffect, useRef, useState } from 'react';

/**
 * A right-click menu, the way a Mac app's works: opens at the pointer, stays
 * on screen, arrows and Enter choose, Escape or a click elsewhere closes.
 * One at a time, owned by the app, so opening another replaces it.
 */
export type MenuEntry =
  | 'separator'
  | {
      label: string;
      run(): void;
      /** A shortcut to show, not to bind — the app binds its own. */
      hint?: string;
      danger?: boolean;
      disabled?: boolean;
    };

export interface MenuState {
  x: number;
  y: number;
  items: MenuEntry[];
  /** Read by screen readers: what the menu is for. */
  label: string;
}

export function ContextMenu({ menu, onClose }: { menu: MenuState; onClose(): void }): JSX.Element {
  const box = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: menu.x, top: menu.y });
  const usable = menu.items
    .map((item, i) => (item !== 'separator' && !item.disabled ? i : -1))
    .filter((i) => i >= 0);
  const [active, setActive] = useState(-1);

  // Keep it on screen: flip left or up when it would run off the edge.
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    const pad = 6;
    setPos({
      left: Math.max(pad, menu.x + width > innerWidth - pad ? menu.x - width : menu.x),
      top: Math.max(pad, menu.y + height > innerHeight - pad ? menu.y - height : menu.y),
    });
    el.focus();
  }, [menu]);

  useEffect(() => {
    const away = (e: Event) => {
      if (box.current && e.target instanceof Node && box.current.contains(e.target)) return;
      onClose();
    };
    window.addEventListener('mousedown', away, true);
    window.addEventListener('scroll', away, true);
    window.addEventListener('resize', onClose);
    window.addEventListener('blur', onClose);
    return () => {
      window.removeEventListener('mousedown', away, true);
      window.removeEventListener('scroll', away, true);
      window.removeEventListener('resize', onClose);
      window.removeEventListener('blur', onClose);
    };
  }, [onClose]);

  const choose = (i: number) => {
    const item = menu.items[i];
    if (!item || item === 'separator' || item.disabled) return;
    onClose();
    item.run();
  };

  return (
    <div
      ref={box}
      className="ctx-menu"
      role="menu"
      aria-label={menu.label}
      tabIndex={-1}
      style={{ left: pos.left, top: pos.top }}
      onContextMenu={(e) => e.preventDefault()}
      onKeyDown={(e) => {
        const at = usable.indexOf(active);
        if (e.key === 'Escape') onClose();
        else if (e.key === 'ArrowDown') setActive(usable[(at + 1) % usable.length] ?? -1);
        else if (e.key === 'ArrowUp')
          setActive(usable[(at - 1 + usable.length) % usable.length] ?? -1);
        else if (e.key === 'Enter' || e.key === ' ') choose(active);
        else return;
        e.preventDefault();
        e.stopPropagation();
      }}
    >
      {menu.items.map((item, i) =>
        item === 'separator' ? (
          <div key={i} className="ctx-sep" role="separator" />
        ) : (
          <button
            key={i}
            role="menuitem"
            className={[
              'ctx-item',
              item.danger ? 'ctx-danger' : '',
              i === active ? 'ctx-active' : '',
            ].join(' ')}
            disabled={item.disabled}
            tabIndex={-1}
            onMouseEnter={() => setActive(i)}
            onClick={() => choose(i)}
          >
            <span>{item.label}</span>
            {item.hint && <kbd>{item.hint}</kbd>}
          </button>
        ),
      )}
    </div>
  );
}
