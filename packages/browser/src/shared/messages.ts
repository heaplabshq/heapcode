/**
 * The panel ↔ service-worker port protocol.
 *
 * Deliberately tiny in M0, because the service worker deliberately does almost
 * nothing. Chrome terminates an idle MV3 worker after about 30 seconds, and an
 * agent run is minutes of LLM calls, so the run cannot live there (PRD §7.1,
 * PLAN guardrail 3). The panel is a real document with a normal lifetime and is
 * where the loop will run from M2; the worker stays a stateless router for the
 * things only it can do — tab events, content-script injection.
 *
 * The port itself is load-bearing beyond messaging: an open `chrome.runtime.Port`
 * keeps the worker alive, so the panel holds one for as long as it is open.
 */

/** Panel → worker. */
export type PanelMessage =
  | { type: 'ping' }
  /** Asks the worker for the extension's own origin, for the Ollama diagnostic. */
  | { type: 'origin' };

/** Worker → panel. */
export type WorkerMessage =
  | { type: 'pong' }
  | { type: 'origin'; origin: string }
  /**
   * Something to put in the composer, from a right-click on the page.
   *
   * Sent over the port when a panel is already open, and left in
   * `chrome.storage.session` regardless — the panel may be opening for the
   * first time in response to this very click, in which case there was no port
   * to send it on when the menu fired.
   */
  | { type: 'prompt'; text: string }
  /**
   * Stop the run, asked for from the page rather than from the panel.
   *
   * The bar heapbrowse draws along the bottom of a page it is driving carries a
   * stop button, because that is where the user is looking when they decide to
   * stop it. A content script cannot reach the panel document, so it goes to the
   * worker and the worker hands it to every open panel — there is at most one
   * run, in one panel, so a broadcast is exact rather than merely convenient.
   */
  | { type: 'stop' };

/** Page → worker. The one thing a driven page may ask for. */
export interface PageStopMessage {
  __heapbrowse: 'stop';
}

export const PORT_NAME = 'heapbrowse';

/** Where a right-click leaves its request for the panel to pick up. */
export const PENDING_PROMPT_KEY = 'heapbrowse.pendingPrompt';
