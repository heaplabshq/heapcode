import { createRequire } from 'node:module';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chunkFile } from '../src/rag/chunker.js';
import { configureAstChunker } from '../src/rag/astChunker.js';

// Test-local loader only: reads grammar wasm straight from node_modules via
// Node's require.resolve. Production path resolution is host-owned (see
// packages/vscode/src/extension.ts) — this mirrors that shape without
// pulling any Node-specific assumptions into packages/core itself.
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

/** Every chunk's line range is contiguous, non-overlapping, and covers the whole file. */
function expectFullCoverage(chunks: Array<{ startLine: number; endLine: number }>, totalLines: number) {
  expect(chunks[0]!.startLine).toBe(1);
  expect(chunks[chunks.length - 1]!.endLine).toBe(totalLines);
  for (let i = 1; i < chunks.length; i++) {
    expect(chunks[i]!.startLine).toBe(chunks[i - 1]!.endLine + 1);
  }
}

describe('chunkFile (AST path)', () => {
  it('splits a TS file along function boundaries, not arbitrary line counts', async () => {
    const content = [
      'export function first(a: number): number {',
      '  return a + 1;',
      '}',
      '',
      'export function second(b: number): number {',
      '  return b * 2;',
      '}',
    ].join('\n');
    const chunks = await chunkFile('a.ts', content, { maxLines: 3 });
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    // First chunk starts exactly at "first"'s declaration; a later chunk
    // starts exactly at "second"'s — real symbol boundaries, not a guess.
    const secondStart = chunks.find((c) => c.text.includes('export function second'));
    expect(secondStart?.startLine).toBe(5);
    expectFullCoverage(chunks, content.split('\n').length);
  });

  it('merges small top-level statements instead of one chunk each', async () => {
    const content = ['const a = 1;', 'const b = 2;', 'const c = 3;', 'const d = 4;'].join('\n');
    const chunks = await chunkFile('a.ts', content, { maxLines: 60 });
    expect(chunks.length).toBe(1);
    expect(chunks[0]!.text).toBe(content);
  });

  it('handles a Python file: merges small statements, splits around a function', async () => {
    const content = [
      'import os',
      'import sys',
      '',
      'def process(x):',
      '    y = x + 1',
      '    z = y * 2',
      '    return z',
    ].join('\n');
    const chunks = await chunkFile('a.py', content, { maxLines: 3 });
    expectFullCoverage(chunks, content.split('\n').length);
    const fnChunk = chunks.find((c) => c.text.includes('def process'));
    expect(fnChunk?.startLine).toBe(4);
  });

  it('falls back to the line-window chunker on unparseable content', async () => {
    // Malformed enough that tree-sitter still returns a tree (it's an error-
    // tolerant parser) but exercises the fallback path if parsing throws —
    // either way this must never throw and must still return chunks.
    const content = 'function ((( {{{ ]]] this is not valid typescript at all';
    const chunks = await chunkFile('a.ts', content, { maxLines: 5 });
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.map((c) => c.text).join('\n')).toContain('not valid typescript');
  });

  it('uses the line-window chunker for extensions without a configured grammar', async () => {
    const content = Array.from({ length: 5 }, (_, i) => `line ${i + 1}`).join('\n');
    const chunks = await chunkFile('README.md', content, { maxLines: 60 });
    // Line-window chunker produces exactly one chunk covering everything for
    // content this short, same as it always has.
    expect(chunks.length).toBe(1);
    expect(chunks[0]!.text).toBe(content);
  });
});
