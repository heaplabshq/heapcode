import { createRequire } from 'node:module';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { extractImportTargets } from '../src/rag/importGraph.js';
import { configureAstChunker } from '../src/rag/astChunker.js';

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

afterAll(() => configureAstChunker(undefined));

describe('extractImportTargets (TS/JS)', () => {
  const knownPaths = new Set([
    'src/index.ts',
    'src/utils/math.ts',
    'src/components/Button.tsx',
    'src/lib/index.ts',
    'src/legacy.js',
  ]);

  it('resolves a relative ESM import to its file', async () => {
    const content = `import { add } from './utils/math';\nexport const x = add(1, 2);`;
    const targets = await extractImportTargets('src/index.ts', content, knownPaths);
    expect(targets).toEqual(['src/utils/math.ts']);
  });

  it('resolves a parent-relative import and a directory import to its index file', async () => {
    const content = `import Button from '../components/Button';\nimport lib from '../lib';`;
    const targets = await extractImportTargets('src/pages/Home.ts', content, knownPaths);
    expect(targets.sort()).toEqual(['src/components/Button.tsx', 'src/lib/index.ts']);
  });

  it('resolves a re-export ("export ... from") and a CommonJS require()', async () => {
    const content = `export { add } from './utils/math';\nconst legacy = require('./legacy');`;
    const targets = await extractImportTargets('src/index.ts', content, knownPaths);
    expect(targets.sort()).toEqual(['src/legacy.js', 'src/utils/math.ts']);
  });

  it('resolves a dynamic import()', async () => {
    const content = `const mod = await import('./utils/math');`;
    const targets = await extractImportTargets('src/index.ts', content, knownPaths);
    expect(targets).toEqual(['src/utils/math.ts']);
  });

  it('drops unresolvable imports: bare package names and relative paths with no matching file', async () => {
    const content = `import React from 'react';\nimport { z } from './nonexistent';`;
    const targets = await extractImportTargets('src/index.ts', content, knownPaths);
    expect(targets).toEqual([]);
  });

  it('never targets the importing file itself', async () => {
    const content = `import './index';`;
    const targets = await extractImportTargets('src/index.ts', content, knownPaths);
    expect(targets).toEqual([]);
  });
});

describe('extractImportTargets (Python)', () => {
  const knownPaths = new Set(['pkg/__init__.py', 'pkg/foo.py', 'pkg/sub/bar.py', 'top.py']);

  it('resolves "from . import foo" to the sibling module, not the package __init__', async () => {
    // The imported name (foo) is the actual sibling module — a bare "from . import x"
    // must resolve to pkg/foo.py, not fall back to pkg/__init__.py.
    const content = 'from . import foo';
    const targets = await extractImportTargets('pkg/mod.py', content, knownPaths);
    expect(targets).toEqual(['pkg/foo.py']);
  });

  it('resolves "from .foo import something" against the current package', async () => {
    const content = 'from .foo import something';
    const targets = await extractImportTargets('pkg/mod.py', content, knownPaths);
    expect(targets).toEqual(['pkg/foo.py']);
  });

  it('resolves "from ..sub.bar import baz" one level up with dotted segments', async () => {
    const content = 'from ..sub.bar import baz';
    const targets = await extractImportTargets('pkg/nested/mod.py', content, knownPaths);
    expect(targets).toEqual(['pkg/sub/bar.py']);
  });

  it('best-effort resolves an absolute dotted "from" import against the workspace root', async () => {
    const content = 'from pkg.sub.bar import baz';
    const targets = await extractImportTargets('top.py', content, knownPaths);
    expect(targets).toEqual(['pkg/sub/bar.py']);
  });

  it('resolves a plain "import pkg.foo" the same way as a from-import', async () => {
    const content = 'import pkg.foo';
    const targets = await extractImportTargets('top.py', content, knownPaths);
    expect(targets).toEqual(['pkg/foo.py']);
  });

  it('resolves an aliased plain import ("import pkg.foo as f")', async () => {
    const content = 'import pkg.foo as f';
    const targets = await extractImportTargets('top.py', content, knownPaths);
    expect(targets).toEqual(['pkg/foo.py']);
  });

  it('drops unresolvable stdlib/third-party imports', async () => {
    const content = 'import os\nimport numpy';
    const targets = await extractImportTargets('top.py', content, knownPaths);
    expect(targets).toEqual([]);
  });
});

describe('extractImportTargets — non-AST-supported files', () => {
  it('returns empty for a language with no configured grammar', async () => {
    const targets = await extractImportTargets('README.md', '[link](./other.md)', new Set(['other.md']));
    expect(targets).toEqual([]);
  });
});
