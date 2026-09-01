import { useMemo, useState } from 'react';

/**
 * A unified diff, as a gutter and a body.
 *
 * Renders the host's `unifiedDiff()` output rather than computing a diff in
 * the browser: the host already has both sides in memory (the checkpoint's
 * original plus the file on disk), and a second diff implementation would be
 * a second answer to "what changed".
 *
 * Used in two places, deliberately the same component: the Changes tab, and the
 * body of an `edit_file`/`write_file` tool chip. Those chips used to render
 * their result as plain `<pre>` text, so the diff the agent just made was a
 * wall of grey with `+` and `-` characters in it — while the CLI coloured the
 * same string green and red (ink/ToolChip.tsx) and the panel two inches to the
 * right coloured it too. One renderer is what keeps those three consistent.
 *
 * Three things the plain colouring did not do:
 *
 * - **Line numbers**, read off each `@@` header. Now that the host emits a
 *   real line diff there is more than one hunk to place, and "which line" is
 *   the first question anyone asks of a diff.
 * - **The marker in the gutter**, not in the text. Selecting a diff used to
 *   copy `+`- and `-`-prefixed lines, which is never what you want to paste.
 *   The gutter is `user-select: none`, so a selection yields the code.
 * - **What changed inside the line.** A one-character edit painted the whole
 *   line red and the whole replacement green, leaving the reader to spot the
 *   difference themselves.
 */
export function DiffView({ diff }: { diff: string }): JSX.Element {
  const rows = useMemo(() => parse(diff), [diff]);
  const [expanded, setExpanded] = useState(false);
  const shown = expanded ? rows : rows.slice(0, COLLAPSE_ABOVE);

  // Wide enough for the largest number in this diff and no wider, so a
  // 40-line file does not carry a five-column gutter.
  const digits = rows.reduce((n, r) => Math.max(n, String(r.newNo ?? r.oldNo ?? '').length), 1);

  return (
    <div className="diff" style={{ ['--diff-no' as string]: `${digits}ch` }}>
      {shown.map((row, i) => (
        <DiffRow key={i} row={row} />
      ))}
      {!expanded && rows.length > COLLAPSE_ABOVE && (
        <button className="diff-more" onClick={() => setExpanded(true)}>
          Show all {rows.length} lines
        </button>
      )}
    </div>
  );
}

/**
 * Past this many lines the rest is behind a click.
 *
 * Not for looks: the component builds an element per line, so a 4,000-line
 * rewrite built 4,000 of them inside a chip that is clamped to 420px tall and
 * shows about twenty.
 */
const COLLAPSE_ABOVE = 300;

function DiffRow({ row }: { row: Row }): JSX.Element {
  if (row.kind === 'hunk' || row.kind === 'meta') {
    return <div className={`diff-line diff-${row.kind}`}>{row.text || ' '}</div>;
  }
  const sign = row.kind === 'add' ? '+' : row.kind === 'del' ? '−' : ' ';
  return (
    <div className={`diff-line diff-${row.kind}`}>
      <span className="diff-no" aria-hidden="true">
        {row.oldNo ?? ''}
      </span>
      <span className="diff-no" aria-hidden="true">
        {row.newNo ?? ''}
      </span>
      <span className="diff-sign" aria-hidden="true">
        {sign}
      </span>
      <span className="diff-text">
        {row.segments
          ? row.segments.map((s, i) =>
              s.changed ? (
                <mark className="diff-word" key={i}>
                  {s.text}
                </mark>
              ) : (
                <span key={i}>{s.text}</span>
              ),
            )
          : row.text || ' '}
      </span>
    </div>
  );
}

/** A stretch of a line, and whether it differs from the line it replaced. */
interface Segment {
  text: string;
  changed: boolean;
}

interface Row {
  kind: 'hunk' | 'meta' | 'context' | 'add' | 'del';
  /** Without the leading `+`/`-`/space — that lives in the gutter now. */
  text: string;
  oldNo?: number;
  newNo?: number;
  /** Set only where there is a counterpart line to compare against. */
  segments?: Segment[];
}

/** Captures both line numbers, so each row can be placed in both files. */
const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

function parse(diff: string): Row[] {
  const rows: Row[] = [];
  let oldNo = 0;
  let newNo = 0;
  // `edit_file` prefixes its diff with a plain sentence, and the `---`/`+++`
  // headers come before the first hunk. Neither has a line number, so nothing
  // is numbered until a hunk header says where we are.
  let inHunk = false;

  for (const line of diff.split('\n')) {
    const header = HUNK_HEADER.exec(line);
    if (header) {
      oldNo = Number(header[1]);
      newNo = Number(header[2]);
      inHunk = true;
      rows.push({ kind: 'hunk', text: line });
    } else if (!inHunk || line.startsWith('+++') || line.startsWith('---')) {
      rows.push({ kind: 'meta', text: line });
    } else if (line.startsWith('+')) {
      rows.push({ kind: 'add', text: line.slice(1), newNo: newNo++ });
    } else if (line.startsWith('-')) {
      rows.push({ kind: 'del', text: line.slice(1), oldNo: oldNo++ });
    } else {
      rows.push({ kind: 'context', text: line.slice(1), oldNo: oldNo++, newNo: newNo++ });
    }
  }

  markChangedWords(rows);
  return rows;
}

/**
 * Marks what actually differs inside each replaced line.
 *
 * A run of removed lines followed by added ones is one replacement, so the
 * n-th removal is compared with the n-th addition. Anything left over is a
 * pure insertion or deletion, which has no counterpart to narrow it down
 * against — those stay wholly marked, which is the truth about them.
 */
function markChangedWords(rows: Row[]): void {
  for (let i = 0; i < rows.length; i++) {
    if (rows[i]!.kind !== 'del' && rows[i]!.kind !== 'add') continue;
    let end = i;
    while (end < rows.length && (rows[end]!.kind === 'del' || rows[end]!.kind === 'add')) end++;

    const block = rows.slice(i, end);
    const removed = block.filter((r) => r.kind === 'del');
    const added = block.filter((r) => r.kind === 'add');
    for (let p = 0; p < Math.min(removed.length, added.length); p++) {
      comparePair(removed[p]!, added[p]!);
    }
    i = end - 1;
  }
}

/** Words, punctuation and runs of whitespace, each its own token. */
const TOKEN = /\s+|[A-Za-z0-9_$]+|[^\sA-Za-z0-9_$]/g;

/**
 * Trims the tokens the two lines share at each end and marks the rest.
 *
 * Token-level rather than character-level: `1` → `42` should mark the number,
 * not the digit they happen to share.
 */
function comparePair(del: Row, add: Row): void {
  const a = del.text.match(TOKEN) ?? [];
  const b = add.text.match(TOKEN) ?? [];

  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  ) {
    tail++;
  }
  if (head === 0 && tail === 0) return; // nothing in common: the line is simply different

  const split = (tokens: string[]): Segment[] =>
    [
      { text: tokens.slice(0, head).join(''), changed: false },
      { text: tokens.slice(head, tokens.length - tail).join(''), changed: true },
      { text: tokens.slice(tokens.length - tail).join(''), changed: false },
    ].filter((s) => s.text.length > 0);

  const delSegments = split(a);
  const addSegments = split(b);
  // When nearly the whole line is marked the marks are noise: they say "this
  // line changed", which the colour already said.
  if (marked(delSegments) > 0.75 * del.text.length && marked(addSegments) > 0.75 * add.text.length) {
    return;
  }
  del.segments = delSegments;
  add.segments = addSegments;
}

function marked(segments: Segment[]): number {
  return segments.reduce((n, s) => (s.changed ? n + s.text.length : n), 0);
}

/** A `unifiedDiff()` hunk header — the one shape that is unambiguously a diff. */
const HUNK_RE = /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/;

/**
 * True when `text` contains a diff hunk.
 *
 * Checks every line, not just the first: `edit_file` and `multi_edit` prefix
 * their diff with a plain "Edited path." line. Same test the CLI uses
 * (ink/ToolChip.tsx), so the two hosts agree on what counts as a diff.
 */
export function isDiffText(text: string): boolean {
  return text.split('\n').some((line) => HUNK_RE.test(line));
}

/**
 * Added/removed line counts for a diff, for the chip's `+n −n` badge.
 *
 * Counted from the diff body only — lines before the first hunk header are the
 * tool's own prose ("Edited src/foo.ts.") and file headers, and counting a
 * `--- a/foo` as a removal is how a one-line edit ends up claiming two.
 */
export function diffStats(text: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  let inHunk = false;
  for (const line of text.split('\n')) {
    if (HUNK_RE.test(line)) {
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+')) added++;
    else if (line.startsWith('-')) removed++;
  }
  return { added, removed };
}
