import { CdpDetached, CdpSession, debuggerAvailable } from './cdp.js';
import { CdpDriver, DomDriver, type PageDriver } from './drivers.js';
import { ensurePage } from '../sidepanel/page.js';

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
  #lost = new Set<number>();
  #onFallback?: (reason: string) => void;

  constructor(enabled: boolean, onFallback?: (reason: string) => void) {
    this.#enabled = enabled;
    this.#onFallback = onFallback;
  }

  /** A driver for the active tab, plus the tab it belongs to. */
  async forActiveTab(): Promise<
    { ok: true; driver: PageDriver; tabId: number; url: string } | { ok: false; reason: string }
  > {
    const page = await ensurePage();
    if (!page.ok) return page;

    const driver = await this.#driverFor(page.tabId);
    return { ok: true, driver, tabId: page.tabId, url: page.url };
  }

  async #driverFor(tabId: number): Promise<PageDriver> {
    if (!this.#enabled || this.#lost.has(tabId)) return new DomDriver(tabId);
    if (!debuggerAvailable()) return new DomDriver(tabId);

    const existing = this.#sessions.get(tabId);
    if (existing?.attached) return new CdpDriver(existing);

    const session = new CdpSession(tabId);
    session.onLost(() => {
      this.#sessions.delete(tabId);
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
      return new DomDriver(tabId);
    }

    this.#sessions.set(tabId, session);
    return new CdpDriver(session);
  }

  /** Take the banner down. Always call this when a run ends, however it ended. */
  async release(): Promise<void> {
    const sessions = [...this.#sessions.values()];
    this.#sessions.clear();
    await Promise.all(sessions.map((session) => session.detach()));
  }

  /** Whether a CDP command failure should be retried on the DOM driver. */
  static isLostSession(error: unknown): boolean {
    return error instanceof CdpDetached;
  }
}
