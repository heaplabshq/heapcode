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
 * The script runs in *every* frame, and the frames talk to each other. Only the
 * top frame answers the panel; a frame inside the page is reached by its parent
 * over `postMessage`, which is the one channel that crosses an origin boundary
 * without a permission of its own. See `FRAME_BAND` for how the handles stay
 * unambiguous across all of them.
 */

const registry = new HandleRegistry();

const IS_TOP = window === window.top;

/**
 * The controls from the most recent snapshot, by handle.
 *
 * Kept so a confirmation can describe the element from our own extraction
 * rather than from the model's description of it -- the page may have named it
 * one thing while it does another.
 */
let lastControls = new Map<number, Control>();

/**
 * How many handles each frame gets to itself.
 *
 * A frame runs its own registry, so without this every frame would mint `[1]`,
 * `[2]`, `[3]` and the panel would have no way to say which document a handle
 * belonged to. Giving each frame a band makes the number itself the routing
 * information: `[100004]` is the fourth control of frame 1, and the top frame
 * knows where to send the click without keeping a side table the model could
 * get out of step with.
 *
 * Deliberately far larger than any page's control count, so a long-lived page
 * cannot count its way into the next frame's band.
 */
const FRAME_BAND = 100_000;

/** Only frames directly inside the top document are aggregated. See `gather`. */
const frameIndexes = new WeakMap<Element, number>();
let nextFrameIndex = 0;

function frameIndexOf(element: Element): number {
  const existing = frameIndexes.get(element);
  if (existing !== undefined) return existing;
  const index = ++nextFrameIndex;
  frameIndexes.set(element, index);
  return index;
}

function frameElements(): HTMLIFrameElement[] {
  return [...document.querySelectorAll('iframe, frame')].filter(
    (element): element is HTMLIFrameElement =>
      element instanceof HTMLIFrameElement && element.contentWindow !== null,
  );
}

function frameLabel(element: HTMLIFrameElement): string {
  const named = element.title?.trim() || element.name?.trim();
  if (named) return named;
  try {
    return new URL(element.src, location.href).host || 'embedded frame';
  } catch {
    return 'embedded frame';
  }
}

/**
 * One request to a frame, over `postMessage`.
 *
 * A timeout rather than an open wait: a frame whose script never arrived (its
 * origin was not granted, or Chrome declined to inject) is indistinguishable
 * from one that is merely slow, and a snapshot that hangs on a third-party
 * advert frame is worse than one that says the frame could not be read.
 */
const FRAME_TIMEOUT_MS = 1_500;
let nextCallId = 1;

function callFrame(
  frame: HTMLIFrameElement,
  message: Record<string, unknown>,
): Promise<FrameReply | undefined> {
  const target = frame.contentWindow;
  if (!target) return Promise.resolve(undefined);

  const id = `${nextCallId++}`;
  return new Promise((resolve) => {
    const timer = setTimeout(() => finish(undefined), FRAME_TIMEOUT_MS);

    function finish(reply: FrameReply | undefined) {
      clearTimeout(timer);
      window.removeEventListener('message', onMessage);
      resolve(reply);
    }

    function onMessage(event: MessageEvent) {
      const data = event.data as FrameEnvelope | undefined;
      if (!data || data.__heapbrowse !== 'reply' || data.id !== id) return;
      // Only the frame we asked may answer for it. Any window can post to us,
      // and a page that could impersonate another frame's reply would be able
      // to put controls in the snapshot that route somewhere else entirely.
      if (event.source !== target) return;
      finish(data.reply);
    }

    window.addEventListener('message', onMessage);
    target.postMessage({ __heapbrowse: 'request', id, ...message }, '*');
  });
}

interface FrameEnvelope {
  __heapbrowse?: 'request' | 'reply';
  id?: string;
  op?: string;
  reply?: FrameReply;
  [key: string]: unknown;
}

type FrameReply =
  | { kind: 'snapshot'; snapshot: PageSnapshot; base: number }
  | { kind: 'acted'; note: string }
  | { kind: 'ok' }
  | { kind: 'error'; error: string };

/**
 * The page, plus everything embedded in it.
 *
 * One level deep on purpose. A frame inside a frame is rare on the sites this
 * is used for, and supporting it means handing out sub-bands from within a band
 * — at which point the number no longer says where to route, which is the whole
 * reason the scheme works. A nested frame is reported as unread rather than
 * silently dropped.
 */
async function snapshotNow(): Promise<PageSnapshot> {
  const snapshot = extractSnapshot(document, registry);
  const merged = IS_TOP ? await mergeFrames(snapshot) : snapshot;
  lastControls = new Map(merged.controls.map((c) => [c.handle, c]));
  return merged;
}

async function mergeFrames(base: PageSnapshot): Promise<PageSnapshot> {
  const frames = frameElements();
  if (frames.length === 0) return base;

  const notes: string[] = [...(base.notes ?? [])];
  const controls = [...base.controls];
  const tables = [...base.tables];
  const texts = [base.text];

  const replies = await Promise.all(
    frames.map(async (frame) => ({
      frame,
      label: frameLabel(frame),
      reply: await callFrame(frame, { op: 'snapshot', base: frameIndexOf(frame) * FRAME_BAND }),
    })),
  );

  for (const { label, reply } of replies) {
    if (!reply || reply.kind !== 'snapshot') {
      notes.push(
        `An embedded frame ("${label}") could not be read. Its content is not in this snapshot; ` +
          `if what you are looking for should be inside it, say so rather than assuming it is absent.`,
      );
      continue;
    }
    const inner = reply.snapshot;
    if (inner.controls.length === 0 && !inner.text.trim()) continue;

    controls.push(
      ...inner.controls.map((control) => ({
        ...control,
        context: control.context ? `${label}: ${control.context}` : `in frame "${label}"`,
        // Frame content ranks just below the host page: it is usually a consent
        // dialog or a payment field, which matters, but the page's own controls
        // are what the user is looking at.
        score: Math.max(0, control.score - 50),
      })),
    );
    tables.push(...inner.tables);
    if (inner.text.trim()) texts.push(`[frame "${label}"]\n${inner.text.trim()}`);
    if (inner.notes?.length) notes.push(...inner.notes);
  }

  return {
    ...base,
    controls,
    tables,
    text: texts.filter(Boolean).join('\n\n'),
    notes: notes.length > 0 ? notes : undefined,
  };
}

/** The frame a handle belongs to, or undefined when it is ours. */
function frameFor(handle: number): HTMLIFrameElement | undefined {
  const index = Math.floor(handle / FRAME_BAND);
  if (index === 0) return undefined;
  return frameElements().find((frame) => frameIndexes.get(frame) === index);
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

/**
 * Send an action to the frame that owns the handle, if it is not ours.
 *
 * Returns undefined when the handle belongs to this document, which is the
 * ordinary case and reads better than a boolean at every call site.
 */
async function delegate(
  handle: number | undefined,
  message: Record<string, unknown>,
): Promise<ContentResponse | undefined> {
  if (handle === undefined) return undefined;
  const frame = frameFor(handle);
  if (!frame) return undefined;

  const label = frameLabel(frame);
  const reply = await callFrame(frame, { ...message, handle });
  if (!reply) {
    return { ok: false, error: `The embedded frame "${label}" did not respond.` };
  }
  if (reply.kind === 'error') return { ok: false, error: reply.error };
  if (reply.kind === 'acted') return { ok: true, kind: 'acted', note: `${reply.note} (in "${label}")` };
  return { ok: true, kind: 'ok' };
}

async function handle(request: ContentRequest): Promise<ContentResponse> {
  try {
    switch (request.type) {
      case 'snapshot':
        return { ok: true, kind: 'snapshot', snapshot: await snapshotNow() };
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
        // A frame's control is described from the merged snapshot rather than by
        // asking the frame again: the record is ours either way, and the point
        // of describing is to show the user what we extracted.
        if (frameFor(request.handle)) return { ok: true, kind: 'control', control };
        const found = resolveTarget(registry, request.handle, request.generation);
        if (!found.ok) return { ok: false, error: found.error };
        return { ok: true, kind: 'control', control };
      }
      case 'highlight': {
        const delegated = await delegate(request.handle, { op: 'highlight' });
        if (delegated) return delegated;
        const found = resolveTarget(registry, request.handle, request.generation);
        if (!found.ok) return { ok: false, error: found.error };
        highlight(found.element);
        return { ok: true, kind: 'ok' };
      }
      case 'clearHighlight': {
        clearHighlight();
        // Broadcast: the outline may be in any frame, and by the time this
        // arrives we no longer know which handle it was for.
        if (IS_TOP) {
          await Promise.all(frameElements().map((frame) => callFrame(frame, { op: 'clearHighlight' })));
        }
        return { ok: true, kind: 'ok' };
      }
      case 'click': {
        const delegated = await delegate(request.handle, { op: 'click' });
        if (delegated) return delegated;
        const found = resolveTarget(registry, request.handle, request.generation);
        if (!found.ok) return { ok: false, error: found.error };
        clearHighlight();
        const result = performClick(found.element);
        return result.ok ? { ok: true, kind: 'acted', note: result.note } : { ok: false, error: result.error };
      }
      case 'type': {
        const delegated = await delegate(request.handle, { op: 'type', text: request.text });
        if (delegated) return delegated;
        const found = resolveTarget(registry, request.handle, request.generation);
        if (!found.ok) return { ok: false, error: found.error };
        clearHighlight();
        const result = performType(found.element, request.text);
        return result.ok ? { ok: true, kind: 'acted', note: result.note } : { ok: false, error: result.error };
      }
      case 'select': {
        const delegated = await delegate(request.handle, { op: 'select', option: request.option });
        if (delegated) return delegated;
        const found = resolveTarget(registry, request.handle, request.generation);
        if (!found.ok) return { ok: false, error: found.error };
        clearHighlight();
        const result = performSelect(found.element, request.option);
        return result.ok ? { ok: true, kind: 'acted', note: result.note } : { ok: false, error: result.error };
      }
      case 'hover': {
        const delegated = await delegate(request.handle, { op: 'hover' });
        if (delegated) return delegated;
        const found = resolveTarget(registry, request.handle, request.generation);
        if (!found.ok) return { ok: false, error: found.error };
        const result = performHover(found.element);
        return result.ok ? { ok: true, kind: 'acted', note: result.note } : { ok: false, error: result.error };
      }
      case 'press': {
        const delegated = await delegate(request.handle, { op: 'press', press: request.press });
        if (delegated) return delegated;
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

/**
 * What a frame does when its parent asks it something.
 *
 * The reply is deliberately narrow — a snapshot, a note, or an error — because
 * the parent turns it back into the same `ContentResponse` the panel expects,
 * and a frame should not be able to widen that shape.
 */
async function handleFrameRequest(data: FrameEnvelope): Promise<FrameReply> {
  // The handle arrives already inside this frame's band, which is exactly what
  // its own registry minted — so it needs no translation, only resolving.
  const handleNumber = typeof data.handle === 'number' ? data.handle : undefined;

  const resolveLocal = () => {
    if (handleNumber === undefined) return { ok: false as const, error: 'No handle given.' };
    return resolveTarget(registry, handleNumber, 0);
  };

  switch (data.op) {
    case 'snapshot': {
      if (typeof data.base === 'number') registry.useBase(data.base);
      const snapshot = await snapshotNow();
      return { kind: 'snapshot', snapshot, base: registry.base };
    }
    case 'highlight': {
      const found = resolveLocal();
      if (!found.ok) return { kind: 'error', error: found.error };
      highlight(found.element);
      return { kind: 'ok' };
    }
    case 'clearHighlight':
      clearHighlight();
      return { kind: 'ok' };
    case 'click': {
      const found = resolveLocal();
      if (!found.ok) return { kind: 'error', error: found.error };
      clearHighlight();
      const result = performClick(found.element);
      return result.ok ? { kind: 'acted', note: result.note } : { kind: 'error', error: result.error };
    }
    case 'type': {
      const found = resolveLocal();
      if (!found.ok) return { kind: 'error', error: found.error };
      clearHighlight();
      const result = performType(found.element, String(data.text ?? ''));
      return result.ok ? { kind: 'acted', note: result.note } : { kind: 'error', error: result.error };
    }
    case 'select': {
      const found = resolveLocal();
      if (!found.ok) return { kind: 'error', error: found.error };
      const result = performSelect(found.element, String(data.option ?? ''));
      return result.ok ? { kind: 'acted', note: result.note } : { kind: 'error', error: result.error };
    }
    case 'hover': {
      const found = resolveLocal();
      if (!found.ok) return { kind: 'error', error: found.error };
      const result = performHover(found.element);
      return result.ok ? { kind: 'acted', note: result.note } : { kind: 'error', error: result.error };
    }
    case 'press': {
      const found = handleNumber === undefined ? undefined : resolveLocal();
      if (found && !found.ok) return { kind: 'error', error: found.error };
      const result = performPress(found?.element, (data.press ?? { key: 'Enter' }) as KeyPress);
      return result.ok ? { kind: 'acted', note: result.note } : { kind: 'error', error: result.error };
    }
    default:
      return { kind: 'error', error: `Unknown frame request "${String(data.op)}".` };
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

  // Only the top frame answers the panel. `chrome.tabs.sendMessage` without a
  // frame id is delivered to every frame in the tab, and the reply used is
  // whichever listener answers first -- so a page with three advert frames
  // would return a snapshot of a random one of them.
  if (IS_TOP) {
    chrome.runtime.onMessage.addListener(
      (request: ContentRequest, _sender, respond: (response: ContentResponse) => void) => {
        void handle(request).then(respond);
        // Keeps the message channel open for the async reply above; without it
        // Chrome closes it and the panel sees the port disconnect instead.
        return true;
      },
    );
  }

  // Every frame, including the top one, answers its parent. The top frame has no
  // parent that will ever ask, and registering anyway keeps the two paths from
  // diverging.
  window.addEventListener('message', (event: MessageEvent) => {
    const data = event.data as FrameEnvelope | undefined;
    if (!data || data.__heapbrowse !== 'request' || typeof data.id !== 'string') return;
    // Only our own parent may drive this frame. Any script on the page can post
    // to this window, and without this check a page could ask its own frames for
    // snapshots or make them click things.
    if (event.source !== window.parent) return;

    void handleFrameRequest(data).then((reply) => {
      (event.source as Window | null)?.postMessage(
        { __heapbrowse: 'reply', id: data.id, reply },
        '*',
      );
    });
  });
}
