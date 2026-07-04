import type { Provider } from '../providers/types.js';
import type { SearchHit } from './store.js';

/** How many vector hits to retrieve as rerank candidates. */
export const RERANK_CANDIDATES = 20;

const PREVIEW_CHARS = 500;

/**
 * LLM listwise rerank: show the model the query plus numbered snippet
 * previews, and keep the snippets it picks, in its order. Embeddings find
 * "about the same topic"; this stage restores "actually answers the query"
 * precision. Best-effort — any failure or unparseable reply falls back to
 * the original vector order.
 */
export async function rerankHits(
  provider: Provider,
  model: string,
  query: string,
  hits: SearchHit[],
  keep: number,
  signal?: AbortSignal,
): Promise<SearchHit[]> {
  if (hits.length <= keep) return hits;

  const listing = hits
    .map(
      (h, i) =>
        `[${i + 1}] ${h.record.path}:${h.record.startLine}-${h.record.endLine}\n${h.record.text.slice(0, PREVIEW_CHARS)}`,
    )
    .join('\n\n');

  try {
    const res = await provider.chat({
      model,
      messages: [
        {
          role: 'system',
          content:
            'You rank code-search results by relevance to a query. Reply with only snippet numbers, comma-separated.',
        },
        {
          role: 'user',
          content:
            `Query: ${query}\n\n` +
            `Pick the ${keep} snippets most relevant to the query, best first. ` +
            `Reply with only their numbers, comma-separated (e.g. "4, 1, 7").\n\n${listing}`,
        },
      ],
      maxTokens: 64,
      temperature: 0,
      signal,
    });
    const picked = [...new Set((res.content.match(/\d+/g) ?? []).map(Number))]
      .filter((n) => n >= 1 && n <= hits.length)
      .slice(0, keep)
      .map((n) => hits[n - 1]!);
    return picked.length > 0 ? picked : hits.slice(0, keep);
  } catch {
    return hits.slice(0, keep);
  }
}
