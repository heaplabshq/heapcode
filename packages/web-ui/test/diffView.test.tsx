// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { DiffView, diffStats, isDiffText } from '../src/components/DiffView.js';

afterEach(cleanup);

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

/**
 * How a diff reads.
 *
 * The three things the plain colourised `<pre>` could not do, and one that it
 * did badly: build an element per line with no limit.
 */
describe('DiffView', () => {
  function rows(diff: string): HTMLElement {
    return render(<DiffView diff={diff} />).container.firstElementChild as HTMLElement;
  }

  it('numbers each side from the hunk header', () => {
    const view = rows(['@@ -10,3 +10,3 @@', ' keep', '-old', '+new', ' after'].join('\n'));
    const numbers = [...view.querySelectorAll('.diff-line:not(.diff-hunk)')].map((r) =>
      [...r.querySelectorAll('.diff-no')].map((n) => n.textContent),
    );
    // A removal has no line in the new file, an addition none in the old.
    expect(numbers).toEqual([
      ['10', '10'],
      ['11', ''],
      ['', '11'],
      ['12', '12'],
    ]);
  });

  it('keeps the markers out of the text, so a selection copies code', () => {
    const view = rows(['@@ -1,2 +1,2 @@', '-const a = 1;', '+const a = 2;'].join('\n'));
    const texts = [...view.querySelectorAll('.diff-text')].map((t) => t.textContent);
    expect(texts).toEqual(['const a = 1;', 'const a = 2;']);
    expect(view.querySelectorAll('.diff-sign')[0]!.textContent).toBe('−');
  });

  it('marks only what differs inside a replaced line', () => {
    const view = rows(['@@ -1,2 +1,2 @@', '-const a = 1;', '+const a = 42;'].join('\n'));
    expect([...view.querySelectorAll('.diff-word')].map((w) => w.textContent)).toEqual(['1', '42']);
  });

  it('leaves a line alone when almost none of it survives', () => {
    // Marking 90% of a line says "this line changed", which the colour said.
    const view = rows(['@@ -1,2 +1,2 @@', '-alpha bravo charlie;', '+delta echo foxtrot;'].join('\n'));
    expect(view.querySelectorAll('.diff-word')).toHaveLength(0);
  });

  it('has nothing to compare a pure insertion against, and marks nothing', () => {
    const view = rows(['@@ -1,1 +1,2 @@', ' keep', '+added'].join('\n'));
    expect(view.querySelectorAll('.diff-word')).toHaveLength(0);
  });

  it('pairs each removal with its own replacement, not with the first one', () => {
    const view = rows(
      ['@@ -1,4 +1,4 @@', '-let a = 1;', '-let b = 2;', '+let a = 9;', '+let b = 8;'].join('\n'),
    );
    // Per row, so this proves the pairing rather than the document order:
    // the second removal is compared with the second addition, not the first.
    const marks = [...view.querySelectorAll('.diff-line')].map((r) =>
      [...r.querySelectorAll('.diff-word')].map((w) => w.textContent).join(''),
    );
    expect(marks).toEqual(['', '1', '2', '9', '8']);
  });

  it('holds a long diff back behind a click rather than building every row', () => {
    // A 4,000-line rewrite built 4,000 elements inside a chip clamped to 420px.
    const long = ['@@ -1,900 +1,900 @@', ...Array.from({ length: 900 }, (_, i) => `+line ${i}`)].join('\n');
    const view = rows(long);
    expect(view.querySelectorAll('.diff-line').length).toBeLessThan(400);
    expect(view.querySelector('.diff-more')?.textContent).toBe('Show all 901 lines');
  });

  it('does not number the prose edit_file puts in front of its diff', () => {
    const view = rows(['Edited src/app.ts.', '@@ -1,1 +1,1 @@', '-a', '+b'].join('\n'));
    const first = view.querySelector('.diff-line')!;
    expect(first.className).toContain('diff-meta');
    expect(first.querySelector('.diff-no')).toBeNull();
  });
});
