import type { Control, ControlRole, PageSnapshot, TableSummary } from '../shared/snapshot.js';
import { namesSensitiveField } from '../shared/sensitive.js';

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

    const value = str(node.value);
    if (value) {
      // The same rule the DOM path applies: a credential never enters the
      // snapshot, because the snapshot goes to the configured endpoint.
      control.value = namesSensitiveField(name, description) ? '[hidden]' : value;
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

  return tables;
}
