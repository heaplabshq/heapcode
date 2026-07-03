export interface Chunk {
  path: string;
  /** 1-indexed, inclusive. */
  startLine: number;
  endLine: number;
  text: string;
  /** Content hash — the embedding cache key. */
  hash: string;
}

/** Lines that look like a good place to start a chunk (symbol boundaries). */
const BOUNDARY =
  /^\s*(export\s+)?(default\s+)?(async\s+)?(function|class|interface|type|enum|const|def |fn |func |impl |struct |trait |public |private |protected )/;

export interface ChunkOptions {
  maxLines?: number;
  overlap?: number;
}

/**
 * Splits a file into overlapping line-window chunks, snapping chunk starts
 * to symbol-like boundaries when one is nearby. (Tree-sitter-precise
 * boundaries can replace this behind the same interface later.)
 */
export function chunkFile(path: string, content: string, opts: ChunkOptions = {}): Chunk[] {
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

/** FNV-1a 32-bit, hex string — fast, stable content hash. */
export function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}
