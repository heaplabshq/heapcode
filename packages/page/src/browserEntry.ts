import { inspect, type DomTree, type InspectOptions } from './inspect.js';
import { describeTarget } from './recorder.js';
import { ActivityWatch, pageHealth, type PageHealth } from './health.js';
import type { RecordedTarget } from './recording.js';

/**
 * What a driver injects into the page under test: `window.__heapqa`.
 *
 * Bundled into one classic script (see qa-playwright's `scripts/buildInspect.mjs`)
 * because an injected script has no module loader. Keeps the elements of the
 * last inspection so a later call can act on "node 412" — the id the agent or
 * the similarity match picked — without re-finding it.
 */
export interface HeapQaPageApi {
  inspect(options?: InspectOptions): DomTree;
  /** The live element behind a node id from the last `inspect`, if still attached. */
  element(id: number): Element | null;
  /**
   * Every way to find that element again, as the recorder would have written
   * it — so a step the AI took records exactly like a step a person took.
   */
  describe(id: number): RecordedTarget | null;
  /** The same for an element the driver already holds (found by a locator). */
  describeElement(el: Element): RecordedTarget;
  /** Error text on screen, sideways overflow — see health.ts. */
  health(): PageHealth;
  /** Start counting DOM changes; `watched` stops and returns the count. */
  watch(): void;
  watched(): number;
  /**
   * Draw each node's number over it (from the last `inspect`), for a vision
   * model to point at; `unmark` takes the labels away again. The labels are
   * in a closed shadow root and ignore the pointer, so they change nothing a
   * person could click.
   */
  mark(ids: number[]): number;
  unmark(): void;
}

let last: Element[] = [];
const activity = new ActivityWatch();

const api: HeapQaPageApi = {
  inspect(options) {
    const elements: Element[] = [];
    const tree = inspect(document, options, elements);
    last = elements;
    return tree;
  },
  element(id) {
    const el = last[id];
    return el && el.isConnected ? el : null;
  },
  describe(id) {
    const el = api.element(id);
    return el ? describeTarget(el) : null;
  },
  describeElement(el) {
    return describeTarget(el);
  },
  health() {
    return pageHealth(document);
  },
  watch() {
    activity.start(document);
  },
  watched() {
    return activity.stop();
  },
  mark(ids) {
    api.unmark();
    const host = document.createElement('heapqa-marks');
    host.setAttribute('style', 'all: initial; position: fixed; inset: 0; z-index: 2147483647; pointer-events: none;');
    const root = host.attachShadow({ mode: 'closed' });
    let drawn = 0;
    for (const id of ids) {
      const el = api.element(id);
      if (!el) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2 || r.bottom < 0 || r.top > innerHeight) continue;
      const box = document.createElement('div');
      box.setAttribute('style', `position:fixed;left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px;outline:2px solid #e11d48;`);
      const tag = document.createElement('span');
      tag.textContent = String(id);
      tag.setAttribute('style', 'position:absolute;left:-2px;top:-16px;background:#e11d48;color:#fff;font:bold 11px/14px monospace;padding:0 3px;border-radius:3px;');
      box.appendChild(tag);
      root.appendChild(box);
      drawn += 1;
    }
    document.documentElement.appendChild(host);
    return drawn;
  },
  unmark() {
    document.querySelectorAll('heapqa-marks').forEach((m) => m.remove());
  },
};

(globalThis as unknown as { __heapqa: HeapQaPageApi }).__heapqa = api;
