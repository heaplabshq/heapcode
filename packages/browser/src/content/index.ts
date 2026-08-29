import { extractSnapshot } from './extract.js';
import { HandleRegistry } from './registry.js';
import {
  performClick,
  performHover,
  performPress,
  performSelect,
  performType,
  resolveTarget,
  type KeyPress,
} from './actions.js';
import { scrollBy } from './scroll.js';
import { openModal } from './modal.js';
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
 *
 * The script runs in *every* frame, and every frame answers the panel for
 * itself. Frames do not talk to each other and no frame speaks for another:
 * the aggregation that used to happen here, over `postMessage`, is done by the
 * panel now, for reasons written up in `shared/frames.ts`. The short version is
 * that `postMessage` proves only which window replied, and the window that
 * matters is one our content script was never injected into.
 *
 * Handles stay unambiguous across frames because the panel gives each frame a
 * band of numbers to mint from.
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
 * This document, and only this document.
 *
 * Frames used to be gathered here, by the top frame, over `postMessage`: it
 * broadcast to every `<iframe>` on the page and merged whatever answered. The
 * frames that mattered were the ones our content script had never been injected
 * into -- a third-party advert whose origin was never granted -- and in those,
 * the only thing that could answer was the page's own script. It could invent
 * controls, and receive the user's saved details when autofill matched one.
 *
 * So the gathering moved to the panel, which addresses each frame directly over
 * `chrome.tabs.sendMessage(..., { frameId })`. Every frame answers for itself,
 * no frame speaks for another, and a frame with no content script in it simply
 * does not reply. See `shared/frames.ts`.
 */
function snapshotNow(base?: number): PageSnapshot {
  // The band this frame's handles live in, assigned by the panel and claimed
  // once: the numbers already handed to the model have to keep meaning what
  // they meant.
  if (base !== undefined && base > 0) registry.useBase(base);
  const snapshot = extractSnapshot(document, registry);
  lastControls = new Map(snapshot.controls.map((c) => [c.handle, c]));
  return snapshot;
}

export type ContentRequest =
  /**
   * Read this frame. `base` is the band of handle numbers it should mint from,
   * assigned by the panel so that a handle says which frame it belongs to.
   */
  | { type: 'snapshot'; base?: number }
  | { type: 'scroll'; direction: 'down' | 'up' | 'top' | 'bottom'; pages?: number }
  | { type: 'settle'; seconds: number }
  /** What is at this handle, for a confirmation the user can actually check. */
  | { type: 'describe'; handle: number; generation: number }
  /**
   * Outline it on the page, so the user sees the real element, not a name.
   *
   * `label` is what the panel is asking the user to approve, drawn beside the
   * ring. Having it on the page as well as in the panel is what lets someone
   * check the two against each other without moving their eyes off the thing.
   */
  | { type: 'highlight'; handle: number; generation: number; label?: string }
  | { type: 'clearHighlight' }
  | { type: 'click'; handle: number; generation: number }
  | { type: 'type'; handle: number; generation: number; text: string }
  | { type: 'select'; handle: number; generation: number; option: string }
  | { type: 'hover'; handle: number; generation: number }
  | { type: 'press'; handle?: number; generation?: number; press: KeyPress }
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
  scrollBy(document, request.direction, request.pages ?? 1, openModal(document));
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
 *
 * Everything lives in a closed shadow root: the page's CSS cannot restyle it,
 * and its own keyframes cannot leak out and animate something on the page the
 * agent is in the middle of reading. It tracks the element rather than being
 * drawn once at fixed coordinates -- the user is being asked a question and may
 * well scroll to look around before answering, and a ring left behind at the
 * old offset points at whatever happens to be there now.
 */
const HIGHLIGHT_ID = '__heapbrowse_highlight';

/** Cancels the frame loop that keeps the ring on the element. */
let untrack: (() => void) | undefined;

function clearHighlight(): void {
  untrack?.();
  untrack = undefined;
  document.getElementById(HIGHLIGHT_ID)?.remove();
}

const HIGHLIGHT_CSS = `
  :host { all: initial; }
  .scrim {
    position: fixed;
    inset: 0;
    background: rgba(10, 12, 18, 0.34);
    pointer-events: none;
    opacity: 0;
    animation: hb-scrim 0.22s cubic-bezier(0.22, 0.61, 0.36, 1) forwards;
  }
  /* The hole is the ring's own outer shadow, so the scrim and the cut-out can
     never disagree about where the element is. */
  .ring {
    position: fixed;
    border: 2px solid #6366f1;
    border-radius: 6px;
    box-shadow:
      0 0 0 9999px rgba(10, 12, 18, 0.34),
      0 0 0 5px rgba(99, 102, 241, 0.28);
    pointer-events: none;
    animation: hb-ring 0.28s cubic-bezier(0.34, 1.4, 0.64, 1);
  }
  .tag {
    position: fixed;
    max-width: min(320px, calc(100vw - 24px));
    padding: 4px 9px;
    border-radius: 7px;
    background: #6366f1;
    color: #fff;
    font: 500 12px/1.35 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    pointer-events: none;
    box-shadow: 0 6px 18px -6px rgba(0, 0, 0, 0.5);
    animation: hb-tag 0.28s cubic-bezier(0.34, 1.4, 0.64, 1);
  }
  .tag:empty { display: none; }
  @keyframes hb-scrim { to { opacity: 1; } }
  @keyframes hb-ring { from { opacity: 0; transform: scale(1.05); } }
  @keyframes hb-tag { from { opacity: 0; transform: translateY(4px); } }
  @media (prefers-reduced-motion: reduce) {
    .scrim { animation: none; opacity: 1; }
    .ring, .tag { animation: none; }
  }
`;

function highlight(element: Element, label?: string): void {
  clearHighlight();
  element.scrollIntoView({ block: 'center', behavior: 'instant' as ScrollBehavior });

  const host = document.createElement('div');
  host.id = HIGHLIGHT_ID;
  Object.assign(host.style, {
    position: 'fixed',
    inset: '0',
    zIndex: '2147483647',
    pointerEvents: 'none',
  } satisfies Partial<CSSStyleDeclaration>);
  const root = host.attachShadow({ mode: 'closed' });

  const style = document.createElement('style');
  style.textContent = HIGHLIGHT_CSS;

  const ring = document.createElement('div');
  ring.className = 'ring';

  const tag = document.createElement('div');
  tag.className = 'tag';
  // `textContent`, never `innerHTML`: this string describes an element the page
  // supplied the name of, and it is being written back onto that page.
  if (label) tag.textContent = label;

  root.append(style, ring, tag);
  document.documentElement.appendChild(host);

  /**
   * Keep the ring on the element.
   *
   * A rAF loop rather than scroll and resize listeners: the element can also
   * move because the page animated it, because a sticky header collapsed, or
   * because a layout settled after a font loaded -- and none of those fire a
   * scroll event. It runs only while a confirmation is on screen, and it writes
   * nothing unless the rectangle actually changed.
   */
  let last = '';
  const place = () => {
    const rect = element.getBoundingClientRect();
    const key = `${rect.left},${rect.top},${rect.width},${rect.height}`;
    if (key !== last) {
      last = key;
      ring.style.left = `${rect.left - 3}px`;
      ring.style.top = `${rect.top - 3}px`;
      ring.style.width = `${rect.width + 6}px`;
      ring.style.height = `${rect.height + 6}px`;
      // Above the element when there is room, below it when there is not, so
      // the label never covers the thing it is naming.
      const above = rect.top > 34;
      tag.style.top = above ? `${rect.top - 31}px` : `${rect.bottom + 9}px`;
      tag.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - 16))}px`;
    }
    frame = requestAnimationFrame(place);
  };
  let frame = requestAnimationFrame(place);
  untrack = () => cancelAnimationFrame(frame);
}

async function handle(request: ContentRequest): Promise<ContentResponse> {
  try {
    switch (request.type) {
      case 'snapshot':
        return { ok: true, kind: 'snapshot', snapshot: snapshotNow(request.base) };
      case 'scroll': {
        scroll(request);
        // Let scrolling take effect, and give a lazy-loading page the chance to
        // put something there, before describing what is now visible.
        await settle(1.5);
        return { ok: true, kind: 'snapshot', snapshot: await snapshotNow() };
      }
      case 'settle': {
        const result = await settle(request.seconds);
        return { ok: true, kind: 'settled', ...result };
      }
      case 'describe': {
        const control = describeHandle(request.handle);
        if (!control) return { ok: false, error: `No record of handle [${request.handle}].` };
        const found = resolveTarget(registry, request.handle, request.generation);
        if (!found.ok) return { ok: false, error: found.error };
        return { ok: true, kind: 'control', control };
      }
      case 'highlight': {
        const found = resolveTarget(registry, request.handle, request.generation);
        if (!found.ok) return { ok: false, error: found.error };
        highlight(found.element, request.label);
        return { ok: true, kind: 'ok' };
      }
      case 'clearHighlight': {
        // Only this frame's outline. The panel sends this to every frame,
        // because by the time it arrives nobody knows which one drew it.
        clearHighlight();
        return { ok: true, kind: 'ok' };
      }
      case 'click': {
        const found = resolveTarget(registry, request.handle, request.generation);
        if (!found.ok) return { ok: false, error: found.error };
        clearHighlight();
        const result = performClick(found.element);
        return result.ok ? { ok: true, kind: 'acted', note: result.note } : { ok: false, error: result.error };
      }
      case 'type': {
        const found = resolveTarget(registry, request.handle, request.generation);
        if (!found.ok) return { ok: false, error: found.error };
        clearHighlight();
        const result = performType(found.element, request.text);
        return result.ok ? { ok: true, kind: 'acted', note: result.note } : { ok: false, error: result.error };
      }
      case 'select': {
        const found = resolveTarget(registry, request.handle, request.generation);
        if (!found.ok) return { ok: false, error: found.error };
        clearHighlight();
        const result = performSelect(found.element, request.option);
        return result.ok ? { ok: true, kind: 'acted', note: result.note } : { ok: false, error: result.error };
      }
      case 'hover': {
        const found = resolveTarget(registry, request.handle, request.generation);
        if (!found.ok) return { ok: false, error: found.error };
        const result = performHover(found.element);
        return result.ok ? { ok: true, kind: 'acted', note: result.note } : { ok: false, error: result.error };
      }
      case 'press': {
        let element: Element | undefined;
        if (request.handle !== undefined) {
          const found = resolveTarget(registry, request.handle, request.generation ?? 0);
          if (!found.ok) return { ok: false, error: found.error };
          element = found.element;
        }
        clearHighlight();
        const result = performPress(element, request.press);
        return result.ok ? { ok: true, kind: 'acted', note: result.note } : { ok: false, error: result.error };
      }
      case 'back':
        history.back();
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

  /**
   * Every frame answers the panel for itself.
   *
   * It used to be only the top frame, because `chrome.tabs.sendMessage` without
   * a frame id goes to all of them and the first reply wins -- a snapshot of a
   * random advert. The panel now always names a frame id, so each frame can
   * answer for its own document and none has to speak for another.
   *
   * `sender.id` is checked for the same reason the background checks it: this
   * listener runs in a hostile document, and only our own extension may drive
   * it. A web page cannot reach `chrome.runtime` at all without
   * `externally_connectable`, which the manifest does not set, so this is
   * making an existing guarantee explicit rather than adding one.
   */
  chrome.runtime.onMessage.addListener(
    (request: ContentRequest, sender, respond: (response: ContentResponse) => void) => {
      if (sender.id !== chrome.runtime.id) return;
      void handle(request).then(respond);
      // Keeps the message channel open for the async reply above; without it
      // Chrome closes it and the panel sees the port disconnect instead.
      return true;
    },
  );
}
