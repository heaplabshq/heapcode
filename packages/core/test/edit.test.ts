import { describe, expect, it } from 'vitest';
import { extractFirstCodeBlock } from '../src/edit/codeBlocks.js';
import { applySearchReplace, findBestMatch } from '../src/edit/fuzzyMatch.js';
import { minIndent, reindent } from '../src/edit/indent.js';

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
