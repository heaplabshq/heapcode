import type { ListItem } from '../shared/listTable.js';
import { isVisible } from './visibility.js';

/**
 * Finding the repeated block a page uses instead of a table.
 *
 * Search results, product grids, job boards, flight lists: all of them are a
 * container whose children are the same shape over and over, and none of them
 * are `<table>`. That repetition is the only thing they reliably have in
 * common, so it is the only thing looked for here -- no per-site selectors, no
 * class-name heuristics that a redesign invalidates on a Tuesday.
 *
 * Shape rather than class names, deliberately. A list's items routinely differ
 * in class -- a sponsored result carries an extra one, the first item carries a
 * modifier, a framework appends a hash -- while the tags inside them stay the
 * same, because that is what a template is. Grouping on the descendant tag set
 * puts the sponsored row in with the rest; grouping on class puts it in a group
 * of its own and finds two lists where there is one.
 */

/** Fewer than this is a coincidence, not a list. */
const MIN_ITEMS = 3;
/** An item with less text than this is a spacer, an icon, or a divider. */
const MIN_ITEM_TEXT = 20;
/** Enough lists to cover a page with a sidebar; more is noise. */
const MAX_LISTS = 2;
/** Bound the walk. A deep page has tens of thousands of elements. */
const MAX_ELEMENTS = 4000;
const MAX_ITEMS = 200;
const MAX_LINES = 40;

/** Chrome that is repeated on every page and is never the answer. */
const FURNITURE = new Set(['NAV', 'HEADER', 'FOOTER', 'ASIDE', 'SELECT', 'TABLE']);

/**
 * The tags inside an element, as an order-independent set.
 *
 * Depth-limited: two cards are the same shape if their first few levels agree,
 * and going deeper starts separating items that differ only in whether they
 * happen to show a badge.
 */
function shape(element: Element, depth = 3): string {
  const tags = new Set<string>();
  const walk = (node: Element, left: number) => {
    for (const child of node.children) {
      tags.add(child.tagName);
      if (left > 1) walk(child, left - 1);
    }
  };
  walk(element, depth);
  return [...tags].sort().join(',');
}

/** The most common value, and how many had it. */
function mode(values: string[]): { value: string; count: number } {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  let best = { value: '', count: 0 };
  for (const [value, count] of counts) if (count > best.count) best = { value, count };
  return best;
}

function textOf(element: Element): string {
  return (element.textContent ?? '').replace(/\s+/g, ' ').trim();
}

/**
 * One line per element that carries its own text.
 *
 * `innerText` would be the right tool and does not exist outside a rendering
 * engine, so this reproduces the part that matters: a block's own words, kept
 * apart from its children's. Without the separation a card collapses to one
 * run-on string and the price ends up glued to the end of the title.
 */
function linesOf(element: Element): string[] {
  const lines: string[] = [];
  const walk = (node: Element) => {
    if (lines.length >= MAX_LINES) return;
    let own = '';
    for (const child of node.childNodes) {
      if (child.nodeType === 3) own += child.nodeValue ?? '';
    }
    const cleaned = own.replace(/\s+/g, ' ').trim();
    if (cleaned) lines.push(cleaned);
    for (const child of node.children) walk(child);
  };
  walk(element);
  return lines;
}

/** What the page itself considers this item to be called. */
function titleOf(element: Element): string | undefined {
  const heading = element.querySelector('h1, h2, h3, h4, h5, h6, [role="heading"]');
  const headingText = heading ? textOf(heading) : '';
  if (headingText.length >= 3) return headingText;

  // Failing a heading, the longest link text: a card's title is a link to the
  // thing, and the other links on it are "add to basket" and "compare".
  let longest = '';
  for (const anchor of element.querySelectorAll('a')) {
    const text = textOf(anchor);
    if (text.length > longest.length) longest = text;
  }
  return longest.length >= 3 ? longest : undefined;
}

function hrefOf(element: Element, base: string): string | undefined {
  const anchor = element.querySelector('a[href]');
  const href = anchor?.getAttribute('href');
  if (!href || href.startsWith('#') || href.startsWith('javascript:')) return undefined;
  try {
    return new URL(href, base).toString();
  } catch {
    return href;
  }
}

function inFurniture(element: Element): boolean {
  for (let node: Element | null = element; node; node = node.parentElement) {
    if (FURNITURE.has(node.tagName)) return true;
  }
  return false;
}

export interface DetectedList {
  label?: string;
  items: ListItem[];
  /** Items times how much each one says. Ranks a results grid above a menu. */
  score: number;
  container: Element;
}

/**
 * Every repeated block on the page, best first.
 *
 * Scored by how many items it has and how much each one says, which is what
 * separates the results grid from the eight-item filter menu beside it without
 * either of them having to be recognised.
 */
export function findLists(root: Document | Element, base: string): DetectedList[] {
  const found: DetectedList[] = [];
  let seen = 0;

  const containers = root.querySelectorAll('*');
  for (const container of containers) {
    if (++seen > MAX_ELEMENTS) break;
    const children = [...container.children];
    if (children.length < MIN_ITEMS) continue;
    if (inFurniture(container)) continue;

    // Same tag first: a grid's items are all divs, a list's are all `li`. Then
    // same shape, which is what survives one of them being sponsored.
    const byTag = new Map<string, Element[]>();
    for (const child of children) {
      const group = byTag.get(child.tagName);
      if (group) group.push(child);
      else byTag.set(child.tagName, [child]);
    }

    for (const group of byTag.values()) {
      if (group.length < MIN_ITEMS) continue;
      const common = mode(group.map((element) => shape(element)));
      if (common.count < MIN_ITEMS) continue;

      const members = group
        .filter((element) => shape(element) === common.value)
        .filter((element) => isVisible(element))
        .filter((element) => textOf(element).length >= MIN_ITEM_TEXT);
      if (members.length < MIN_ITEMS) continue;

      const items = members.slice(0, MAX_ITEMS).map((element) => ({
        title: titleOf(element),
        lines: linesOf(element),
        href: hrefOf(element, base),
      }));

      const words = members.reduce((total, element) => total + textOf(element).length, 0);
      found.push({
        label: labelFor(container),
        items,
        score: members.length * Math.min(words / members.length, 400),
        container,
      });
    }
  }

  found.sort((a, b) => b.score - a.score);

  // One list per region. A grid nested inside another container matches twice,
  // and the two are the same list described at two depths.
  const kept: DetectedList[] = [];
  for (const candidate of found) {
    if (kept.some((other) => contains(other.container, candidate.container))) continue;
    kept.push(candidate);
    if (kept.length >= MAX_LISTS) break;
  }
  return kept;
}

function contains(outer: Element, inner: Element): boolean {
  return outer === inner || outer.contains(inner) || inner.contains(outer);
}

/** A name for the list, when the page gave its container one. */
function labelFor(container: Element): string | undefined {
  const labelled = container.getAttribute('aria-label');
  if (labelled?.trim()) return labelled.trim();
  const id = container.getAttribute('id');
  return id ? `list#${id}` : undefined;
}
