/**
 * Shared model-list search, used by every surface that shows a model picker
 * (the CLI's `/model` and setup wizard, the extension's chat and settings
 * views) so the same query narrows the list the same way in all of them.
 *
 * Model ids are long and punctuation-heavy — `nvidia/nemotron-3-ultra-550b-
 * a55b:free` — and providers list hundreds of them (OpenRouter is past 400).
 * A single substring test, which is what each picker grew independently,
 * fails the query users actually type: "nvidia ultra" appears nowhere in that
 * id as a contiguous run. Terms are therefore matched individually and in any
 * order, so partial recall of an id is enough to find it.
 */

/** Splits a raw query into lowercased terms; every term must match. */
export function modelQueryTerms(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter(Boolean);
}

/** The separators that divide a model id into its meaningful parts. */
const SEPARATORS = /[/:@._\-\s]+/;

export function matchesModelQuery(model: string, terms: readonly string[]): boolean {
  const haystack = model.toLowerCase();
  return terms.every((term) => haystack.includes(term));
}

/**
 * Lower sorts first. Ranks by how "anchored" the first term is, so typing
 * "gpt" leads with `gpt-4o` rather than whatever unrelated id happens to
 * contain "gpt" in the middle and sorts earlier in the provider's list.
 */
function rank(model: string, terms: readonly string[]): number {
  const id = model.toLowerCase();
  const joined = terms.join(' ');
  if (id === joined || id === terms.join('')) return 0;
  const first = terms[0]!;
  if (id.startsWith(first)) return 1;
  if (id.split(SEPARATORS).some((part) => part.startsWith(first))) return 2;
  return 3;
}

/**
 * Every model matching `query`, best matches first. An empty query returns
 * the list unchanged — pickers show the provider's own ordering until the
 * user actually types something.
 */
export function filterModels(models: readonly string[], query: string): string[] {
  const terms = modelQueryTerms(query);
  if (terms.length === 0) return [...models];
  return models
    .map((model, index) => ({ model, index, score: rank(model, terms) }))
    .filter((entry) => matchesModelQuery(entry.model, terms))
    // Ties keep the provider's ordering — it is usually newest-first, and
    // reshuffling equally-good matches would make the list feel unstable.
    .sort((a, b) => a.score - b.score || a.index - b.index)
    .map((entry) => entry.model);
}
