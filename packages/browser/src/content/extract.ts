import type { Control, ControlRole, PageSnapshot, TableSummary } from '../shared/snapshot.js';
import { accessibleName, nearestContext } from './accessibleName.js';
import { isDisabled, isVisible, positionScore } from './visibility.js';
import type { HandleRegistry } from './registry.js';
import { namesSensitiveField } from '../shared/sensitive.js';

/**
 * The DOM walk: a live page in, a `PageSnapshot` out.
 *
 * Takes the document rather than reading a global so it can be driven by jsdom
 * in tests. Nothing here formats text for the model — that is `formatSnapshot`,
 * deliberately kept on the other side of a DOM-free boundary.
 */

const CONTROL_SELECTOR = [
  'a[href]',
  'button',
  'input',
  'select',
  'textarea',
  '[role="button"]',
  '[role="link"]',
  '[role="checkbox"]',
  '[role="tab"]',
  '[contenteditable="true"]',
].join(',');

/** Elements that are structurally present but never page content. */
const NON_CONTENT = 'script,style,noscript,template,svg,head';

/** Plus the page furniture that is content but never the content in question. */
const SKIP_FOR_TEXT = `${NON_CONTENT},nav,footer,[role="navigation"],[role="contentinfo"],aside`;

const MAX_CONTROLS = 300;
const MAX_TABLE_SAMPLE_ROWS = 5;
const MAX_TABLES = 5;

function roleOf(element: Element): ControlRole | undefined {
  const explicit = element.getAttribute('role');
  if (explicit === 'checkbox') return 'checkbox';
  if (explicit === 'link') return 'link';
  if (explicit === 'button' || explicit === 'tab') return 'button';

  if (element instanceof HTMLAnchorElement) return 'link';
  if (element instanceof HTMLButtonElement) return 'button';
  if (element instanceof HTMLSelectElement) return 'select';
  if (element instanceof HTMLTextAreaElement) return 'textarea';
  if (element instanceof HTMLInputElement) {
    switch (element.type) {
      case 'checkbox':
        return 'checkbox';
      case 'radio':
        return 'radio';
      case 'button':
      case 'submit':
      case 'reset':
      case 'image':
        return 'button';
      case 'hidden':
        return undefined;
      default:
        return 'input';
    }
  }
  if (element.getAttribute('contenteditable') === 'true') return 'textarea';
  return undefined;
}

/**
 * A control's current value — except where reading it would be a leak.
 *
 * Password and payment field contents are never put in the snapshot. The
 * executor refuses to *type* into them (PRD §6.4), but reading is the same
 * exposure by a different route: the snapshot is sent to whatever endpoint the
 * user configured, so a password manager's autofill would otherwise be
 * transmitted verbatim.
 */
function isSensitive(element: Element): boolean {
  if (element instanceof HTMLInputElement && element.type === 'password') return true;
  return namesSensitiveField(
    element.getAttribute('name'),
    element.getAttribute('id'),
    element.getAttribute('autocomplete'),
    element.getAttribute('placeholder'),
    element.getAttribute('aria-label'),
    accessibleName(element),
  );
}

/** Landmarks where an action is far more likely to cost money. */
const CHECKOUT_SCOPE =
  '[id*="checkout" i],[class*="checkout" i],[id*="payment" i],[class*="payment" i],' +
  '[id*="cart" i],[class*="cart" i],form[action*="order" i],form[action*="pay" i]';

function isSubmit(element: Element): boolean {
  if (element instanceof HTMLButtonElement) {
    // A <button> inside a form defaults to type=submit.
    return element.type === 'submit' && element.form !== null;
  }
  if (element instanceof HTMLInputElement) {
    return (element.type === 'submit' || element.type === 'image') && element.form !== null;
  }
  return false;
}

function valueOf(element: Element): string | undefined {
  if (element instanceof HTMLInputElement) {
    if (element.type === 'password') return '[hidden]';
    if (element.type === 'checkbox' || element.type === 'radio') return undefined;
    if (isSensitive(element)) return element.value ? '[hidden]' : '';
    return element.value;
  }
  if (element instanceof HTMLTextAreaElement) return element.value;
  if (element instanceof HTMLSelectElement) return element.value;
  return undefined;
}

function extractControls(doc: Document, registry: HandleRegistry): Control[] {
  const controls: Control[] = [];
  for (const element of doc.querySelectorAll(CONTROL_SELECTOR)) {
    const role = roleOf(element);
    if (!role) continue;
    if (!isVisible(element)) continue;

    const name = accessibleName(element);
    const disabled = isDisabled(element);
    // An unnamed control with no context cannot be referred to or reasoned
    // about; it is noise that costs budget a named control could have used.
    const context = nearestContext(element);
    if (!name && !context) continue;

    const control: Control = {
      handle: registry.add(element),
      role,
      name,
      score: positionScore(element),
    };

    const value = valueOf(element);
    if (value !== undefined) control.value = value;
    if (context && context !== name) control.context = context;
    if (disabled) control.disabled = true;
    if (isSubmit(element)) control.submits = true;
    if (element.closest(CHECKOUT_SCOPE)) control.checkout = true;
    if ((role === 'input' || role === 'textarea') && isSensitive(element)) control.sensitive = true;

    if (element instanceof HTMLAnchorElement) control.href = element.getAttribute('href') ?? undefined;
    if (element instanceof HTMLSelectElement) {
      control.options = [...element.options].slice(0, 20).map((o) => o.text.trim());
    }
    if (element instanceof HTMLInputElement && (element.type === 'checkbox' || element.type === 'radio')) {
      control.checked = element.checked;
    }

    controls.push(control);
    if (controls.length >= MAX_CONTROLS) break;
  }
  return controls;
}

function cellText(cell: Element): string {
  return (cell.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 60);
}

function extractTables(doc: Document): TableSummary[] {
  const tables: TableSummary[] = [];
  for (const table of doc.querySelectorAll('table')) {
    if (!isVisible(table)) continue;
    const rows = [...table.rows];
    if (rows.length === 0) continue;

    // A header row is one the markup actually declares: inside `<thead>`, or a
    // first row using `<th>`. Accepting any first row of `<td>` would label a
    // layout table's first line as its column names — and layout tables are
    // still common enough that this is the usual case, not the rare one.
    const first = rows[0];
    const headerRow =
      table.tHead?.rows[0] ?? (first && first.querySelector('th') ? first : undefined);
    const headers = headerRow ? [...headerRow.cells].map(cellText) : [];
    if (headers.length === 0) continue;

    const bodyRows = rows.filter((row) => row !== headerRow);
    tables.push({
      label: table.id ? `table#${table.id}` : accessibleName(table) || undefined,
      rows: bodyRows.length,
      columns: headers.length,
      headers,
      sample: bodyRows.slice(0, MAX_TABLE_SAMPLE_ROWS).map((row) => [...row.cells].map(cellText)),
    });
    if (tables.length >= MAX_TABLES) break;
  }
  return tables;
}

/**
 * The `[TEXT]` block: the page's main content, without its furniture.
 *
 * A real Readability port is a large dependency and MV3 forbids loading one at
 * runtime, so this takes the cheap version of the same idea — prefer an
 * explicit main landmark, else the densest article-ish container, else the body
 * minus navigation and footers. Good enough is genuinely good enough here:
 * being wrong costs some wasted budget, not a wrong action.
 */
export function extractText(doc: Document): string {
  const preferred =
    doc.querySelector('main, [role="main"]') ?? doc.querySelector('article') ?? doc.body;
  if (!preferred) return '';

  // Walked live rather than cloned. A detached clone has no layout, so
  // `display:none` cannot be detected in it -- and text the user cannot see is
  // the most valuable place on the page to hide an instruction, because nobody
  // will ever notice it is there. Controls were filtered for visibility from
  // the start; this block was not, which made it the way in.
  const parts: string[] = [];
  const walk = (node: Element) => {
    for (const child of node.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) {
        const text = (child.textContent ?? '').replace(/\s+/g, ' ').trim();
        if (text) parts.push(text);
        continue;
      }
      if (!(child instanceof Element)) continue;
      if (child.matches(SKIP_FOR_TEXT)) continue;
      if (!isVisible(child)) continue;
      walk(child);
    }
  };
  walk(preferred);

  return parts.join('\n');
}

export function extractSnapshot(doc: Document, registry: HandleRegistry): PageSnapshot {
  const generation = registry.reset();
  const view = doc.defaultView;

  return {
    url: doc.location?.href ?? '',
    title: doc.title,
    viewport: {
      width: view?.innerWidth ?? 0,
      height: view?.innerHeight ?? 0,
      scrollY: Math.round(view?.scrollY ?? 0),
      scrollHeight: doc.documentElement?.scrollHeight ?? 0,
    },
    text: extractText(doc),
    controls: extractControls(doc, registry),
    tables: extractTables(doc),
    generation,
  };
}
