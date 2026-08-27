// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { performClick, performSelect, performType } from '../src/content/actions.js';

function load(html: string): Element {
  document.body.innerHTML = html;
  return document.body.firstElementChild!;
}

/**
 * Doing things to a page, and refusing to do some of them.
 *
 * A bare `element.click()` is `isTrusted: false` and skips the pointer and
 * focus phases, which many frameworks and most anti-bot layers notice. The
 * failure is silent -- nothing happens and the agent reports success -- so the
 * event sequence is asserted rather than assumed.
 */

describe('clicking', () => {
  it('dispatches the phases a real interaction produces, in order', () => {
    const button = load('<button>Go</button>');
    const seen: string[] = [];
    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
      button.addEventListener(type, () => seen.push(type));
    }

    performClick(button);

    expect(seen).toEqual(['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']);
  });

  it('focuses the element, as a real click would', () => {
    const button = load('<button>Go</button>');
    performClick(button);
    expect(document.activeElement).toBe(button);
  });

  it('lets default behaviour run, so a form actually submits', () => {
    document.body.innerHTML = '<form><button type="submit">Send</button></form>';
    const form = document.querySelector('form')!;
    let submitted = false;
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      submitted = true;
    });
    performClick(document.querySelector('button')!);
    expect(submitted).toBe(true);
  });
});

describe('typing', () => {
  it('sets the value and fires input and change', () => {
    const input = load('<input>') as HTMLInputElement;
    const seen: string[] = [];
    input.addEventListener('input', () => seen.push('input'));
    input.addEventListener('change', () => seen.push('change'));

    const result = performType(input, 'ThinkPad');

    expect(result.ok).toBe(true);
    expect(input.value).toBe('ThinkPad');
    expect(seen).toEqual(['input', 'change']);
  });

  it('refuses a password field outright, without asking anyone', () => {
    // There is no answer to "may I type your password?" that makes it safe, so
    // this is refused at the executor rather than escalated to a prompt.
    const input = load('<input type="password">') as HTMLInputElement;
    const result = performType(input, 'hunter2');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/never types into those/);
    expect(input.value).toBe('');
  });

  it('refuses one-time-code and card fields, which are usually type=text', () => {
    for (const html of [
      '<input name="otp">',
      '<input name="cardNumber">',
      '<input autocomplete="cc-csc">',
      '<input placeholder="CVV">',
      '<input aria-label="Enter your PIN">',
    ]) {
      const input = load(html) as HTMLInputElement;
      const result = performType(input, '123456');
      expect(result.ok, html).toBe(false);
      expect(input.value, html).toBe('');
    }
  });

  it('still types into an ordinary field whose name merely looks alarming', () => {
    // Over-refusing has a cost too: the agent becomes useless on normal forms.
    const input = load('<input name="passenger_name">') as HTMLInputElement;
    expect(performType(input, 'Ada').ok).toBe(true);
  });

  it('refuses anything that is not a text field', () => {
    expect(performType(load('<button>x</button>'), 'text').ok).toBe(false);
  });
});

describe('choosing in a dropdown', () => {
  const html =
    '<select><option value="rel">Relevance</option><option value="asc">Price: Low to High</option></select>';

  it('matches on the visible text', () => {
    const select = load(html) as HTMLSelectElement;
    const result = performSelect(select, 'Price: Low to High');
    expect(result.ok).toBe(true);
    expect(select.value).toBe('asc');
  });

  it('matches on the value, and on a partial name', () => {
    expect((performSelect(load(html) as HTMLSelectElement, 'asc')).ok).toBe(true);
    expect((performSelect(load(html) as HTMLSelectElement, 'low to high')).ok).toBe(true);
  });

  it('lists the real options when nothing matches, so a retry can work', () => {
    const result = performSelect(load(html) as HTMLSelectElement, 'Cheapest');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('Relevance');
      expect(result.error).toContain('Price: Low to High');
    }
  });

  it('fires change, so a page that re-sorts on selection actually does', () => {
    const select = load(html) as HTMLSelectElement;
    let changed = false;
    select.addEventListener('change', () => (changed = true));
    performSelect(select, 'asc');
    expect(changed).toBe(true);
  });
});
