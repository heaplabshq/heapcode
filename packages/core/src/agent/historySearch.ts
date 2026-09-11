import type { Conversation, StoredMessage } from '../history/types.js';
import type { ToolDefinition } from './tools.js';

/**
 * Searching the conversation the model can no longer see.
 *
 * A long run does not keep its whole transcript in context: `buildAgentHistory`
 * trims it, and beyond a point the loop folds the earlier half into a few
 * hundred words of notes. The full record is never lost — it is in the
 * conversation store on disk, complete — but the model's view of it is, so
 * "what was the figure you quoted at the start" is answered from a summary of
 * a summary, confidently and often wrongly.
 *
 * `recap.ts` handles the neighbouring case, a question *about* the
 * conversation ("summarise this"), by raising the budget so compaction holds
 * off. That cannot help here: widening a window still only widens it, and the
 * detail being asked for may be a hundred turns back. This is the other half —
 * going and looking.
 *
 * Keyword scoring rather than embeddings, deliberately. Conversations are not
 * indexed, and indexing them is a much larger thing with its own questions
 * about what gets embedded and sent where. Terms and their neighbourhoods
 * answer "find where we talked about X" well enough to be worth having now.
 */

/** Characters of a matching message to return, before its neighbours. */
const EXCERPT_CHARS = 700;
/** How many results to return when the caller does not say. */
const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 20;
/** Terms this short match too much to be worth scoring. */
const MIN_TERM = 3;

export interface HistoryMatch {
  conversationId: string;
  conversationTitle: string;
  /** Position in the conversation, so the model can say "early on" honestly. */
  turn: number;
  totalTurns: number;
  role: string;
  text: string;
  score: number;
}

export interface HistorySearchOptions {
  limit?: number;
  /** Surrounding messages to include with each hit, for context. */
  neighbours?: number;
}

/** The terms worth matching on, lowercased and deduplicated. */
export function searchTerms(query: string): string[] {
  return [...new Set(query.toLowerCase().split(/[^\p{L}\p{N}_.-]+/u).filter((t) => t.length >= MIN_TERM))];
}

/**
 * Messages in `conversation` that match `query`, best first.
 *
 * Reasoning blocks and transcript furniture are skipped: a model's own
 * scratchpad is excluded from context everywhere else for the same reason, and
 * surfacing it here would let it answer from something it already decided not
 * to treat as dialogue.
 */
export function searchConversation(
  conversation: Conversation,
  query: string,
  opts: HistorySearchOptions = {},
): HistoryMatch[] {
  const terms = searchTerms(query);
  if (terms.length === 0) return [];

  const messages = conversation.messages;
  const scored: HistoryMatch[] = [];
  messages.forEach((message, index) => {
    if (!isSearchable(message)) return;
    const haystack = message.content.toLowerCase();
    let score = 0;
    for (const term of terms) {
      const hits = countOccurrences(haystack, term);
      // Diminishing: a message that says the word twenty times is not ten
      // times the answer of one that says it twice, and length alone should
      // not win.
      if (hits > 0) score += 1 + Math.log2(hits);
    }
    if (score === 0) return;
    // Every term present beats a single term repeated — the question is
    // usually a phrase, not a word.
    const covered = terms.filter((t) => haystack.includes(t)).length;
    scored.push({
      conversationId: conversation.id,
      conversationTitle: conversation.title,
      turn: index,
      totalTurns: messages.length,
      role: message.role,
      text: excerptAround(message.content, terms),
      score: score * (covered / terms.length) ** 2,
    });
  });

  const limit = Math.min(Math.max(opts.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
  return scored.sort((a, b) => b.score - a.score || a.turn - b.turn).slice(0, limit);
}

/** What the tool hands back to the model. */
export function formatHistoryMatches(matches: HistoryMatch[], query: string): string {
  if (matches.length === 0) {
    return `Nothing in the conversation record matches "${query}". It may have been phrased differently, or may not have been said.`;
  }
  return matches
    .map((m) => {
      // Named as a position, because "earlier" is what the model wants to say
      // and it should be able to say it accurately.
      const where = `turn ${m.turn + 1} of ${m.totalTurns}`;
      const which = m.conversationTitle ? ` in "${m.conversationTitle}"` : '';
      return `--- ${m.role} at ${where}${which} ---\n${m.text}`;
    })
    .join('\n\n');
}

/**
 * Transcript furniture is not dialogue.
 *
 * Reasoning blocks are excluded from model context everywhere else in this
 * codebase; returning them through a search would be a way around that.
 */
function isSearchable(message: StoredMessage): boolean {
  if (message.ui?.reasoning) return false;
  if (!message.content?.trim()) return false;
  return message.role === 'user' || message.role === 'assistant';
}

function countOccurrences(haystack: string, term: string): number {
  let count = 0;
  let at = haystack.indexOf(term);
  while (at !== -1) {
    count += 1;
    at = haystack.indexOf(term, at + term.length);
  }
  return count;
}

/**
 * The part of a long message the terms are actually in.
 *
 * A matching message can be thousands of characters; returning all of several
 * would spend the context this tool exists to save.
 */
function excerptAround(content: string, terms: string[]): string {
  if (content.length <= EXCERPT_CHARS) return content;
  const lower = content.toLowerCase();
  let first = -1;
  for (const term of terms) {
    const at = lower.indexOf(term);
    if (at !== -1 && (first === -1 || at < first)) first = at;
  }
  if (first === -1) return `${content.slice(0, EXCERPT_CHARS)}…`;
  const start = Math.max(0, first - Math.floor(EXCERPT_CHARS / 3));
  const end = Math.min(content.length, start + EXCERPT_CHARS);
  return `${start > 0 ? '…' : ''}${content.slice(start, end)}${end < content.length ? '…' : ''}`;
}

/**
 * The roster entry.
 *
 * The description names the situation rather than the capability, because the
 * failure this addresses is not the model being unable to look — it is the
 * model not knowing it should. A compacted transcript carries a marker saying
 * earlier work was folded away; this says what to do about it.
 */
export const SEARCH_HISTORY_TOOL: ToolDefinition = {
  name: 'search_history',
  description:
    'Search the full record of this conversation, including turns no longer in your context. ' +
    'Long conversations are trimmed, and older ones are folded into a short summary marked ' +
    '"[Earlier work compacted to save context]" — detail is lost from your view but not from the record. ' +
    'Use this whenever you are asked about something said earlier that you cannot see, or when you are ' +
    'about to answer from a summary rather than from what was actually said. Answering "we decided X" ' +
    'from compacted notes is how a confident wrong answer gets made. Searches the current conversation ' +
    'by default; pass `conversation_id` to search an earlier one.',
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Words to look for, as they were likely said. Distinctive terms work best.',
      },
      conversation_id: {
        type: 'string',
        description: 'An earlier conversation to search instead of this one. Omit for the current one.',
      },
      limit: { type: 'number', description: `Matches to return (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}).` },
    },
    required: ['query'],
  },
  // It reads what was already said in this session: nothing to approve, and
  // nothing that reaches the machine or the network.
  permission: 'read',
};
