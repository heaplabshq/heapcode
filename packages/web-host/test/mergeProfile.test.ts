import { describe, expect, it } from 'vitest';
import { mergeProfile } from '../src/session.js';

const base = { name: 'local', preset: 'ollama' as const, baseUrl: 'http://localhost:11434/v1', model: 'llama' };

describe('mergeProfile — the response timeout', () => {
  it('sets it, clears it with null, and leaves it alone when the patch says nothing', () => {
    const set = mergeProfile(base, { name: 'local', timeoutMs: 900_000 });
    expect(set.timeoutMs).toBe(900_000);
    expect(mergeProfile(set, { name: 'local', model: 'other' }).timeoutMs).toBe(900_000);
    expect(mergeProfile(set, { name: 'local', timeoutMs: null }).timeoutMs).toBeUndefined();
    expect(mergeProfile(base, { name: 'local', timeoutMs: 0 }).timeoutMs).toBe(0);
  });

  it('refuses a value the provider could not use', () => {
    expect(() => mergeProfile(base, { name: 'local', timeoutMs: -1 })).toThrow(/timeout/);
    expect(() => mergeProfile(base, { name: 'local', timeoutMs: 1.5 })).toThrow(/timeout/);
  });
});
