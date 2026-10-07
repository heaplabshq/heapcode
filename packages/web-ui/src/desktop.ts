/**
 * What the Heap Code desktop app (packages/desktop) adds to the page, via its
 * preload script. Absent in a plain browser tab, so every caller must treat it
 * as optional — the web UI is the same bundle in both places.
 */
export interface DesktopBridge {
  /** Hold (or release) a power-save blocker; resolves to the new state. */
  keepAwake?(on: boolean): Promise<boolean>;
  /** The current state, synchronously, so a menu opens already correct. */
  keepAwakeState?(): boolean;
  /** A real shell on a pty, run by the desktop app — see desktop/src/terminal.cjs. */
  terminal?: DesktopTerminal;
  /**
   * Present when the page may use <webview> — the desktop app vets each one
   * (desktop/src/browser.cjs). Also the dev-server addresses its shells printed.
   */
  browser?: {
    /** A JPEG data: URL of the webview whose contents id this is. */
    capture(webContentsId: number): Promise<string>;
    /** A real click, key or text insertion into that webview (desktop/src/browser.cjs). */
    input(
      webContentsId: number,
      action: { kind: 'click'; x: number; y: number } | { kind: 'text'; text: string } | { kind: 'key'; key: string },
    ): Promise<boolean>;
    localUrls(): Promise<string[]>;
    onLocalUrls(cb: (urls: string[]) => void): () => void;
  };
}

export interface DesktopTerminal {
  /**
   * Attach to the shell for `cwd`, starting one if there is none. `replay` is
   * what it printed while nobody was watching, so a reopened view is not blank.
   */
  open(cwd: string | undefined, cols: number, rows: number): Promise<{ id: string; replay: string }>;
  write(id: string, data: string): void;
  resize(id: string, cols: number, rows: number): void;
  kill(id: string): void;
  onData(id: string, cb: (data: string) => void): () => void;
  onExit(id: string, cb: (code: number) => void): () => void;
}

export function desktopBridge(): DesktopBridge | undefined {
  return (globalThis as { heapDesktop?: DesktopBridge }).heapDesktop;
}
