export interface DiffStats {
  added: number;
  removed: number;
}

/**
 * Approximate added/removed line counts via line-frequency matching —
 * fast and good enough for "+12 −3" badges (not a real diff).
 */
export function lineDiffStats(oldText: string, newText: string): DiffStats {
  const oldLines = oldText.split('\n');
  const newLines = newText.split('\n');
  const pool = new Map<string, number>();
  for (const line of oldLines) pool.set(line, (pool.get(line) ?? 0) + 1);
  let unchanged = 0;
  for (const line of newLines) {
    const count = pool.get(line) ?? 0;
    if (count > 0) {
      pool.set(line, count - 1);
      unchanged++;
    }
  }
  return { added: newLines.length - unchanged, removed: oldLines.length - unchanged };
}
