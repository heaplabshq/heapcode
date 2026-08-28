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
 * What one item says, reading only what is actually on screen.
 *
 * One walk for all three answers, and every branch of it checked for
 * visibility. Pages keep a great deal of text in the DOM that nobody can see --
 * collapsed panels, offscreen carousels, templates, and, the case that produced
 * this: a hidden error placeholder inside every card. Amazon puts "An error
 * occurred, please try again in a moment" in each wish-list item against the
 * day it needs it, and reading the DOM without looking at what is rendered made
 * that the name of all fifty rows.
 *
 * The check is on the way down and short-circuits: a hidden container costs one
 * test, not one per element inside it. `textContent` is deliberately not used
 * for the lines, because it cannot tell a rendered string from a waiting one.
 */
function readItem(element: Element, base: string): ListItem {
  const lines: string[] = [];
  let heading: string | undefined;
  let longestLink = '';
  let described = '';
  let href: string | undefined;

  const walk = (node: Element) => {
    if (lines.length >= MAX_LINES) return;
    if (!isVisible(node)) return;

    // `innerText` would be the right tool and does not exist outside a
    // rendering engine, so this reproduces the part that matters: a block's own
    // words, kept apart from its children's. Without the separation a card
    // collapses to one run-on string and the price is glued to the title.
    let own = '';
    for (const child of node.childNodes) {
      if (child.nodeType === 3) own += child.nodeValue ?? '';
    }
    const cleaned = own.replace(/\s+/g, ' ').trim();
    if (cleaned) lines.push(cleaned);

    if (!heading && /^H[1-6]$/.test(node.tagName)) {
      const text = textOf(node);
      if (text.length >= 3) heading = text;
    } else if (!heading && node.getAttribute('role') === 'heading') {
      const text = textOf(node);
      if (text.length >= 3) heading = text;
    }

    /*
     * The name a card carries in an attribute rather than in text.
     *
     * A product card names itself in its image's `alt` -- that is what alt text
     * is for, so it is both reliably present and reliably correct -- and often
     * again in a `title`. Worth reading because the visible name is the part
     * that fails: a card whose title has not rendered yet, or has been replaced
     * by an error placeholder, still has both. The accessibility tree gets this
     * for free, since Chrome computes an image's name from its alt; this is the
     * content-script path catching up.
     */
    const described_ = node.getAttribute('alt') ?? node.getAttribute('title') ?? '';
    const cleanedDescription = described_.replace(/\s+/g, ' ').trim();
    if (cleanedDescription.length > described.length) described = cleanedDescription;

    if (node.tagName === 'A') {
      const text = textOf(node);
      // The card's title is a link to the thing; the other links on it are
      // "add to basket" and "compare", which are shorter.
      if (text.length > longestLink.length) longestLink = text;
      const raw = node.getAttribute('href');
      if (!href && raw && !raw.startsWith('#') && !raw.startsWith('javascript:')) {
        try {
          href = new URL(raw, base).toString();
        } catch {
          href = raw;
        }
      }
    }

    for (const child of node.children) walk(child);
  };
  walk(element);

  return {
    title:
      heading ??
      (longestLink.length >= 3 ? longestLink : undefined) ??
      (described.length >= 3 ? described : undefined),
    lines,
    href,
  };
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
  /*
   * Candidates carry their elements, not their contents.
   *
   * Reading an item is the expensive half -- a visibility test per node, on
   * every node of every card -- and a page offers far more candidate groups
   * than it has lists. Everything below scores and discards on cheap signals,
   * and only what survives is actually read.
   */
  const found: (Omit<DetectedList, 'items'> & { members: Element[] })[] = [];
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

      const words = members.reduce((total, element) => total + textOf(element).length, 0);
      found.push({
        label: labelFor(container),
        members: members.slice(0, MAX_ITEMS),
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
    kept.push({
      label: candidate.label,
      container: candidate.container,
      score: candidate.score,
      items: candidate.members.map((element) => readItem(element, base)),
    });
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
