/**
 * Quick Open's matching: every typed character in order, case-insensitive.
 * Higher is better — a prefix beats a word start beats letters scattered
 * through the title, and shorter titles win ties.
 */
export function fuzzyScore(query: string, text: string): number | null {
  const q = query.trim().toLowerCase();
  if (!q) return 0;
  const t = text.toLowerCase();
  if (t.startsWith(q)) return 1000 - t.length;
  const at = t.indexOf(q);
  if (at >= 0) return (/\W/.test(t[at - 1] ?? ' ') ? 800 : 600) - at - t.length / 100;
  let score = 0;
  let from = 0;
  let prev = -2;
  for (const ch of q) {
    if (ch === ' ') continue;
    const i = t.indexOf(ch, from);
    if (i === -1) return null;
    score += i === prev + 1 ? 6 : /\W/.test(t[i - 1] ?? ' ') ? 4 : 1;
    prev = i;
    from = i + 1;
  }
  return score - t.length / 100;
}

export function fuzzyFilter<T>(
  query: string,
  items: T[],
  text: (item: T) => string,
  limit = 50,
): T[] {
  if (!query.trim()) return items.slice(0, limit);
  return items
    .map((item) => ({ item, score: fuzzyScore(query, text(item)) }))
    .filter((x): x is { item: T; score: number } => x.score !== null)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((x) => x.item);
}
