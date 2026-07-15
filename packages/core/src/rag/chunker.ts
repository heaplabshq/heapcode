import { chunkFileAst, isAstSupported } from './astChunker.js';
import { fnv1a } from './hash.js';

export interface Chunk {
  path: string;
  /** 1-indexed, inclusive. */
  startLine: number;
  endLine: number;
  text: string;
  /** Content hash — the embedding cache key. */
  hash: string;
}

export { fnv1a } from './hash.js';

/** Lines that look like a good place to start a chunk (symbol boundaries). */
export const BOUNDARY =
  /^\s*(export\s+)?(default\s+)?(async\s+)?(function|class|interface|type|enum|const|def |fn |func |impl |struct |trait |public|private|protected )/;

export interface ChunkOptions {
  maxLines?: number;
  overlap?: number;
}

/**
 * Splits a file into overlapping line-window chunks, snapping chunk starts
 * to symbol-like boundaries when one is nearby. Used directly for languages
 * without a configured AST grammar, and as the fallback when AST chunking
 * (astChunker.ts) is unavailable or fails for a particular file.
 */
export function chunkFileByLines(path: string, content: string, opts: ChunkOptions = {}): Chunk[] {
  const maxLines = opts.maxLines ?? 60;
  const overlap = opts.overlap ?? 10;
  const lines = content.split('\n');
  if (lines.length === 0 || !content.trim()) return [];

  const chunks: Chunk[] = [];
  let start = 0;
  while (start < lines.length) {
    let end = Math.min(start + maxLines, lines.length);

    // If the window cuts mid-symbol, try to end just before a nearby boundary.
    if (end < lines.length) {
      for (let back = 0; back < Math.min(15, maxLines / 2); back++) {
        if (BOUNDARY.test(lines[end - back] ?? '')) {
          end = end - back;
          break;
        }
      }
      if (end <= start) end = Math.min(start + maxLines, lines.length);
    }

    const text = lines.slice(start, end).join('\n');
    if (text.trim()) {
      chunks.push({
        path,
        startLine: start + 1,
        endLine: end,
        text,
        hash: fnv1a(`${path}:${text}`),
      });
    }
    if (end >= lines.length) break;
    start = Math.max(end - overlap, start + 1);
  }
  return chunks;
}

/**
 * Splits a file into chunks. Tries AST-aware structural chunking first
 * (astChunker.ts) for languages with a configured grammar; falls back to
 * the line-window chunker for everything else, or if AST chunking isn't
 * wired up (see configureAstChunker) or fails for this particular file.
 */
export async function chunkFile(
  path: string,
  content: string,
  opts: ChunkOptions = {},
): Promise<Chunk[]> {
  if (isAstSupported(path)) {
    const chunks = await chunkFileAst(path, content, opts);
    if (chunks) return chunks;
  }
  return chunkFileByLines(path, content, opts);
}
