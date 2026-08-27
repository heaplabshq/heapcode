import { describe, expect, it } from 'vitest';
import { describeChanges } from '../src/shared/delta.js';
import type { Control, PageSnapshot } from '../src/shared/snapshot.js';

function control(handle: number, name: string, extra: Partial<Control> = {}): Control {
  return { handle, role: 'button', name, score: 10, ...extra };
}

function page(overrides: Partial<PageSnapshot> = {}): PageSnapshot {
  return {
    url: 'https://shop.example.com/laptops',
    title: 'Laptops',
    viewport: { width: 1440, height: 900, scrollY: 0, scrollHeight: 8400 },
    text: 'Some page text.',
    controls: [],
    tables: [],
    generation: 1,
    ...overrides,
  };
}

describe('describing what changed', () => {
  it('says nothing changed when nothing did', () => {
    const before = page({ controls: [control(1, 'Add to cart')] });
    const after = page({ controls: [control(1, 'Add to cart')], generation: 2 });
    expect(describeChanges(before, after)).toBe('Nothing on the page changed.');
  });

  it('matches controls across reads by identity, not by handle', () => {
    // The registry renumbers from 1 on every read, so [4] is a position rather
    // than an identity. Matching on handles would report every control as both
    // removed and added the moment anything shifted.
    const before = page({ controls: [control(1, 'Filter'), control(2, 'Add to cart')] });
    const after = page({
      controls: [control(1, 'Add to cart'), control(2, 'Filter')],
      generation: 2,
    });
    expect(describeChanges(before, after)).toBe('Nothing on the page changed.');
  });

  it('warns that handles were reissued whenever it reports a change', () => {
    // Without this the model happily reuses the numbers from the previous read.
    const before = page({ controls: [control(1, 'Add to cart')] });
    const after = page({
      controls: [control(1, 'Add to cart'), control(2, 'Remove')],
      generation: 2,
    });
    expect(describeChanges(before, after)).toMatch(/Handles have been reissued/);
  });

  it('reports a new control with its current handle', () => {
    const before = page({ controls: [control(1, 'Add to cart')] });
    const after = page({
      controls: [control(1, 'Add to cart'), control(2, 'Checkout')],
      generation: 2,
    });
    const result = describeChanges(before, after);
    expect(result).toMatch(/New controls/);
    expect(result).toContain('[2]');
    expect(result).toContain('Checkout');
  });

  it('reports a changed value with what it was before', () => {
    const before = page({ controls: [control(1, 'Search', { role: 'input', value: '' })] });
    const after = page({
      controls: [control(1, 'Search', { role: 'input', value: '16GB' })],
      generation: 2,
    });
    const result = describeChanges(before, after);
    expect(result).toContain('16GB');
    expect(result).toMatch(/was ""/);
  });

  it('reports a control becoming enabled', () => {
    const before = page({ controls: [control(1, 'Checkout', { disabled: true })] });
    const after = page({ controls: [control(1, 'Checkout')], generation: 2 });
    expect(describeChanges(before, after)).toMatch(/now enabled/);
  });

  it('reports controls that disappeared', () => {
    const before = page({ controls: [control(1, 'Add to cart'), control(2, 'Compare')] });
    const after = page({ controls: [control(1, 'Add to cart')], generation: 2 });
    expect(describeChanges(before, after)).toMatch(/Gone: "Compare"/);
  });

  it('reports scrolling with the new position', () => {
    const before = page();
    const after = page({ viewport: { ...page().viewport, scrollY: 1800 }, generation: 2 });
    const result = describeChanges(before, after);
    expect(result).toMatch(/Scrolled down 1800px/);
    expect(result).toMatch(/now at 1800 of 8400/);
  });
});

describe('when a diff would be the wrong answer', () => {
  it('sends the whole page after a navigation, and says the handles are void', () => {
    // A new URL is a new document with a discarded registry. Describing that as
    // "142 removed, 138 added" is both longer and actively misleading.
    const before = page({ controls: [control(1, 'Add to cart')] });
    const after = page({
      url: 'https://shop.example.com/checkout',
      controls: [control(1, 'Pay now')],
      generation: 2,
    });
    const result = describeChanges(before, after);
    expect(result).toMatch(/navigated to https:\/\/shop\.example\.com\/checkout/);
    expect(result).toMatch(/previous handles are void/);
    expect(result).toContain('URL: https://shop.example.com/checkout');
  });

  it('sends the whole page when most of it turned over', () => {
    const before = page({
      controls: Array.from({ length: 10 }, (_, i) => control(i + 1, `Old ${i}`)),
    });
    const after = page({
      controls: Array.from({ length: 10 }, (_, i) => control(i + 1, `New ${i}`)),
      generation: 2,
    });
    const result = describeChanges(before, after);
    expect(result).toMatch(/changed substantially/);
    expect(result).toContain('URL:');
  });

  it('still diffs when the change is small relative to the page', () => {
    const controls = Array.from({ length: 20 }, (_, i) => control(i + 1, `Item ${i}`));
    const before = page({ controls });
    const after = page({ controls: [...controls, control(21, 'Load more')], generation: 2 });
    const result = describeChanges(before, after);
    expect(result).not.toMatch(/changed substantially/);
    expect(result).toContain('Load more');
  });
});

describe('the reason deltas exist', () => {
  it('costs far less than re-sending the page', () => {
    // M2's exit criteria bound the cost of a ten-step run. A delta that is not
    // dramatically smaller than the snapshot is not doing its job.
    const controls = Array.from({ length: 60 }, (_, i) =>
      control(i + 1, `Product ${i} add to cart`, { context: `Row ${i} with a long description` }),
    );
    const before = page({ controls, text: 'x'.repeat(4000) });
    const after = page({
      controls: [...controls, control(61, 'Load more')],
      text: 'x'.repeat(4000),
      generation: 2,
    });

    const delta = describeChanges(before, after);
    expect(delta.length).toBeLessThan(400);
  });
});
