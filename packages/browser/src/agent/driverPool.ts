import { CdpDetached, CdpSession, debuggerAvailable } from './cdp.js';
import { CdpDriver, DomDriver, type PageDriver } from './drivers.js';
import { ensurePage, ensureTab } from '../sidepanel/page.js';

/**
 * Picks the driver for a tab, and copes with losing it.
 *
 * CDP is preferred whenever the user has granted the permission and enabled it.
 * Chrome removes the session without warning the moment DevTools is opened, so
 * this quietly falls back to the content script rather than failing the run --
 * the agent should notice a different-shaped page, not an error.
 *
 * Attaching is per tab and per run. Detaching at the end matters: the "Chrome is
 * being debugged" banner stays up until it happens, and leaving it there after a
 * run has finished is a bug a user reads as spyware.
 */
export class DriverPool {
  #enabled: boolean;
  #sessions = new Map<number, CdpSession>();
  /**
   * One driver per tab, kept for the life of the run.
   *
   * Not an optimisation. `CdpDriver` holds the handle registry and the
   * generation counter as instance state, because handles map to backend node
   * ids rather than to anything living in the page. Handing out a fresh
   * instance per call gave every action an empty registry and a generation of
   * zero, so a handle issued by the read was always "from an earlier snapshot"
   * — reported, absurdly, as generation 1 now 0. Every click failed.
   *
   * `DomDriver` is stateless and survived this, which is exactly why the bug
   * only appeared once CDP was switched on.
   */
  #drivers = new Map<number, PageDriver>();
  #lost = new Set<number>();
  #onFallback?: (reason: string) => void;
  /**
   * The tab this run is working on, once it has opened or chosen one.
   *
   * Unset means "whatever the user is looking at", which is the right default:
   * the panel is docked to a window and the user's attention is the context.
   * Once the agent opens a second tab, though, "active" stops being a useful
   * answer — the run is working in one tab while the user may click into
   * another, and every read would follow them. So opening or switching pins the
   * run to a tab, and it stays pinned until it is closed or switched again.
   */
  #target?: number;

  constructor(enabled: boolean, onFallback?: (reason: string) => void) {
    this.#enabled = enabled;
    this.#onFallback = onFallback;
  }

  /** Which tab the run is pinned to, if any. */
  get target(): number | undefined {
    return this.#target;
  }

  /** Work in this tab from now on. */
  focus(tabId: number): void {
    this.#target = tabId;
  }

  /** Stop working in this tab — it has been closed, or the run is done with it. */
  async forget(tabId: number): Promise<void> {
    if (this.#target === tabId) this.#target = undefined;
    this.#drivers.delete(tabId);
    this.#lost.delete(tabId);
    const session = this.#sessions.get(tabId);
    this.#sessions.delete(tabId);
    await session?.detach();
  }

  /**
   * A driver for the tab the run is working on, plus the tab it belongs to.
   *
   * Named for the active tab because that is the usual answer and every call
   * site reads better for it. When the run has pinned a tab, that one wins —
   * including while the user is looking at something else, which is the whole
   * point of pinning.
   */
  async forActiveTab(): Promise<
    { ok: true; driver: PageDriver; tabId: number; url: string } | { ok: false; reason: string }
  > {
    const page = this.#target !== undefined ? await ensureTab(this.#target) : await ensurePage();
    if (!page.ok) {
      // A pinned tab that has gone is not a failure to report to the user; it is
      // a reason to go back to following them.
      if (this.#target !== undefined) {
        await this.forget(this.#target);
        const fallback = await ensurePage();
        if (fallback.ok) {
          const driver = await this.#driverFor(fallback.tabId);
          return { ok: true, driver, tabId: fallback.tabId, url: fallback.url };
        }
        return fallback;
      }
      return page;
    }

    const driver = await this.#driverFor(page.tabId);
    return { ok: true, driver, tabId: page.tabId, url: page.url };
  }

  async #driverFor(tabId: number): Promise<PageDriver> {
    const cached = this.#drivers.get(tabId);
    if (cached) return cached;

    if (!this.#enabled || this.#lost.has(tabId)) return this.#remember(tabId, new DomDriver(tabId));
    if (!debuggerAvailable()) return this.#remember(tabId, new DomDriver(tabId));

    const session = new CdpSession(tabId);
    session.onLost(() => {
      this.#sessions.delete(tabId);
      // The CDP driver's registry died with the session; the next call builds a
      // DomDriver in its place.
      this.#drivers.delete(tabId);
      // Remembered for the rest of the run: re-attaching would fight whatever
      // took the session, and DevTools being open is a deliberate act.
      this.#lost.add(tabId);
      this.#onFallback?.(
        'The debugger session ended — DevTools was opened on this tab. Continuing without it, ' +
          'which means clicks are synthetic and file attachment is unavailable.',
      );
    });

    const attached = await session.attach();
    if (!attached.ok) {
      this.#lost.add(tabId);
      this.#onFallback?.(`${attached.reason} Continuing without the debugger.`);
      return this.#remember(tabId, new DomDriver(tabId));
    }

    this.#sessions.set(tabId, session);
    return this.#remember(tabId, new CdpDriver(session));
  }

  #remember(tabId: number, driver: PageDriver): PageDriver {
    this.#drivers.set(tabId, driver);
    return driver;
  }

  /** Take the banner down. Always call this when a run ends, however it ended. */
  async release(): Promise<void> {
    const sessions = [...this.#sessions.values()];
    this.#sessions.clear();
    this.#drivers.clear();
    this.#target = undefined;
    await Promise.all(sessions.map((session) => session.detach()));
  }

  /** Whether a CDP command failure should be retried on the DOM driver. */
  static isLostSession(error: unknown): boolean {
    return error instanceof CdpDetached;
  }
}
