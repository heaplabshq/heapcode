import { readFrontMatter } from './frontMatter.js';

/**
 * What Heapnotes needs to know about a note's Markdown, found in one pass.
 *
 * Not a renderer — the editor renders. This finds the structure the index,
 * search and the edit commands work on: headings, tags, wiki links, tasks and
 * attachments, each with its offset so a rename can rewrite it in place.
 *
 * The grammar is CommonMark's block structure with Bear's choices:
 * ATX headings only (no setext), fenced code only
 * (no indented code), no lazy continuation. Those three are what make a
 * line-by-line scan exact rather than approximate.
 *
 * Every offset is a UTF-16 index into the whole file, front matter included.
 */
export interface ParsedNote {
  frontMatter: Record<string, unknown>;
  /** Where the body starts, past any front matter. */
  bodyStart: number;
  /** First non-blank body line, heading marks stripped. Empty for an empty note. */
  title: string;
  /** Just past the title line and its line break; `bodyStart` for an empty note. */
  titleEnd: number;
  /** A line or two of lead text after the title, markup stripped — the note list's preview. */
  subtitle: string;
  headings: Heading[];
  tags: TagRef[];
  wikiLinks: WikiLink[];
  /** `[text](target)` and `![alt](target)` whose target is a file in the vault, not a URL. */
  localLinks: LocalLink[];
  todoOpen: number;
  todoDone: number;
  hasCode: boolean;
  hasImages: boolean;
  hasFiles: boolean;
  words: number;
}

export interface Heading {
  level: number;
  text: string;
  /** Start of the heading's line. */
  start: number;
  /** End of the heading's line, before its line break. */
  lineEnd: number;
}

export interface TagRef {
  /** As written, without the `#`s: `Work/Q3`, `multi word`. */
  name: string;
  /** Span of the whole token, `#`s included. */
  start: number;
  end: number;
}

export interface WikiLink {
  target: string;
  heading?: string;
  alias?: string;
  /** `![[…]]` — Obsidian's embed form. */
  embed: boolean;
  start: number;
  end: number;
}

export interface LocalLink {
  /** Decoded path, as written relative to the note. */
  path: string;
  image: boolean;
  start: number;
  end: number;
}

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
const TASK = /^\s*(?:>\s*)*(?:[-*+]|\d+[.)])[ \t]+\[([ xX])\](?=\s|$)/;
const IMAGE_EXT = /\.(?:png|jpe?g|gif|webp|svg|bmp|tiff?|heic|avif)$/i;
const URL_SCHEME = /^[a-z][a-z0-9+.-]*:/i;

export function parseNote(text: string): ParsedNote {
  const fm = readFrontMatter(text);
  const out: ParsedNote = {
    frontMatter: fm.data,
    bodyStart: fm.end,
    title: '',
    titleEnd: fm.end,
    subtitle: '',
    headings: [],
    tags: [],
    wikiLinks: [],
    localLinks: [],
    todoOpen: 0,
    todoDone: 0,
    hasCode: false,
    hasImages: false,
    hasFiles: false,
    words: 0,
  };

  let fence: { char: string; length: number } | null = null;
  const leadLines: string[] = [];
  let titleFound = false;

  for (const { line, start } of lines(text, fm.end)) {
    if (fence) {
      const close = FENCE.exec(line);
      if (
        close &&
        close[1]![0] === fence.char &&
        close[1]!.length >= fence.length &&
        line.slice(close[0].length).trim() === ''
      ) {
        fence = null;
      }
      continue;
    }
    const open = FENCE.exec(line);
    // A backtick fence's info string can't contain a backtick — otherwise
    // ``` `inline` ``` at the start of a line would swallow the rest of the note.
    if (open && !(open[1]![0] === '`' && line.slice(open[0].length).includes('`'))) {
      fence = { char: open[1]![0]!, length: open[1]!.length };
      out.hasCode = true;
      continue;
    }

    out.words += countWords(line);
    const heading = HEADING.exec(line);
    if (heading) {
      out.headings.push({
        level: heading[1]!.length,
        text: (heading[2] ?? '').trim(),
        start,
        lineEnd: start + line.length,
      });
    }
    const task = TASK.exec(line);
    if (task) {
      if (task[1] === ' ') out.todoOpen++;
      else out.todoDone++;
    }

    scanInline(line, start, out);

    if (!titleFound) {
      if (line.trim() !== '') {
        titleFound = true;
        out.title = heading ? (heading[2] ?? '').trim() : line.trim();
        out.titleEnd = lineEndWithBreak(text, start + line.length);
      }
    } else if (
      leadLines.length < 2 &&
      line.trim() !== '' &&
      !heading &&
      !isTagOnly(line, start, out.tags)
    ) {
      leadLines.push(line);
    }
  }

  out.title = plain(out.title).slice(0, 200);
  out.subtitle = leadLines.map(plain).join(' ').slice(0, 160);
  out.hasImages =
    out.localLinks.some((l) => l.image) ||
    out.wikiLinks.some((w) => w.embed && IMAGE_EXT.test(w.target));
  out.hasFiles =
    out.localLinks.some((l) => !l.image) ||
    out.wikiLinks.some(
      (w) => w.embed && !IMAGE_EXT.test(w.target) && /\.[a-z0-9]{1,5}$/i.test(w.target),
    );
  return out;
}

/** Each line from `from` on, with its start offset, line break excluded. */
export function* lines(text: string, from = 0): Generator<{ line: string; start: number }> {
  let start = from;
  while (start <= text.length) {
    let end = text.indexOf('\n', start);
    if (end === -1) end = text.length;
    let line = text.slice(start, end);
    if (line.endsWith('\r')) line = line.slice(0, -1);
    yield { line, start };
    if (end === text.length) return;
    start = end + 1;
  }
}

/** A line that is nothing but tags — Bear's tag line under the title — isn't preview text. */
function isTagOnly(line: string, start: number, tags: TagRef[]): boolean {
  let rest = line;
  for (const t of tags) {
    if (t.start >= start && t.end <= start + line.length)
      rest =
        rest.slice(0, t.start - start) + ' '.repeat(t.end - t.start) + rest.slice(t.end - start);
  }
  return rest.trim() === '';
}

function lineEndWithBreak(text: string, at: number): number {
  if (text.startsWith('\r\n', at)) return at + 2;
  if (text[at] === '\n') return at + 1;
  return at;
}

function scanInline(line: string, lineStart: number, out: ParsedNote): void {
  // Blank out what can't hold a tag or link — code spans, then URLs — with
  // spaces, so every offset into `masked` is still an offset into `line`.
  let masked = maskCodeSpans(line);
  if (masked !== line) out.hasCode = true;

  const wiki = /(!?)\[\[([^[\]\n]+?)\]\]/g;
  for (let m = wiki.exec(masked); m; m = wiki.exec(masked)) {
    const inner = m[2]!.replace(/\\\|/g, '|');
    const bar = inner.indexOf('|');
    const ref = (bar >= 0 ? inner.slice(0, bar) : inner).trim();
    const alias = bar >= 0 ? inner.slice(bar + 1).trim() : undefined;
    const hash = ref.indexOf('#');
    const target = (hash >= 0 ? ref.slice(0, hash) : ref).trim();
    const heading = hash >= 0 ? ref.slice(hash + 1).trim() : undefined;
    if (target) {
      out.wikiLinks.push({
        target,
        ...(heading ? { heading } : {}),
        ...(alias ? { alias } : {}),
        embed: m[1] === '!',
        start: lineStart + m.index,
        end: lineStart + m.index + m[0].length,
      });
    }
    masked = blank(masked, m.index, m.index + m[0].length);
  }

  const link = /(!?)\[([^\]\n]*)\]\(\s*(<[^>\n]*>|[^)\s]+)(?:\s+(?:"[^"\n]*"|'[^'\n]*'))?\s*\)/g;
  for (let m = link.exec(masked); m; m = link.exec(masked)) {
    let target = m[3]!;
    if (target.startsWith('<')) target = target.slice(1, -1);
    if (
      !URL_SCHEME.test(target) &&
      !target.startsWith('#') &&
      !target.startsWith('/') &&
      target !== ''
    ) {
      out.localLinks.push({
        path: safeDecode(target),
        image: m[1] === '!',
        start: lineStart + m.index,
        end: lineStart + m.index + m[0].length,
      });
    }
    // Only the target goes: a tag in a link's text is still a tag.
    const targetAt = m.index + m[0].indexOf('](') + 1;
    masked = blank(masked, targetAt, m.index + m[0].length);
  }
  masked = masked.replace(/<[a-z][a-z0-9+.-]*:[^>\s]*>|\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, (s) =>
    ' '.repeat(s.length),
  );

  for (const tag of findTags(masked)) {
    out.tags.push({ name: tag.name, start: lineStart + tag.start, end: lineStart + tag.end });
  }
}

/**
 * Bear's tag forms: `#tag`, `#parent/child`, and `#multi word tag#`. A tag
 * starts a line or follows whitespace, so `## Heading`, `a#b` and URL
 * fragments are not tags; it needs one non-digit, so `#1` is an issue number.
 */
export function findTags(line: string): { name: string; start: number; end: number }[] {
  const found: { name: string; start: number; end: number }[] = [];
  for (let i = 0; i < line.length; i++) {
    if (line[i] !== '#') continue;
    if (i > 0 && !/\s/.test(line[i - 1]!)) continue;
    const next = line[i + 1];
    if (next === undefined || /\s|#/.test(next)) continue;

    // The closed form wins when it fits: `#multi word#` ends at a `#` that
    // ends a word, and holds no `#` of its own.
    const close = line.indexOf('#', i + 1);
    if (close > i + 1) {
      const inner = line.slice(i + 1, close);
      const after = line[close + 1];
      if (
        !/^\s|\s$/.test(inner) &&
        (after === undefined || /[\s.,;:!?)]/.test(after)) &&
        isTagName(inner)
      ) {
        found.push({ name: normalizeTagName(inner), start: i, end: close + 1 });
        i = close;
        continue;
      }
    }

    let j = i + 1;
    while (j < line.length && !/[\s#,;:!?()[\]{}"'<>|*~=`]/.test(line[j]!)) j++;
    let name = line.slice(i + 1, j);
    const trimmed = name.replace(/[./-]+$/, '');
    j -= name.length - trimmed.length;
    name = trimmed;
    if (name && !name.startsWith('/') && isTagName(name))
      found.push({ name: normalizeTagName(name), start: i, end: j });
    i = j - 1;
  }
  return found;
}

function isTagName(s: string): boolean {
  return /[^\d/\s]/.test(s) && !/[[\]]/.test(s) && !/^\d+$/.test(s.replace(/\//g, ''));
}

export function normalizeTagName(s: string): string {
  return s
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/\/{2,}/g, '/')
    .replace(/^\/|\/$/g, '');
}

/** How a tag is written back: closed form when it has a space. */
export function formatTag(name: string): string {
  return /\s/.test(name) ? `#${name}#` : `#${name}`;
}

/**
 * CommonMark code spans: a run of N backticks up to the next run of exactly
 * N. Replaced with spaces, delimiters included.
 */
export function maskCodeSpans(line: string): string {
  let out = line;
  const open = /`+/g;
  for (let m = open.exec(line); m; m = open.exec(line)) {
    const run = m[0];
    const close = new RegExp(`(?<!\`)${run}(?!\`)`, 'g');
    close.lastIndex = m.index + run.length;
    const c = close.exec(line);
    if (!c) continue;
    out = blank(out, m.index, c.index + run.length);
    open.lastIndex = c.index + run.length;
  }
  return out;
}

function blank(s: string, from: number, to: number): string {
  return s.slice(0, from) + ' '.repeat(to - from) + s.slice(to);
}

function countWords(line: string): number {
  return line.match(/[\p{L}\p{N}][\p{L}\p{N}'’_-]*/gu)?.length ?? 0;
}

/** Markup stripped for a one-line preview. */
function plain(s: string): string {
  return s
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2')
    .replace(/\[\[([^\]]+)\]\]/g, '$1')
    .replace(/^\s*(?:>\s*)*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/, '')
    .replace(/^\s*>\s*/, '')
    .replace(/(\*\*|__|~~|==|`|\*|~)(?=\S)(.+?)(?<=\S)\1/g, '$2')
    .replace(/(^|\W)_(?=\S)(.+?)(?<=\S)_(?=\W|$)/g, '$1$2')
    .replace(/\s+/g, ' ')
    .trim();
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}
