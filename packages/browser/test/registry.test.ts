// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { HandleRegistry } from '../src/content/registry.js';

function element(html = '<button>x</button>'): Element {
  document.body.innerHTML = html;
  return document.body.firstElementChild!;
}

describe('handle expiry', () => {
  it('resolves a handle within its own generation', () => {
    const registry = new HandleRegistry();
    const generation = registry.reset();
    const handle = registry.add(element());
    const found = registry.resolve(handle, generation);
    expect(found.ok).toBe(true);
  });

  it('refuses a handle from an earlier snapshot instead of guessing', () => {
    // The central safety rule: a re-rendered list is the normal case, so
    // best-effort resolution clicks the wrong product about as often as the
    // right one. Refusing is the whole point (PRD §4.2).
    const registry = new HandleRegistry();
    const old = registry.reset();
    const handle = registry.add(element());

    registry.reset(); // a mutating action happened
    registry.add(element('<button>a different button now</button>'));

    const found = registry.resolve(handle, old);
    expect(found.ok).toBe(false);
    if (!found.ok) {
      expect(found.reason).toMatch(/earlier snapshot/);
      // The model has to be told what to do next, or it retries the same call.
      expect(found.reason).toMatch(/[Rr]ead the page again/);
    }
  });

  it('refuses a handle whose element has been detached', () => {
    // The node survives in the map after removal, and clicking it is silently a
    // no-op the model would report as success.
    const registry = new HandleRegistry();
    const generation = registry.reset();
    const target = element();
    const handle = registry.add(target);
    target.remove();

    const found = registry.resolve(handle, generation);
    expect(found.ok).toBe(false);
    if (!found.ok) expect(found.reason).toMatch(/removed from the page/);
  });

  it('refuses a handle that was never issued', () => {
    const registry = new HandleRegistry();
    const generation = registry.reset();
    expect(registry.resolve(99, generation).ok).toBe(false);
  });

  it('restarts numbering each snapshot, so indices stay small and stable', () => {
    const registry = new HandleRegistry();
    registry.reset();
    expect(registry.add(element())).toBe(1);
    registry.reset();
    expect(registry.add(element())).toBe(1);
  });

  it('advances the generation on every reset', () => {
    const registry = new HandleRegistry();
    const a = registry.reset();
    const b = registry.reset();
    expect(b).toBeGreaterThan(a);
  });
});
