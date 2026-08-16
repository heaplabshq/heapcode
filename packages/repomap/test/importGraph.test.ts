import { describe, expect, it } from 'vitest';
import { extractImportTargets } from '../src/importGraph.js';

/**
 * Relative-import resolution, and the TypeScript ESM case in particular.
 *
 * A specifier names the *emitted* file, so idiomatic TS ESM source imports
 * `./x.js` from a file that is `./x.ts` on disk. Resolution used to only
 * append extensions, so those probed as `x.js`, `x.js.ts`, `x.js.tsx`… and
 * matched nothing: a whole repo of TS ESM produced an import graph with
 * essentially no edges, which silently collapsed the repo map's
 * centrality ranking to alphabetical order.
 */

/** Minimal stand-in for tree-sitter — one import node, shaped as SyntaxNode. */
function parserWithImport(spec: string) {
  const source = { type: 'string_fragment', text: spec, namedChildren: [], childForFieldName: () => undefined };
  const literal = { type: 'string', text: `'${spec}'`, namedChildren: [source], childForFieldName: () => undefined };
  const statement = {
    type: 'import_statement',
    text: `import x from '${spec}';`,
    namedChildren: [literal],
    childForFieldName: (f: string) => (f === 'source' ? literal : undefined),
  };
  const root = {
    type: 'program',
    text: '',
    namedChildren: [statement],
    childForFieldName: () => undefined,
  };
  return () => Promise.resolve({ parse: () => ({ rootNode: root }) } as never);
}

const known = new Set(['src/a.ts', 'src/b.ts', 'src/c.tsx', 'src/d.mts', 'src/legacy.js', 'src/dir/index.ts']);

async function resolve(spec: string): Promise<string[]> {
  return extractImportTargets('src/a.ts', `import x from '${spec}';`, known, parserWithImport(spec));
}

describe('relative import resolution', () => {
  it('resolves a .js specifier to the .ts file it is emitted from', async () => {
    expect(await resolve('./b.js')).toEqual(['src/b.ts']);
  });

  it('resolves .js to .tsx, and .mjs to .mts', async () => {
    expect(await resolve('./c.js')).toEqual(['src/c.tsx']);
    expect(await resolve('./d.mjs')).toEqual(['src/d.mts']);
  });

  it('still prefers a real .js file when one actually exists', async () => {
    // The rewrite must not shadow a genuine JavaScript file of the same name.
    expect(await resolve('./legacy.js')).toEqual(['src/legacy.js']);
  });

  it('still handles extensionless and directory specifiers', async () => {
    expect(await resolve('./b')).toEqual(['src/b.ts']);
    expect(await resolve('./dir')).toEqual(['src/dir/index.ts']);
  });

  it('leaves bare package specifiers out of the intra-repo graph', async () => {
    expect(await resolve('@heapcode/core')).toEqual([]);
    expect(await resolve('node:fs')).toEqual([]);
  });

  it('resolves nothing that is not in the index', async () => {
    expect(await resolve('./missing.js')).toEqual([]);
  });
});
