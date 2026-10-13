import { accessibleName } from './accessibleName.js';
import { roleOf } from './role.js';
import { isVisible } from './visibility.js';

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

export interface InspectOptions {
  /** Default 20 000 — more than any sane app page, few enough to stay fast. */
  maxNodes?: number;
}

const SKIP = new Set(['script', 'style', 'noscript', 'template', 'meta', 'link', 'head']);
const MAX_ATTR = 200;
const MAX_TEXT = 200;

/**
 * Read the document into a `DomTree`. Runs in the page.
 *
 * `elements` receives the live element for each node id, so a caller in the
 * page can act on "node 412" after the agent picked it — see `browserEntry.ts`.
 */
export function inspect(doc: Document, options: InspectOptions = {}, elements: Element[] = []): DomTree {
  const maxNodes = options.maxNodes ?? 20_000;
  const nodes: DomNode[] = [];
  let truncated = false;

  const visit = (element: Element, parent: number | null, where: { shadow?: true; frame?: string }): void => {
    if (nodes.length >= maxNodes) {
      truncated = true;
      return;
    }
    const tag = element.tagName.toLowerCase();
    if (SKIP.has(tag)) return;

    const node = describe(element, nodes.length, parent, where);
    nodes.push(node);
    elements.push(element);
    if (parent !== null) nodes[parent]!.children.push(node.id);

    // An svg's insides are drawing instructions, not things a test points at.
    if (tag === 'svg') return;

    for (const child of Array.from(element.children)) visit(child, node.id, where);
    const root = (element as HTMLElement).shadowRoot;
    if (root) for (const child of Array.from(root.children)) visit(child, node.id, { ...where, shadow: true });
    if (tag === 'iframe') {
      const inner = sameOriginDocument(element as HTMLIFrameElement);
      if (inner?.documentElement) visit(inner.documentElement, node.id, { ...where, frame: inner.URL });
    }
  };

  if (doc.documentElement) visit(doc.documentElement, null, {});
  return { url: doc.URL, title: doc.title, nodes, truncated };
}

function describe(element: Element, id: number, parent: number | null, where: { shadow?: true; frame?: string }): DomNode {
  const attrs: Record<string, string> = {};
  for (const attr of Array.from(element.attributes)) {
    if (attr.name === 'style') continue;
    attrs[attr.name] = attr.value.slice(0, MAX_ATTR);
  }
  const node: DomNode = {
    id,
    parent,
    children: [],
    tag: element.tagName.toLowerCase(),
    attrs,
    text: ownText(element),
    // isVisible's instanceof checks are against this realm's classes, and an
    // iframe's elements belong to the frame's realm — so frames get the same
    // test written realm-free.
    visible: where.frame ? frameVisible(element) : isVisible(element),
  };
  const role = roleOf(element);
  if (role) {
    node.role = role;
    const name = accessibleName(element);
    if (name) node.name = name;
  }
  const rect = layout(element);
  if (rect) node.rect = rect;
  if (where.shadow) node.shadow = true;
  if (where.frame) node.frame = where.frame;

  // By tag, not instanceof, for the same realm reason.
  if (node.tag === 'input') {
    const input = element as HTMLInputElement;
    if (input.type === 'checkbox' || input.type === 'radio') node.checked = input.checked;
    else if (input.type !== 'password') node.value = input.value.slice(0, MAX_ATTR);
  } else if (node.tag === 'textarea' || node.tag === 'select') {
    node.value = (element as HTMLTextAreaElement).value.slice(0, MAX_ATTR);
  }
  if ((element as HTMLButtonElement).disabled === true || element.getAttribute('aria-disabled') === 'true') {
    node.disabled = true;
  }
  return node;
}

function frameVisible(element: Element): boolean {
  if (element.closest('[hidden], [inert], [aria-hidden="true"]')) return false;
  const style = element.ownerDocument.defaultView?.getComputedStyle(element);
  if (style && (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0)) return false;
  return true;
}

function ownText(element: Element): string {
  let text = '';
  for (const child of Array.from(element.childNodes)) {
    if (child.nodeType === 3) text += child.textContent ?? '';
  }
  return text.replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT);
}

function layout(element: Element): Rect | undefined {
  const r = element.getBoundingClientRect();
  // jsdom: no layout at all. Absent rather than a fake zero box, so matching
  // does not treat every element as sitting in the same place.
  if (r.width === 0 && r.height === 0 && r.top === 0 && r.left === 0) return undefined;
  const view = element.ownerDocument.defaultView;
  return {
    x: Math.round(r.left + (view?.scrollX ?? 0)),
    y: Math.round(r.top + (view?.scrollY ?? 0)),
    w: Math.round(r.width),
    h: Math.round(r.height),
  };
}

function sameOriginDocument(frame: HTMLIFrameElement): Document | null {
  try {
    return frame.contentDocument;
  } catch {
    return null;
  }
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
