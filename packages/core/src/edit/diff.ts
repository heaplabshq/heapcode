/**
 * Unified-diff text between two versions of a file, for showing an edit's
 * actual effect (not just "Edited path.").
 *
 * This is a real line diff — Myers' O(ND) algorithm — and it used to not be.
 * The old version trimmed the common prefix and suffix and called everything
 * between them one changed block, on the reasoning that `edit_file` already
 * knows its change is one contiguous region. That reasoning does not survive
 * contact with the two callers that matter: `multi_edit` writes several
 * regions in one pass, and the web host diffs the *whole file* against its
 * checkpoint, so a file touched twice in a session had every untouched line
 * between the first and last edit printed as removed and then added again. A
 * twelve-line file with lines 2 and 11 changed reported ten removals and ten
 * additions instead of one and one — and those counts feed the `+n −n` badges
 * on tool chips, on the changed-file rows, and in the Changes header.
 *
 * Four surfaces render this string (the CLI's tools, the VS Code extension,
 * the web workspace panel, and the transcript chips), so it is worth being
 * right here rather than papering over it in any of them.
 */
export function unifiedDiff(oldText: string, newText: string, context = 2): string {
  const ops = diffLines(oldText.split('\n'), newText.split('\n'));
  return formatHunks(ops, context);
}

/** One line of the diff, before the lines are grouped into hunks. */
interface Op {
  sign: ' ' | '-' | '+';
  text: string;
}

/**
 * Beyond this many edits, stop looking for a minimal diff.
 *
 * Myers is O((N+M)·D), so it is fast exactly when D is small — which is what
 * an agent edit is. A wholesale rewrite is the case it cannot do cheaply, and
 * also the case where a minimal diff is worth least: "every line changed" is
 * the honest summary of a rewrite. The bound also caps the trace's memory,
 * which grows as D².
 */
const MAX_EDIT_DISTANCE = 1000;

/**
 * The diff, as a flat list of context/removed/added lines.
 *
 * The common prefix and suffix are trimmed first. That is not a shortcut past
 * the real algorithm, it is what makes it affordable: two versions of a file
 * usually differ in the middle, so trimming turns a 4,000-line comparison into
 * a 40-line one before Myers sees it.
 */
function diffLines(a: string[], b: string[]): Op[] {
  const maxCommon = Math.min(a.length, b.length);
  let prefix = 0;
  while (prefix < maxCommon && a[prefix] === b[prefix]) prefix++;

  let suffix = 0;
  const maxSuffix = maxCommon - prefix;
  while (suffix < maxSuffix && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) suffix++;

  const midA = a.slice(prefix, a.length - suffix);
  const midB = b.slice(prefix, b.length - suffix);

  // Past the bound, fall back to what this function used to always do: one
  // block of removals followed by one block of additions.
  const middle =
    myers(midA, midB) ??
    [
      ...midA.map((text): Op => ({ sign: '-', text })),
      ...midB.map((text): Op => ({ sign: '+', text })),
    ];

  return [
    ...a.slice(0, prefix).map((text): Op => ({ sign: ' ', text })),
    ...middle,
    ...a.slice(a.length - suffix).map((text): Op => ({ sign: ' ', text })),
  ];
}

/**
 * Myers' greedy shortest-edit-script search, with the trace kept so the path
 * can be walked back into a list of operations.
 *
 * Returns `undefined` when the two sides are further apart than
 * `MAX_EDIT_DISTANCE`, which the caller reads as "give up and print a block".
 */
function myers(a: string[], b: string[]): Op[] | undefined {
  const n = a.length;
  const m = b.length;
  if (n === 0 && m === 0) return [];
  if (n === 0) return b.map((text) => ({ sign: '+', text }));
  if (m === 0) return a.map((text) => ({ sign: '-', text }));

  const maxD = Math.min(n + m, MAX_EDIT_DISTANCE);
  // `k` runs over [-d, d] and the step reads k±1, so the array needs one slot
  // of margin on each side of ±maxD.
  const offset = maxD + 1;
  const v = new Int32Array(2 * maxD + 3);
  const trace: Int32Array[] = [];

  for (let d = 0; d <= maxD; d++) {
    // Snapshotted before the step, which is the state `backtrack` needs to
    // decide which way this step came from.
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      // Extend whichever neighbouring path is further along: down (an
      // insertion) or right (a deletion).
      const down = k === -d || (k !== d && v[k - 1 + offset]! < v[k + 1 + offset]!);
      let x = down ? v[k + 1 + offset]! : v[k - 1 + offset]! + 1;
      let y = x - k;
      // The snake: follow the diagonal as far as the lines keep matching.
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[k + offset] = x;
      if (x >= n && y >= m) return backtrack(trace, a, b, offset);
    }
  }
  return undefined;
}

/** Walks the trace back from (n, m) to the origin, collecting the operations. */
function backtrack(trace: Int32Array[], a: string[], b: string[], offset: number): Op[] {
  const ops: Op[] = [];
  let x = a.length;
  let y = b.length;

  for (let d = trace.length - 1; d >= 0; d--) {
    const v = trace[d]!;
    const k = x - y;
    const down = k === -d || (k !== d && v[k - 1 + offset]! < v[k + 1 + offset]!);
    const prevK = down ? k + 1 : k - 1;
    const prevX = v[prevK + offset]!;
    const prevY = prevX - prevK;

    while (x > prevX && y > prevY) {
      x--;
      y--;
      ops.push({ sign: ' ', text: a[x]! });
    }
    if (d > 0) {
      if (x === prevX) ops.push({ sign: '+', text: b[--y]! });
      else ops.push({ sign: '-', text: a[--x]! });
    }
    x = prevX;
    y = prevY;
  }

  return ops.reverse();
}

/**
 * Groups the changed lines into hunks with `context` lines around each, and
 * renders them.
 *
 * Two changes close enough that their context windows would touch are one
 * hunk: emitting `@@` twice with a single shared line between them says the
 * change is in two places when it is in one.
 */
function formatHunks(ops: Op[], context: number): string {
  const changed: number[] = [];
  for (let i = 0; i < ops.length; i++) if (ops[i]!.sign !== ' ') changed.push(i);
  if (changed.length === 0) return '';

  const groups: Array<[number, number]> = [];
  let from = changed[0]!;
  let to = changed[0]!;
  for (const i of changed.slice(1)) {
    if (i - to <= context * 2 + 1) to = i;
    else {
      groups.push([from, to]);
      from = to = i;
    }
  }
  groups.push([from, to]);

  const out: string[] = [];
  for (const [first, last] of groups) {
    const start = Math.max(0, first - context);
    const end = Math.min(ops.length - 1, last + context);

    // Lines consumed before this hunk decide where it starts. A hunk that
    // removes nothing is numbered from the line before it, which is what git
    // does and what makes `-0,0` impossible to misread as line zero.
    let oldBefore = 0;
    let newBefore = 0;
    for (let i = 0; i < start; i++) {
      if (ops[i]!.sign !== '+') oldBefore++;
      if (ops[i]!.sign !== '-') newBefore++;
    }

    let oldCount = 0;
    let newCount = 0;
    const body: string[] = [];
    for (let i = start; i <= end; i++) {
      const op = ops[i]!;
      if (op.sign !== '+') oldCount++;
      if (op.sign !== '-') newCount++;
      body.push(`${op.sign}${op.text}`);
    }

    const oldStart = oldCount === 0 ? oldBefore : oldBefore + 1;
    const newStart = newCount === 0 ? newBefore : newBefore + 1;
    out.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`, ...body);
  }
  return out.join('\n');
}
