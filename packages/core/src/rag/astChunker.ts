import { Parser, Language, type Node as TSNode } from 'web-tree-sitter';
import type { Chunk, ChunkOptions } from './chunker.js';
import { fnv1a } from './hash.js';

/** File extension -> tree-sitter grammar id (grammar wasm is tree-sitter-<id>.wasm). */
const LANGUAGE_BY_EXT: Record<string, string> = {
  '.ts': 'typescript',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.tsx': 'tsx',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.py': 'python',
};

/** Defensive only — real callers filter by MAX_FILE_BYTES well before this. */
const MAX_CONTENT_LENGTH = 2_000_000;

function extOf(path: string): string {
  const i = path.lastIndexOf('.');
  return i === -1 ? '' : path.slice(i).toLowerCase();
}

export function isAstSupported(path: string): boolean {
  return extOf(path) in LANGUAGE_BY_EXT;
}

/**
 * Resolves a wasm asset filename (e.g. "tree-sitter.wasm",
 * "tree-sitter-python.wasm") to a loadable path. Host-supplied: only the
 * host (VS Code, a future JetBrains/Neovim adapter, ...) reliably knows
 * where its own bundled assets live at runtime, so `core` never resolves
 * its own paths — see configureAstChunker.
 */
export type WasmResolver = (filename: string) => string;

let resolveWasm: WasmResolver | undefined;
let initPromise: Promise<void> | undefined;
const languageCache = new Map<string, Promise<Language | undefined>>();

/**
 * Wires up grammar loading for AST-aware chunking. Until this is called (or
 * if called with undefined), chunkFile() always uses the line-window
 * chunker — a safe no-op default for hosts and tests that haven't set one
 * up, not a failure state.
 */
export function configureAstChunker(resolver: WasmResolver | undefined): void {
  resolveWasm = resolver;
  initPromise = undefined;
  languageCache.clear();
}

function initParser(): Promise<void> {
  if (!resolveWasm) return Promise.reject(new Error('AST chunker not configured'));
  if (!initPromise) {
    const resolver = resolveWasm;
    initPromise = Parser.init({ locateFile: () => resolver('tree-sitter.wasm') });
  }
  return initPromise;
}

function loadLanguage(id: string): Promise<Language | undefined> {
  let cached = languageCache.get(id);
  if (!cached) {
    cached = (async () => {
      const resolver = resolveWasm;
      if (!resolver) return undefined;
      await initParser();
      return await Language.load(resolver(`tree-sitter-${id}.wasm`));
    })().catch(() => undefined);
    languageCache.set(id, cached);
  }
  return cached;
}

function lineSpan(node: TSNode): number {
  return node.endPosition.row - node.startPosition.row + 1;
}

/** Recursively descend into oversized nodes until each piece fits the line budget. */
function collectLeaves(node: TSNode, maxLines: number, out: TSNode[]): void {
  if (lineSpan(node) <= maxLines) {
    out.push(node);
    return;
  }
  const children = node.namedChildren.filter((c): c is TSNode => c != null);
  if (children.length === 0) {
    out.push(node); // unsplittable oversized leaf (e.g. one huge literal)
    return;
  }
  for (const child of children) collectLeaves(child, maxLines, out);
}

/**
 * AST-aware structural chunking (cAST-style): parse the file, recursively
 * split oversized nodes and greedily merge small sibling leaves under the
 * line budget, so chunk boundaries land on real syntactic edges instead of
 * an arbitrary line count. Language-invariant — no per-language node-type
 * lists, so the same code path covers every configured grammar.
 *
 * Returns undefined (never throws) when this file's language has no
 * configured grammar, no loader is wired up, or parsing fails for any
 * reason — the caller falls back to the line-window chunker.
 */
export async function chunkFileAst(
  path: string,
  content: string,
  opts: ChunkOptions = {},
): Promise<Chunk[] | undefined> {
  if (!content.trim()) return [];
  if (content.length > MAX_CONTENT_LENGTH) return undefined;

  const id = LANGUAGE_BY_EXT[extOf(path)];
  if (!id || !resolveWasm) return undefined;

  const language = await loadLanguage(id);
  if (!language) return undefined;

  try {
    const parser = new Parser();
    parser.setLanguage(language);
    const tree = parser.parse(content);
    if (!tree) return undefined;

    const maxLines = opts.maxLines ?? 60;
    const lines = content.split('\n');
    const leaves: TSNode[] = [];
    collectLeaves(tree.rootNode, maxLines, leaves);
    if (leaves.length === 0) return [];

    // Boundaries come from each leaf's start row only (not its own end row):
    // a chunk runs from its own start up to just before the next chunk's
    // start, so gaps between named children (blank lines, comments,
    // punctuation) are absorbed into the preceding chunk rather than
    // dropped, and multiple leaves starting on the same source line
    // collapse into one boundary instead of producing empty ranges.
    const starts = leaves.map((leaf, i) => (i === 0 ? 0 : leaf.startPosition.row));
    const uniqueStarts = starts.filter((s, i) => i === 0 || s !== starts[i - 1]);
    const bounds = uniqueStarts.map((start, i) => ({
      start,
      end: i === uniqueStarts.length - 1 ? lines.length - 1 : uniqueStarts[i + 1]! - 1,
    }));

    // Greedily merge consecutive small leaves under the same budget.
    const merged: Array<{ start: number; end: number }> = [];
    for (const b of bounds) {
      const last = merged[merged.length - 1];
      if (last && b.end - last.start + 1 <= maxLines) {
        last.end = b.end;
      } else {
        merged.push({ ...b });
      }
    }

    return merged.map(({ start, end }) => {
      const text = lines.slice(start, end + 1).join('\n');
      return { path, startLine: start + 1, endLine: end + 1, text, hash: fnv1a(`${path}:${text}`) };
    });
  } catch {
    return undefined;
  }
}
