import { INTERACTIVE_ROLES, type DomNode, type DomTree } from './tree.js';

/**
 * The page as a model reads it: headings, the things it can act on, and the
 * visible text around them, every line numbered by node id — a few thousand
 * characters cut from a tree that may hold hundreds of thousands.
 *
 * Built from `inspect`'s tree, so the numbers are node ids: what the model
 * picks is exactly the element Heap QA then acts on and records (via the
 * recorder's `describeTarget`), with no second lookup to drift.
 *
 * DOM-free: runs in Node on a tree that came over from the page.
 */
export interface OutlineOptions {
  /** Default 8000. */
  maxChars?: number;
}

const FIELD_TAGS = new Set(['input', 'textarea', 'select']);

/** Whether a node is something to act on: an interactive role, a field, or a link. */
export function isActionable(node: DomNode): boolean {
  if (node.role && INTERACTIVE_ROLES.has(node.role)) return true;
  if (FIELD_TAGS.has(node.tag) && node.attrs.type !== 'hidden') return true;
  return false;
}

export function formatOutline(tree: DomTree, options: OutlineOptions = {}): string {
  const max = options.maxChars ?? 8000;
  const lines: string[] = [];
  const hidden = new Set<number>();
  // A node is hidden if it or any ancestor is.
  for (const node of tree.nodes) {
    if (!node.visible || (node.parent !== null && hidden.has(node.parent))) hidden.add(node.id);
  }
  const insideActionable = new Set<number>();
  for (const node of tree.nodes) {
    if (node.parent !== null && (insideActionable.has(node.parent) || isActionable(tree.nodes[node.parent]!))) insideActionable.add(node.id);
  }

  for (const node of tree.nodes) {
    if (hidden.has(node.id)) continue;
    if (isActionable(node) && !insideActionable.has(node.id)) {
      lines.push(describeActionable(node));
    } else if (node.role === 'heading') {
      // Numbered too: a heading or a message is what a check points at.
      lines.push(`[${node.id}] ${'#'.repeat(Math.min(6, Number(node.tag.slice(1)) || 2))} ${node.name ?? node.text}`);
    } else if (node.text && !insideActionable.has(node.id) && !(node.parent !== null && tree.nodes[node.parent]!.role === 'heading')) {
      lines.push(`[${node.id}] ${node.text}`);
    }
  }

  const head = `Page: ${tree.title ? `"${tree.title}" — ` : ''}${tree.url}`;
  let out = head;
  let truncated = tree.truncated;
  for (const line of lines) {
    if (out.length + line.length + 1 > max) {
      truncated = true;
      break;
    }
    out += `\n${line}`;
  }
  if (truncated) out += '\n… (page continues — not everything is shown)';
  return out;
}

function describeActionable(node: DomNode): string {
  const role = node.role ?? (node.tag === 'select' ? 'combobox' : node.tag === 'textarea' ? 'textbox' : node.attrs.type === 'password' ? 'password field' : 'input');
  const name = node.name ?? node.attrs.placeholder ?? node.text ?? '';
  const bits: string[] = [];
  if (node.attrs.placeholder && node.attrs.placeholder !== name) bits.push(`placeholder "${node.attrs.placeholder}"`);
  if (node.value !== undefined && node.value !== '') bits.push(`value "${node.value.slice(0, 60)}"`);
  if (node.attrs.type === 'password') bits.push('password');
  if (node.checked !== undefined) bits.push(node.checked ? 'checked' : 'unchecked');
  if (node.disabled) bits.push('disabled');
  if (node.role === 'link' && node.attrs.href) bits.push(`→ ${node.attrs.href.slice(0, 80)}`);
  return `[${node.id}] ${role}${name ? ` "${name}"` : ''}${bits.length ? ` (${bits.join(', ')})` : ''}`;
}
