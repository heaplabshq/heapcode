import { describe, expect, it } from 'vitest';
import { diffStats, isDiffText } from '../src/components/DiffView.js';

/**
 * Diff detection for tool-chip bodies.
 *
 * An `edit_file` result is a diff with a plain sentence in front of it, so this
 * is what decides whether a chip renders colourised lines or grey `<pre>` text.
 * A false negative is the bug the user reported — an edit shown as
 * undifferentiated text while the CLI and the panel both colour the same
 * string. A false positive is worse: a test failure or a log full of lines
 * starting with `-` painted red as if it were a deletion.
 */

const EDIT_RESULT = [
  'Edited src/app.ts.',
  '--- src/app.ts',
  '+++ src/app.ts',
  '@@ -1,4 +1,5 @@',
  ' import x from "x";',
  '-const a = 1;',
  '+const a = 2;',
  '+const b = 3;',
].join('\n');

describe('isDiffText', () => {
  it('sees the diff under edit_file’s leading prose line', () => {
    expect(isDiffText(EDIT_RESULT)).toBe(true);
  });

  it('accepts a single-line hunk header, which omits the counts', () => {
    expect(isDiffText('@@ -3 +3 @@\n-old\n+new')).toBe(true);
  });

  it('leaves ordinary tool output alone', () => {
    // Every one of these has lines a naive check would colour.
    expect(isDiffText('npm test\n- 3 passing\n- 1 failing')).toBe(false);
    expect(isDiffText('usage: tool [--flag]\n  -v  verbose\n  +x  something')).toBe(false);
    expect(isDiffText('')).toBe(false);
  });
});

describe('diffStats', () => {
  it('counts only lines inside the hunks', () => {
    // The `---`/`+++` headers are not a deletion and an addition; counting
    // them is how a one-line edit ends up claiming two of each.
    expect(diffStats(EDIT_RESULT)).toEqual({ added: 2, removed: 1 });
  });

  it('is zero for text with no hunk at all', () => {
    expect(diffStats('nothing to see')).toEqual({ added: 0, removed: 0 });
  });
});
