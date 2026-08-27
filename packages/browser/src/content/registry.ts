import type { Handle } from '../shared/snapshot.js';

/**
 * The map from `[3]` to a real element, and the rule that it expires.
 *
 * Handles are per-snapshot. Any mutating action or navigation mints a new
 * generation and the previous one stops resolving, so a model that says
 * "click [7]" using indices it read three actions ago gets a hard error rather
 * than a click on whatever now sits at index 7 (PRD §4.2).
 *
 * This is the single most important safety property in the page layer, and it
 * is a property of *refusing* rather than of guessing well: a re-rendered list
 * is the normal case on a modern page, not an edge case, and best-effort
 * resolution there means clicking the wrong product roughly as often as the
 * right one.
 */
export class HandleRegistry {
  #elements = new Map<Handle, Element>();
  #generation = 0;
  #next: Handle = 1;

  get generation(): number {
    return this.#generation;
  }

  /** Begin a new snapshot. Every previously issued handle stops resolving. */
  reset(): number {
    this.#elements.clear();
    this.#next = 1;
    this.#generation++;
    return this.#generation;
  }

  add(element: Element): Handle {
    const handle = this.#next++;
    this.#elements.set(handle, element);
    return handle;
  }

  /**
   * The element for a handle, or a reason it is not available.
   *
   * Detached elements are refused too: a node can survive in the map while
   * being removed from the document, and clicking it is silently a no-op —
   * which the model would otherwise report as success.
   */
  resolve(handle: Handle, generation: number): { ok: true; element: Element } | { ok: false; reason: string } {
    if (generation !== this.#generation) {
      return {
        ok: false,
        reason: `Handle [${handle}] is from an earlier snapshot (generation ${generation}, now ${this.#generation}). The page has changed since. Read the page again to get current handles.`,
      };
    }
    const element = this.#elements.get(handle);
    if (!element) {
      return { ok: false, reason: `No element with handle [${handle}] in the current snapshot.` };
    }
    if (!element.isConnected) {
      return {
        ok: false,
        reason: `Handle [${handle}] refers to an element that has been removed from the page. Read the page again.`,
      };
    }
    return { ok: true, element };
  }

  get size(): number {
    return this.#elements.size;
  }
}
