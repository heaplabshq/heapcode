// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { HandleRegistry } from '../src/content/registry.js';

function element(html = '<button>x</button>'): Element {
  document.body.innerHTML = html;
  return document.body.firstElementChild!;
}

/**
 * Handles name elements, not positions.
 *
 * The first design numbered controls from 1 on every read and retired them all
 * after any action, because [4] was a position and a re-rendered list puts
 * something else there. Sound reasoning, and it cost most of every run: the
 * agent had to re-read the page between each action to learn numbers it had just
 * been given.
 *
 * A WeakRef removes the reason for it. The handle names one node — if the page
 * replaces that node the reference dies and the handle is refused, and if the
 * page reorders around it the handle is still right. Identity gives the safety
 * expiry was approximating, and gives it more precisely: expiry only ever knew
 * that *something* had changed.
 */

describe('naming an element', () => {
  it('gives the same element the same number across reads', () => {
    // What makes "[12] is the Apply button" hold across several steps.
    const registry = new HandleRegistry();
    const target = element();

    registry.reset();
    const first = registry.add(target);
    registry.reset();
    const second = registry.add(target);

    expect(second).toBe(first);
  });

  it('gives different elements different numbers', () => {
    document.body.innerHTML = '<button>a</button><button>b</button>';
    const [a, b] = [...document.querySelectorAll('button')];
    const registry = new HandleRegistry();
    registry.reset();

    expect(registry.add(a!)).not.toBe(registry.add(b!));
  });

  it('resolves a handle issued several reads ago', () => {
    // The whole point: no re-read between actions.
    const registry = new HandleRegistry();
    registry.reset();
    const handle = registry.add(element());

    registry.reset();
    registry.reset();

    expect(registry.resolve(handle).ok).toBe(true);
  });
});

describe('when the element is gone', () => {
  it('refuses a detached element rather than clicking it', () => {
    // Detached but not yet collected: clicking it is silently a no-op, which the
    // model would otherwise report as success.
    const registry = new HandleRegistry();
    registry.reset();
    const target = element();
    const handle = registry.add(target);

    target.remove();

    const found = registry.resolve(handle);
    expect(found.ok).toBe(false);
    if (!found.ok) {
      expect(found.reason).toMatch(/removed from the page/);
      // The model needs to know what to do next, or it retries the same call.
      expect(found.reason).toMatch(/[Rr]ead the page again/);
    }
  });

  it('refuses a handle that was never issued', () => {
    const registry = new HandleRegistry();
    registry.reset();
    expect(registry.resolve(99).ok).toBe(false);
  });

  it('refuses a handle whose element was replaced by a re-render', () => {
    // The case expiry existed for. Identity handles it without expiring
    // everything else: the old node is detached, so its handle dies; any node
    // that survived the re-render keeps working.
    const registry = new HandleRegistry();
    registry.reset();
    const before = element('<button>Add to cart</button>');
    const handle = registry.add(before);

    document.body.innerHTML = '<button>Add to cart</button>';

    expect(registry.resolve(handle).ok).toBe(false);
  });
});

describe('the read counter', () => {
  it('advances per read, for reporting rather than for gating', () => {
    const registry = new HandleRegistry();
    const first = registry.reset();
    const second = registry.reset();
    expect(second).toBeGreaterThan(first);
  });

  it('does not reject a handle whose read counter has moved on', () => {
    const registry = new HandleRegistry();
    registry.reset();
    const handle = registry.add(element());
    registry.reset();

    expect(registry.resolve(handle, 1).ok).toBe(true);
  });
});
