import { noteHits } from './ask.js';
import type { RelatedNote } from './protocol.js';
import type { Vault } from './vault.js';

/**
 * Notes related to one note, for the Info panel (HEAPNOTES_PHASE2_PLAN §2C):
 * close in meaning first, then ones that link to the same notes, then ones
 * sharing a tag — each with the reason, so a suggestion can be judged at a
 * glance. Notes already linked either way are left out: the point is the
 * connection that isn't there yet (Reflect's "link it", Obsidian Copilot's
 * relevant notes, which use links as well as meaning).
 *
 * `semantic` is the meaning index (a note's text in, `--- path:… (score n)`
 * blocks out); without it, links and tags still work.
 */
export async function relatedNotes(
  vault: Vault,
  id: string,
  semantic?: (text: string) => Promise<string>,
  opts: { limit?: number; hiddenTags?: string[] } = {},
): Promise<RelatedNote[]> {
  const limit = opts.limit ?? 8;
  const note = await vault.get({ id });
  // A hidden note's text is never the query: it would go to the embeddings model.
  const hidden = (opts.hiddenTags ?? []).map((t) => t.toLowerCase());
  if (
    note.tags.some((t) =>
      hidden.some((h) => t.toLowerCase() === h || t.toLowerCase().startsWith(`${h}/`)),
    )
  ) {
    semantic = undefined;
  }
  const skip = new Set<string>([note.id]);
  for (const l of note.links) if (l.id) skip.add(l.id);
  for (const b of await vault.backlinks({ id })) skip.add(b.id);
  const out: RelatedNote[] = [];
  const add = (
    n: { id: string; title: string; subtitle: string; location: string },
    reason: string,
    kind: RelatedNote['kind'],
  ) => {
    if (skip.has(n.id) || n.location !== 'notes' || out.length >= limit) return;
    skip.add(n.id);
    out.push({ id: n.id, title: n.title, subtitle: n.subtitle, reason, kind });
  };

  if (semantic) {
    const body = (await vault.read({ id })).content.slice(0, 4000);
    const formatted = body.trim() ? await semantic(body).catch(() => '') : '';
    // The note itself comes back as the best match; it would set the bar for the rest.
    const hits = (await noteHits(vault, formatted)).filter((h) => h.note.id !== note.id);
    for (const h of closeEnough(hits).slice(0, 5)) add(h.note, 'Similar in meaning', 'meaning');
  }

  // Linking to the same note is a strong sign two notes are about one thing.
  for (const l of note.links) {
    if (!l.id) continue;
    const target = await vault.get({ id: l.id }).catch(() => undefined);
    if (!target) continue;
    for (const other of await vault.backlinks({ id: l.id }))
      add(other, `Also links to ${target.title}`, 'links');
  }

  // A tag on nearly everything says little; only the narrower ones count.
  for (const tag of note.tags) {
    const { notes, total } = await vault.list({ tag, limit: 12 });
    if (total > 40) continue;
    for (const other of notes) add(other, `Also tagged #${tag}`, 'tags');
  }
  return out;
}

/**
 * The hits that stand out from the rest. Embedding models put unrelated text
 * at different similarities — around 0.4 for one, 0.2 for another — so the
 * cut is relative: three quarters of a standard deviation above the average
 * of what came back. With too few hits to have an average, those near the best.
 */
export function closeEnough<T extends { score: number }>(hits: T[]): T[] {
  if (hits.length === 0) return [];
  const scores = hits.map((h) => h.score);
  const best = Math.max(...scores);
  if (hits.length < 4) return hits.filter((h) => h.score >= best - 0.1);
  const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
  const sd = Math.sqrt(scores.reduce((a, b) => a + (b - mean) ** 2, 0) / scores.length);
  return hits.filter((h) => h.score > mean + 0.75 * sd);
}
