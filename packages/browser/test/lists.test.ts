// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { extractSnapshot } from '../src/content/extract.js';
import { HandleRegistry } from '../src/content/registry.js';
import { tableFromList } from '../src/shared/listTable.js';

/**
 * The repeated block a page uses instead of a table.
 *
 * `extract_data` saw only real `<table>` markup, which meant it saw nothing on
 * the pages people actually point it at: search results, product grids, job
 * boards. Those have been repeated `<div>`s for fifteen years, so the request
 * this whole feature exists for -- "compare these on price" -- fell back to the
 * model writing a price list in prose. That is precisely the outcome collecting
 * rows was built to replace: plausible, unverifiable, impossible to sort.
 */

function snapshot(html: string) {
  document.body.innerHTML = html;
  return extractSnapshot(document, new HandleRegistry());
}

function card(name: string, price: string, rating: string, href: string, extra = ''): string {
  return `<div class="item ${extra}">
    <a href="${href}"><h2>${name}</h2></a>
    <span>${price}</span>
    <span>${rating} out of 5 stars</span>
    <button>Add to cart</button>
  </div>`;
}

const PHONES = `<div id="results">
  ${card('Apple iPhone 16e 128 GB', '₹59,900', '4.5', '/dp/B01', 'AdHolder')}
  ${card('Apple iPhone 16 128 GB', '₹64,900', '4.6', '/dp/B02')}
  ${card('Apple iPhone 16 Plus 256 GB', '₹89,900', '4.4', '/dp/B03')}
  ${card('Apple iPhone Air 256 GB', '₹1,01,900', '4.2', '/dp/B04')}
</div>`;

describe('a product grid that is not a table', () => {
  it('becomes a table with the columns the page actually has', () => {
    const [table] = snapshot(PHONES).tables;
    expect(table?.headers).toEqual(['Name', 'Price', 'Rating', 'Link']);
    expect(table?.rows).toBe(4);
  });

  it('reads the values off each card', () => {
    const [table] = snapshot(PHONES).tables;
    expect(table?.body?.[0]?.[0]).toBe('Apple iPhone 16e 128 GB');
    expect(table?.body?.[0]?.[1]).toBe('₹59,900');
    expect(table?.body?.[0]?.[2]).toBe('4.5');
  });

  /**
   * The reason grouping is on shape rather than class. A sponsored result
   * carries an extra class and is otherwise the same card; grouping on class
   * puts it in a group of its own and finds two lists where there is one.
   */
  it('keeps the sponsored card in with the rest', () => {
    const [table] = snapshot(PHONES).tables;
    expect(table?.rows).toBe(4);
  });

  /** The selling price is written before the struck-through one, on every shop. */
  it('takes the selling price, not the list price', () => {
    const [table] = snapshot(`<div id="r">
      ${['A', 'B', 'C'].map((n) => `<div class="item"><a href="/${n}"><h2>Phone ${n}</h2></a><span>₹59,900</span><span>M.R.P. ₹79,900</span></div>`).join('')}
    </div>`).tables;
    expect(table?.body?.[0]?.[1]).toBe('₹59,900');
  });

  it('resolves each item\'s link against the page', () => {
    const [table] = snapshot(PHONES).tables;
    expect(table?.body?.[0]?.[3]).toMatch(/\/dp\/B01$/);
  });
});

describe('what is not a list', () => {
  it('ignores the navigation, however repeated it is', () => {
    const tables = snapshot(
      `<nav>${['Deals', 'Prime', 'Returns', 'Cart'].map((n) => `<a href="/${n}"><span>${n}</span><span>Shop ${n} now</span></a>`).join('')}</nav>`,
    ).tables;
    expect(tables).toHaveLength(0);
  });

  it('ignores two of a thing, which is a coincidence', () => {
    const tables = snapshot(
      `<div id="r">${card('One', '₹10', '4.1', '/a')}${card('Two', '₹20', '4.2', '/b')}</div>`,
    ).tables;
    expect(tables).toHaveLength(0);
  });

  /**
   * A column of names and nothing else is something read_page already reports
   * better -- as controls carrying handles the agent can act on, which beats
   * the same strings with no way to click them.
   */
  it('ignores a list with nothing in it but names', () => {
    const tables = snapshot(
      `<ul>${['Alpha', 'Beta', 'Gamma', 'Delta'].map((n) => `<li><h3>${n}</h3><p>Some words about ${n} that make it long enough.</p></li>`).join('')}</ul>`,
    ).tables;
    expect(tables).toHaveLength(0);
  });

  /** Real markup wins: a `<table>` declares its columns, a list only guesses. */
  it('puts a real table first when the page has both', () => {
    const tables = snapshot(
      `<table><thead><tr><th>Spec</th><th>Value</th></tr></thead><tbody><tr><td>Weight</td><td>4kg</td></tr></tbody></table>${PHONES}`,
    ).tables;
    expect(tables[0]?.headers).toEqual(['Spec', 'Value']);
    expect(tables[1]?.headers).toContain('Price');
  });
});

describe('deciding what a row is', () => {
  it('drops a column most items do not have', () => {
    const table = tableFromList([
      { title: 'A', lines: ['A', '₹10'] },
      { title: 'B', lines: ['B', '₹20'] },
      { title: 'C', lines: ['C', '₹30', '4.5 out of 5'] },
    ]);
    expect(table?.headers).toEqual(['Name', 'Price']);
  });

  it('names an item from its longest prose when it has no heading', () => {
    const table = tableFromList([
      { lines: ['₹10', 'Nord Wireless Headphones, over-ear'] },
      { lines: ['₹20', 'Nord Wireless Earbuds, in-ear'] },
      { lines: ['₹30', 'Nord Wireless Speaker, portable'] },
    ]);
    expect(table?.body?.[0]?.[0]).toBe('Nord Wireless Headphones, over-ear');
  });

  it('reads the currencies a shop actually writes', () => {
    for (const price of ['₹1,01,900', '$1,299.00', '£89', '€1.234,50', 'Rs. 450']) {
      const table = tableFromList([
        { title: 'A', lines: ['A', price] },
        { title: 'B', lines: ['B', price] },
        { title: 'C', lines: ['C', price] },
      ]);
      expect(table?.body?.[0]?.[1], price).toBe(price);
    }
  });

  it('is nothing at all when there is nothing worth a table', () => {
    expect(tableFromList([{ lines: ['one'] }, { lines: ['two'] }])).toBeUndefined();
  });
});
