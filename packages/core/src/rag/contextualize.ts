import type { Provider } from '../providers/types.js';
import type { Chunk } from './chunker.js';

const BATCH = 10;
const MAX_FILE_CONTEXT_CHARS = 4_000;
const MAX_CHUNK_PREVIEW_CHARS = 400;

/**
 * Contextual retrieval (Anthropic): generates a short, specific blurb per
 * chunk describing what it is and how it fits into the file, to prepend
 * before embedding. Batches ~10 chunks per call with a capped slice of the
 * file for grounding. Best-effort like rerankHits — any failure or
 * unparseable reply leaves that batch's blurbs empty (''), never throws;
 * the caller falls back to embedding the chunk on its own.
 */
export async function contextualizeChunks(
  provider: Provider,
  model: string,
  filePath: string,
  fileContent: string,
  chunks: Chunk[],
  signal?: AbortSignal,
): Promise<string[]> {
  const results: string[] = new Array(chunks.length).fill('');
  if (chunks.length === 0) return results;

  const fileContext =
    fileContent.length > MAX_FILE_CONTEXT_CHARS
      ? fileContent.slice(0, MAX_FILE_CONTEXT_CHARS) + '\n…[truncated]'
      : fileContent;

  for (let i = 0; i < chunks.length; i += BATCH) {
    const batch = chunks.slice(i, i + BATCH);
    const listing = batch
      .map(
        (c, j) =>
          `[${j + 1}] lines ${c.startLine}-${c.endLine}:\n${c.text.slice(0, MAX_CHUNK_PREVIEW_CHARS)}`,
      )
      .join('\n\n');

    try {
      const res = await provider.chat({
        model,
        messages: [
          {
            role: 'system',
            content:
              'You write one-sentence contextual descriptions of code snippets for a search index. ' +
              'For each numbered snippet, describe what it is and how it fits into the file — be ' +
              'specific (symbol names, purpose), not generic. Reply with exactly one line per ' +
              'snippet: "N: description".',
          },
          {
            role: 'user',
            content: `File: ${filePath}\n\n${fileContext}\n\n---\n\nSnippets:\n\n${listing}`,
          },
        ],
        maxTokens: 60 * batch.length,
        temperature: 0,
        signal,
      });
      for (const line of res.content.split('\n')) {
        const m = /^\s*\[?(\d+)\]?[:.)]\s*(.+)$/.exec(line);
        if (!m) continue;
        const idx = Number(m[1]) - 1;
        if (idx >= 0 && idx < batch.length) results[i + idx] = m[2]!.trim();
      }
    } catch {
      // best-effort — leave this batch's entries as '', embedding input
      // falls back to plain path+text
    }
  }
  return results;
}
