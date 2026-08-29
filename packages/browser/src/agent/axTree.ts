import type { Control, ControlRole, PageSnapshot, TableSummary } from '../shared/snapshot.js';
import { tableFromList, type ListItem } from '../shared/listTable.js';
import { namesSensitiveField } from '../shared/sensitive.js';
import type { PageFacts } from './domFacts.js';

/**
 * The page as the browser itself understands it.
 *
 * This is what CDP buys. Every heuristic in `src/content/` is an estimate of
 * something the browser has already computed exactly, and the estimates are
 * where the per-site breakage came from:
 *
 *   - `ignored` covers `display:none`, `visibility:hidden`, `aria-hidden`,
 *     zero-size, and — the one that cost a whole session — everything behind an
 *     open modal, which the browser marks inert without being asked.
 *   - `name` is the real accessible name, computed by the full AccName
 *     algorithm rather than my shortened version of it.
 *   - `role` is the computed role, so a div behaving as a button is a button.
 *   - `disabled`, `checked`, `expanded` come from the browser's own state.
 *
 * The tree is also *smaller* than the DOM by construction: presentational
 * wrappers are not in it. That is budget spent on things the model can act on.
 */

/** One node of `Accessibility.getFullAXTree`. */
interface AxValue {
  type?: string;
  value?: unknown;
}

interface AxProperty {
  name: string;
  value?: AxValue;
}

export interface AxNode {
  nodeId: string;
  /**
   * Which embedded frame this node came from, when it is not the page itself.
   *
   * Set while merging the per-frame trees. It reaches the model as the control's
   * context, because "Accept" in a consent frame and "Accept" on the page are
   * different buttons and the difference is not visible from the name.
   */
  frameLabel?: string;
  ignored?: boolean;
  role?: AxValue;
  name?: AxValue;
  value?: AxValue;
  description?: AxValue;
  properties?: AxProperty[];
  childIds?: string[];
  backendDOMNodeId?: number;
}

/** AX roles worth offering as something to act on, mapped to our vocabulary. */
const ACTIONABLE: Record<string, ControlRole> = {
  button: 'button',
  link: 'link',
  textbox: 'input',
  searchbox: 'input',
  combobox: 'select',
  listbox: 'select',
  checkbox: 'checkbox',
  radio: 'radio',
  switch: 'checkbox',
  menuitem: 'button',
  menuitemcheckbox: 'checkbox',
  menuitemradio: 'radio',
  tab: 'button',
  spinbutton: 'input',
  slider: 'input',
};

/** Roles whose text is page content rather than a control's own label. */
const TEXT_ROLES = new Set(['StaticText', 'staticText', 'paragraph', 'heading', 'text']);

function str(value: AxValue | undefined): string {
  return typeof value?.value === 'string' ? value.value.trim() : '';
}

function prop(node: AxNode, name: string): unknown {
  return node.properties?.find((p) => p.name === name)?.value?.value;
}

/**
 * Node ids of everything inside a focusable-blocking modal.
 *
 * Chrome already marks inert subtrees `ignored`, so this is belt and braces for
 * the case where a site builds its own overlay without `inert` — the modal is
 * then still in the tree, and so is the page behind it.
 */
function modalScope(nodes: AxNode[], byId: Map<string, AxNode>): Set<string> | undefined {
  // Only a modal in the page itself scopes the snapshot. A dialog inside an
  // embedded frame blocks that frame, not the page, and letting one scope
  // everything would hide the whole page behind an advert's own overlay.
  const modal = nodes.find(
    (node) =>
      !node.ignored &&
      !node.frameLabel &&
      prop(node, 'modal') === true &&
      str(node.role) === 'dialog',
  );
  if (!modal) return undefined;

  const inside = new Set<string>();
  const walk = (id: string) => {
    if (inside.has(id)) return;
    inside.add(id);
    for (const child of byId.get(id)?.childIds ?? []) walk(child);
  };
  walk(modal.nodeId);
  return inside;
}

export interface AxSnapshotInput {
  nodes: AxNode[];
  url: string;
  title: string;
  viewport: PageSnapshot['viewport'];
  generation: number;
  /** Things about the read rather than the page — chiefly unreadable frames. */
  notes?: string[];
  /** Assigns a handle and remembers how to reach the node again. */
  register(node: AxNode): number;
  /**
   * The markup facts the accessibility tree does not carry.
   *
   * Absent when the driver could not read them, which is reported as
   * `signals: 'partial'` rather than passed off as a page with nothing
   * dangerous on it. See `domFacts.ts`.
   */
  facts?: PageFacts;
}

/** Build a `PageSnapshot` from an accessibility tree. */
export function snapshotFromAxTree(input: AxSnapshotInput): PageSnapshot {
  const { nodes } = input;
  const byId = new Map(nodes.map((node) => [node.nodeId, node]));
  const scope = modalScope(nodes, byId);

  const controls: Control[] = [];
  const textParts: string[] = [];
  let order = 0;

  for (const node of nodes) {
    if (node.ignored) continue;
    if (scope && !scope.has(node.nodeId)) continue;

    const role = str(node.role);
    order++;

    if (TEXT_ROLES.has(role)) {
      const text = str(node.name) || str(node.value);
      if (text) textParts.push(text);
      continue;
    }

    const mapped = ACTIONABLE[role];
    if (!mapped) continue;
    if (node.backendDOMNodeId === undefined) continue;

    const name = str(node.name) || str(node.description);
    const description = str(node.description);
    if (!name && !description) continue;

    const control: Control = {
      handle: input.register(node),
      role: mapped,
      name,
      // Earlier in the tree is earlier on the page. Without box models this is
      // the ranking signal available in one round trip; the DOM driver's
      // viewport proximity is better, and this is the trade for one call.
      score: Math.max(0, 1000 - order),
    };

    if (description && description !== name) control.context = description.slice(0, 80);
    if (node.frameLabel) {
      control.context = control.context
        ? `in frame ${node.frameLabel}: ${control.context}`
        : `in frame ${node.frameLabel}`;
      // A frame's controls rank below the page's own. They matter — a consent
      // dialog blocks everything behind it — but on a page with hundreds of
      // controls the user is usually pointing at the page, not the advert.
      control.score = Math.max(0, control.score - 50);
    }
    if (prop(node, 'disabled') === true) control.disabled = true;
    if (typeof prop(node, 'checked') === 'boolean') control.checked = prop(node, 'checked') as boolean;

    // What the markup says about this element, which the tree does not. Without
    // it `submits`, `checkout` and `sensitive` are all absent, and absent reads
    // to every guardrail downstream as "no".
    const facts = input.facts?.for(node.backendDOMNodeId);
    // Read but not found is not the same as read and unremarkable. An
    // out-of-process iframe is absent from the markup snapshot entirely, and
    // its controls must not be judged as though they had been checked.
    if (input.facts && !input.facts.knows(node.backendDOMNodeId)) {
      control.unknownSignals = true;
    }
    if (facts?.submits) control.submits = true;
    if (facts?.checkout) control.checkout = facts.checkout;
    if (facts?.autocomplete) control.autocomplete = facts.autocomplete;
    if (facts?.href) control.href = facts.href;

    // The name is a signal in its own right and the only one available when the
    // markup could not be read, so it is checked either way -- a box labelled
    // "Password" is a password box whether or not its input carries the type.
    const sensitive =
      facts?.sensitive === true ||
      ((mapped === 'input' || mapped === 'textarea') && namesSensitiveField(name, description));
    if (sensitive) control.sensitive = true;

    const value = str(node.value);
    if (value) {
      // The same rule the DOM path applies: a credential never enters the
      // snapshot, because the snapshot goes to the configured endpoint.
      control.value = sensitive || namesSensitiveField(name, description) ? '[hidden]' : value;
    }

    controls.push(control);
  }

  return {
    url: input.url,
    title: scope ? `${input.title} — dialog open` : input.title,
    viewport: input.viewport,
    text: textParts.join('\n'),
    controls,
    tables: tablesFromAxTree(nodes, byId, scope),
    generation: input.generation,
    notes: input.notes?.length ? input.notes : undefined,
    signals: input.facts ? 'full' : 'partial',
  };
}

const MAX_SAMPLE_ROWS = 5;
const MAX_TABLES = 5;
/** Every row, for `extract_data`. Never rendered into a prompt. */
const MAX_TABLE_ROWS = 200;

function tablesFromAxTree(
  nodes: AxNode[],
  byId: Map<string, AxNode>,
  scope: Set<string> | undefined,
): TableSummary[] {
  const tables: TableSummary[] = [];

  for (const node of nodes) {
    if (node.ignored || str(node.role) !== 'table') continue;
    if (scope && !scope.has(node.nodeId)) continue;

    const rows: AxNode[] = [];
    const collect = (id: string) => {
      const child = byId.get(id);
      if (!child || child.ignored) return;
      if (str(child.role) === 'row') rows.push(child);
      for (const grandchild of child.childIds ?? []) collect(grandchild);
    };
    for (const child of node.childIds ?? []) collect(child);
    if (rows.length === 0) continue;

    const cellsOf = (row: AxNode) =>
      (row.childIds ?? [])
        .map((id) => byId.get(id))
        .filter((cell): cell is AxNode => !!cell && !cell.ignored)
        .map((cell) => str(cell.name).slice(0, 60));

    const headerRow = rows.find((row) =>
      (row.childIds ?? []).some((id) => str(byId.get(id)?.role) === 'columnheader'),
    );
    const headers = headerRow ? cellsOf(headerRow) : [];
    if (headers.length === 0) continue;

    const body = rows.filter((row) => row !== headerRow);
    tables.push({
      label: str(node.name) || undefined,
      rows: body.length,
      columns: headers.length,
      headers,
      sample: body.slice(0, MAX_SAMPLE_ROWS).map(cellsOf),
      body: body.slice(0, MAX_TABLE_ROWS).map(cellsOf),
    });
    if (tables.length >= MAX_TABLES) break;
  }

  for (const list of listsFromAxTree(nodes, byId, scope)) {
    if (tables.length >= MAX_TABLES) break;
    const table = tableFromList(list.items, list.label);
    if (table) tables.push(table);
  }

  return tables;
}

/** Fewer than this is a coincidence, not a list. */
const MIN_LIST_ITEMS = 3;
/** An item saying less than this is a spacer, an icon or a divider. */
const MIN_ITEM_TEXT = 20;
const MAX_LISTS = 2;
const MAX_LIST_ITEMS = 200;

/**
 * The repeated block a page uses instead of a table, in the accessibility tree.
 *
 * The same idea as the content script's version and necessarily a different
 * implementation: this side has roles rather than tags, and no elements to ask
 * about visibility -- Chrome has already dropped what is not there. Grouping is
 * on the set of roles inside an item, which is what stays the same across a
 * sponsored result and an ordinary one while the class names do not.
 *
 * There is no Link column here. The accessibility tree names a link and does
 * not carry its address, and inventing one from the name would be worse than
 * leaving it out.
 */
function listsFromAxTree(
  nodes: AxNode[],
  byId: Map<string, AxNode>,
  scope: Set<string> | undefined,
): { label?: string; items: ListItem[]; score: number; covers: string[] }[] {
  /**
   * Walk through a node, whether or not it counts as content.
   *
   * `ignored` is not "not there" -- it is "carries no meaning of its own", and
   * Chrome marks every generic wrapper that way. A real results grid is several
   * such wrappers deep, so a traversal that stops at the first one finds every
   * item empty, drops them all for having no text, and reports no list. That is
   * exactly what happened on Amazon: the content-script path found the grid and
   * this one found nothing, because this one is the one with an accessibility
   * tree full of ignored scaffolding in it.
   *
   * So structure and content are separated: everything is walked through, and
   * only named nodes are read.
   */
  const within = (id: string): AxNode | undefined => {
    const node = byId.get(id);
    if (!node) return undefined;
    if (scope && !scope.has(id)) return undefined;
    return node;
  };

  /** The roles inside a node, order-independent and depth-limited. */
  const shape = (node: AxNode, depth = 3): string => {
    const roles = new Set<string>();
    const walk = (current: AxNode, left: number) => {
      for (const id of current.childIds ?? []) {
        const child = within(id);
        if (!child) continue;
        // Scaffolding is walked through but does not describe the shape: two
        // cards that differ only in how many wrappers Chrome collapsed are the
        // same card.
        if (!child.ignored) roles.add(str(child.role));
        if (left > 1) walk(child, left - 1);
      }
    };
    walk(node, depth);
    return [...roles].sort().join(',');
  };

  /** Every piece of text inside a node, in order. */
  const linesOf = (node: AxNode): string[] => {
    const lines: string[] = [];
    const walk = (current: AxNode) => {
      if (lines.length >= 40) return;
      const name = str(current.name);
      if (!current.ignored && name && TEXT_ROLES.has(str(current.role))) lines.push(name);
      for (const id of current.childIds ?? []) {
        const child = within(id);
        if (child) walk(child);
      }
    };
    walk(node);
    return lines;
  };

  const titleOf = (node: AxNode): string | undefined => {
    let heading: string | undefined;
    let longestLink = '';
    const walk = (current: AxNode) => {
      const role = str(current.role);
      const name = str(current.name);
      if (!current.ignored) {
        if (!heading && role === 'heading' && name) heading = name;
        if (role === 'link' && name.length > longestLink.length) longestLink = name;
      }
      for (const id of current.childIds ?? []) {
        const child = within(id);
        if (child) walk(child);
      }
    };
    walk(node);
    return heading ?? (longestLink.length >= 3 ? longestLink : undefined);
  };

  const found: { label?: string; items: ListItem[]; score: number; covers: string[] }[] = [];

  for (const parent of nodes) {
    // A grid's own container is very often ignored scaffolding too.
    if (scope && !scope.has(parent.nodeId)) continue;
    const children = (parent.childIds ?? [])
      .map(within)
      .filter((child): child is AxNode => child !== undefined);
    if (children.length < MIN_LIST_ITEMS) continue;

    // Grouped on role *and* whether the node is scaffolding, so a run of
    // ignored wrappers each holding one card still groups together -- which is
    // the shape a real results grid arrives in.
    const byRole = new Map<string, AxNode[]>();
    for (const child of children) {
      const role = child.ignored ? 'generic' : str(child.role);
      const group = byRole.get(role);
      if (group) group.push(child);
      else byRole.set(role, [child]);
    }

    for (const group of byRole.values()) {
      if (group.length < MIN_LIST_ITEMS) continue;
      const shapes = group.map((node) => shape(node));
      const counts = new Map<string, number>();
      for (const value of shapes) counts.set(value, (counts.get(value) ?? 0) + 1);
      let common = { value: '', count: 0 };
      for (const [value, count] of counts) if (count > common.count) common = { value, count };
      if (common.count < MIN_LIST_ITEMS) continue;

      const members = group.filter((node, index) => shapes[index] === common.value);
      const items = members
        .slice(0, MAX_LIST_ITEMS)
        .map((node) => ({ title: titleOf(node), lines: linesOf(node) }))
        .filter((item) => item.lines.join(' ').length >= MIN_ITEM_TEXT);
      if (items.length < MIN_LIST_ITEMS) continue;

      const words = items.reduce((total, item) => total + item.lines.join(' ').length, 0);
      found.push({
        label: parent.ignored ? undefined : str(parent.name) || undefined,
        items,
        score: items.length * Math.min(words / items.length, 400),
        covers: members.flatMap((node) => subtree(node)),
      });
    }
  }

  found.sort((a, b) => b.score - a.score);

  /*
   * One list per region.
   *
   * Now that scaffolding is walked through rather than stopped at, a grid
   * matches at every wrapper depth it is nested in -- and those matches are the
   * same list described three times over. Kept by best score; a candidate built
   * from nodes an earlier one already covers is that same list again.
   */
  const kept: typeof found = [];
  const taken = new Set<string>();
  for (const candidate of found) {
    const overlap = candidate.covers.filter((id) => taken.has(id)).length;
    if (overlap > candidate.covers.length / 2) continue;
    for (const id of candidate.covers) taken.add(id);
    kept.push(candidate);
    if (kept.length >= MAX_LISTS) break;
  }
  return kept;

  /** Every node id under this one, so overlap between candidates is visible. */
  function subtree(node: AxNode): string[] {
    const ids: string[] = [];
    const walk = (current: AxNode) => {
      ids.push(current.nodeId);
      for (const id of current.childIds ?? []) {
        const child = within(id);
        if (child) walk(child);
      }
    };
    walk(node);
    return ids;
  }
}
