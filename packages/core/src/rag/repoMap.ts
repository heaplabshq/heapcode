import {
  extractImportTargets as extractImportTargetsWith,
  extractSymbols as extractSymbolsWith,
  type RepoSymbol,
} from '@heapcode/repomap';
import { parserForPath } from './astChunker.js';

/**
 * The repo mapper (@heapcode/repomap) bound to core's tree-sitter parser.
 *
 * The package takes its parser as a parameter — it has no dependency on
 * web-tree-sitter, and its parser-free regex fallback is a supported mode,
 * not a degraded one. Core is where a parser actually lives (astChunker's
 * host-configured wasm loader, shared with chunking and syntax checking), so
 * this is where the two get tied together: callers inside heapcode get
 * AST-quality symbols and a real import graph without knowing a seam exists.
 */
export function extractSymbols(path: string, content: string): Promise<RepoSymbol[]> {
  return extractSymbolsWith(path, content, parserForPath);
}

export function extractImportTargets(
  path: string,
  content: string,
  knownPaths: ReadonlySet<string>,
): Promise<string[]> {
  return extractImportTargetsWith(path, content, knownPaths, parserForPath);
}

export {
  centralityStats,
  formatRankingDebug,
  formatRepoMap,
  rankByCentrality,
  RepoMapIndexer,
  REPO_MAP_FILE,
  type CentralityStats,
  type FileSource,
  type ImportEdge,
  type ParserResolver,
  type RankBoost,
  type RankingDebugOptions,
  type RepoMapFileEntry,
  type RepoMapIndexerOptions,
  type RepoMapStore,
  type RepoSymbol,
} from '@heapcode/repomap';
