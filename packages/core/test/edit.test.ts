import { describe, expect, it } from 'vitest';
import { extractFirstCodeBlock } from '../src/edit/codeBlocks.js';
import { unifiedDiff } from '../src/edit/diff.js';
import { applySearchReplace, findBestMatch } from '../src/edit/fuzzyMatch.js';
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
