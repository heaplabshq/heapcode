import type { Handle } from '../shared/snapshot.js';

/**
 * Handles that name an element, not a position.
 *
 * The first version numbered controls from 1 on every read and retired them all
 * after any action, because `[4]` was a *position* and a re-rendered list puts
 * something else there. That is true, and it made the agent re-read the page
 * between every single action — most of a run spent asking what it had just
 * been told.
 *
 * A `WeakRef` to the element removes the reason for any of it. The handle names
 * one specific node: if the page replaces that node the reference dies and the
 * handle is refused, and if the page merely reorders around it the handle is
 * still correct. Identity gives the safety that expiry was approximating, and
 * gives it more precisely — expiry only knew that *something* had changed.
 *
 * Numbers are stable across reads for the same element, so the model can hold
 * "[12] is the Apply button" across several steps, and garbage collection is the
 * thing that cleans up, which is exactly what `WeakRef` is for.
 */
export class HandleRegistry {
  #byHandle = new Map<Handle, WeakRef<Element>>();
  #byElement = new WeakMap<Element, Handle>();
  #next: Handle = 1;
  /**
   * Where this registry's numbers start.
   *
   * Zero in the top frame. A frame inside the page gets a band of its own, so a
   * handle is unique across the whole tab and the number itself says which frame
   * to send the action to — without that, `[3]` means one element in the page
   * and a different one in the embedded checkout, and the top frame has no way
   * to tell which the model meant.
   */
  #base = 0;
  /** Incremented per read. Informational — never used to reject a handle. */
  #reads = 0;

  get generation(): number {
    return this.#reads;
  }

  get base(): number {
    return this.#base;
  }

  /**
   * Claim a band of handle numbers. Only ever honoured once.
   *
   * A frame keeps the band it was first given for as long as it lives, even if
   * a later read would assign a different one — the numbers already handed to
   * the model have to keep meaning what they meant.
   */
  useBase(base: number): number {
    if (this.#base === 0 && base > 0 && this.#next === 1) {
      this.#base = base;
      this.#next = base + 1;
    }
    return this.#base;
  }

  /** Begin a read. Handles survive it; only the read counter moves. */
  reset(): number {
    this.#reads++;
    // Drop entries whose element has been collected, so the map does not grow
    // without bound on a long-lived page.
    for (const [handle, ref] of this.#byHandle) {
      if (!ref.deref()) this.#byHandle.delete(handle);
    }
    return this.#reads;
  }

  /** The handle for this element — the same number every time it is seen. */
  add(element: Element): Handle {
    const existing = this.#byElement.get(element);
    if (existing !== undefined && this.#byHandle.get(existing)?.deref() === element) {
      return existing;
    }
    const handle = this.#next++;
    this.#byHandle.set(handle, new WeakRef(element));
    this.#byElement.set(element, handle);
    return handle;
  }

  /**
   * The element for a handle, or a reason it cannot be used.
   *
   * `generation` is accepted and ignored: handles no longer expire with a read,
   * and callers still pass what the snapshot reported. Kept in the signature so
   * the two drivers stay interchangeable.
   */
  resolve(
    handle: Handle,
    _generation?: number,
  ): { ok: true; element: Element } | { ok: false; reason: string } {
    const element = this.#byHandle.get(handle)?.deref();
    if (!element) {
      return {
        ok: false,
        reason: `Handle [${handle}] no longer exists — that element has been removed from the page. Read the page again.`,
      };
    }
    if (!element.isConnected) {
      // Detached but not yet collected. Clicking it is silently a no-op, which
      // the model would otherwise report as success.
      return {
        ok: false,
        reason: `Handle [${handle}] refers to an element that has been removed from the page. Read the page again.`,
      };
    }
    return { ok: true, element };
  }

  get size(): number {
    return this.#byHandle.size;
  }
}
