import { describe, expect, it } from 'vitest';
import { applySearchReplace, findBestMatch, stripLineNumbers } from '../src/edit/fuzzyMatch.js';

/**
 * `read_file` returns `12\tconst x = 1;` — number, TAB, source. `edit_file`
 * then refused any search text that still carried those prefixes, because the
 * matcher compares lines trimmed and `12\tconst x` never equals `const x`.
 *
 * The tool was handing the model a format it would not itself accept, and the
 * failure surfaced as "the search text was not found in …", which reads like
 * the file has changed rather than like a transcription rule was broken.
 */

const FILE = ['function greet() {', '  return "hi";', '}', ''].join('\n');

/** What a model gets back from read_file and copies verbatim. */
const numbered = (from: number, lines: string[]): string =>
  lines.map((l, i) => `${from + i}\t${l}`).join('\n');

describe('search text copied straight out of read_file', () => {
  it('matches despite the line-number gutter', () => {
    expect(findBestMatch(FILE, numbered(2, ['  return "hi";']))).toMatchObject({ ambiguous: false });
  });

  it('applies the edit, and writes no line numbers into the file', () => {
    const next = applySearchReplace(FILE, numbered(2, ['  return "hi";']), '  return "hello";');
    expect(next).toBe(['function greet() {', '  return "hello";', '}', ''].join('\n'));
  });

  it('strips the gutter from the replacement too', () => {
    // A model that numbered the search has very likely numbered the
    // replacement; stripping only one side would silently write `2\t…` in.
    const next = applySearchReplace(FILE, numbered(2, ['  return "hi";']), numbered(2, ['  return "hello";']));
    expect(next).toContain('return "hello";');
    expect(next).not.toMatch(/^\d+\t/m);
  });

  it('handles a multi-line block', () => {
    const next = applySearchReplace(FILE, numbered(1, ['function greet() {', '  return "hi";', '}']), 'const greet = () => "hi";');
    expect(next).toBe(['const greet = () => "hi";', ''].join('\n'));
  });
});

describe('stripLineNumbers is all-or-nothing', () => {
  it('leaves a block alone unless every non-blank line is numbered', () => {
    // Half-numbered means something else is going on; guessing would be worse
    // than failing.
    const mixed = ['1\tconst a = 1;', 'const b = 2;'].join('\n');
    expect(stripLineNumbers(mixed)).toBe(mixed);
  });

  it('does not touch source that merely starts with a digit', () => {
    // No TAB, so not the gutter shape.
    const code = ['404: return notFound();'].join('\n');
    expect(stripLineNumbers(code)).toBe(code);
  });

  it('tolerates blank lines inside a numbered block', () => {
    expect(stripLineNumbers(['1\tconst a = 1;', '', '3\tconst b = 2;'].join('\n'))).toBe(
      ['const a = 1;', '', 'const b = 2;'].join('\n'),
    );
  });

  it('leaves ordinary search text completely unchanged', () => {
    const plain = ['function greet() {', '  return "hi";', '}'].join('\n');
    expect(stripLineNumbers(plain)).toBe(plain);
  });
});

describe('what the gutter tolerance must not break', () => {
  it('still refuses an ambiguous match', () => {
    const twice = ['if (a) {', '  return 1;', '}', 'if (b) {', '  return 1;', '}', ''].join('\n');
    expect(findBestMatch(twice, numbered(2, ['  return 1;']))?.ambiguous).toBe(true);
    expect(applySearchReplace(twice, numbered(2, ['  return 1;']), '  return 2;')).toBeUndefined();
  });

  it('still reports genuinely missing text as missing', () => {
    expect(applySearchReplace(FILE, numbered(9, ['  return "nope";']), 'x')).toBeUndefined();
  });

  it('still tolerates the indentation a model mangles', () => {
    expect(applySearchReplace(FILE, 'return "hi";', '  return "hello";')).toContain('return "hello";');
  });
});

describe('indentation is not doubled', () => {
  // Trimming the needle before matching anchored a single-line search mid-line,
  // so a replacement that carried its own indentation landed twice as deep.
  // Silently almost-right, which is worse than a clean failure.
  it('keeps the original indent when search and replace both carry it', () => {
    expect(applySearchReplace(FILE, '  return "hi";', '  return "hello";')).toBe(
      ['function greet() {', '  return "hello";', '}', ''].join('\n'),
    );
  });

  it('does the same for a numbered copy out of read_file', () => {
    expect(applySearchReplace(FILE, '2\t  return "hi";', '  return "hello";')).toBe(
      ['function greet() {', '  return "hello";', '}', ''].join('\n'),
    );
  });

  it('still matches when the model dropped the indentation', () => {
    // Falls through to the trimmed probe, which anchors at the text itself —
    // the replacement then supplies whatever indent it says.
    expect(applySearchReplace(FILE, 'return "hi";', 'return "hello";')).toBe(
      ['function greet() {', '  return "hello";', '}', ''].join('\n'),
    );
  });
});
