import { describe, expect, it } from 'vitest';
import {
  SEARCH_HISTORY_TOOL,
  formatHistoryMatches,
  searchConversation,
  searchTerms,
} from '../src/agent/historySearch.js';
import type { Conversation, StoredMessage } from '../src/history/types.js';

/**
 * A long run does not keep its whole transcript in context, and past a point
 * the loop folds the earlier half into a few hundred words of notes. The
 * record on disk stays complete; the model's view of it does not. This is how
 * it goes and looks.
 */

function convo(messages: Array<Partial<StoredMessage> & { content: string }>): Conversation {
  return {
    id: 'c1',
    title: 'Deployment work',
    updatedAt: 1,
    messages: messages.map((m) => ({ role: 'user', ...m }) as StoredMessage),
  };
}

describe('searchTerms', () => {
  it('drops words too short to be worth matching', () => {
    expect(searchTerms('what was the DB port')).toEqual(['what', 'was', 'the', 'port']);
  });

  it('keeps the shapes people actually search for', () => {
    expect(searchTerms('config.json and api_key v2.1')).toEqual(['config.json', 'and', 'api_key', 'v2.1']);
  });

  it('has nothing to do when the query is all noise', () => {
    expect(searchConversation(convo([{ content: 'anything' }]), 'a I of')).toEqual([]);
  });
});

describe('searching a conversation', () => {
  const history = convo([
    { role: 'user', content: 'We should deploy to staging on Friday.' },
    { role: 'assistant', content: 'Noted. The staging database runs on port 5433.' },
    { role: 'user', content: 'What about the cache?' },
    { role: 'assistant', content: 'Redis, unchanged.' },
  ]);

  it('finds the turn that actually said it', () => {
    const [best] = searchConversation(history, 'staging database port');
    expect(best?.text).toContain('5433');
    expect(best?.role).toBe('assistant');
  });

  it('reports where in the conversation it was, so "earlier" can be said accurately', () => {
    const [best] = searchConversation(history, 'staging database port');
    expect(best?.turn).toBe(1);
    expect(best?.totalTurns).toBe(4);
  });

  it('prefers the turn covering more of the question to one repeating a word', () => {
    const noisy = convo([
      { role: 'assistant', content: 'cache cache cache cache cache cache' },
      { role: 'assistant', content: 'The cache is Redis and the port is 6379.' },
    ]);
    expect(searchConversation(noisy, 'cache port')[0]?.turn).toBe(1);
  });

  it('returns nothing rather than a bad guess', () => {
    expect(searchConversation(history, 'kubernetes ingress')).toEqual([]);
  });

  it('honours a limit, and caps it', () => {
    const many = convo(Array.from({ length: 40 }, () => ({ role: 'assistant' as const, content: 'deploy staging' })));
    expect(searchConversation(many, 'deploy').length).toBe(5);
    expect(searchConversation(many, 'deploy', { limit: 3 }).length).toBe(3);
    expect(searchConversation(many, 'deploy', { limit: 999 }).length).toBe(20);
  });
});

describe('what is left out', () => {
  it('skips reasoning blocks, which are not dialogue', () => {
    // Excluded from model context everywhere else in this codebase; a search
    // that returned them would be a way around that.
    const withThinking = convo([
      { role: 'assistant', content: 'The token is abc123', ui: { reasoning: true } } as never,
      { role: 'assistant', content: 'I have set it up.' },
    ]);
    expect(searchConversation(withThinking, 'token abc123')).toEqual([]);
  });

  it('skips empty turns', () => {
    expect(searchConversation(convo([{ role: 'assistant', content: '   ' }]), 'anything')).toEqual([]);
  });
});

describe('long messages', () => {
  it('returns the part the terms are in, not the whole thing', () => {
    const needle = 'the invoice total was 4,812.55';
    const long = convo([{ role: 'assistant', content: `${'padding. '.repeat(400)}${needle}${' trailing.'.repeat(400)}` }]);
    const [best] = searchConversation(long, 'invoice total');
    expect(best?.text).toContain(needle);
    expect(best!.text.length).toBeLessThan(1_000);
    expect(best?.text.startsWith('…')).toBe(true);
  });
});

describe('what the model is handed', () => {
  it('says which turn of how many, so it can place the answer in time', () => {
    const matches = searchConversation(convo([{ role: 'assistant', content: 'port 5433' }]), 'port');
    expect(formatHistoryMatches(matches, 'port')).toContain('turn 1 of 1');
  });

  it('says plainly when there is nothing, rather than returning empty', () => {
    expect(formatHistoryMatches([], 'kubernetes')).toMatch(/Nothing in the conversation record matches/);
  });
});

describe('the tool definition', () => {
  it('needs no approval — it reads what was already said here', () => {
    expect(SEARCH_HISTORY_TOOL.permission).toBe('read');
  });

  it('names the situation, not just the capability', () => {
    // The failure is not that the model cannot look; it is that it does not
    // know it should, and answers from a summary instead.
    expect(SEARCH_HISTORY_TOOL.description).toContain('compacted');
    expect(SEARCH_HISTORY_TOOL.description).toMatch(/no longer in your context/);
  });
});
