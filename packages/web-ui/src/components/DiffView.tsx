/**
 * A unified diff, colourised.
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
 */
export function DiffView({ diff }: { diff: string }): JSX.Element {
  const lines = diff.split('\n');
  return (
    <pre className="diff">
      {lines.map((line, i) => (
        <div key={i} className={`diff-line ${classOf(line)}`}>
          {line || ' '}
        </div>
      ))}
    </pre>
  );
}

function classOf(line: string): string {
  if (line.startsWith('@@')) return 'diff-hunk';
  // Check the ---/+++ file headers before the bare +/- cases, or they colour
  // as an added and a removed line.
  if (line.startsWith('+++') || line.startsWith('---')) return 'diff-meta';
  if (line.startsWith('+')) return 'diff-add';
  if (line.startsWith('-')) return 'diff-del';
  return '';
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
