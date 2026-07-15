import type { VectorRecord } from './store.js';

const K1 = 1.5;
const B = 0.75;

/**
 * Lowercases, splits on non-alphanumeric boundaries, and also splits
 * camelCase / snake_case / kebab-case identifiers into sub-words — so a
 * query for "role profile" matches `resolveRoleProfile`. This matters far
 * more for code search than prose search.
 */
export function tokenize(text: string): string[] {
  const withBoundaries = text
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2') // camelCase -> camel Case
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2'); // HTTPServer -> HTTP Server
  return withBoundaries
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1);
}

/**
 * Okapi BM25 (k1=1.5, b=0.75) over each record's `context + text`, computed
 * fresh per call rather than maintained as a persistent index — the same
 * brute-force philosophy as VectorStore's cosine scan, and the same
 * asymptotic cost, so it doesn't change the "comfortable to ~50k chunks"
 * ceiling that already applies to search().
 */
export function bm25Scores(records: VectorRecord[], queryTerms: string[]): Map<VectorRecord, number> {
  const scores = new Map<VectorRecord, number>();
  const uniqueQueryTerms = [...new Set(queryTerms)];
  if (uniqueQueryTerms.length === 0 || records.length === 0) return scores;

  const docTokens = records.map((r) => tokenize(`${r.context ?? ''} ${r.text}`));
  const docLengths = docTokens.map((t) => t.length);
  const avgDocLength = docLengths.reduce((a, b) => a + b, 0) / records.length || 1;

  const docFreq = new Map<string, number>();
  const termFreqs: Array<Map<string, number>> = docTokens.map((tokens) => {
    const tf = new Map<string, number>();
    for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
    return tf;
  });
  for (const term of uniqueQueryTerms) {
    let df = 0;
    for (const tf of termFreqs) if (tf.has(term)) df++;
    docFreq.set(term, df);
  }

  records.forEach((record, i) => {
    let score = 0;
    const tf = termFreqs[i]!;
    const docLength = docLengths[i]!;
    for (const term of uniqueQueryTerms) {
      const freq = tf.get(term);
      if (!freq) continue;
      const df = docFreq.get(term)!;
      const idf = Math.log(1 + (records.length - df + 0.5) / (df + 0.5));
      score += (idf * (freq * (K1 + 1))) / (freq + K1 * (1 - B + (B * docLength) / avgDocLength));
    }
    if (score > 0) scores.set(record, score);
  });
  return scores;
}
