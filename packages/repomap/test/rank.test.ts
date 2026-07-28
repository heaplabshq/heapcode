import { describe, expect, it } from 'vitest';
import { centralityStats, rankByCentrality } from '../src/rank.js';

describe('rankByCentrality', () => {
  it('ranks a widely-imported file above files nothing depends on', () => {
    const paths = ['util.ts', 'a.ts', 'b.ts', 'c.ts'];
    const edges = [
      { from: 'a.ts', to: 'util.ts' },
      { from: 'b.ts', to: 'util.ts' },
      { from: 'c.ts', to: 'util.ts' },
    ];
    const ranked = rankByCentrality(paths, edges);
    expect(ranked[0]).toBe('util.ts');
  });

  it('weighs in-degree above out-degree', () => {
    // hub.ts is imported by 2 files (in-degree 2); importer.ts imports 3 files (out-degree 3).
    // in-degree counts double, so hub.ts (score 4) should still rank above importer.ts (score 3).
    const paths = ['hub.ts', 'importer.ts', 'x.ts', 'y.ts', 'z.ts'];
    const edges = [
      { from: 'p.ts', to: 'hub.ts' },
      { from: 'q.ts', to: 'hub.ts' },
      { from: 'importer.ts', to: 'x.ts' },
      { from: 'importer.ts', to: 'y.ts' },
      { from: 'importer.ts', to: 'z.ts' },
    ];
    const ranked = rankByCentrality(paths, edges);
    expect(ranked.indexOf('hub.ts')).toBeLessThan(ranked.indexOf('importer.ts'));
  });

  it('open files rank above everything else, even with no import edges at all', () => {
    const paths = ['hub.ts', 'leaf.ts'];
    const edges = [
      { from: 'a.ts', to: 'hub.ts' },
      { from: 'b.ts', to: 'hub.ts' },
    ];
    const ranked = rankByCentrality(paths, edges, { openFiles: ['leaf.ts'] });
    expect(ranked[0]).toBe('leaf.ts');
  });

  it('open-file boost outranks recent-file boost', () => {
    const paths = ['open.ts', 'recent.ts'];
    const ranked = rankByCentrality(paths, [], { openFiles: ['open.ts'], recentFiles: ['recent.ts'] });
    expect(ranked).toEqual(['open.ts', 'recent.ts']);
  });

  it('falls back to alphabetical order for equal scores', () => {
    const ranked = rankByCentrality(['zeta.ts', 'alpha.ts', 'mid.ts'], []);
    expect(ranked).toEqual(['alpha.ts', 'mid.ts', 'zeta.ts']);
  });

  it('is a pure function — does not mutate the input paths array', () => {
    const paths = ['b.ts', 'a.ts'];
    rankByCentrality(paths, []);
    expect(paths).toEqual(['b.ts', 'a.ts']);
  });
});

describe('centralityStats', () => {
  it('reports the exact in/out-degree and boost that produce rankByCentrality\'s score', () => {
    const paths = ['hub.ts', 'leaf.ts'];
    const edges = [
      { from: 'a.ts', to: 'hub.ts' },
      { from: 'b.ts', to: 'hub.ts' },
      { from: 'hub.ts', to: 'leaf.ts' },
    ];
    const stats = centralityStats(paths, edges, { openFiles: ['leaf.ts'] });
    expect(stats.get('hub.ts')).toEqual({ inDegree: 2, outDegree: 1, boost: 0, score: 5 });
    expect(stats.get('leaf.ts')).toEqual({ inDegree: 1, outDegree: 0, boost: 50, score: 52 });
  });

  it('is consistent with rankByCentrality\'s actual ordering', () => {
    const paths = ['a.ts', 'b.ts', 'c.ts'];
    const edges = [
      { from: 'x.ts', to: 'a.ts' },
      { from: 'y.ts', to: 'a.ts' },
      { from: 'z.ts', to: 'b.ts' },
    ];
    const ranked = rankByCentrality(paths, edges);
    const stats = centralityStats(paths, edges);
    const scores = ranked.map((p) => stats.get(p)!.score);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
  });
});
