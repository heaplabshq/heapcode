import { existsSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import pkg from '../package.json' with { type: 'json' };

/**
 * The browser-safe subpaths must stay buildable by a host that has no Node.
 *
 * `@heapcode/core/agent`, `/providers` and `/context` exist so hosts like an MV3
 * extension can take the agent loop and the provider layer without the package
 * barrel's Node-coupled modules — `workspaceTools` shells out, `server/` opens
 * sockets, `node/fs` touches the disk. Importing any of those from a browser
 * bundle is a build failure, not a runtime one, so nothing catches it until
 * someone tries to ship the extension.
 *
 * The eslint rule in `eslint.config.mjs` guards the direct case. It cannot guard
 * the case that actually happens: a browser-safe module importing a sibling that
 * imports a sibling that imports `node:child_process`. `agent/webSearch.ts` is
 * exactly that shape today. So this walks the real transitive graph from each
 * barrel and asserts the whole closure is clean.
 */

const CORE = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Import specifiers, with comments and string bodies excluded.
 *
 * A regex over raw source finds prose — core's own comments contain quoted
 * phrases like "things the user asked for", which a naive scan reports as an
 * external package. Missing a real import in a safety check is the worse
 * failure, so this scans rather than pattern-matches: comments are dropped with
 * string state tracked, so a `//` inside a URL does not eat the line, and every
 * literal is replaced by an index so its own punctuation cannot pair with a
 * later quote.
 */
function importSpecifiers(source: string): string[] {
  const literals: string[] = [];
  let out = '';
  let i = 0;
  while (i < source.length) {
    const c = source[i];
    const next = source[i + 1];
    if (c === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') i++;
    } else if (c === '/' && next === '*') {
      i += 2;
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) i++;
      i += 2;
    } else if (c === '"' || c === "'" || c === '`') {
      const quote = c;
      i++;
      let body = '';
      while (i < source.length && source[i] !== quote) {
        if (source[i] === '\\') {
          body += source[i + 1] ?? '';
          i += 2;
          continue;
        }
        body += source[i];
        i++;
      }
      i++;
      // Stand every literal down to an index. Keeping the body would leak its
      // punctuation into the scan: an apostrophe inside a double-quoted string
      // ("can't") pairs with the next quote and turns the prose between them
      // into a phantom import specifier.
      literals.push(body);
      out += `\u0000${literals.length - 1}\u0000`;
    } else {
      out += c;
      i++;
    }
  }

  // Every index came from a capture group this function itself emitted, so a
  // miss means the scan and the patterns have drifted apart — say so loudly
  // rather than pushing undefined into the results.
  const at = (token: string): string => {
    const literal = literals[Number(token)];
    if (literal === undefined) throw new Error(`no literal recorded for placeholder ${token}`);
    return literal;
  };
  const specs: string[] = [];
  // `import x from 's'` / `export * from 's'` / `import 's'`
  const statement = /(?:^|[\s;}])(?:import|export)\s*(?:[^\u0000]*?\sfrom\s*|\s*)?\u0000(\d+)\u0000/g;
  for (const m of out.matchAll(statement)) if (m[1]) specs.push(at(m[1]));
  const dynamic = /\bimport\s*\(\s*\u0000(\d+)\u0000\s*\)/g;
  for (const m of out.matchAll(dynamic)) if (m[1]) specs.push(at(m[1]));
  return specs;
}

function resolveRelative(spec: string, fromFile: string): string | undefined {
  let p = resolve(dirname(fromFile), spec);
  if (p.endsWith('.js')) p = `${p.slice(0, -3)}.ts`; // NodeNext specifiers point at emitted .js
  if (existsSync(p) && !p.endsWith('.json')) return p;
  if (existsSync(`${p}.ts`)) return `${p}.ts`;
  const asIndex = resolve(p, 'index.ts');
  if (existsSync(asIndex)) return asIndex;
  return undefined;
}

interface Closure {
  files: string[];
  external: { spec: string; importer: string }[];
  unresolved: { spec: string; importer: string }[];
}

function walk(entry: string): Closure {
  const seen = new Set<string>();
  const external: Closure['external'] = [];
  const unresolved: Closure['unresolved'] = [];
  const queue = [resolve(CORE, entry)];

  while (queue.length) {
    const file = queue.pop() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    const here = relative(CORE, file);
    for (const spec of importSpecifiers(readFileSync(file, 'utf8'))) {
      if (spec.startsWith('.')) {
        const target = resolveRelative(spec, file);
        if (target) queue.push(target);
        else unresolved.push({ spec, importer: here });
      } else {
        external.push({ spec, importer: here });
      }
    }
  }

  return { files: [...seen].map((f) => relative(CORE, f)).sort(), external, unresolved };
}

/** Subpaths a host without Node must be able to import. */
const BROWSER_SAFE = ['./agent', './providers', './context'] as const;

function entryFor(subpath: string): string {
  const entry = (pkg.exports as Record<string, { default: string }>)[subpath];
  if (!entry) throw new Error(`package.json has no "${subpath}" export`);
  return entry.default;
}

describe('browser-safe subpath exports', () => {
  for (const subpath of BROWSER_SAFE) {
    describe(`@heapcode/core${subpath.slice(1)}`, () => {
      it('is declared in package.json and points at a file that exists', () => {
        const entry = entryFor(subpath);
        expect(existsSync(resolve(CORE, entry))).toBe(true);
      });

      it('reaches no Node builtin anywhere in its import graph', () => {
        const { external } = walk(entryFor(subpath));
        const node = external.filter((e) => e.spec.startsWith('node:'));
        expect(node.map((e) => `${e.importer} -> ${e.spec}`)).toEqual([]);
      });

      it('reaches no external package anywhere in its import graph', () => {
        // Nothing in the browser-safe surface needs a dependency today. An npm
        // package is how Node coupling sneaks back in without the word "node"
        // appearing — `agent/mcp.ts` pulls `node:child_process` through the MCP
        // SDK's stdio transport. Adding one here means checking it bundles for
        // the browser first.
        const { external } = walk(entryFor(subpath));
        expect(external.map((e) => `${e.importer} -> ${e.spec}`)).toEqual([]);
      });

      it('resolves every relative import', () => {
        const { unresolved } = walk(entryFor(subpath));
        expect(unresolved.map((u) => `${u.importer} -> ${u.spec}`)).toEqual([]);
      });
    });
  }

  it('keeps the Node-coupled agent modules out of the browser-safe closure', () => {
    const reachable = new Set(BROWSER_SAFE.flatMap((s) => walk(entryFor(s)).files));
    for (const forbidden of [
      'src/agent/workspaceTools.ts',
      'src/agent/webSearch.ts',
      'src/agent/mcp.ts',
      'src/net/safeFetch.ts',
      'src/node/fs.ts',
    ]) {
      expect(reachable.has(forbidden)).toBe(false);
    }
  });

  it('still exposes the Node-only surface under its own subpath', () => {
    const entry = (pkg.exports as Record<string, { default: string } | undefined>)['./node'];
    expect(entry).toBeDefined();
    expect(existsSync(resolve(CORE, entry!.default))).toBe(true);
  });

  it('marks the package side-effect free so bundlers can tree-shake it', () => {
    expect(pkg.sideEffects).toBe(false);
  });
});
