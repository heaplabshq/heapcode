export interface ImportEdge {
  from: string;
  to: string;
}

/** Personalization boost applied on top of raw centrality — additive, so it works even for a zero-edge file (e.g. an open leaf UI component nothing imports). */
export interface RankBoost {
  openFiles?: Iterable<string>;
  recentFiles?: Iterable<string>;
}

export const OPEN_FILE_BOOST = 50;
export const RECENT_FILE_BOOST = 20;

export interface CentralityStats {
  inDegree: number;
  outDegree: number;
  boost: number;
  score: number;
}

/**
 * Per-file score breakdown behind rankByCentrality's ordering — in-degree,
 * out-degree, personalization boost, and the combined score. Exposed
 * separately (rather than folded silently into the sort) so a debug/
 * inspection view can show *why* a file ranked where it did, not just the
 * final order.
 */
export function centralityStats(
  paths: readonly string[],
  edges: readonly ImportEdge[],
  boost: RankBoost = {},
): Map<string, CentralityStats> {
  const inDegree = new Map<string, number>();
  const outDegree = new Map<string, number>();
  for (const { from, to } of edges) {
    inDegree.set(to, (inDegree.get(to) ?? 0) + 1);
    outDegree.set(from, (outDegree.get(from) ?? 0) + 1);
  }
  const boosted = new Map<string, number>();
  for (const p of boost.openFiles ?? []) boosted.set(p, (boosted.get(p) ?? 0) + OPEN_FILE_BOOST);
  for (const p of boost.recentFiles ?? []) boosted.set(p, (boosted.get(p) ?? 0) + RECENT_FILE_BOOST);

  const out = new Map<string, CentralityStats>();
  for (const p of paths) {
    const inD = inDegree.get(p) ?? 0;
    const outD = outDegree.get(p) ?? 0;
    const b = boosted.get(p) ?? 0;
    out.set(p, { inDegree: inD, outDegree: outD, boost: b, score: inD * 2 + outD + b });
  }
  return out;
}

/**
 * Degree-centrality ranking over the intra-repo import graph — simpler than
 * PageRank, and enough to answer "which files does the rest of the repo
 * actually depend on" (PLAN.md M11's own stated bar: "degree-centrality
 * first"). In-degree (how many files import this one) counts double against
 * out-degree (how many files this one imports): being widely depended-upon
 * is a stronger "this file matters" signal than importing a lot yourself.
 */
export function rankByCentrality(paths: readonly string[], edges: readonly ImportEdge[], boost: RankBoost = {}): string[] {
  const stats = centralityStats(paths, edges, boost);
  const score = (p: string) => stats.get(p)?.score ?? 0;
  return [...paths].sort((a, b) => score(b) - score(a) || a.localeCompare(b));
}
