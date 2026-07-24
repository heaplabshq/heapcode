import { createRequire } from 'node:module';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkSyntax } from '../src/edit/syntaxCheck.js';
import { configureAstChunker } from '../src/rag/astChunker.js';

// Same test-local wasm loader as astChunker.test.ts — production path
// resolution is host-owned (see packages/vscode/src/extension.ts).
const require = createRequire(import.meta.url);
const WASM_PATHS: Record<string, string> = {
  'tree-sitter.wasm': require.resolve('web-tree-sitter/tree-sitter.wasm'),
  'tree-sitter-typescript.wasm': require.resolve('tree-sitter-wasms/out/tree-sitter-typescript.wasm'),
  'tree-sitter-javascript.wasm': require.resolve('tree-sitter-wasms/out/tree-sitter-javascript.wasm'),
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

describe('checkSyntax', () => {
  it('returns undefined for syntactically valid JS', async () => {
    expect(await checkSyntax('a.js', 'function f() {\n  return 1;\n}\n')).toBeUndefined();
  });

  it('reports a syntax error for JS with a missing closing paren (real live incident)', async () => {
    // Reproduces the exact corruption a live run once wrote to disk: a "});" that
    // should have closed a test(...) call got truncated to just "}".
    const broken = "test('x', () => {\n  assert.equal(1, 1);\n}\n// next test\ntest('y', () => {});\n";
    const err = await checkSyntax('math.test.js', broken);
    expect(err).toContain('Syntax error');
  });

  it('returns undefined for a language with no configured grammar', async () => {
    expect(await checkSyntax('README.md', '# broken ((( markdown')).toBeUndefined();
  });

  it('returns undefined for empty content', async () => {
    expect(await checkSyntax('a.js', '')).toBeUndefined();
  });
});
