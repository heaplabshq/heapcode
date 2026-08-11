import {
  centralityStats,
  OPEN_FILE_BOOST,
  RECENT_FILE_BOOST,
  rankByCentrality,
  type ImportEdge,
  type RankBoost,
} from './rank.js';

export interface RankingDebugOptions {
  /** First line of the report — the host's own name for its repo map. */
  title: string;
  paths: readonly string[];
  edges: readonly ImportEdge[];
  boost?: RankBoost;
  /** Label for the open-files line and column. The whole column is omitted when `boost.openFiles` is absent (a host with no editor has nothing to put in it). */
  openLabel?: string;
  /** Label for the recent-files line — hosts differ on what "recent" means (saved in an editor, written by the agent, …). */
  recentLabel?: string;
}

interface Column {
  header: string;
  cell: (i: number) => string;
}

/**
 * Plain-text ranking breakdown: every ranked path with the score components
 * behind its position, straight from centralityStats — so you can see *why*
 * a file ranked where it did without going through an agent or an LLM at
 * all. A free function over the graph rather than a method on the indexer:
 * the inputs are just paths, edges and a boost, and anything that can
 * produce those (a test, a script, a one-off analysis) should be able to
 * render this without building an index first.
 */
export function formatRankingDebug(opts: RankingDebugOptions): string {
  const { title, paths, edges, boost = {} } = opts;
  const open = boost.openFiles ? new Set(boost.openFiles) : undefined;
  const recent = new Set(boost.recentFiles ?? []);
  const stats = centralityStats(paths, edges, boost);
  const ranked = rankByCentrality(paths, edges, boost);

  const list = (files: Set<string>) => (files.size ? [...files].join(', ') : '(none)');
  const lines = [title, `${paths.length} files indexed, ${edges.length} resolved import edges`];
  if (open) lines.push(`${opts.openLabel ?? 'Open files'} (+${OPEN_FILE_BOOST} each): ${list(open)}`);
  lines.push(`${opts.recentLabel ?? 'Recent files'} (+${RECENT_FILE_BOOST} each): ${list(recent)}`);
  lines.push('');

  const columns: Column[] = [
    { header: 'rank', cell: (i) => String(i + 1) },
    { header: 'score', cell: (i) => String(stats.get(ranked[i]!)!.score) },
    { header: 'in', cell: (i) => String(stats.get(ranked[i]!)!.inDegree) },
    { header: 'out', cell: (i) => String(stats.get(ranked[i]!)!.outDegree) },
    { header: 'boost', cell: (i) => String(stats.get(ranked[i]!)!.boost) },
  ];
  if (open) columns.push({ header: 'open', cell: (i) => (open.has(ranked[i]!) ? '●' : ' ') });
  columns.push({ header: 'recent', cell: (i) => (recent.has(ranked[i]!) ? '●' : ' ') });

  lines.push([...columns.map((c) => c.header), 'path'].join('  '));
  lines.push([...columns.map((c) => '-'.repeat(c.header.length)), '----'].join('  '));
  ranked.forEach((path, i) => {
    lines.push([...columns.map((c) => c.cell(i).padStart(c.header.length)), ' ' + path].join('  '));
  });
  return lines.join('\n');
}
