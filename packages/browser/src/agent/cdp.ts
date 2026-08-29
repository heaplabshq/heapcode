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
  /**
   * Requests the page has started and not finished.
   *
   * This is what makes waiting mean something. Without it `settle` is a fixed
   * sleep, which is wrong in both directions: too short for a search that takes
   * two seconds to come back, and wasted time on a page that was ready
   * immediately. The browser already knows; it just has to be asked.
   */
  #pending = new Set<string>();
  /** When the last request started or finished. The clock `settle` waits on. */
  #lastActivity = 0;

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
    this.#pending.clear();
    this.#onLost?.();
  };

  /**
   * Protocol events for this tab.
   *
   * Only network bookkeeping uses this today. It is a listener on the whole
   * `chrome.debugger.onEvent` stream filtered to our tab, because the API
   * provides no per-session subscription -- every extension listener sees every
   * event and has to sort them out itself.
   */
  #eventListener = (source: chrome.debugger.Debuggee, method: string, params?: object) => {
    if (source.tabId !== this.#tabId) return;
    const requestId = (params as { requestId?: string } | undefined)?.requestId;

    switch (method) {
      case 'Network.requestWillBeSent':
        if (requestId) this.#pending.add(requestId);
        this.#lastActivity = Date.now();
        break;
      case 'Network.loadingFinished':
      case 'Network.loadingFailed':
      case 'Network.requestServedFromCache':
        if (requestId) this.#pending.delete(requestId);
        this.#lastActivity = Date.now();
        break;
      case 'Page.frameNavigated':
        // A new document owns none of the old document's requests, and a
        // navigation that abandons them would otherwise leave `settle` waiting
        // for replies that are never coming.
        this.#pending.clear();
        this.#lastActivity = Date.now();
        break;
      default:
        break;
    }
  };

  /** How many requests the page is still waiting on. */
  get pendingRequests(): number {
    return this.#pending.size;
  }

  /** When the network last did anything, as an epoch millisecond count. */
  get lastNetworkActivity(): number {
    return this.#lastActivity;
  }

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
    chrome.debugger.onEvent.addListener(this.#eventListener);
    this.#attached = true;

    // The accessibility tree is not populated until the domain is enabled, and
    // DOM must be enabled before backend node ids can be resolved. `Page` is
    // what lists the frames; `Network` is what makes waiting real. Both are
    // enabled once here rather than per call, because the events they produce
    // only arrive while the domain is on.
    await this.send('DOM.enable');
    await this.send('Accessibility.enable');
    await this.send('Page.enable');
    // Zero buffers: the only thing wanted from `Network` is the count of
    // requests in flight. Chrome's default is to hold every response body in
    // memory in case a debugger asks for one, and nothing here ever will.
    await this.send('Network.enable', { maxTotalBufferSize: 0, maxResourceBufferSize: 0 });
    return { ok: true };
  }

  async detach(): Promise<void> {
    chrome.debugger.onDetach.removeListener(this.#detachListener);
    chrome.debugger.onEvent.removeListener(this.#eventListener);
    this.#pending.clear();
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

/**
 * Whether the debugger API is usable at all.
 *
 * `debugger` is a required permission -- Chrome does not allow it to be optional
 * -- so this is normally true. It is checked rather than assumed because a
 * manifest edit that dropped it would otherwise fail as a confusing `undefined`
 * deep inside a run rather than as a clean fall back to the content script.
 */
export function debuggerAvailable(): boolean {
  return typeof chrome !== 'undefined' && typeof chrome.debugger?.attach === 'function';
}

/** One entry of `Page.getFrameTree`, flattened. */
export interface FrameRef {
  id: string;
  url: string;
  /** True for the page's own top-level document. */
  top: boolean;
}

interface FrameTreeNode {
  frame: { id: string; url?: string };
  childFrames?: FrameTreeNode[];
}

/**
 * Every frame in the tab, top document first.
 *
 * The accessibility tree is per frame: `Accessibility.getFullAXTree` with no
 * argument returns the main document only, so an embedded consent dialog, an
 * embedded checkout, or a payment field inside an iframe is simply not in the
 * page as the model sees it. Asking per frame is the fix, and enumerating them
 * is the first half of it.
 *
 * Frames Chrome runs in another process (a cross-origin iframe, usually) belong
 * to a different debugger target and will refuse the AX request. They are still
 * listed here so the caller can say the frame exists and could not be read,
 * which is a materially different thing to tell a model than silence.
 */
export async function frameList(session: CdpSession): Promise<FrameRef[]> {
  try {
    const tree = await session.send<{ frameTree: FrameTreeNode }>('Page.getFrameTree');
    const frames: FrameRef[] = [];
    const walk = (node: FrameTreeNode, top: boolean) => {
      frames.push({ id: node.frame.id, url: node.frame.url ?? '', top });
      for (const child of node.childFrames ?? []) walk(child, false);
    };
    walk(tree.frameTree, true);
    return frames;
  } catch (error) {
    if (error instanceof CdpDetached) throw error;
    return [];
  }
}
