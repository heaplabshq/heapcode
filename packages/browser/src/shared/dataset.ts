import type { TableSummary } from './snapshot.js';

/**
 * Rows the agent has collected, accumulated across pages.
 *
 * The thing multi-page work was missing. Asked to compare fifty listings across
 * five pages, the agent had to carry every row it had already seen in its own
 * transcript — so page five was reasoned about alongside four pages of text it
 * was re-sending on every turn, and by the third page the context was mostly a
 * copy of pages one and two. It got slower and worse as the task went on, which
 * is the wrong direction.
 *
 * The rows live here instead. `extract_data` appends to this and tells the model
 * only the count and what is new; the accumulated set goes to the panel, where
 * the user can read it and export it, and is never re-sent to the model at all.
 *
 * The user gets the table. The model gets a receipt.
 */

export interface Dataset {
  /** The column headers this set is keyed on. */
  headers: string[];
  rows: string[][];
  /** Which pages contributed, in order, so a row's origin is recoverable. */
  sources: string[];
  label?: string;
}

/** Headers are the same set if they read the same, ignoring case and padding. */
function sameShape(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((header, index) => header.trim().toLowerCase() === b[index]?.trim().toLowerCase());
}

/** A row's identity for de-duplication: its cells, exactly. */
function rowKey(row: string[]): string {
  return JSON.stringify(row.map((cell) => cell.trim()));
}

export interface MergeResult {
  dataset: Dataset;
  added: number;
  duplicates: number;
  /**
   * True when the incoming table had different columns, so the old rows were
   * dropped rather than mixed in. Reported rather than silently handled: two
   * tables with different columns are two datasets, and quietly concatenating
   * them produces a file with values under the wrong headings.
   */
  restarted: boolean;
}

export function mergeTable(
  existing: Dataset | undefined,
  table: TableSummary,
  source: string,
): MergeResult {
  const incoming = table.sample.map((row) => row.map((cell) => cell.trim()));

  if (!existing || !sameShape(existing.headers, table.headers)) {
    const seen = new Set<string>();
    const rows: string[][] = [];
    for (const row of incoming) {
      const key = rowKey(row);
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push(row);
    }
    return {
      dataset: {
        headers: table.headers,
        rows,
        sources: [source],
        label: table.label,
      },
      added: rows.length,
      duplicates: incoming.length - rows.length,
      restarted: existing !== undefined,
    };
  }

  const seen = new Set(existing.rows.map(rowKey));
  const rows = [...existing.rows];
  let added = 0;
  for (const row of incoming) {
    const key = rowKey(row);
    // Pagination overlaps constantly -- a "load more" that re-renders the list,
    // a page 2 that repeats the last item of page 1. Without this the exported
    // file has the same listing three times and the comparison is wrong.
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push(row);
    added++;
  }

  return {
    dataset: {
      ...existing,
      rows,
      sources: existing.sources.includes(source) ? existing.sources : [...existing.sources, source],
    },
    added,
    duplicates: incoming.length - added,
    restarted: false,
  };
}

/** RFC 4180 quoting: a cell with a comma, a quote or a newline must be quoted. */
function csvCell(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export function toCsv(dataset: Dataset): string {
  return [dataset.headers, ...dataset.rows].map((row) => row.map(csvCell).join(',')).join('\r\n');
}

/** Objects rather than arrays: the headers are the point of having them. */
export function toJson(dataset: Dataset): string {
  const objects = dataset.rows.map((row) =>
    Object.fromEntries(dataset.headers.map((header, index) => [header, row[index] ?? ''])),
  );
  return JSON.stringify(objects, null, 2);
}

/** A filename that says what it is and when, and is safe on every platform. */
export function suggestedFilename(dataset: Dataset, extension: 'csv' | 'json'): string {
  const base = (dataset.label ?? 'heapbrowse-data')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
  const stamp = new Date().toISOString().slice(0, 10);
  return `${base || 'heapbrowse-data'}-${stamp}.${extension}`;
}
