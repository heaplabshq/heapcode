import type { Node as TSNode } from 'web-tree-sitter';
import { isAstSupported, parserForPath } from './astChunker.js';

const MAX_CONTENT_LENGTH = 2_000_000;
const JS_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];
const PY_EXTENSIONS = ['.py'];

function dirname(p: string): string {
  const i = p.lastIndexOf('/');
  return i === -1 ? '' : p.slice(0, i);
}

/** Minimal POSIX path join/normalize (no node:path — core stays runtime-agnostic) that collapses "." and "..". */
function joinPosix(...parts: string[]): string {
  const out: string[] = [];
  for (const seg of parts.filter(Boolean).join('/').split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') out.pop();
    else out.push(seg);
  }
  return out.join('/');
}

function probeFile(base: string, knownPaths: ReadonlySet<string>, extensions: string[]): string | undefined {
  if (knownPaths.has(base)) return base;
  for (const ext of extensions) {
    if (knownPaths.has(base + ext)) return base + ext;
  }
  for (const ext of extensions) {
    const indexFile = joinPosix(base, `index${ext}`);
    if (knownPaths.has(indexFile)) return indexFile;
  }
  if (extensions === PY_EXTENSIONS) {
    const init = joinPosix(base, '__init__.py');
    if (knownPaths.has(init)) return init;
  }
  return undefined;
}

function resolveRelativeJs(fromPath: string, spec: string, knownPaths: ReadonlySet<string>): string | undefined {
  return probeFile(joinPosix(dirname(fromPath), spec), knownPaths, JS_EXTENSIONS);
}

/**
 * Python module resolution, best-effort: relative imports (`.foo`, `..foo.bar`,
 * `from . import x`) resolve precisely against the file's own directory —
 * one leading dot is the current package, each extra dot one level up.
 * Absolute dotted imports (`import foo.bar`) are searched from the workspace
 * root; unresolvable ones (stdlib, third-party packages) return undefined,
 * same as an unresolvable JS import — they're not part of the intra-repo graph.
 */
function resolvePythonModule(fromPath: string, spec: string, knownPaths: ReadonlySet<string>): string | undefined {
  if (spec.startsWith('.')) {
    let dots = 0;
    while (spec[dots] === '.') dots++;
    const rest = spec.slice(dots);
    let dir = dirname(fromPath);
    for (let level = 1; level < dots; level++) dir = dirname(dir);
    const restPath = rest ? rest.replace(/\./g, '/') : '';
    return probeFile(restPath ? joinPosix(dir, restPath) : dir, knownPaths, PY_EXTENSIONS);
  }
  return probeFile(spec.replace(/\./g, '/'), knownPaths, PY_EXTENSIONS);
}

function stringLiteralText(node: TSNode): string | undefined {
  const text = node.text;
  const quote = text[0];
  if (text.length >= 2 && (quote === '"' || quote === "'" || quote === '`') && text.endsWith(quote)) {
    return text.slice(1, -1);
  }
  return undefined;
}

/**
 * Raw, unresolved import specifiers pulled from the AST — e.g. "./foo",
 * "../bar", "os", "react". Covers ESM import/export-from, CommonJS require(),
 * and Python import/from-import. Node types are matched directly (not the
 * convention-based approach symbols.ts uses for declarations) since "import"
 * has no shared structural convention across grammars — JS's import_statement
 * and Python's import_statement are unrelated shapes that happen to share a
 * name, which is exactly why this only pulls a field when it's actually
 * present rather than assuming a common one.
 */
/** The dotted-name / aliased-import children of a Python import statement — the actual imported module names. */
function collectDottedNames(node: TSNode, exclude: TSNode | null): string[] {
  const out: string[] = [];
  for (const child of node.namedChildren) {
    if (!child || child === exclude) continue;
    if (child.type === 'dotted_name') out.push(child.text);
    else if (child.type === 'aliased_import') {
      const name = child.childForFieldName('name');
      if (name) out.push(name.text);
    }
  }
  return out;
}

function walk(node: TSNode, out: string[]): void {
  switch (node.type) {
    case 'import_statement': {
      // JS/TS: `import x from '...'` / side-effect `import '...'` — has a `source` field.
      const source = node.childForFieldName('source');
      if (source) {
        const spec = stringLiteralText(source);
        if (spec) out.push(spec);
      } else {
        // Python: bare `import pkg.sub[, other.pkg][ as alias]` — no `source`, one or
        // more dotted_name/aliased_import children carrying the module path(s) instead.
        out.push(...collectDottedNames(node, null));
      }
      break;
    }
    case 'export_statement': {
      const source = node.childForFieldName('source');
      if (source) {
        const spec = stringLiteralText(source);
        if (spec) out.push(spec);
      }
      break;
    }
    case 'call_expression': {
      const fn = node.childForFieldName('function');
      if (fn?.text === 'require' || fn?.text === 'import') {
        const args = node.childForFieldName('arguments');
        const first = args?.namedChildren[0];
        const spec = first ? stringLiteralText(first) : undefined;
        if (spec) out.push(spec);
      }
      break;
    }
    case 'import_from_statement': {
      // Python: `from X import a, b`. When X is bare dots ("." / ".." / …) — `from .
      // import foo` — the imported names ARE the sibling modules, so resolve each of
      // those instead of the dots alone; a non-bare X ("from .foo import bar") already
      // names the target module directly and the imported symbols don't matter here.
      const moduleNode = node.childForFieldName('module_name');
      if (moduleNode) {
        const bareDots = moduleNode.type === 'relative_import' && /^\.+$/.test(moduleNode.text);
        if (bareDots) {
          for (const name of collectDottedNames(node, moduleNode)) out.push(moduleNode.text + name);
        } else {
          out.push(moduleNode.text);
        }
      }
      break;
    }
  }
  for (const child of node.namedChildren) {
    if (child) walk(child, out);
  }
}

async function extractRawImports(path: string, content: string): Promise<string[]> {
  if (!isAstSupported(path) || !content.trim() || content.length > MAX_CONTENT_LENGTH) return [];
  const parser = await parserForPath(path);
  if (!parser) return [];
  try {
    const tree = parser.parse(content);
    if (!tree) return [];
    const out: string[] = [];
    walk(tree.rootNode, out);
    return out;
  } catch {
    return [];
  }
}

/**
 * This file's intra-repo import edges, resolved against `knownPaths` (every
 * indexed file's workspace-relative path). External packages/stdlib imports
 * that don't resolve to a known file are dropped — they're not part of the
 * dependency graph repo_map ranks by. Deduplicated; never throws.
 */
export async function extractImportTargets(
  path: string,
  content: string,
  knownPaths: ReadonlySet<string>,
): Promise<string[]> {
  const raw = await extractRawImports(path, content);
  if (raw.length === 0) return [];
  const isPython = path.toLowerCase().endsWith('.py');
  const resolved = new Set<string>();
  for (const spec of raw) {
    const target = isPython
      ? resolvePythonModule(path, spec, knownPaths)
      : spec.startsWith('.')
        ? resolveRelativeJs(path, spec, knownPaths)
        : undefined;
    if (target && target !== path) resolved.add(target);
  }
  return [...resolved];
}
