// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
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

/**
 * The variants are not the plain click called more than once. A page reads
 * `event.detail` and `event.button`, so two plain clicks are to a double-click
 * what typing a letter twice is to a word -- asserted here because the failure
 * is silent, same as the original sequence was.
 */
describe('clicking the way a person would', () => {
  it('sends a double click as one burst: two clicks with rising detail, then dblclick', () => {
    const row = load('<div class="folder">Documents</div>');
    const clicks: number[] = [];
    const dblclicks: number[] = [];
    row.addEventListener('click', (e) => clicks.push((e as MouseEvent).detail));
    row.addEventListener('dblclick', (e) => dblclicks.push((e as MouseEvent).detail));

    const result = performClick(row, 'double');

    expect(result.ok).toBe(true);
    expect(clicks).toHaveLength(2);
    expect(clicks.at(-1)).toBe(2);
    expect(dblclicks).toEqual([2]);
  });

  it('runs default behaviour once on a double click, not once per round', () => {
    // The first round uses `.click()` so links and submits still work; the
    // later rounds are synthesized precisely so they cannot, and in a real
    // Chrome a synthesized click never runs an element's activation behaviour.
    // (jsdom is more permissive here, so what is asserted is the round count
    // itself rather than its downstream effect.)
    document.body.innerHTML = '<form><button type="submit">Send</button></form>';
    const button = document.querySelector('button')!;
    const click = vi.spyOn(button, 'click');

    performClick(button, 'double');

    expect(click).toHaveBeenCalledTimes(1);
  });

  it('sends a triple click as three clicks, the last carrying detail 3', () => {
    const field = load('<p>One whole paragraph of text.</p>');
    const clicks: number[] = [];
    const dblclicks: number[] = [];
    field.addEventListener('click', (e) => clicks.push((e as MouseEvent).detail));
    field.addEventListener('dblclick', (e) => dblclicks.push((e as MouseEvent).detail));

    const result = performClick(field, 'triple');

    expect(result.ok).toBe(true);
    // Three clicks, and exactly one dblclick — on the second, the way a real
    // browser pairs a rapid sequence and then keeps going. Firing it on the
    // third as well would run a page's "open this" handler twice off one
    // triple-click, which is a real double-action, not a fidelity nit.
    expect(clicks).toHaveLength(3);
    expect(clicks.at(-1)).toBe(3);
    expect(dblclicks).toEqual([2]);
    // The note is honest about what a synthesized triple click cannot do: the
    // browser's own paragraph selection happens only for trusted input.
    expect(result.ok && result.note).toMatch(/did not run/);
  });

  it('sends a right click as contextmenu, with no click event at all', () => {
    const row = load('<div class="doc">Report.pdf</div>');
    const seen: string[] = [];
    let button = -1;
    row.addEventListener('click', () => seen.push('click'));
    row.addEventListener('contextmenu', (e) => {
      seen.push('contextmenu');
      button = (e as MouseEvent).button;
    });

    const result = performClick(row, 'right');

    expect(result.ok).toBe(true);
    expect(seen).toEqual(['contextmenu']);
    expect(button).toBe(2);
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
