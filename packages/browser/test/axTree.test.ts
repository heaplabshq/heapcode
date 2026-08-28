import { describe, expect, it } from 'vitest';
import { snapshotFromAxTree, type AxNode } from '../src/agent/axTree.js';

/**
 * The page as the browser understands it.
 *
 * Every test here is a heuristic in `src/content/` that stops being needed. The
 * DOM path had to estimate visibility, modality, accessible names and roles, and
 * each estimate is where a site eventually broke. The accessibility tree is the
 * browser's own answer to all four.
 */

const text = (value: string) => ({ type: 'computedString', value });

function node(partial: Partial<AxNode> & { nodeId: string }): AxNode {
  return { childIds: [], backendDOMNodeId: Number(partial.nodeId), ...partial };
}

function build(nodes: AxNode[]) {
  let handle = 0;
  return snapshotFromAxTree({
    nodes,
    url: 'https://example.com/jobs',
    title: 'Jobs',
    viewport: { width: 1280, height: 800, scrollY: 0, scrollHeight: 4000 },
    generation: 1,
    register: () => ++handle,
  });
}

describe('what becomes a control', () => {
  it('maps computed roles, so a div behaving as a button is a button', () => {
    // The DOM path had to infer this from tag names and role attributes.
    const page = build([
      node({ nodeId: '1', role: text('button'), name: text('Apply') }),
      node({ nodeId: '2', role: text('link'), name: text('Next page') }),
      node({ nodeId: '3', role: text('textbox'), name: text('Search') }),
      node({ nodeId: '4', role: text('combobox'), name: text('Sort by') }),
      node({ nodeId: '5', role: text('checkbox'), name: text('Remote') }),
    ]);
    expect(page.controls.map((c) => c.role)).toEqual([
      'button',
      'link',
      'input',
      'select',
      'checkbox',
    ]);
  });

  it('skips ignored nodes without any visibility logic of our own', () => {
    // `ignored` already covers display:none, visibility:hidden, aria-hidden,
    // zero-size, and inert — four separate checks the DOM path maintains.
    const page = build([
      node({ nodeId: '1', role: text('button'), name: text('Visible') }),
      node({ nodeId: '2', role: text('button'), name: text('Hidden'), ignored: true }),
    ]);
    expect(page.controls.map((c) => c.name)).toEqual(['Visible']);
  });

  it('takes state from the browser rather than reading attributes', () => {
    const page = build([
      node({
        nodeId: '1',
        role: text('button'),
        name: text('Checkout'),
        properties: [{ name: 'disabled', value: { type: 'boolean', value: true } }],
      }),
      node({
        nodeId: '2',
        role: text('checkbox'),
        name: text('Remote'),
        properties: [{ name: 'checked', value: { type: 'boolean', value: true } }],
      }),
    ]);
    expect(page.controls[0]?.disabled).toBe(true);
    expect(page.controls[1]?.checked).toBe(true);
  });

  it('drops a control with no name and nothing to describe it', () => {
    const page = build([node({ nodeId: '1', role: text('button'), name: text('') })]);
    expect(page.controls).toEqual([]);
  });

  it('never puts a credential value in the snapshot', () => {
    // Same rule as the DOM path, and for the same reason: the snapshot goes to
    // whatever endpoint the user configured.
    const page = build([
      node({ nodeId: '1', role: text('textbox'), name: text('Password'), value: text('hunter2') }),
    ]);
    expect(JSON.stringify(page)).not.toContain('hunter2');
    expect(page.controls[0]?.value).toBe('[hidden]');
  });
});

describe('a modal dialog', () => {
  const nodes = [
    node({ nodeId: '1', role: text('button'), name: text('Background') }),
    node({
      nodeId: '2',
      role: text('dialog'),
      name: text('Apply'),
      childIds: ['3'],
      properties: [{ name: 'modal', value: { type: 'boolean', value: true } }],
    }),
    node({ nodeId: '3', role: text('button'), name: text('Submit application') }),
  ];

  it('scopes the snapshot to it, without needing an overlay heuristic', () => {
    const page = build(nodes);
    expect(page.controls.map((c) => c.name)).toEqual(['Submit application']);
  });

  it('says a dialog is open', () => {
    expect(build(nodes).title).toMatch(/dialog open/);
  });
});

describe('page text', () => {
  it('comes from the tree, so it is what a screen reader would announce', () => {
    const page = build([
      node({ nodeId: '1', role: text('heading'), name: text('Senior Frontend Developer') }),
      node({ nodeId: '2', role: text('StaticText'), name: text('Bangalore, hybrid') }),
      node({ nodeId: '3', role: text('StaticText'), name: text('Hidden'), ignored: true }),
    ]);
    expect(page.text).toContain('Senior Frontend Developer');
    expect(page.text).toContain('Bangalore, hybrid');
    expect(page.text).not.toContain('Hidden');
  });
});

describe('tables', () => {
  it('reads shape and rows from table, row and columnheader roles', () => {
    const page = build([
      node({ nodeId: '1', role: text('table'), name: text('Results'), childIds: ['2', '4'] }),
      node({ nodeId: '2', role: text('row'), childIds: ['3', '3b'] }),
      node({ nodeId: '3', role: text('columnheader'), name: text('Role') }),
      node({ nodeId: '3b', role: text('columnheader'), name: text('Salary') }),
      node({ nodeId: '4', role: text('row'), childIds: ['5', '5b'] }),
      node({ nodeId: '5', role: text('cell'), name: text('Frontend') }),
      node({ nodeId: '5b', role: text('cell'), name: text('60 LPA') }),
    ]);
    const table = page.tables[0]!;
    expect(table.headers).toEqual(['Role', 'Salary']);
    expect(table.rows).toBe(1);
    expect(table.sample[0]).toEqual(['Frontend', '60 LPA']);
  });
});

/**
 * The repeated block a page uses instead of a table, seen through the
 * accessibility tree.
 *
 * The same idea as the content script's version and necessarily a different
 * implementation: this side has roles rather than tags, and no elements to ask
 * about visibility — Chrome has already dropped what is not there. It matters
 * that both paths find the same list, because the debugger is on by default and
 * this is the path most runs actually take.
 */
describe('a list that is not a table', () => {
  /** One search result, as Chrome describes a product card. */
  function result(id: number, name: string, price: string, rating: string): AxNode[] {
    const base = id * 10;
    return [
      node({ nodeId: `${base}`, role: text('listitem'), childIds: [`${base + 1}`, `${base + 3}`, `${base + 4}`] }),
      node({ nodeId: `${base + 1}`, role: text('heading'), name: text(name), childIds: [`${base + 2}`] }),
      node({ nodeId: `${base + 2}`, role: text('StaticText'), name: text(name) }),
      node({ nodeId: `${base + 3}`, role: text('StaticText'), name: text(price) }),
      node({ nodeId: `${base + 4}`, role: text('StaticText'), name: text(`${rating} out of 5 stars`) }),
    ];
  }

  const results = [
    node({ nodeId: '1', role: text('list'), name: text('Results'), childIds: ['10', '20', '30', '40'] }),
    ...result(1, 'Apple iPhone 16e 128 GB', '₹59,900', '4.5'),
    ...result(2, 'Apple iPhone 16 128 GB', '₹64,900', '4.6'),
    ...result(3, 'Apple iPhone 16 Plus 256 GB', '₹89,900', '4.4'),
    ...result(4, 'Apple iPhone Air 256 GB', '₹1,01,900', '4.2'),
  ];

  it('becomes a table', () => {
    const [table] = build(results).tables;
    expect(table?.headers).toEqual(['Name', 'Price', 'Rating']);
    expect(table?.rows).toBe(4);
  });

  it('reads the values off each item', () => {
    const [table] = build(results).tables;
    expect(table?.body?.[0]).toEqual(['Apple iPhone 16e 128 GB', '₹59,900', '4.5']);
  });

  it('names the list from the container the page named', () => {
    const [table] = build(results).tables;
    expect(table?.label).toBe('Results');
  });

  /**
   * There is no Link column here on purpose: the accessibility tree names a
   * link and does not carry its address, and inventing one from the name would
   * be worse than leaving it out.
   */
  it('does not invent an address it was not given', () => {
    const [table] = build(results).tables;
    expect(table?.headers).not.toContain('Link');
  });

  /**
   * The tree Chrome actually produces, rather than the tidy one.
   *
   * `ignored` does not mean "not there" -- it means "carries no meaning of its
   * own", and Chrome marks every generic wrapper that way. A real results grid
   * arrives several such wrappers deep. The first version of this walked with a
   * filter that dropped them, so it never reached any text, found every item
   * empty and reported no list at all: on Amazon the content-script path found
   * the grid and this one found nothing, which is the wrong way round, because
   * this is the path a run takes by default.
   */
  it('walks through the scaffolding Chrome marks ignored', () => {
    const card = (id: number, name: string, price: string): AxNode[] => {
      const b = id * 10;
      return [
        // The card itself: an anonymous wrapper, ignored.
        node({ nodeId: `${b}`, ignored: true, childIds: [`${b + 1}`] }),
        // And another one inside it, because that is how deep these go.
        node({ nodeId: `${b + 1}`, ignored: true, childIds: [`${b + 2}`, `${b + 4}`] }),
        node({ nodeId: `${b + 2}`, role: text('heading'), name: text(name), childIds: [`${b + 3}`] }),
        node({ nodeId: `${b + 3}`, role: text('StaticText'), name: text(name) }),
        node({ nodeId: `${b + 4}`, role: text('StaticText'), name: text(price) }),
      ];
    };

    const page = build([
      node({ nodeId: '1', ignored: true, childIds: ['10', '20', '30', '40'] }),
      ...card(1, 'Samsung Galaxy M07 (Black, 4GB/64GB)', '₹11,499'),
      ...card(2, 'OnePlus Nord CE6 Lite 8GB+128GB', '₹30,999'),
      ...card(3, 'Apple iPhone Air 256GB, Sky Blue', '₹1,01,900'),
      ...card(4, 'Motorola G57 Power 5G, 8GB/128GB', '₹21,999'),
    ]);

    const [table] = page.tables;
    expect(table?.headers).toEqual(['Name', 'Price']);
    expect(table?.rows).toBe(4);
    expect(table?.body?.[2]).toEqual(['Apple iPhone Air 256GB, Sky Blue', '₹1,01,900']);
  });

  /**
   * A grid nested in wrappers matches at every depth it is wrapped in, and
   * those matches are the same list described several times. Two identical
   * tables in one snapshot is budget spent saying the same thing twice.
   */
  it('reports a deeply wrapped grid once, not once per wrapper', () => {
    const card = (id: number, name: string, price: string): AxNode[] => {
      const b = id * 10;
      return [
        node({ nodeId: `${b}`, ignored: true, childIds: [`${b + 1}`] }),
        node({ nodeId: `${b + 1}`, ignored: true, childIds: [`${b + 2}`, `${b + 3}`] }),
        node({ nodeId: `${b + 2}`, role: text('heading'), name: text(name) }),
        node({ nodeId: `${b + 3}`, role: text('StaticText'), name: text(price) }),
      ];
    };
    const page = build([
      node({ nodeId: '1', ignored: true, childIds: ['2'] }),
      node({ nodeId: '2', ignored: true, childIds: ['10', '20', '30'] }),
      ...card(1, 'Samsung Galaxy M07 (Black, 4GB/64GB)', '₹11,499'),
      ...card(2, 'OnePlus Nord CE6 Lite 8GB+128GB', '₹30,999'),
      ...card(3, 'Apple iPhone Air 256GB, Sky Blue', '₹1,01,900'),
    ]);
    expect(page.tables).toHaveLength(1);
  });

  it('is not fooled by three of anything', () => {
    const page = build([
      node({ nodeId: '1', role: text('list'), childIds: ['2', '3', '4'] }),
      node({ nodeId: '2', role: text('listitem'), name: text('One') }),
      node({ nodeId: '3', role: text('listitem'), name: text('Two') }),
      node({ nodeId: '4', role: text('listitem'), name: text('Three') }),
    ]);
    expect(page.tables).toHaveLength(0);
  });
})
