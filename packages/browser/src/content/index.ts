import { extractSnapshot } from './extract.js';
import { HandleRegistry } from './registry.js';
import type { PageSnapshot } from '../shared/snapshot.js';

/**
 * The content script: the only code that touches the page.
 *
 * Injected on demand rather than declared in the manifest. A declared
 * `content_scripts` entry needs its `matches` granted at install time, which
 * for a general-purpose browser agent means asking for every site up front —
 * the broad grant PRD §7.6 says to avoid. Injecting per-tab, against a
 * per-origin permission the user grants when they point the agent at a page,
 * gets the same capability with a proportionate ask.
 *
 * The registry lives here, not in the panel, because handles must be tied to
 * the actual element identities in this document. It is module state, so it
 * dies with the page — which is exactly right: navigation invalidates every
 * handle, and there is no way for a stale one to survive the transition
 * (PRD §7.5).
 */

const registry = new HandleRegistry();

export type ContentRequest = { type: 'snapshot' };

export type ContentResponse =
  | { ok: true; snapshot: PageSnapshot }
  | { ok: false; error: string };

function handle(request: ContentRequest): ContentResponse {
  try {
    switch (request.type) {
      case 'snapshot':
        return { ok: true, snapshot: extractSnapshot(document, registry) };
      default:
        return { ok: false, error: `unknown request` };
    }
  } catch (error) {
    // A page can break extraction in ways worth reporting rather than hanging:
    // an exotic custom element, a getter that throws, a cross-origin frame.
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

// Guard against double injection. `executeScript` on an already-injected tab
// runs the file again, which would otherwise register a second listener and
// mint handles from a second registry.
declare global {
  interface Window {
    __heapbrowseInjected?: boolean;
  }
}

if (!window.__heapbrowseInjected) {
  window.__heapbrowseInjected = true;
  chrome.runtime.onMessage.addListener(
    (request: ContentRequest, _sender, respond: (response: ContentResponse) => void) => {
      respond(handle(request));
      return true;
    },
  );
}
