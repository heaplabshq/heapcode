import { describe, expect, it } from 'vitest';
import { formatSnapshot, type Control, type PageSnapshot } from '../src/shared/snapshot.js';

function control(handle: number, name: string, score: number, extra: Partial<Control> = {}): Control {
  return { handle, role: 'button', name, score, ...extra };
}

function page(overrides: Partial<PageSnapshot> = {}): PageSnapshot {
  return {
    url: 'https://example.com/laptops',
    title: 'Laptops',
    viewport: { width: 1440, height: 900, scrollY: 1200, scrollHeight: 8400 },
    text: '',
    controls: [],
    tables: [],
    generation: 1,
    ...overrides,
  };
}

describe('snapshot rendering', () => {
  it('leads with the facts the model needs to orient', () => {
    const out = formatSnapshot(page());
    expect(out).toContain('URL: https://example.com/laptops');
    expect(out).toContain('TITLE: Laptops');
    expect(out).toContain('scrolled 1200/8400 (14%)');
  });

  it('renders controls with their handle, role and name', () => {
    const out = formatSnapshot(page({ controls: [control(1, 'Add to cart', 10)] }));
    expect(out).toContain('[1]');
    expect(out).toContain('"Add to cart"');
  });

  it('shows a select’s options and a link’s target', () => {
    const out = formatSnapshot(
      page({
        controls: [
          control(1, 'Sort by', 10, { role: 'select', options: ['Relevance', 'Price'] }),
          control(2, 'Next', 9, { role: 'link', href: '/page/2' }),
        ],
      }),
    );
    expect(out).toContain('options: Relevance|Price');
    expect(out).toContain('→ /page/2');
  });

  it('marks a disabled control rather than dropping it', () => {
    expect(formatSnapshot(page({ controls: [control(1, 'Checkout', 5, { disabled: true })] }))).toContain('DISABLED');
  });
});

describe('budgeted truncation', () => {
  const many = Array.from({ length: 200 }, (_, i) => control(i + 1, `Control ${i + 1}`, i));

  it('stays within the character budget', () => {
    const out = formatSnapshot(page({ controls: many }), { budgetChars: 800 });
    expect(out.length).toBeLessThanOrEqual(1000); // header + note overhead
  });

  it('keeps the highest-ranked controls, not the first in document order', () => {
    // Head-truncating a control list reliably discards what the user is
    // pointing at — the interesting controls are rarely first in the DOM.
    const out = formatSnapshot(page({ controls: many }), { budgetChars: 700 });
    expect(out).toContain('Control 200'); // highest score
    expect(out).not.toContain('"Control 1"'); // lowest score
  });

  it('says how many controls it withheld', () => {
    const out = formatSnapshot(page({ controls: many }), { budgetChars: 700 });
    expect(out).toMatch(/more control\(s\) not shown/);
  });

  it('presents the survivors in handle order, however they were ranked', () => {
    const out = formatSnapshot(
      page({ controls: [control(1, 'Low', 1), control(2, 'High', 100), control(3, 'Mid', 50)] }),
    );
    const order = [...out.matchAll(/\[(\d)\]/g)].map((m) => Number(m[1]));
    expect(order).toEqual([1, 2, 3]);
  });

  it('truncates the text block rather than letting it eat the control budget', () => {
    const out = formatSnapshot(
      page({ text: 'x'.repeat(50_000), controls: [control(1, 'Add to cart', 10)] }),
      { budgetChars: 2000 },
    );
    expect(out).toContain('…[truncated]');
    expect(out).toContain('Add to cart'); // the controls still made it
  });
});

describe('intent ranking', () => {
  it('promotes controls matching what the user actually asked for', () => {
    const controls = [
      control(1, 'Newsletter signup', 90),
      control(2, 'Add to cart', 1),
      control(3, 'Cookie preferences', 89),
    ];
    const out = formatSnapshot(page({ controls }), {
      budgetChars: 320,
      intent: 'add the 16GB laptop to my cart',
    });
    // Without the boost, "Add to cart" (score 1) loses to both distractors.
    expect(out).toContain('Add to cart');
  });

  it('ignores short words that would match everything', () => {
    const controls = [control(1, 'Onward', 5), control(2, 'Buy now', 4)];
    const out = formatSnapshot(page({ controls }), { intent: 'go on to buy' });
    expect(out).toContain('Buy now');
  });
});
