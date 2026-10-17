import { NoteError } from './errors.js';
import { normalizeTagName } from './parse.js';

/**
 * Bear's search syntax: words, `"exact phrases"`,
 * `-excluded` words, `#tags` (subtags included) and `@tokens`, all combined
 * with AND. Any term can be negated with a leading `-`.
 */
export interface SearchQuery {
  /** Words and phrases every result must contain. Phrases keep their spaces. */
  terms: { text: string; phrase: boolean }[];
  excludeTerms: { text: string; phrase: boolean }[];
  tags: string[];
  excludeTags: string[];
  /** Match words against titles only (`@title`). */
  titleOnly: boolean;
  filters: Filter[];
}

export type Flag =
  | 'todo'
  | 'done'
  | 'task'
  | 'tagged'
  | 'untagged'
  | 'pinned'
  | 'images'
  | 'files'
  | 'attachments'
  | 'code'
  | 'wikilinks'
  | 'backlinks';

export type Filter =
  | { kind: 'flag'; flag: Flag; negate: boolean }
  /** A date range on `modified` or `created`, as epoch ms, `[from, to)`. */
  | { kind: 'date'; field: 'modified' | 'created'; from?: number; to?: number; negate: boolean };

const FLAGS: Record<string, Flag> = {
  todo: 'todo',
  done: 'done',
  task: 'task',
  tasks: 'task',
  tagged: 'tagged',
  untagged: 'untagged',
  pinned: 'pinned',
  images: 'images',
  files: 'files',
  attachments: 'attachments',
  code: 'code',
  wikilinks: 'wikilinks',
  backlinks: 'backlinks',
};

export function parseQuery(input: string, now: Date = new Date()): SearchQuery {
  const q: SearchQuery = { terms: [], excludeTerms: [], tags: [], excludeTags: [], titleOnly: false, filters: [] };
  for (const raw of tokenize(input)) {
    const negate = raw.negate;
    const t = raw.text;
    if (raw.quoted) {
      (negate ? q.excludeTerms : q.terms).push({ text: t, phrase: true });
      continue;
    }
    if (t.startsWith('#') && t.length > 1) {
      const name = normalizeTagName(t.replace(/^#|#$/g, '')).toLowerCase();
      if (name) (negate ? q.excludeTags : q.tags).push(name);
      continue;
    }
    if (t.startsWith('@') && t.length > 1) {
      const token = t.slice(1).toLowerCase();
      if (token === 'title') {
        q.titleOnly = true;
        continue;
      }
      const flag = FLAGS[token];
      if (flag) {
        q.filters.push({ kind: 'flag', flag, negate });
        continue;
      }
      const date = parseDateToken(token, now);
      if (date) {
        q.filters.push({ ...date, negate });
        continue;
      }
      throw new NoteError('invalid_argument', `Unknown search token ${t}. Known: @today, @yesterday, @last7days, @date(…), @ctoday, @created7days, @cdate(…), @todo, @done, @task, @tagged, @untagged, @title, @pinned, @images, @files, @attachments, @code, @wikilinks, @backlinks.`);
    }
    (negate ? q.excludeTerms : q.terms).push({ text: t, phrase: false });
  }
  return q;
}

interface RawToken {
  text: string;
  quoted: boolean;
  negate: boolean;
}

/** Split on whitespace, keeping `"…"`, `#multi word#` and `@date(…)` whole. */
function tokenize(input: string): RawToken[] {
  const out: RawToken[] = [];
  let i = 0;
  while (i < input.length) {
    while (i < input.length && /\s/.test(input[i]!)) i++;
    if (i >= input.length) break;
    let negate = false;
    if (input[i] === '-' && i + 1 < input.length && !/\s/.test(input[i + 1]!)) {
      negate = true;
      i++;
    }
    if (input[i] === '"') {
      const close = input.indexOf('"', i + 1);
      const end = close === -1 ? input.length : close;
      const text = input.slice(i + 1, end).trim();
      if (text) out.push({ text, quoted: true, negate });
      i = end + 1;
      continue;
    }
    let end = i;
    if (input[i] === '#') {
      // `#multi word tag#`: closed by a `#` that ends a word.
      const close = input.indexOf('#', i + 1);
      if (close > i + 1 && /\s/.test(input.slice(i + 1, close)) && (close + 1 >= input.length || /\s/.test(input[close + 1]!))) {
        out.push({ text: input.slice(i, close + 1), quoted: false, negate });
        i = close + 1;
        continue;
      }
    }
    if (input[i] === '@') {
      const paren = /^@[a-z]+\([^)]*\)/i.exec(input.slice(i));
      if (paren) {
        out.push({ text: paren[0], quoted: false, negate });
        i += paren[0].length;
        continue;
      }
    }
    while (end < input.length && !/\s/.test(input[end]!)) end++;
    out.push({ text: input.slice(i, end), quoted: false, negate });
    i = end;
  }
  return out;
}

function parseDateToken(token: string, now: Date): Omit<Extract<Filter, { kind: 'date' }>, 'negate'> | null {
  const today = startOfDay(now);
  const day = (field: 'modified' | 'created', from: number, to: number) => ({ kind: 'date' as const, field, from, to });

  let m = /^(c?)(today|yesterday)$/.exec(token);
  if (m) {
    const field = m[1] ? 'created' : 'modified';
    return m[2] === 'today' ? day(field, today, shift(today, 1)) : day(field, shift(today, -1), today);
  }
  // @last7days / @created7days, any number of days, today included.
  m = /^(last|created)(\d{1,4})days?$/.exec(token);
  if (m) {
    const field = m[1] === 'created' ? 'created' : 'modified';
    const n = Math.max(1, Number(m[2]));
    return { kind: 'date', field, from: shift(today, -(n - 1)) };
  }
  m = /^(c?)date\(\s*(<=|>=|<|>)?\s*(\d{4}-\d{2}-\d{2})\s*\)$/.exec(token);
  if (m) {
    const field = m[1] ? 'created' : 'modified';
    const d = localDay(m[3]!);
    if (d === null) throw new NoteError('invalid_argument', `@${token}: not a date. Use YYYY-MM-DD.`);
    switch (m[2]) {
      case '<':
        return { kind: 'date', field, to: d };
      case '<=':
        return { kind: 'date', field, to: shift(d, 1) };
      case '>':
        return { kind: 'date', field, from: shift(d, 1) };
      case '>=':
        return { kind: 'date', field, from: d };
      default:
        return day(field, d, shift(d, 1));
    }
  }
  return null;
}

function startOfDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** Midnight `days` calendar days away — not `± 24h`, which drifts across DST. */
function shift(dayStart: number, days: number): number {
  const d = new Date(dayStart);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + days).getTime();
}

function localDay(iso: string): number | null {
  const [y, mo, d] = iso.split('-').map(Number) as [number, number, number];
  const date = new Date(y, mo - 1, d);
  if (date.getFullYear() !== y || date.getMonth() !== mo - 1 || date.getDate() !== d) return null;
  return date.getTime();
}
