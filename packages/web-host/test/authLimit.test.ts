import { describe, expect, it } from 'vitest';
import { AuthLimiter, MAX_FAILURES } from '../src/authLimit.js';

/**
 * W3.5. The value here is that a brute-force attempt actually stops, and — just
 * as important — that a real user who fumbles a paste is not locked out of
 * their own machine.
 */
describe('AuthLimiter', () => {
  it('blocks an address only after the allowance is spent', () => {
    const limiter = new AuthLimiter();
    for (let i = 1; i < MAX_FAILURES; i++) {
      limiter.fail('10.0.0.5');
      expect(limiter.blocked('10.0.0.5')).toBe(false);
    }
    limiter.fail('10.0.0.5');
    expect(limiter.blocked('10.0.0.5')).toBe(true);
  });

  it('does not block a different address', () => {
    const limiter = new AuthLimiter();
    for (let i = 0; i < MAX_FAILURES; i++) limiter.fail('10.0.0.5');
    expect(limiter.blocked('10.0.0.5')).toBe(true);
    expect(limiter.blocked('10.0.0.6')).toBe(false);
  });

  it('a successful auth clears the record — one bad paste must not lock you out', () => {
    const limiter = new AuthLimiter();
    for (let i = 0; i < MAX_FAILURES - 1; i++) limiter.fail('10.0.0.5');
    limiter.succeed('10.0.0.5');
    expect(limiter.failures('10.0.0.5')).toBe(0);
    limiter.fail('10.0.0.5');
    expect(limiter.blocked('10.0.0.5')).toBe(false);
  });

  it('the block expires, and expiring restores the full allowance', () => {
    let now = 1_000_000;
    const limiter = new AuthLimiter(MAX_FAILURES, 60_000, 60_000, () => now);
    for (let i = 0; i < MAX_FAILURES; i++) limiter.fail('10.0.0.5');
    expect(limiter.blocked('10.0.0.5')).toBe(true);

    now += 60_001;
    expect(limiter.blocked('10.0.0.5')).toBe(false);
    // Not one-strike-and-blocked-again: the record is gone, not decremented.
    limiter.fail('10.0.0.5');
    expect(limiter.blocked('10.0.0.5')).toBe(false);
  });

  it('failures spread beyond the window do not accumulate into a block', () => {
    let now = 1_000_000;
    const limiter = new AuthLimiter(MAX_FAILURES, 60_000, 10_000, () => now);
    for (let i = 0; i < MAX_FAILURES * 2; i++) {
      limiter.fail('10.0.0.5');
      now += 10_001;
    }
    expect(limiter.blocked('10.0.0.5')).toBe(false);
  });
});
