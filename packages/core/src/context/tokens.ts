import type { ChatMessage } from '../providers/types.js';

/** Fallback when a profile doesn't declare its model's context window. */
export const DEFAULT_CONTEXT_WINDOW = 32_768;

/** Compact when estimated usage crosses this fraction of the context window. */
export const COMPACTION_THRESHOLD = 0.8;

/**
 * Rough token estimate (≈ 4 chars/token for English + code). Deliberately
 * tokenizer-free: Cortex is model-agnostic, and the meter/compaction only
 * need to be directionally right.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function estimateMessagesTokens(messages: ChatMessage[]): number {
  let total = 0;
  for (const m of messages) {
    total += estimateTokens(m.content) + 4; // +4 ≈ per-message framing overhead
    if (m.toolCalls) total += estimateTokens(JSON.stringify(m.toolCalls));
    if (m.images) total += m.images.length * 800; // ≈ one downscaled screenshot
  }
  return total;
}
