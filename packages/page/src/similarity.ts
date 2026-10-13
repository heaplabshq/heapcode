import { fingerprintOf, type Fingerprint } from './fingerprint.js';
import { TEST_ID_ATTRS, type DomTree } from './tree.js';

/**
 * Find the element on a changed page that is most like a saved one.
 *
 * Similo's idea (Nass, Alégroth, Feldt, Leotta, Ricca — arXiv:2208.00677):
 * score every candidate on many properties at once, weighted by how stable
 * each tends to be, and take the best. In their study it missed 11% of
 * relocations where single locators missed 27%, at a few milliseconds per
 * lookup. The weights below follow theirs — names, ids, tags and visible text
 * count most; classes, paths and position least, because those are what a
 * restyle changes.
 *
 * Deliberately no model. Most app changes are a renamed id, a moved button, a
 * reworded label — this settles those for free, and only what it cannot
 * settle with confidence goes to the agent.
 */

export interface Match {
  nodeId: number;
  /** 0–1: the weighted share of the saved properties this element matches. */
  score: number;
}

export interface MatchResult {
  /** Best first; at most `limit`. */
  ranked: Match[];
  best?: Match;
  /** `best.score - second.score`: how clearly the best one won. */
  margin: number;
}

interface Weighted {
  weight: number;
  /** 0–1, or undefined when the saved fingerprint has nothing to compare. */
  similarity: (saved: Fingerprint, candidate: Fingerprint) => number | undefined;
}

const PROPERTIES: Weighted[] = [
  // A test id is a promise from the app's authors that this is the element,
  // so it outweighs a reworded label — unlike Similo's sites, which had none.
  // A *different* test id says it is another element; *no* test id says
  // nothing (refactors drop them), so it is left out rather than scored 0.
  { weight: 6, similarity: (s, c) => (s.testId === undefined || c.testId === undefined ? undefined : equal(s.testId, c.testId)) },
  { weight: 1.5, similarity: (s, c) => (s.id === undefined ? undefined : equal(s.id, c.id)) },
  { weight: 1.5, similarity: (s, c) => equal(s.tag, c.tag) },
  { weight: 1.5, similarity: (s, c) => (s.name === undefined ? undefined : textSimilarity(s.name, c.name)) },
  { weight: 1.5, similarity: (s, c) => (s.text === undefined ? undefined : textSimilarity(s.text, c.text)) },
  { weight: 1.5, similarity: (s, c) => (s.neighborText === undefined ? undefined : textSimilarity(s.neighborText, c.neighborText)) },
  { weight: 1.0, similarity: (s, c) => (s.role === undefined ? undefined : equal(s.role, c.role)) },
  { weight: 1.5, similarity: (s, c) => (s.attrs.name === undefined ? undefined : equal(s.attrs.name, c.attrs.name)) },
  { weight: 0.5, similarity: (s, c) => (s.attrs.type === undefined ? undefined : equal(s.attrs.type, c.attrs.type)) },
  { weight: 0.5, similarity: (s, c) => (s.attrs.href === undefined ? undefined : textSimilarity(s.attrs.href, c.attrs.href)) },
  { weight: 0.5, similarity: (s, c) => (s.attrs.placeholder === undefined ? undefined : textSimilarity(s.attrs.placeholder, c.attrs.placeholder)) },
  { weight: 0.5, similarity: (s, c) => (s.attrs.alt === undefined ? undefined : textSimilarity(s.attrs.alt, c.attrs.alt)) },
  { weight: 0.5, similarity: (s, c) => (s.classes.length === 0 ? undefined : setSimilarity(s.classes, c.classes)) },
  { weight: 0.5, similarity: (s, c) => pathSimilarity(s.path, c.path) },
  { weight: 0.5, similarity: (s, c) => (s.rect && c.rect ? locationSimilarity(s, c) : undefined) },
];

export interface FindOptions {
  /** Only consider these nodes — e.g. visible ones. Default: every visible element. */
  candidates?: number[];
  limit?: number;
}

export function findSimilar(saved: Fingerprint, tree: DomTree, options: FindOptions = {}): MatchResult {
  let ids = options.candidates ?? tree.nodes.filter((n) => n.visible).map((n) => n.id);
  // Elements still carrying the saved test id are the only contenders: the
  // app's authors said which element this is, whatever its words became.
  if (saved.testId) {
    const same = ids.filter((id) => Object.entries(tree.nodes[id]!.attrs).some(([k, v]) => TEST_ID_ATTRS.includes(k) && v === saved.testId));
    if (same.length) ids = same;
  }
  const ranked: Match[] = [];
  for (const id of ids) ranked.push({ nodeId: id, score: score(saved, fingerprintOf(tree, id)) });
  ranked.sort((a, b) => b.score - a.score);
  const top = ranked.slice(0, options.limit ?? 5);
  const best = top[0];
  const margin = best ? best.score - (top[1]?.score ?? 0) : 0;
  return best ? { ranked: top, best, margin } : { ranked: top, margin };
}

/** Weighted share, over the properties the saved fingerprint actually has. */
export function score(saved: Fingerprint, candidate: Fingerprint): number {
  let total = 0;
  let got = 0;
  for (const p of PROPERTIES) {
    const s = p.similarity(saved, candidate);
    if (s === undefined) continue;
    total += p.weight;
    got += p.weight * s;
  }
  return total === 0 ? 0 : got / total;
}

function equal(a: string | undefined, b: string | undefined): number {
  return a !== undefined && a === b ? 1 : 0;
}

/** Word-overlap (Dice) on normalised words — robust to reordering and small rewording. */
export function textSimilarity(a: string | undefined, b: string | undefined): number {
  if (!a || !b) return 0;
  const x = normalise(a);
  const y = normalise(b);
  if (x === y) return 1;
  const wa = words(x);
  const wb = words(y);
  if (wa.length === 0 || wb.length === 0) return 0;
  const setB = new Set(wb);
  let common = 0;
  for (const w of new Set(wa)) if (setB.has(w)) common += 1;
  return (2 * common) / (new Set(wa).size + setB.size);
}

function setSimilarity(a: string[], b: string[]): number {
  if (b.length === 0) return 0;
  const setB = new Set(b);
  let common = 0;
  for (const x of new Set(a)) if (setB.has(x)) common += 1;
  return (2 * common) / (new Set(a).size + setB.size);
}

/** Share of the path, from the root, that is the same. */
function pathSimilarity(a: string, b: string): number {
  const x = a.split('/');
  const y = b.split('/');
  let same = 0;
  while (same < x.length && same < y.length && x[same] === y[same]) same += 1;
  return same / Math.max(x.length, y.length);
}

/** 1 when in the same place, falling to 0 at 400px away. */
function locationSimilarity(a: Fingerprint, b: Fingerprint): number {
  const dx = a.rect!.x - b.rect!.x;
  const dy = a.rect!.y - b.rect!.y;
  return Math.max(0, 1 - Math.sqrt(dx * dx + dy * dy) / 400);
}

function normalise(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').trim();
}

function words(s: string): string[] {
  return s.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}
