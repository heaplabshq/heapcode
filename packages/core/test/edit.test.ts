import { describe, expect, it } from 'vitest';
import { extractFirstCodeBlock } from '../src/edit/codeBlocks.js';
import { unifiedDiff } from '../src/edit/diff.js';
import { applySearchReplace, applySearchReplaceAll, describeAmbiguity, findBestMatch } from '../src/edit/fuzzyMatch.js';
import { minIndent, reindent } from '../src/edit/indent.js';
import { buildInlineEditMessages } from '../src/prompts/edit.js';

describe('extractFirstCodeBlock', () => {
  it('extracts a plain fenced block', () => {
    expect(extractFirstCodeBlock('```\nconst a = 1;\n```')).toBe('const a = 1;');
  });

  it('extracts a language-tagged block surrounded by prose', () => {
    const md = 'Here you go:\n```typescript\nfoo();\nbar();\n```\nHope that helps!';
    expect(extractFirstCodeBlock(md)).toBe('foo();\nbar();');
  });

  it('takes only the first of multiple blocks', () => {
    expect(extractFirstCodeBlock('```\nfirst\n```\ntext\n```\nsecond\n```')).toBe('first');
  });

  it('handles CRLF and dotted language tags', () => {
    expect(extractFirstCodeBlock('```objective-c\r\nx\r\n```')).toBe('x');
  });

  it('returns undefined when there is no block', () => {
    expect(extractFirstCodeBlock('just prose')).toBeUndefined();
  });
});

describe('unifiedDiff', () => {
  it('shows a single changed line as -old/+new, with only nearby lines kept as context', () => {
    const before = ['line1', 'line2', 'line3', 'OLD', 'line5', 'line6', 'line7'].join('\n');
    const after = ['line1', 'line2', 'line3', 'NEW', 'line5', 'line6', 'line7'].join('\n');
    const diff = unifiedDiff(before, after);
    expect(diff).toContain('-OLD');
    expect(diff).toContain('+NEW');
    expect(diff).toContain(' line3'); // immediate context before the change
    expect(diff).toContain(' line5'); // immediate context after
    expect(diff).not.toContain('line1'); // outside the (default 2-line) context window
    expect(diff).not.toContain('line7'); // outside the context window
  });

  it('returns empty string for identical text', () => {
    expect(unifiedDiff('same\ntext', 'same\ntext')).toBe('');
  });

  it('handles a pure insertion (no old lines removed)', () => {
    const diff = unifiedDiff('a\nb', 'a\nnew\nb');
    expect(diff).toContain('+new');
    expect(diff.split('\n').some((l) => l.startsWith('-'))).toBe(false); // no removed line, only the hunk header's own "-"
  });

  /*
   * The reason this stopped being a prefix/suffix trim.
   *
   * That version called everything between the first and last change one
   * block, so a file edited in two places printed every untouched line
   * between them as removed and then added again — and the counts it implied
   * are what the `+n −n` badges are computed from.
   */
  it('leaves untouched lines between two edits alone', () => {
    const before = Array.from({ length: 12 }, (_, i) => `line ${i}`).join('\n');
    const after = before.split('\n');
    after[1] = 'CHANGED 1';
    after[10] = 'CHANGED 10';
    const diff = unifiedDiff(before, after.join('\n'));
    const removed = diff.split('\n').filter((l) => l.startsWith('-') && !l.startsWith('---'));
    const added = diff.split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++'));
    expect(removed).toEqual(['-line 1', '-line 10']);
    expect(added).toEqual(['+CHANGED 1', '+CHANGED 10']);
    // Far enough apart that their context windows do not touch, so two hunks.
    expect(diff.split('\n').filter((l) => l.startsWith('@@'))).toHaveLength(2);
  });

  it('keeps two nearby edits in one hunk rather than splitting on a shared line', () => {
    const before = Array.from({ length: 10 }, (_, i) => `line ${i}`).join('\n');
    const after = before.split('\n');
    after[4] = 'A';
    after[6] = 'B';
    const diff = unifiedDiff(before, after.join('\n'));
    expect(diff.split('\n').filter((l) => l.startsWith('@@'))).toHaveLength(1);
    // The line between them is context, not a removal and an addition.
    expect(diff).toContain(' line 5');
  });

  it('numbers each hunk against both files', () => {
    const before = ['a', 'b', 'c', 'd'].join('\n');
    const after = ['a', 'B', 'c', 'd'].join('\n');
    expect(unifiedDiff(before, after).split('\n')[0]).toBe('@@ -1,4 +1,4 @@');
  });

  it('numbers a pure insertion from the line before it, the way git does', () => {
    // A hunk that removes nothing has an old count of zero; starting it at
    // line 1 rather than at the preceding line is how `-0,0` gets misread.
    const diff = unifiedDiff('a\nb\nc', 'a\nb\nc\nd');
    expect(diff.split('\n')[0]).toBe('@@ -2,2 +2,3 @@');
  });

  it('falls back to one block when the two sides are too far apart to diff cheaply', () => {
    // Past the edit-distance bound the search is abandoned. "Everything
    // changed" is both the cheap answer and the true one for a rewrite.
    const before = Array.from({ length: 1200 }, (_, i) => `old ${i}`).join('\n');
    const after = Array.from({ length: 1200 }, (_, i) => `new ${i}`).join('\n');
    const diff = unifiedDiff(before, after);
    expect(diff.split('\n').filter((l) => l.startsWith('-'))).toHaveLength(1200);
    expect(diff.split('\n').filter((l) => l.startsWith('+'))).toHaveLength(1200);
  });

  it('diffs a large file with a small edit without breaking a sweat', () => {
    const before = Array.from({ length: 20_000 }, (_, i) => `line ${i}`).join('\n');
    const after = before.split('\n');
    after[9_000] = 'CHANGED';
    const started = Date.now();
    const diff = unifiedDiff(before, after.join('\n'));
    expect(Date.now() - started).toBeLessThan(500);
    expect(diff.split('\n').filter((l) => l.startsWith('-'))).toEqual(['-line 9000']);
  });
});

describe('findBestMatch', () => {
  const file = [
    'function greet(name) {',
    '  if (!name) {',
    '    return "hello";',
    '  }',
    '  return `hello ${name}`;',
    '}',
  ].join('\n');

  it('finds exact matches', () => {
    const m = findBestMatch(file, '  if (!name) {\n    return "hello";\n  }');
    expect(m?.exact).toBe(true);
    expect(file.slice(m!.start, m!.end)).toContain('return "hello"');
  });

  it('finds matches despite mangled indentation (the LLM case)', () => {
    const needle = 'if (!name) {\nreturn "hello";\n}';
    const m = findBestMatch(file, needle);
    expect(m).toBeDefined();
    expect(m!.exact).toBe(false);
    expect(file.slice(m!.start, m!.end)).toBe('  if (!name) {\n    return "hello";\n  }');
  });

  it('matches a single line as an exact substring, keeping surrounding indent intact', () => {
    const m = findBestMatch(file, 'return `hello ${name}`;');
    expect(m?.exact).toBe(true);
    expect(file.slice(m!.start, m!.end)).toBe('return `hello ${name}`;');
  });

  it('returns undefined when content genuinely differs', () => {
    expect(findBestMatch(file, 'return "goodbye";')).toBeUndefined();
  });

  it('returns undefined for empty needles', () => {
    expect(findBestMatch(file, '   \n  ')).toBeUndefined();
  });

  it('flags an exact match that occurs in more than one place as ambiguous (real live incident)', () => {
    // "});\n" closes every test block in a typical test file — matching the first one
    // silently is exactly how a real live model corrupted a file: it meant the LAST
    // closing brace but the tool applied the edit to the FIRST one instead.
    const multi = 'a();\n});\nb();\n});\nc();\n});';
    const m = findBestMatch(multi, '});');
    expect(m?.ambiguous).toBe(true);
    expect(m?.occurrences).toBe(3);
  });

  it('flags a fuzzy (whitespace-tolerant) match that occurs in more than one place as ambiguous', () => {
    const twoFns = [
      'function greetA(name) {',
      '  if (!name) {',
      '    return "hello";',
      '  }',
      '}',
      'function greetB(name) {',
      '  if (!name) {',
      '    return "hello";',
      '  }',
      '}',
    ].join('\n');
    // Mangled indentation forces the fuzzy (non-exact) matching path, and the same
    // guard body appears identically in both functions.
    const m = findBestMatch(twoFns, 'if (!name) {\nreturn "hello";\n}');
    expect(m?.exact).toBe(false);
    expect(m?.ambiguous).toBe(true);
    expect(m?.occurrences).toBe(2);
  });

  it('does not flag a match that occurs exactly once', () => {
    const m = findBestMatch(file, 'return "hello";');
    expect(m?.ambiguous).toBe(false);
    expect(m?.occurrences).toBeUndefined();
  });

  describe('indentation disambiguation', () => {
    // The same two statements at three nesting depths. Indentation is the only
    // thing telling them apart, and the fuzzy pass compares lines trimmed.
    const depths = [
      'function run(a, b) {',
      '  if (a) {',
      '    setLoading(true);',
      '    fetchData();',
      '  }',
      '  while (b) {',
      '      setLoading(true);',
      '      fetchData();',
      '  }',
      '}',
    ].join('\n');

    it('picks the candidate whose indentation is closest when the exact pass misses', () => {
      // Three spaces, not four — a near miss, so the exact pass can't help.
      const m = findBestMatch(depths, '   setLoading(true);\n   fetchData();');
      expect(m?.exact).toBe(false);
      expect(m?.ambiguous).toBe(false);
      expect(depths.slice(m!.start, m!.end)).toBe('    setLoading(true);\n    fetchData();');
    });

    it('picks the deeper one when the needle is quoted at the deeper indentation', () => {
      const m = findBestMatch(depths, '       setLoading(true);\n       fetchData();');
      expect(m?.ambiguous).toBe(false);
      expect(depths.slice(m!.start, m!.end)).toBe('      setLoading(true);\n      fetchData();');
    });

    it('stays ambiguous when the needle sits equidistant between two depths', () => {
      // Five spaces is exactly one column from the 4-space site and one from
      // the 6-space one. Nothing here says which was meant, so it refuses.
      const m = findBestMatch(depths, '     setLoading(true);\n     fetchData();');
      expect(m?.ambiguous).toBe(true);
      expect(m?.occurrences).toBe(2);
    });

    it('stays ambiguous when the candidates sit at the same depth — indentation cannot break that tie', () => {
      const twice = ['if (x) {', '  go();', '}', 'if (y) {', '  go();', '}'].join('\n');
      const m = findBestMatch(twice, 'go();\n');
      expect(m?.ambiguous).toBe(true);
      expect(m?.occurrences).toBe(2);
    });

    it('survives a CRLF file, which defeats the exact pass on every needle', () => {
      const crlf = depths.replace(/\n/g, '\r\n');
      const m = findBestMatch(crlf, '    setLoading(true);\n    fetchData();');
      expect(m?.exact).toBe(false);
      expect(m?.ambiguous).toBe(false);
      // The span runs to the end of the matched line, trailing \r included.
      expect(crlf.slice(m!.start, m!.end)).toBe('    setLoading(true);\r\n    fetchData();\r');
    });
  });

  it('reports the 1-based line of every match, so the refusal can say where they are', () => {
    const m = findBestMatch('a();\n});\nb();\n});\nc();\n});', '});');
    expect(m?.lines).toEqual([2, 4, 6]);
  });
});

describe('describeAmbiguity', () => {
  it('names the lines and points at replace_all', () => {
    const m = findBestMatch('a();\n});\nb();\n});\nc();\n});', '});')!;
    const message = describeAmbiguity(m, 'src/App.jsx');
    expect(message).toContain('matches 3 different places in src/App.jsx');
    expect(message).toContain('lines 2, 4, 6');
    expect(message).toContain('replace_all');
  });

  it('caps the list rather than printing hundreds of line numbers', () => {
    const many = Array.from({ length: 25 }, () => 'x();').join('\n');
    const message = describeAmbiguity(findBestMatch(many, 'x();')!, 'a.js');
    expect(message).toContain('… (15 more)');
  });
});

describe('applySearchReplaceAll', () => {
  it('replaces every occurrence — the answer to an ambiguity no context can resolve', () => {
    const src = 'a();\n});\nb();\n});\nc();\n});';
    const result = applySearchReplaceAll(src, '});', 'DONE;');
    expect(result?.count).toBe(3);
    expect(result?.text).toBe('a();\nDONE;\nb();\nDONE;\nc();\nDONE;');
  });

  it('leaves each site’s indentation alone, rather than restating whole lines', () => {
    const src = ['if (x) {', '  go();', '}', 'if (y) {', '    go();', '}'].join('\n');
    const result = applySearchReplaceAll(src, 'go();', 'stop();');
    expect(result?.count).toBe(2);
    expect(result?.text).toBe(['if (x) {', '  stop();', '}', 'if (y) {', '    stop();', '}'].join('\n'));
  });

  it('falls back to the fuzzy pass when the search text is nowhere literal', () => {
    const src = ['if (x) {', '  go();', '}', 'if (y) {', '  go();', '}'].join('\n');
    // Mangled indentation on a multi-line needle — no literal occurrence.
    const result = applySearchReplaceAll(src, 'if (x) {\ngo();\n}', 'run();');
    expect(result?.count).toBe(1);
    expect(result?.text).toBe(['run();', 'if (y) {', '  go();', '}'].join('\n'));
  });

  it('returns undefined when nothing matched, so "no match" stays distinguishable', () => {
    expect(applySearchReplaceAll('a();', 'nope();', 'x')).toBeUndefined();
  });

  it('does not corrupt the file with a self-overlapping needle', () => {
    expect(applySearchReplaceAll('aaa', 'aa', 'b')?.text).toBe('ba');
  });
});

describe('applySearchReplace', () => {
  it('replaces an exact match', () => {
    expect(applySearchReplace('a\nb\nc', 'b', 'B')).toBe('a\nB\nc');
  });

  it('replaces a substring match preserving the line indent', () => {
    const content = '  foo();\n  bar();\n  baz();';
    const result = applySearchReplace(content, 'bar();', 'qux();');
    expect(result).toBe('  foo();\n  qux();\n  baz();');
  });

  it('replaces a multi-line fuzzy match when indentation is mangled', () => {
    const content = '  if (a) {\n    b();\n  }';
    const result = applySearchReplace(content, 'if (a) {\nb();\n}', 'c();');
    expect(result).toBe('c();');
  });

  it('returns undefined instead of guessing on no match', () => {
    expect(applySearchReplace('abc', 'xyz', '123')).toBeUndefined();
  });

  it('returns undefined instead of guessing which of several identical matches was meant', () => {
    const content = 'a();\n});\nb();\n});\nc();\n});';
    expect(applySearchReplace(content, '});', 'DONE;')).toBeUndefined();
  });
});

describe('buildInlineEditMessages', () => {
  const base = {
    instruction: 'add error handling',
    selectedCode: 'foo();',
    languageId: 'typescript',
    filePath: 'src/a.ts',
  };

  it('omits the related-code section when none is given', () => {
    const [, user] = buildInlineEditMessages(base);
    expect(user!.content).not.toContain('RELATED CODE');
  });

  it('includes related code from the RAG index when provided', () => {
    const [, user] = buildInlineEditMessages({ ...base, relatedCode: '--- src/b.ts:1-2 ---\nbar();' });
    expect(user!.content).toContain('RELATED CODE FROM ELSEWHERE IN THE WORKSPACE');
    expect(user!.content).toContain('bar();');
  });
});

describe('indent helpers', () => {
  it('minIndent finds the smallest indentation, ignoring blank lines', () => {
    expect(minIndent('    a\n\n  b\n      c')).toBe('  ');
    expect(minIndent('a\n  b')).toBe('');
  });

  it('reindent shifts flush-left code to the reference indent', () => {
    const proposed = 'if (x) {\n  y();\n}';
    expect(reindent(proposed, '    ')).toBe('    if (x) {\n      y();\n    }');
  });

  it('reindent reduces over-indented code', () => {
    const proposed = '    a();\n      b();';
    expect(reindent(proposed, '  ')).toBe('  a();\n    b();');
  });

  it('reindent leaves matching indentation untouched', () => {
    const proposed = '  a();\n    b();';
    expect(reindent(proposed, '  ')).toBe(proposed);
  });
});
