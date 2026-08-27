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
  | { type: 'origin'; origin: string };

export const PORT_NAME = 'heapbrowse';
