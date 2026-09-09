/**
 * "Summarize this chat" — a request about the conversation, not within it.
 *
 * Ported from heapchat's `RECAP_INTENT` (`server.js:1919`), which is the one
 * idea its compaction had and this one did not.
 *
 * The failure it prevents is specific and quite bad: a long conversation is
 * over budget, so the loop folds its earlier half into ~350 words of notes —
 * and then the user asks "what did we decide?", and the model answers from
 * the notes. The reply reads like a recap of the conversation and is in fact
 * a recap of a lossy summary of it, with no sign anywhere that half the
 * detail was gone before the question was read.
 *
 * The response is to raise the budget, never to disable compaction: a request
 * about a conversation is exactly the case where the transcript is long, and
 * skipping outright would overflow the window instead. Compaction still
 * happens if the conversation is genuinely enormous — it just holds far more
 * verbatim first.
 */

const RECAP_INTENT =
  /\b(summari[sz]e|summary|recap|tl;?dr|(?:take|taking|make|making|jot|write)\s+(?:down\s+|a\s+|some\s+)*notes?|minutes?|action items?|key points?|takeaways?|what (?:did|have) we (?:discuss|cover|talk|decide|say)|so far|this (?:chat|conversation|thread|discussion))\b/i;

/** Whether this task is asking about the conversation itself. */
export function wantsConversationRecap(text: string | undefined): boolean {
  return RECAP_INTENT.test(String(text ?? ''));
}

/**
 * How much further to let the transcript grow before folding it, when the
 * question is about the transcript.
 *
 * Four, matching the ratio heapchat used (×8 against a ×2 baseline). Large
 * enough that an ordinary conversation is never compacted before being
 * recapped, small enough to stay well inside the window that
 * `compactionBudget` was already a fraction of.
 */
export const RECAP_BUDGET_MULTIPLIER = 4;
