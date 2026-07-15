import { createRequire } from 'node:module';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { extractSymbols, formatRepoMap, type RepoMapFileEntry } from '../src/rag/symbols.js';
import { configureAstChunker } from '../src/rag/astChunker.js';

// Same test-local loader as astChunker.test.ts — production path resolution
// is host-owned (packages/vscode/src/extension.ts).
const require = createRequire(import.meta.url);
const WASM_PATHS: Record<string, string> = {
  'tree-sitter.wasm': require.resolve('web-tree-sitter/tree-sitter.wasm'),
  'tree-sitter-typescript.wasm': require.resolve('tree-sitter-wasms/out/tree-sitter-typescript.wasm'),
  'tree-sitter-tsx.wasm': require.resolve('tree-sitter-wasms/out/tree-sitter-tsx.wasm'),
  'tree-sitter-javascript.wasm': require.resolve('tree-sitter-wasms/out/tree-sitter-javascript.wasm'),
  'tree-sitter-python.wasm': require.resolve('tree-sitter-wasms/out/tree-sitter-python.wasm'),
};

beforeAll(() => {
  configureAstChunker((filename) => {
    const resolved = WASM_PATHS[filename];
    if (!resolved) throw new Error(`no test wasm mapped for ${filename}`);
    return resolved;
  });
});

afterAll(() => {
  configureAstChunker(undefined);
});

describe('extractSymbols (AST path)', () => {
  it('extracts a top-level function and a class with its methods from TS', async () => {
    const content = [
      'export function topLevel(a: number): number {',
      '  return a + 1;',
      '}',
      '',
      'export class Widget {',
      '  render(): void {',
      '    const local = 1;',
      '  }',
      '  destroy(): void {}',
      '}',
    ].join('\n');
    const symbols = await extractSymbols('a.ts', content);
    const names = symbols.map((s) => s.name);
    expect(names).toContain('topLevel');
    expect(names).toContain('Widget');
    expect(names).toContain('render');
    expect(names).toContain('destroy');
    // No leakage of locals from inside a method body.
    expect(names).not.toContain('local');

    const widget = symbols.find((s) => s.name === 'Widget')!;
    expect(widget.line).toBe(5);
    expect(widget.kind).toContain('class');
  });

  it('extracts a Python function and class', async () => {
    const content = [
      'def process(x):',
      '    return x + 1',
      '',
      'class Handler:',
      '    def handle(self):',
      '        pass',
    ].join('\n');
    const symbols = await extractSymbols('a.py', content);
    const names = symbols.map((s) => s.name);
    expect(names).toContain('process');
    expect(names).toContain('Handler');
    expect(names).toContain('handle');
  });

  it('falls back to the regex-based extractor on unparseable content, without throwing', async () => {
    const content = 'function ((( {{{ export function realOne() {} ]]] garbage';
    const symbols = await extractSymbols('a.ts', content);
    expect(Array.isArray(symbols)).toBe(true);
  });

  it('uses the regex-based extractor for extensions without a configured grammar', async () => {
    const content = ['export function fromMarkdownCodeBlock() {}', 'not a declaration'].join('\n');
    const symbols = await extractSymbols('README.md', content);
    expect(symbols.length).toBeGreaterThan(0);
    expect(symbols[0]!.kind).toBe('line');
    expect(symbols[0]!.line).toBe(1);
  });
});

describe('formatRepoMap', () => {
  const entries: RepoMapFileEntry[] = [
    { path: 'packages/core/src/rag/store.ts', symbols: [{ name: 'VectorStore', kind: 'class_declaration', line: 27 }] },
    { path: 'packages/vscode/src/extension.ts', symbols: [{ name: 'activate', kind: 'function_declaration', line: 52 }] },
    { path: 'packages/core/src/rag/bm25.ts', symbols: [] },
  ];

  it('lists files with symbols, skips files with none, sorted by path', () => {
    const text = formatRepoMap(entries);
    expect(text).toContain('packages/core/src/rag/store.ts');
    expect(text).toContain('VectorStore');
    expect(text).not.toContain('bm25.ts');
    expect(text.indexOf('packages/core')).toBeLessThan(text.indexOf('packages/vscode'));
  });

  it('scopes to a path prefix', () => {
    const text = formatRepoMap(entries, { pathPrefix: 'packages/core' });
    expect(text).toContain('store.ts');
    expect(text).not.toContain('extension.ts');
  });

  it('truncates with a note when over budget', () => {
    const text = formatRepoMap(entries, { budgetChars: 10 });
    expect(text).toContain('truncated');
  });
});
