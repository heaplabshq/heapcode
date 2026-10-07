import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import type { DesktopTerminal } from '../desktop.js';

/**
 * An interactive shell in the Terminal view — desktop app only.
 *
 * The shell itself lives in the desktop app's main process (it needs a pty,
 * which a browser tab cannot have and the CLI will not ship). This component is
 * only a view onto it: unmounting detaches, it does not kill, so closing the
 * panel or switching to Changes leaves a running build running, and coming
 * back replays what it printed meanwhile.
 */
export function Shell({ cwd, bridge }: { cwd?: string; bridge: DesktopTerminal }): JSX.Element {
  const host = useRef<HTMLDivElement>(null);
  const [exited, setExited] = useState<number>();
  /** Bumped by Restart: the old shell is gone, so the effect opens a new one. */
  const [generation, setGeneration] = useState(0);

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const term = new Terminal({
      fontFamily: cssVar('--mono') || 'ui-monospace, Menlo, monospace',
      fontSize: 12.5,
      lineHeight: 1.2,
      cursorBlink: true,
      scrollback: 5000,
      theme: themeFromPage(),
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(el);
    safeFit(fit);

    let id: string | undefined;
    let live = true;
    const offs: Array<() => void> = [];

    void bridge
      .open(cwd, term.cols, term.rows)
      .then((r) => {
        if (!live) return;
        id = r.id;
        if (r.replay) term.write(r.replay);
        offs.push(bridge.onData(r.id, (d) => term.write(d)));
        offs.push(bridge.onExit(r.id, (code) => setExited(code)));
        term.focus();
      })
      .catch((err: Error) => term.write(`\r\n\x1b[31m${err.message}\x1b[0m\r\n`));

    const input = term.onData((d) => {
      if (id) bridge.write(id, d);
    });
    // Refit whenever the panel is dragged wider or the window resized, and
    // tell the pty — a shell that thinks it is 80 columns wraps full-screen
    // programs wrongly in a 140-column pane.
    const ro = new ResizeObserver(() => {
      safeFit(fit);
      if (id) bridge.resize(id, term.cols, term.rows);
    });
    ro.observe(el);

    return () => {
      live = false;
      ro.disconnect();
      input.dispose();
      for (const off of offs) off();
      term.dispose();
    };
  }, [cwd, bridge, generation]);

  return (
    <div className="shell">
      <div className="shell-host" ref={host} />
      {exited !== undefined && (
        <div className="shell-exited">
          <span>Shell exited{exited ? ` (code ${exited})` : ''}.</span>
          <button
            className="link-btn"
            onClick={() => {
              setExited(undefined);
              setGeneration((g) => g + 1);
            }}
          >
            Start a new one
          </button>
        </div>
      )}
    </div>
  );
}

function safeFit(fit: FitAddon): void {
  // Throws while the element is display:none or has no size yet.
  try {
    fit.fit();
  } catch {
    /* next resize will fit it */
  }
}

function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/** The page's own colours, so the shell reads as part of it in either theme. */
function themeFromPage(): Record<string, string> {
  const accent = cssVar('--accent');
  return {
    background: cssVar('--code-bg') || '#f6f8fa',
    foreground: cssVar('--text') || '#14171a',
    cursor: accent,
    cursorAccent: cssVar('--code-bg'),
    // xterm parses colours itself and knows nothing of color-mix(); a fixed
    // translucent blue reads as selection on both themes.
    selectionBackground: 'rgba(76, 141, 255, 0.3)',
  };
}
