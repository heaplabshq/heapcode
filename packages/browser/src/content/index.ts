import { extractSnapshot } from './extract.js';
import { HandleRegistry } from './registry.js';
import { performClick, performSelect, performType, resolveTarget } from './actions.js';
import type { Control, PageSnapshot } from '../shared/snapshot.js';

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

/**
 * The controls from the most recent snapshot, by handle.
 *
 * Kept so a confirmation can describe the element from our own extraction
 * rather than from the model's description of it -- the page may have named it
 * one thing while it does another.
 */
let lastControls = new Map<number, Control>();

/**
 * Retire every handle issued so far.
 *
 * Called after any mutating action, because that is the moment the page may
 * have re-rendered underneath the indices. The next action on an old handle
 * then fails loudly instead of landing on whatever now occupies that position
 * (PRD section 4.2). The cost is a re-read between actions; the delta path
 * makes that cheap, and the alternative is clicking the wrong row.
 */
function invalidateHandles(): void {
  registry.reset();
  lastControls = new Map();
}

function snapshotNow(): PageSnapshot {
  const snapshot = extractSnapshot(document, registry);
  lastControls = new Map(snapshot.controls.map((c) => [c.handle, c]));
  return snapshot;
}

export type ContentRequest =
  | { type: 'snapshot' }
  | { type: 'scroll'; direction: 'down' | 'up' | 'top' | 'bottom'; pages?: number }
  | { type: 'settle'; seconds: number }
  /** What is at this handle, for a confirmation the user can actually check. */
  | { type: 'describe'; handle: number; generation: number }
  /** Outline it on the page, so the user sees the real element, not a name. */
  | { type: 'highlight'; handle: number; generation: number }
  | { type: 'clearHighlight' }
  | { type: 'click'; handle: number; generation: number }
  | { type: 'type'; handle: number; generation: number; text: string }
  | { type: 'select'; handle: number; generation: number; option: string }
  | { type: 'back' };

/** Discriminated on `kind` so a caller can narrow without re-checking shape. */
export type ContentResponse =
  | { ok: true; kind: 'snapshot'; snapshot: PageSnapshot }
  | { ok: true; kind: 'settled'; settled: boolean; waitedMs: number }
  | { ok: true; kind: 'control'; control: Control }
  | { ok: true; kind: 'acted'; note: string }
  | { ok: true; kind: 'ok' }
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

/** The snapshot entry for a handle, so a confirmation can describe the real element. */
function describeHandle(handle: number): Control | undefined {
  return lastControls.get(handle);
}

/**
 * A visible outline on the element about to be acted on.
 *
 * The confirmation shows the user the element itself, not the model's account
 * of it. That is the point of PRD section 6.1.4: a page can name a button one
 * thing and have it do another, so the human is shown our extraction and the
 * real thing on screen.
 */
const HIGHLIGHT_ID = '__heapbrowse_highlight';

function clearHighlight(): void {
  document.getElementById(HIGHLIGHT_ID)?.remove();
}

function highlight(element: Element): void {
  clearHighlight();
  element.scrollIntoView({ block: 'center', behavior: 'instant' as ScrollBehavior });
  const rect = element.getBoundingClientRect();
  const box = document.createElement('div');
  box.id = HIGHLIGHT_ID;
  Object.assign(box.style, {
    position: 'fixed',
    left: `${rect.left - 3}px`,
    top: `${rect.top - 3}px`,
    width: `${rect.width + 6}px`,
    height: `${rect.height + 6}px`,
    border: '2px solid #2563eb',
    borderRadius: '4px',
    boxShadow: '0 0 0 9999px rgba(0,0,0,0.28)',
    zIndex: '2147483647',
    pointerEvents: 'none',
  } satisfies Partial<CSSStyleDeclaration>);
  document.body.appendChild(box);
}

async function handle(request: ContentRequest): Promise<ContentResponse> {
  try {
    switch (request.type) {
      case 'snapshot':
        return { ok: true, kind: 'snapshot', snapshot: snapshotNow() };
      case 'scroll': {
        scroll(request);
        // Let scrolling take effect, and give a lazy-loading page the chance to
        // put something there, before describing what is now visible.
        await settle(1.5);
        return { ok: true, kind: 'snapshot', snapshot: snapshotNow() };
      }
      case 'settle': {
        const result = await settle(request.seconds);
        return { ok: true, kind: 'settled', ...result };
      }
      case 'describe': {
        const found = resolveTarget(registry, request.handle, request.generation);
        if (!found.ok) return { ok: false, error: found.error };
        const control = describeHandle(request.handle);
        if (!control) return { ok: false, error: `No record of handle [${request.handle}].` };
        return { ok: true, kind: 'control', control };
      }
      case 'highlight': {
        const found = resolveTarget(registry, request.handle, request.generation);
        if (!found.ok) return { ok: false, error: found.error };
        highlight(found.element);
        return { ok: true, kind: 'ok' };
      }
      case 'clearHighlight':
        clearHighlight();
        return { ok: true, kind: 'ok' };
      case 'click': {
        const found = resolveTarget(registry, request.handle, request.generation);
        if (!found.ok) return { ok: false, error: found.error };
        clearHighlight();
        const result = performClick(found.element);
        invalidateHandles();
        return result.ok ? { ok: true, kind: 'acted', note: result.note } : { ok: false, error: result.error };
      }
      case 'type': {
        const found = resolveTarget(registry, request.handle, request.generation);
        if (!found.ok) return { ok: false, error: found.error };
        clearHighlight();
        const result = performType(found.element, request.text);
        invalidateHandles();
        return result.ok ? { ok: true, kind: 'acted', note: result.note } : { ok: false, error: result.error };
      }
      case 'select': {
        const found = resolveTarget(registry, request.handle, request.generation);
        if (!found.ok) return { ok: false, error: found.error };
        clearHighlight();
        const result = performSelect(found.element, request.option);
        invalidateHandles();
        return result.ok ? { ok: true, kind: 'acted', note: result.note } : { ok: false, error: result.error };
      }
      case 'back':
        history.back();
        invalidateHandles();
        return { ok: true, kind: 'acted', note: 'Went back.' };
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
