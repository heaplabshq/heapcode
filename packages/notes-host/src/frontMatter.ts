import { isCollection, isMap, parseDocument } from 'yaml';
import { NoteError } from './errors.js';

/**
 * YAML front matter: a first line of exactly `---`, then YAML, then a line of
 * `---` (or `...`). Heapnotes keeps its own metadata here — `id`, `created`,
 * `pinned`, `archived`, `trashed` — beside whatever the note already had, so
 * a vault stays a folder other tools can open.
 */
export interface FrontMatter {
  /** Parsed keys. Empty when there is no block, or when its YAML is broken. */
  data: Record<string, unknown>;
  /** Offset where the body starts: just past the closing fence's line break. 0 with no block. */
  end: number;
  /** The block is there but isn't a YAML mapping — never rewritten, only read around. */
  invalid: boolean;
  present: boolean;
  /** The YAML between the fences, as written. */
  yaml: string;
}

const OPEN = /^\uFEFF?---[ \t]*\r?\n/;
const CLOSE = /^(?:---|\.\.\.)[ \t]*$/m;

export function readFrontMatter(text: string): FrontMatter {
  const open = OPEN.exec(text);
  if (!open) return { data: {}, end: 0, invalid: false, present: false, yaml: '' };
  const rest = text.slice(open[0].length);
  const close = CLOSE.exec(rest);
  if (!close) return { data: {}, end: 0, invalid: false, present: false, yaml: '' };
  let end = open[0].length + close.index + close[0].length;
  if (text.startsWith('\r\n', end)) end += 2;
  else if (text[end] === '\n') end += 1;
  const yaml = rest.slice(0, close.index);
  const block = { end, present: true, yaml };
  try {
    const doc = parseDocument(yaml);
    if (doc.errors.length > 0) return { ...block, data: {}, invalid: true };
    const value: unknown = doc.toJS();
    if (value === null || value === undefined) return { ...block, data: {}, invalid: false };
    if (typeof value !== 'object' || Array.isArray(value))
      return { ...block, data: {}, invalid: true };
    return { ...block, data: value as Record<string, unknown>, invalid: false };
  } catch {
    return { ...block, data: {}, invalid: true };
  }
}

/**
 * Set or remove keys (`undefined` removes), keeping every other key, its
 * order and its comments. A block that ends up empty is dropped, so pinning
 * and unpinning a note that had none leaves the file as it was.
 */
export function updateFrontMatter(text: string, patch: Record<string, unknown>): string {
  const fm = readFrontMatter(text);
  if (fm.invalid) {
    throw new NoteError(
      'bad_front_matter',
      "This note's front matter isn't valid YAML, so Heapnotes won't rewrite it. Fix it by hand first.",
    );
  }
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const body = text.slice(fm.end);
  const doc = parseDocument(fm.yaml);
  if (!isMap(doc.contents)) doc.contents = doc.createNode({}) as never;
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) {
      doc.delete(key);
      continue;
    }
    // `tags: [a, b]` stays on one line when its items change.
    const before = doc.get(key, true);
    const node = doc.createNode(value);
    if (isCollection(before) && isCollection(node)) node.flow = before.flow;
    doc.set(key, node);
  }
  const map = doc.contents;
  if (!isMap(map) || map.items.length === 0) return body;
  let yaml = doc.toString({ lineWidth: 0 });
  if (!yaml.endsWith('\n')) yaml += '\n';
  if (eol === '\r\n') yaml = yaml.replace(/\r?\n/g, '\r\n');
  return `---${eol}${yaml}---${eol}${body}`;
}
