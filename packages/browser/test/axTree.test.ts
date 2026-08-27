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
