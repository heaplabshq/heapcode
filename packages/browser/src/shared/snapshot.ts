/**
 * What a page looks like to the model.
 *
 * The raw DOM never crosses this boundary. A mid-size page is 200k–2M
 * characters and the useful part is a few thousand tokens, so extraction
 * produces this structure and `formatSnapshot` renders it to the budgeted text
 * the model actually sees (PRD §4).
 *
 * Extraction needs a DOM; formatting does not. Keeping them apart is what lets
 * the ranking and truncation rules — the part that decides whether a 500KB page
 * costs 2k tokens or 40k — be tested without standing up a document.
 */

/** How the model addresses an element: `[3]`, never a CSS selector it invented. */
export type Handle = number;

export type ControlRole =
  | 'button'
  | 'link'
  | 'input'
  | 'textarea'
  | 'select'
  | 'checkbox'
  | 'radio';

export interface Control {
  handle: Handle;
  role: ControlRole;
  /** Accessible name — `aria-label` → text → placeholder → title → name. */
  name: string;
  value?: string;
  /** For select: the choices, so the model picks a real one. */
  options?: string[];
  href?: string;
  checked?: boolean;
  /**
   * Listed but not actionable. Kept in the snapshot because "the button is
   * there but greyed out" is the answer to a lot of questions, and hiding it
   * makes the model theorise about why it cannot find the thing it expects.
   */
  disabled?: boolean;
  /** Nearest heading or row, for controls whose own name is uninformative. */
  context?: string;
  /**
   * Submitting a form. Marked at extraction because it needs the DOM, and it
   * is one of the three signals that escalate an action to destructive: a
   * submit is the moment a page stops being reversible.
   */
  submits?: boolean;
  /** Inside a checkout, payment or order landmark. */
  checkout?: boolean;
  /**
   * A credential, one-time code, or payment field. The executor refuses to type
   * into these outright -- before the model's request is ever shown as a prompt
   * (PRD section 6.4) -- and extraction never reports their value.
   */
  sensitive?: boolean;
  /**
   * Higher survives truncation. Computed at extraction from viewport
   * proximity and landmark role; `formatSnapshot` may add an intent boost.
   */
  score: number;
}

export interface TableSummary {
  /** Present when the table has a stable id or accessible name. */
  label?: string;
  rows: number;
  columns: number;
  headers: string[];
  /** Leading rows, already truncated by the extractor. */
  sample: string[][];
}

export interface Viewport {
  width: number;
  height: number;
  scrollY: number;
  scrollHeight: number;
}

export interface PageSnapshot {
  url: string;
  title: string;
  viewport: Viewport;
  /** Readability-style main content, already stripped of chrome. */
  text: string;
  controls: Control[];
  tables: TableSummary[];
  /**
   * Which handle generation this is. Every mutating action or navigation mints
   * a new one and the old handles stop resolving, so acting on a stale handle
   * is a hard error rather than a click on whatever now occupies that index
   * (PRD §4.2).
   */
  generation: number;
}

export interface FormatOptions {
  /** Total character budget for the rendered snapshot. */
  budgetChars?: number;
  /**
   * The user's request. Controls whose name or context matches get a boost, so
   * "add the 16GB one to the cart" keeps the cart button when the page has
   * three hundred controls and room for forty.
   */
  intent?: string;
}

const DEFAULT_BUDGET_CHARS = 6_000;
/** The text block gets at most this share; controls are why we are here. */
const TEXT_SHARE = 0.5;

function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const cut = text.slice(0, limit);
  // Prefer a sentence or line boundary so the model is not handed half a word.
  const boundary = Math.max(cut.lastIndexOf('\n'), cut.lastIndexOf('. '));
  const kept = boundary > limit * 0.6 ? cut.slice(0, boundary + 1) : cut;
  return `${kept.trimEnd()}\n…[truncated]`;
}

/** Words worth matching on — short ones match everything and rank nothing. */
function intentTerms(intent: string): string[] {
  return [...new Set(intent.toLowerCase().match(/[a-z0-9]{3,}/g) ?? [])];
}

function intentBoost(control: Control, terms: string[]): number {
  if (terms.length === 0) return 0;
  const haystack = `${control.name} ${control.context ?? ''} ${control.value ?? ''}`.toLowerCase();
  const hits = terms.filter((term) => haystack.includes(term)).length;
  return hits === 0 ? 0 : 50 + hits * 10;
}

function renderControl(control: Control): string {
  const parts = [`[${control.handle}]`, control.role.padEnd(8), JSON.stringify(control.name)];
  if (control.value !== undefined) parts.push(`value=${JSON.stringify(control.value)}`);
  if (control.options?.length) parts.push(`options: ${control.options.join('|')}`);
  if (control.href) parts.push(`→ ${control.href}`);
  if (control.checked !== undefined) parts.push(control.checked ? 'checked' : 'unchecked');
  if (control.disabled) parts.push('DISABLED');
  if (control.context) parts.push(`(${control.context})`);
  return parts.join('  ');
}

function renderTable(table: TableSummary): string {
  const head = `${table.label ?? 'table'} ${table.rows} rows x ${table.columns} cols: ${table.headers.join(' | ')}`;
  const rows = table.sample.map((row) => `  ${row.join(' | ')}`);
  return [head, ...rows].join('\n');
}

/**
 * Render the snapshot to the text the model sees, inside `budgetChars`.
 *
 * Truncation is ranked, never head-first: the controls that survive the cut are
 * the ones nearest the viewport, inside the main landmark, or matching what the
 * user asked for. Head-truncating a page's control list reliably discards the
 * thing the user is pointing at, because the interesting controls are rarely
 * the first ones in document order.
 */
export function formatSnapshot(snapshot: PageSnapshot, options: FormatOptions = {}): string {
  const budget = options.budgetChars ?? DEFAULT_BUDGET_CHARS;
  const scrolled = snapshot.viewport.scrollHeight > 0
    ? Math.round((snapshot.viewport.scrollY / snapshot.viewport.scrollHeight) * 100)
    : 0;

  const header = [
    `URL: ${snapshot.url}`,
    `TITLE: ${snapshot.title}`,
    `VIEWPORT: ${snapshot.viewport.width}x${snapshot.viewport.height}, scrolled ${snapshot.viewport.scrollY}/${snapshot.viewport.scrollHeight} (${scrolled}%)`,
  ].join('\n');

  let remaining = budget - header.length;

  const textBudget = Math.max(0, Math.floor(remaining * TEXT_SHARE));
  const text = snapshot.text.trim().length > 0 ? truncate(snapshot.text.trim(), textBudget) : '';
  remaining -= text.length;

  const terms = options.intent ? intentTerms(options.intent) : [];
  const ranked = [...snapshot.controls].sort(
    (a, b) => b.score + intentBoost(b, terms) - (a.score + intentBoost(a, terms)),
  );

  const lines: string[] = [];
  let used = 0;
  let dropped = 0;
  for (const control of ranked) {
    const line = renderControl(control);
    if (used + line.length + 1 > remaining) {
      dropped++;
      continue;
    }
    lines.push(line);
    used += line.length + 1;
  }
  // Handles are the model's addressing scheme, so present them in index order
  // even though they were selected by rank — a list that jumps around is
  // harder to read back against the page.
  lines.sort((a, b) => Number(/\[(\d+)\]/.exec(a)?.[1]) - Number(/\[(\d+)\]/.exec(b)?.[1]));
  remaining -= used;

  const sections = [header];
  if (text) sections.push(`[TEXT]\n${text}`);
  if (lines.length > 0) {
    const note = dropped > 0 ? `\n…[${dropped} more control(s) not shown — scroll or filter to see them]` : '';
    sections.push(`[CONTROLS]\n${lines.join('\n')}${note}`);
  } else if (dropped > 0) {
    sections.push(`[CONTROLS]\n…[${dropped} control(s) not shown — no budget remaining]`);
  }

  const tableLines: string[] = [];
  for (const table of snapshot.tables) {
    const block = renderTable(table);
    if (block.length + 1 > remaining) break;
    tableLines.push(block);
    remaining -= block.length + 1;
  }
  if (tableLines.length > 0) sections.push(`[TABLES]\n${tableLines.join('\n')}`);

  return sections.join('\n\n');
}
