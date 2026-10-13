import { testIdOf, type DomNode, type DomTree, type Rect } from './inspect.js';

/**
 * Everything worth remembering about one element, so it can be found again
 * after the page changes.
 *
 * Saved when a step is recorded and refreshed on every run that passes, so it
 * describes the element as it last looked when the test worked. No single
 * field is trusted: ids get regenerated, text gets reworded, layouts move.
 * `similarity.ts` scores every element on the new page against all of them at
 * once, which is what survives a change to any one (Similo; Nass et al.,
 * arXiv:2208.00677).
 *
 * Pure: computed from a `DomTree`, so it runs in Node as well as in the page.
 */
export interface Fingerprint {
  tag: string;
  id?: string;
  testId?: string;
  role?: string;
  name?: string;
  /** The element's whole visible text (own + descendants), trimmed. */
  text?: string;
  classes: string[];
  /** The attributes that tend to identify a control. */
  attrs: Partial<Record<(typeof KEPT_ATTRS)[number], string>>;
  /** Tag path from the root with sibling indexes: `html/body[1]/main[1]/form[2]/button[1]`. */
  path: string;
  /** Nearby text a person would use to tell it apart: its label, the heading above it. */
  neighborText?: string;
  rect?: Rect;
}

const KEPT_ATTRS = ['name', 'type', 'href', 'placeholder', 'title', 'alt', 'aria-label', 'for', 'value'] as const;
const MAX = 120;

export function fingerprintOf(tree: DomTree, nodeId: number): Fingerprint {
  const node = tree.nodes[nodeId];
  if (!node) throw new Error(`No node ${nodeId} in this inspection.`);
  const attrs: Fingerprint['attrs'] = {};
  for (const key of KEPT_ATTRS) {
    const value = node.attrs[key];
    if (value) attrs[key] = value.slice(0, MAX);
  }
  const fp: Fingerprint = {
    tag: node.tag,
    classes: (node.attrs.class ?? '').split(/\s+/).filter(Boolean),
    attrs,
    path: pathOf(tree, node),
  };
  if (node.attrs.id) fp.id = node.attrs.id;
  const testId = testIdOf(node);
  if (testId) fp.testId = testId.value;
  if (node.role) fp.role = node.role;
  if (node.name) fp.name = node.name;
  const text = textOf(tree, node);
  if (text) fp.text = text;
  const neighbor = neighborTextOf(tree, node);
  if (neighbor) fp.neighborText = neighbor;
  if (node.rect) fp.rect = node.rect;
  return fp;
}

/** Own text plus descendants', in document order, capped. */
export function textOf(tree: DomTree, node: DomNode): string {
  const parts: string[] = [];
  let length = 0;
  const walk = (n: DomNode): void => {
    if (length > MAX) return;
    if (n.text) {
      parts.push(n.text);
      length += n.text.length;
    }
    for (const child of n.children) walk(tree.nodes[child]!);
  };
  walk(node);
  return parts.join(' ').replace(/\s+/g, ' ').trim().slice(0, MAX);
}

export function pathOf(tree: DomTree, node: DomNode): string {
  const steps: string[] = [];
  let current: DomNode | undefined = node;
  while (current) {
    const parent: DomNode | undefined = current.parent === null ? undefined : tree.nodes[current.parent];
    if (!parent) {
      steps.push(current.tag);
      break;
    }
    let index = 0;
    for (const sibling of parent.children) {
      if (tree.nodes[sibling]!.tag === current.tag) index += 1;
      if (sibling === current.id) break;
    }
    steps.push(`${current.tag}[${index}]`);
    current = parent;
  }
  return steps.reverse().join('/');
}

const BOUNDARIES = new Set(['form', 'fieldset', 'section', 'article', 'main', 'nav', 'header', 'footer', 'aside', 'dialog', 'li', 'tr', 'body']);

const labelIndex = new WeakMap<DomTree, Map<string, DomNode>>();

/** `<label for>` by target id, built once per tree — healing fingerprints every element. */
function labelsOf(tree: DomTree): Map<string, DomNode> {
  let map = labelIndex.get(tree);
  if (!map) {
    map = new Map();
    for (const n of tree.nodes) if (n.tag === 'label' && n.attrs.for && !map.has(n.attrs.for)) map.set(n.attrs.for, n);
    labelIndex.set(tree, map);
  }
  return map;
}

/**
 * The text a person would read next to it: a `<label for>` pointing at it,
 * else the closest text before it, walking back through siblings and then up
 * through ancestors.
 */
export function neighborTextOf(tree: DomTree, node: DomNode): string | undefined {
  const id = node.attrs.id;
  if (id) {
    const label = labelsOf(tree).get(id);
    if (label) {
      const text = textOf(tree, label);
      if (text) return text.slice(0, 80);
    }
  }
  let current: DomNode | undefined = node;
  for (let depth = 0; current && depth < 6; depth += 1) {
    const parent: DomNode | undefined = current.parent === null ? undefined : tree.nodes[current.parent];
    if (!parent) break;
    const index = parent.children.indexOf(current.id);
    for (let i = index - 1; i >= 0; i -= 1) {
      const text = textOf(tree, tree.nodes[parent.children[i]!]!);
      if (text) return text.slice(0, 80);
    }
    if (parent.text) return parent.text.slice(0, 80);
    // Text from outside the form or card the element sits in describes some
    // other part of the page, and makes every first-in-form control look alike.
    if (BOUNDARIES.has(parent.tag)) break;
    current = parent;
  }
  return undefined;
}
