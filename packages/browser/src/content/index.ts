import { extractSnapshot } from './extract.js';
import { HandleRegistry } from './registry.js';
import type { PageSnapshot } from '../shared/snapshot.js';

/**
 * The content script: the only code that touches the page.
 *
 * Injected on demand rather than declared in the manifest. A declared
 * `content_scripts` entry needs its `matches` granted at install time, which
 * for a general-purpose browser agent means asking for every site up front --
 * the broad grant PRD section 7.6 says to avoid. Injecting per-tab, against a
 * per-origin permission the user grants when they point the agent at a page,
 * gets the same capability with a proportionate ask.
 *
 * The registry lives here, not in the panel, because handles must be tied to
 * the actual element identities in this document. It is module state, so it
 * dies with the page -- which is exactly right: navigation invalidates every
 * handle, and there is no way for a stale one to survive the transition
 * (PRD section 7.5).
 */

const registry = new HandleRegistry();

export type ContentRequest =
  | { type: 'snapshot' }
  | { type: 'scroll'; direction: 'down' | 'up' | 'top' | 'bottom'; pages?: number }
  | { type: 'settle'; seconds: number };

/** Discriminated on `kind` so a caller can narrow without re-checking shape. */
export type ContentResponse =
  | { ok: true; kind: 'snapshot'; snapshot: PageSnapshot }
  | { ok: true; kind: 'settled'; settled: boolean; waitedMs: number }
  | { ok: false; error: string };

function scroll(request: Extract<ContentRequest, { type: 'scroll' }>): void {
  const step = window.innerHeight * (request.pages ?? 1);
  switch (request.direction) {
    case 'down':
      window.scrollBy({ top: step, behavior: 'instant' as ScrollBehavior });
      break;
    case 'up':
      window.scrollBy({ top: -step, behavior: 'instant' as ScrollBehavior });
      break;
    case 'top':
      window.scrollTo({ top: 0, behavior: 'instant' as ScrollBehavior });
      break;
    case 'bottom':
      window.scrollTo({ top: document.body.scrollHeight, behavior: 'instant' as ScrollBehavior });
      break;
  }
}

/**
 * Resolve once the page stops mutating, or when the budget runs out.
 *
 * A fixed sleep is wrong in both directions -- too short for a slow fetch, and
 * wasted time on a page that was ready immediately. A MutationObserver that
 * resets a short quiet timer on each batch returns as soon as the DOM settles,
 * which is the actual condition the agent is waiting for.
 */
function settle(seconds: number): Promise<{ settled: boolean; waitedMs: number }> {
  const budget = Math.min(Math.max(seconds, 0), 15) * 1000;
  const QUIET_MS = 400;
  const started = Date.now();

  return new Promise((resolve) => {
    let quiet: ReturnType<typeof setTimeout>;
    const observer = new MutationObserver(() => {
      clearTimeout(quiet);
      quiet = setTimeout(done, QUIET_MS);
    });

    function done(settled = true) {
      observer.disconnect();
      clearTimeout(quiet);
      clearTimeout(cap);
      resolve({ settled, waitedMs: Date.now() - started });
    }

    const cap = setTimeout(() => done(false), budget);
    quiet = setTimeout(() => done(true), QUIET_MS);
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
    });
  });
}

async function handle(request: ContentRequest): Promise<ContentResponse> {
  try {
    switch (request.type) {
      case 'snapshot':
        return { ok: true, kind: 'snapshot', snapshot: extractSnapshot(document, registry) };
      case 'scroll': {
        scroll(request);
        // Let scrolling take effect, and give a lazy-loading page the chance to
        // put something there, before describing what is now visible.
        await settle(1.5);
        return { ok: true, kind: 'snapshot', snapshot: extractSnapshot(document, registry) };
      }
      case 'settle': {
        const result = await settle(request.seconds);
        return { ok: true, kind: 'settled', ...result };
      }
      default:
        return { ok: false, error: 'unknown request' };
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
      void handle(request).then(respond);
      // Keeps the message channel open for the async reply above; without it
      // Chrome closes it and the panel sees the port disconnect instead.
      return true;
    },
  );
}
