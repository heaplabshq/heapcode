import type { Node as TSNode } from 'web-tree-sitter';
import { isAstSupported, parserForPath } from './astChunker.js';
import { BOUNDARY } from './chunker.js';

export interface RepoSymbol {
  name: string;
  /** Tree-sitter node type (e.g. "function_declaration"), or "line" for the regex fallback. */
  kind: string;
  /** 1-indexed. */
  line: number;
}

export interface RepoMapFileEntry {
  path: string;
  symbols: RepoSymbol[];
}

const MAX_CONTENT_LENGTH = 2_000_000;
const MAX_DEPTH = 5;
const DECLARATION_TYPE = /(declaration|definition)$/;

function isDeclarationLike(node: TSNode): boolean {
  return DECLARATION_TYPE.test(node.type) || node.type === 'method_definition';
}

/** Recurse into class-like containers to find methods, not into function bodies (which also have named locals). */
function isContainerLike(node: TSNode): boolean {
  return /class/.test(node.type);
}

function walk(node: TSNode, depth: number, out: RepoSymbol[]): void {
  if (depth > MAX_DEPTH) return;
  for (const child of node.namedChildren) {
    if (!child) continue;
    const nameNode = child.childForFieldName('name');
    if (nameNode && isDeclarationLike(child)) {
      out.push({ name: nameNode.text, kind: child.type, line: child.startPosition.row + 1 });
      if (isContainerLike(child)) walk(child, depth + 1, out);
    } else {
      walk(child, depth + 1, out);
    }
  }
}

/**
 * AST-based symbol extraction: declaration-shaped nodes (type ending in
 * "declaration"/"definition", or "method_definition") that have
 * tree-sitter's standard `name` field — a convention that holds across the
 * TS/TSX/JS/JSX/Python grammars without a hand-maintained node-type list per
 * language. Returns undefined (never throws) when this file's language has
 * no configured grammar or parsing fails — the caller falls back to the
 * regex-based extractor, same contract as chunkFileAst/chunkFileByLines.
 */
async function extractSymbolsAst(path: string, content: string): Promise<RepoSymbol[] | undefined> {
  if (!content.trim()) return [];
  if (content.length > MAX_CONTENT_LENGTH) return undefined;

  const parser = await parserForPath(path);
  if (!parser) return undefined;

  try {
    const tree = parser.parse(content);
    if (!tree) return undefined;
    const out: RepoSymbol[] = [];
    walk(tree.rootNode, 0, out);
    return out;
  } catch {
    return undefined;
  }
}

/** Weaker fallback for unsupported languages / parse failure: lines that look like a declaration. */
function extractSymbolsByLines(content: string): RepoSymbol[] {
  const symbols: RepoSymbol[] = [];
  content.split('\n').forEach((line, i) => {
    if (BOUNDARY.test(line)) {
      symbols.push({ name: line.trim().slice(0, 80), kind: 'line', line: i + 1 });
    }
  });
  return symbols;
}

/** Extracts a file's top-level symbols for the repo map. Tries AST-based extraction first, falls back to regex. */
export async function extractSymbols(path: string, content: string): Promise<RepoSymbol[]> {
  if (isAstSupported(path)) {
    const symbols = await extractSymbolsAst(path, content);
    if (symbols) return symbols;
  }
  return extractSymbolsByLines(content);
}

const DEFAULT_BUDGET_CHARS = 8_000;

/**
 * Formats per-file symbol lists into the text handed to the agent, budgeted
 * with a truncation note. Without `rank`, files are alphabetical (the
 * original behavior). With `rank` (a path priority order — most-relevant
 * first, from e.g. rankByCentrality), entries are ordered by their position
 * in it instead — this is what actually matters once the budget forces
 * truncation: the most-connected/most-relevant files should survive the cut,
 * not just whatever sorts first alphabetically. Paths missing from `rank`
 * (nothing indexed for them, or the graph couldn't place them) fall to the
 * end, alphabetical among themselves.
 */
export function formatRepoMap(
  entries: RepoMapFileEntry[],
  opts: { pathPrefix?: string; budgetChars?: number; rank?: readonly string[] } = {},
): string {
  const budget = opts.budgetChars ?? DEFAULT_BUDGET_CHARS;
  const rankIndex = opts.rank ? new Map(opts.rank.map((p, i) => [p, i])) : undefined;
  const filtered = (opts.pathPrefix ? entries.filter((e) => e.path.startsWith(opts.pathPrefix!)) : entries)
    .filter((e) => e.symbols.length > 0)
    .sort((a, b) => {
      if (rankIndex) {
        const ra = rankIndex.get(a.path) ?? Number.MAX_SAFE_INTEGER;
        const rb = rankIndex.get(b.path) ?? Number.MAX_SAFE_INTEGER;
        if (ra !== rb) return ra - rb;
      }
      return a.path.localeCompare(b.path);
    });

  const parts: string[] = [];
  let used = 0;
  for (let i = 0; i < filtered.length; i++) {
    const entry = filtered[i]!;
    const block =
      `${entry.path}\n` +
      entry.symbols.map((s) => `  ${s.kind} ${s.name} (line ${s.line})`).join('\n') +
      '\n';
    if (used + block.length > budget) {
      parts.push(`…[truncated — ${filtered.length - i} more file(s) not shown]`);
      break;
    }
    parts.push(block);
    used += block.length;
  }
  return parts.join('\n');
}
