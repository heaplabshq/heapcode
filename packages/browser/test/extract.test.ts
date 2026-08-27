// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { extractSnapshot, extractText } from '../src/content/extract.js';
import { HandleRegistry } from '../src/content/registry.js';
import { accessibleName, nearestContext } from '../src/content/accessibleName.js';

function load(html: string): Document {
  document.body.innerHTML = html;
  return document;
}

function snapshot(html: string) {
  return extractSnapshot(load(html), new HandleRegistry());
}

describe('accessible names', () => {
  it('prefers aria-label over everything else', () => {
    const doc = load('<button aria-label="Close dialog">×</button>');
    expect(accessibleName(doc.querySelector('button')!)).toBe('Close dialog');
  });

  it('follows aria-labelledby to the referenced text', () => {
    const doc = load('<h2 id="t">Shipping address</h2><input aria-labelledby="t">');
    expect(accessibleName(doc.querySelector('input')!)).toBe('Shipping address');
  });

  it('uses a label[for] and a wrapping label', () => {
    const explicit = load('<label for="e">Email</label><input id="e">');
    expect(accessibleName(explicit.querySelector('input')!)).toBe('Email');
    const wrapping = load('<label>Postcode <input></label>');
    expect(accessibleName(wrapping.querySelector('input')!)).toBe('Postcode');
  });

  it('does not break on an id containing selector punctuation', () => {
    // Generated markup produces these routinely; an unescaped id throws inside
    // querySelector and would take the whole snapshot down with it.
    const doc = load('<label for="a[0].b">Quantity</label><input id="a[0].b">');
    expect(() => accessibleName(doc.querySelector('input')!)).not.toThrow();
    expect(accessibleName(doc.querySelector('input')!)).toBe('Quantity');
  });

  it('falls back through alt, placeholder and title', () => {
    expect(accessibleName(load('<button><img alt="Search"></button>').querySelector('button')!)).toBe('Search');
    expect(accessibleName(load('<input placeholder="Search products">').querySelector('input')!)).toBe('Search products');
    expect(accessibleName(load('<input title="Postcode">').querySelector('input')!)).toBe('Postcode');
  });

  it('takes a submit input name from its value', () => {
    expect(accessibleName(load('<input type="submit" value="Place order">').querySelector('input')!)).toBe('Place order');
  });
});

describe('distinguishing context', () => {
  it('finds the row a repeated control sits in', () => {
    // Twenty identical "Add to cart" buttons are indistinguishable without it,
    // and picking the wrong one spends real money.
    const doc = load(`
      <ul>
        <li>ThinkPad X1 £1200 <button>Add to cart</button></li>
        <li>MacBook Air £999 <button>Add to cart</button></li>
      </ul>`);
    const buttons = [...doc.querySelectorAll('button')];
    expect(nearestContext(buttons[0]!)).toContain('ThinkPad');
    expect(nearestContext(buttons[1]!)).toContain('MacBook');
  });

  it('falls back to the nearest preceding heading', () => {
    const doc = load('<section><h3>Filters</h3><div><button>Apply</button></div></section>');
    expect(nearestContext(doc.querySelector('button')!)).toBe('Filters');
  });
});

describe('what gets a handle', () => {
  it('assigns sequential handles to actionable controls', () => {
    const page = snapshot('<button>One</button><a href="/x">Two</a><select aria-label="Sort"><option>A</option></select>');
    expect(page.controls.map((c) => c.handle)).toEqual([1, 2, 3]);
    expect(page.controls.map((c) => c.role)).toEqual(['button', 'link', 'select']);
  });

  it('skips hidden, aria-hidden and display:none elements', () => {
    const page = snapshot(`
      <button>Visible</button>
      <button hidden>Hidden attr</button>
      <div aria-hidden="true"><button>Aria hidden</button></div>
      <button style="display:none">Styled out</button>`);
    expect(page.controls.map((c) => c.name)).toEqual(['Visible']);
  });

  it('lists a disabled control but marks it, rather than hiding it', () => {
    // "The checkout button is greyed out" is frequently the answer; hiding it
    // makes the model theorise about why it cannot find what it expects.
    const page = snapshot('<button disabled>Checkout</button>');
    expect(page.controls[0]?.disabled).toBe(true);
    expect(page.controls[0]?.name).toBe('Checkout');
  });

  it('skips hidden inputs and unnamed controls with no context', () => {
    const page = snapshot('<input type="hidden" name="csrf" value="x"><button></button>');
    expect(page.controls).toEqual([]);
  });

  it('records select options so the model picks a real one', () => {
    const page = snapshot('<select aria-label="Sort by"><option>Relevance</option><option>Price</option></select>');
    expect(page.controls[0]?.options).toEqual(['Relevance', 'Price']);
  });

  it('records checkbox state', () => {
    const page = snapshot('<label>16GB <input type="checkbox" checked></label>');
    expect(page.controls[0]?.checked).toBe(true);
  });
});

describe('secrets never reach the snapshot', () => {
  it('never emits a password field value', () => {
    // The executor refuses to type into these (PRD §6.4), but reading is the
    // same exposure by another route — the snapshot goes to the endpoint.
    const doc = load('<label>Password <input type="password"></label>');
    (doc.querySelector('input') as HTMLInputElement).value = 'hunter2';
    const page = extractSnapshot(doc, new HandleRegistry());
    expect(JSON.stringify(page)).not.toContain('hunter2');
    expect(page.controls[0]?.value).toBe('[hidden]');
  });

  it('redacts card and OTP fields matched by name', () => {
    const doc = load('<label>Card number <input name="cardNumber"></label><label>OTP <input name="otp"></label>');
    for (const input of doc.querySelectorAll('input')) (input as HTMLInputElement).value = '4111111111111111';
    const page = extractSnapshot(doc, new HandleRegistry());
    expect(JSON.stringify(page)).not.toContain('4111111111111111');
  });
});

describe('tables', () => {
  it('summarises shape and samples the leading rows', () => {
    const page = snapshot(`
      <table id="results">
        <thead><tr><th>Model</th><th>RAM</th><th>Price</th></tr></thead>
        <tbody>
          <tr><td>X1</td><td>16GB</td><td>1200</td></tr>
          <tr><td>Air</td><td>8GB</td><td>999</td></tr>
        </tbody>
      </table>`);
    const table = page.tables[0]!;
    expect(table.label).toBe('table#results');
    expect(table.headers).toEqual(['Model', 'RAM', 'Price']);
    expect(table.rows).toBe(2);
    expect(table.sample[0]).toEqual(['X1', '16GB', '1200']);
  });

  it('ignores a layout table with no headers', () => {
    expect(snapshot('<table><tr><td>a</td><td>b</td></tr></table>').tables).toEqual([]);
  });
});

describe('main text extraction', () => {
  it('prefers the main landmark and drops nav and footer', () => {
    const doc = load(`
      <nav>Home Products Support</nav>
      <main><h1>Refund policy</h1><p>You have 30 days.</p></main>
      <footer>Copyright</footer>`);
    const text = extractText(doc);
    expect(text).toContain('You have 30 days.');
    expect(text).not.toContain('Support');
    expect(text).not.toContain('Copyright');
  });

  it('never includes script or style contents', () => {
    const doc = load('<main><script>var secret = 1;</script><style>.a{color:red}</style><p>Real</p></main>');
    const text = extractText(doc);
    expect(text).toBe('Real');
  });
});
