// The page as data: what `inspect` produces and fingerprints and matching read.
// No DOM types here — this half of @heapcode/page runs in Node too.

/**
 * The whole page, as a tree a program can walk.
 *
 * Not what the model sees. A real page is 200k–2M characters of markup, and
 * the snapshot a model reads is a budgeted few thousand tokens of it (see
 * heapbrowse's `shared/snapshot.ts`). This is the other thing: everything,
 * kept on the tester's side, so that healing can score every element against
 * a saved fingerprint and so the agent's DOM tools can drill into exactly the
 * branch they need. The model is shown slices of it, never all of it.
 *
 * Plain data — numbers, strings, arrays — because it crosses from the page to
 * Node through `page.evaluate`, which serialises by structured clone.
 */
export interface DomNode {
  /** Index into `DomTree.nodes`. Stable for one inspection only. */
  id: number;
  parent: number | null;
  children: number[];
  /** Lowercase tag name. */
  tag: string;
  /** Every attribute, values capped. `style` is dropped: it is noise for matching and huge. */
  attrs: Record<string, string>;
  /** The element's own text — its direct text-node children, not its descendants'. */
  text: string;
  role?: string;
  /** Accessible name, computed for elements that have a role. */
  name?: string;
  visible: boolean;
  /** Layout box in CSS pixels, page coordinates. Absent where there is no layout (jsdom). */
  rect?: Rect;
  /** Lives inside an open shadow root. */
  shadow?: true;
  /** Lives inside a same-origin iframe: that frame's URL. */
  frame?: string;
  /** Current value of a form field (never for password fields). */
  value?: string;
  checked?: boolean;
  disabled?: true;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface DomTree {
  url: string;
  title: string;
  nodes: DomNode[];
  /** Stopped at `maxNodes`; the tree is the first part of the document, in order. */
  truncated: boolean;
}

/** Test-id attributes, in the order a locator should prefer them. */
export const TEST_ID_ATTRS = ['data-testid', 'data-test-id', 'data-test', 'data-cy', 'data-qa'];

export function testIdOf(node: DomNode): { attr: string; value: string } | undefined {
  for (const attr of TEST_ID_ATTRS) {
    const value = node.attrs[attr];
    if (value) return { attr, value };
  }
  return undefined;
}

/** Roles a test acts on, as opposed to ones that only structure the page. */
export const INTERACTIVE_ROLES = new Set([
  'button',
  'link',
  'textbox',
  'searchbox',
  'checkbox',
  'radio',
  'combobox',
  'listbox',
  'option',
  'slider',
  'spinbutton',
  'switch',
  'tab',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'treeitem',
]);
