/**
 * A Chrome DevTools Protocol session on one tab.
 *
 * The reason to want CDP at all: it is what the browser uses on itself, so it
 * answers questions a content script can only estimate. The accessibility tree
 * already knows which elements are hidden, inert behind a modal, or unnamed;
 * `Input` dispatches events the page cannot tell from a person's; and
 * `DOM.setFileInputFiles` is the only way to attach a file at all. Every
 * heuristic in `src/content/` exists because none of that was available.
 *
 * The reason it cannot simply replace the content script: **Chrome detaches the
 * debugger the moment DevTools is opened on the tab**, and there is no way to
 * prevent or predict it. So CDP is the preferred driver and the DOM walk is the
 * landing ground, not a nicety. `onDetach` is treated as normal, not an error.
 *
 * Attaching also shows a permanent "Chrome is being debugged" banner. That is
 * the price, it is not hideable, and it is why this is opt-in.
 */

export type CdpParams = Record<string, unknown>;

export class CdpSession {
  #tabId: number;
  #attached = false;
  #onLost?: () => void;

  constructor(tabId: number) {
    this.#tabId = tabId;
  }

  get tabId(): number {
    return this.#tabId;
  }

  get attached(): boolean {
    return this.#attached;
  }

  /** Called when Chrome takes the session away — DevTools, or the tab closing. */
  onLost(handler: () => void): void {
    this.#onLost = handler;
  }

  #detachListener = (source: chrome.debugger.Debuggee) => {
    if (source.tabId !== this.#tabId) return;
    this.#attached = false;
    this.#onLost?.();
  };

  async attach(): Promise<{ ok: true } | { ok: false; reason: string }> {
    if (this.#attached) return { ok: true };
    try {
      // 1.3 is the protocol version every domain used here is stable in.
      await chrome.debugger.attach({ tabId: this.#tabId }, '1.3');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // The common causes are worth naming: another debugger already has the
      // tab (DevTools, or another extension), or the page is one Chrome will
      // not let anyone attach to.
      if (/already attached/i.test(message)) {
        return {
          ok: false,
          reason:
            'Something else is already debugging this tab — usually DevTools. Close it and try again.',
        };
      }
      return { ok: false, reason: `Could not attach the debugger: ${message}` };
    }

    chrome.debugger.onDetach.addListener(this.#detachListener);
    this.#attached = true;

    // The accessibility tree is not populated until the domain is enabled, and
    // DOM must be enabled before backend node ids can be resolved.
    await this.send('DOM.enable');
    await this.send('Accessibility.enable');
    return { ok: true };
  }

  async detach(): Promise<void> {
    chrome.debugger.onDetach.removeListener(this.#detachListener);
    if (!this.#attached) return;
    this.#attached = false;
    try {
      await chrome.debugger.detach({ tabId: this.#tabId });
    } catch {
      // Already gone is the outcome we wanted.
    }
  }

  /**
   * One protocol command.
   *
   * Throws `CdpDetached` when the session has gone, so callers can fall back to
   * the content script rather than reporting a failure the user cannot act on.
   */
  async send<T = unknown>(method: string, params: CdpParams = {}): Promise<T> {
    if (!this.#attached) throw new CdpDetached();
    try {
      return (await chrome.debugger.sendCommand({ tabId: this.#tabId }, method, params)) as T;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/detached|not attached|No tab with given id/i.test(message)) {
        this.#attached = false;
        this.#onLost?.();
        throw new CdpDetached();
      }
      throw new Error(`${method} failed: ${message}`);
    }
  }
}

/** The session went away mid-run. Expected, and always recoverable. */
export class CdpDetached extends Error {
  constructor() {
    super('The debugger session ended — DevTools was opened, or the tab closed.');
    this.name = 'CdpDetached';
  }
}

/** Whether the user has granted the `debugger` permission. */
export async function hasDebuggerPermission(): Promise<boolean> {
  return chrome.permissions.contains({ permissions: ['debugger'] });
}

/** Ask for it. Must run inside a user gesture. */
export async function requestDebuggerPermission(): Promise<boolean> {
  return chrome.permissions.request({ permissions: ['debugger'] });
}
