import { describe, expect, it } from 'vitest';
import { filterModels, matchesModelQuery, modelQueryTerms } from '../src/providers/modelFilter.js';

const MODELS = [
  'sakana/sakana-namazu',
  'openai/gpt-4o-mini',
  'nvidia/nemotron-3-ultra-550b-a55b:free',
  'nvidia/nemotron-3-nano-30b-a3b',
  'gpt-4o',
  'anthropic/claude-opus-4',
];

describe('filterModels', () => {
  it('returns the list untouched for an empty query', () => {
    expect(filterModels(MODELS, '')).toEqual(MODELS);
    expect(filterModels(MODELS, '   ')).toEqual(MODELS);
  });

  it('matches a plain substring, case-insensitively', () => {
    expect(filterModels(MODELS, 'NEMOTRON')).toEqual([
      'nvidia/nemotron-3-ultra-550b-a55b:free',
      'nvidia/nemotron-3-nano-30b-a3b',
    ]);
  });

  /** The case a single substring test gets wrong — the terms are not adjacent. */
  it('matches multiple terms in any order, not just contiguous runs', () => {
    expect(filterModels(MODELS, 'nvidia ultra')).toEqual(['nvidia/nemotron-3-ultra-550b-a55b:free']);
    expect(filterModels(MODELS, 'ultra nvidia')).toEqual(['nvidia/nemotron-3-ultra-550b-a55b:free']);
    expect(filterModels(MODELS, 'free nemotron')).toEqual(['nvidia/nemotron-3-ultra-550b-a55b:free']);
  });

  it('ranks an exact id, then a prefix, then a segment start, above a mid-string hit', () => {
    // "gpt-4o" is exact; "openai/gpt-4o-mini" only matches inside a segment.
    expect(filterModels(MODELS, 'gpt-4o')).toEqual(['gpt-4o', 'openai/gpt-4o-mini']);
  });

  it('keeps the provider ordering for equally good matches', () => {
    // Both match only inside a segment, so the input order must survive.
    expect(filterModels(MODELS, 'nemotron-3')).toEqual([
      'nvidia/nemotron-3-ultra-550b-a55b:free',
      'nvidia/nemotron-3-nano-30b-a3b',
    ]);
  });

  it('returns nothing when a term matches nothing', () => {
    expect(filterModels(MODELS, 'nvidia sonnet')).toEqual([]);
  });

  it('does not mutate the input', () => {
    const input = [...MODELS];
    filterModels(input, 'gpt');
    expect(input).toEqual(MODELS);
  });
});

describe('modelQueryTerms / matchesModelQuery', () => {
  it('drops empty terms from padded queries', () => {
    expect(modelQueryTerms('  gpt   4o ')).toEqual(['gpt', '4o']);
  });

  it('requires every term to be present', () => {
    expect(matchesModelQuery('openai/gpt-4o-mini', ['gpt', 'mini'])).toBe(true);
    expect(matchesModelQuery('openai/gpt-4o-mini', ['gpt', 'ultra'])).toBe(false);
  });
});
