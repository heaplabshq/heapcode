import { fingerprintOf, pathOf, type Fingerprint } from './fingerprint.js';
import { findSimilar } from './similarity.js';
import { INTERACTIVE_ROLES, type DomNode, type DomTree } from './tree.js';

/**
 * Looking around a page the way a person does in dev tools — for the healing
 * agent, which has to work out where a button went without being handed the
 * whole document (200k–2M characters) in one message.
 *
 * Each function returns a short text view of part of the tree: an outline to a
 * depth, a search, one branch opened, an element's surroundings, and the
 * elements most like the one that went missing. Node ids are `inspect`'s, so
 * whatever the agent picks is exactly the element that gets clicked.
 *
 * DOM-free: these run in Node on a tree that came over from the page.
 */

const MAX = 6000;

/** One line for a node: `[412] <button#save.btn primary> button "Save" — Save changes`. */
export function nodeLine(node: DomNode): string {
  const id = node.attrs.id ? `#${node.attrs.id}` : '';
  const cls = node.attrs.class ? `.${node.attrs.class.trim().split(/\s+/).slice(0, 3).join('.')}` : '';
  const test = Object.entries(node.attrs).find(([k]) => /^data-(testid|test-id|test|cy|qa)$/.test(k));
  const bits = [`[${node.id}] <${node.tag}${id}${cls}>`];
  if (node.role) bits.push(node.role);
  // A container's "name" is all the text inside it — noise; only things you
  // act on, headings and images have a name worth reading.
  const named = node.role && (INTERACTIVE_ROLES.has(node.role) || node.role === 'heading' || node.role === 'img');
  if (named && node.name) bits.push(`"${node.name.slice(0, 60)}"`);
  if (test) bits.push(`${test[0]}=${test[1]}`);
  const text = node.text;
  if (text && text !== node.name) bits.push(`— ${text.slice(0, 60)}`);
  if (!node.visible) bits.push('(hidden)');
  return bits.join(' ');
}

/** The tree from `root` (default: body) down to `depth` levels; long child lists are cut. */
export function domOutline(tree: DomTree, options: { root?: number; depth?: number } = {}): string {
  const root = options.root ?? tree.nodes.find((n) => n.tag === 'body')?.id ?? 0;
  const depth = options.depth ?? 4;
  const lines: string[] = [];
  const walk = (id: number, level: number): void => {
    const node = tree.nodes[id];
    if (!node) return;
    lines.push(`${'  '.repeat(level)}${nodeLine(node)}`);
    if (level >= depth) {
      if (node.children.length) lines.push(`${'  '.repeat(level + 1)}… ${node.children.length} child element${node.children.length === 1 ? '' : 's'}`);
      return;
    }
    const shown = node.children.slice(0, 25);
    for (const child of shown) walk(child, level + 1);
    if (node.children.length > shown.length) lines.push(`${'  '.repeat(level + 1)}… ${node.children.length - shown.length} more`);
  };
  walk(root, 0);
  return clip(lines);
}

/** Elements whose text, name or any attribute value contains `query` (case-insensitive). */
export function domSearch(tree: DomTree, query: string, limit = 30): string {
  const q = query.trim().toLowerCase();
  if (!q) return 'Search for some text.';
  const hits = tree.nodes.filter(
    (n) =>
      n.text.toLowerCase().includes(q) ||
      (n.name ?? '').toLowerCase().includes(q) ||
      Object.values(n.attrs).some((v) => v.toLowerCase().includes(q)),
  );
  if (!hits.length) return `Nothing on the page contains "${query}".`;
  const lines = hits.slice(0, limit).map((n) => `${nodeLine(n)}   in ${pathOf(tree, n)}`);
  if (hits.length > limit) lines.push(`… ${hits.length - limit} more`);
  return clip(lines);
}

/** One element opened: itself and its descendants to `depth`. */
export function domSubtree(tree: DomTree, id: number, depth = 3): string {
  if (!tree.nodes[id]) return `There is no element [${id}].`;
  return domOutline(tree, { root: id, depth });
}

/** Where an element sits: its ancestors, then its siblings, itself marked. */
export function domAround(tree: DomTree, id: number): string {
  const node = tree.nodes[id];
  if (!node) return `There is no element [${id}].`;
  const ancestors: DomNode[] = [];
  for (let p = node.parent; p !== null; p = tree.nodes[p]!.parent) ancestors.unshift(tree.nodes[p]!);
  const lines = ['Ancestors:', ...ancestors.slice(-6).map((a, i) => `${'  '.repeat(i)}${nodeLine(a)}`), 'Siblings:'];
  const parent = node.parent === null ? undefined : tree.nodes[node.parent];
  for (const sib of (parent?.children ?? [id]).slice(0, 30)) lines.push(`${sib === id ? '→ ' : '  '}${nodeLine(tree.nodes[sib]!)}`);
  return clip(lines);
}

/**
 * The elements most like the one a step was recorded against, scored on
 * every saved property (see `similarity.ts`), with what matched — the place
 * a person would start looking.
 */
export function domCandidates(tree: DomTree, saved: Fingerprint, limit = 8): string {
  const result = findSimilar(saved, tree, { limit });
  if (!result.ranked.length) return 'No visible element resembles it.';
  const lines = result.ranked.map((m) => {
    const fp = fingerprintOf(tree, m.nodeId);
    const same: string[] = [];
    if (saved.testId && fp.testId === saved.testId) same.push('test id');
    if (saved.id && fp.id === saved.id) same.push('id');
    if (saved.name && fp.name === saved.name) same.push('name');
    if (saved.text && fp.text === saved.text) same.push('text');
    if (saved.neighborText && fp.neighborText === saved.neighborText) same.push('nearby text');
    if (fp.tag === saved.tag) same.push('tag');
    return `${(m.score * 100).toFixed(0)}%  ${nodeLine(tree.nodes[m.nodeId]!)}${same.length ? `   same: ${same.join(', ')}` : ''}`;
  });
  return clip(lines);
}

/** A saved fingerprint, as words — what the element used to be. */
export function describeFingerprint(fp: Fingerprint): string {
  const bits = [`<${fp.tag}${fp.id ? `#${fp.id}` : ''}${fp.classes.length ? `.${fp.classes.slice(0, 3).join('.')}` : ''}>`];
  if (fp.role) bits.push(`role ${fp.role}`);
  if (fp.name) bits.push(`named "${fp.name}"`);
  if (fp.text && fp.text !== fp.name) bits.push(`showing "${fp.text}"`);
  if (fp.testId) bits.push(`test id ${fp.testId}`);
  if (fp.neighborText) bits.push(`next to "${fp.neighborText}"`);
  bits.push(`at ${fp.path}`);
  return bits.join(', ');
}

function clip(lines: string[]): string {
  let out = '';
  for (const line of lines) {
    if (out.length + line.length + 1 > MAX) return `${out}\n… (cut — open a smaller part)`;
    out += (out ? '\n' : '') + line;
  }
  return out;
}
