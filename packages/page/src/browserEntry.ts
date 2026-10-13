import { inspect, type DomTree, type InspectOptions } from './inspect.js';

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
}

let last: Element[] = [];

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
};

(globalThis as unknown as { __heapqa: HeapQaPageApi }).__heapqa = api;
