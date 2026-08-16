/**
 * Auth-failure rate limiting (WEB_APP_PLAN §6.1).
 *
 * The token is 32 random bytes, so guessing it is not a realistic attack and
 * this is not what stops one. What it stops is the *quiet* attack: something on
 * the LAN grinding away at the port for hours, and a log nobody reads. Ten
 * failures from one peer and that peer is refused for a while — cheap, and it
 * turns an invisible brute-force into a visible failure.
 *
 * Keyed by remote address rather than by socket, because the interesting case
 * is a client that reconnects for each attempt. A successful auth clears the
 * record: a user who fumbles a paste and then gets it right should not be
 * locked out of their own tool.
 */

/** Failures from one address before it is refused. */
export const MAX_FAILURES = 10;

/** How long a blocked address stays blocked. */
export const BLOCK_MS = 15 * 60_000;

/**
 * Failures older than this are forgotten, so a long-lived host does not treat
 * one typo an hour ago as part of today's attempt.
 */
export const WINDOW_MS = 15 * 60_000;

interface Record_ {
  failures: number;
  /** When the most recent failure happened — the window and the block both key off it. */
  last: number;
}

export class AuthLimiter {
  private readonly seen = new Map<string, Record_>();

  constructor(
    private readonly maxFailures = MAX_FAILURES,
    private readonly blockMs = BLOCK_MS,
    private readonly windowMs = WINDOW_MS,
    /** Injected so tests do not have to sleep. */
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** True when this address has spent its attempts and is still in the penalty box. */
  blocked(address: string | undefined): boolean {
    const rec = this.seen.get(this.key(address));
    if (!rec) return false;
    if (rec.failures < this.maxFailures) return false;
    if (this.now() - rec.last >= this.blockMs) {
      // Served its time. Cleared rather than decremented, so the next mistake
      // starts from a full allowance instead of instantly re-blocking.
      this.seen.delete(this.key(address));
      return false;
    }
    return true;
  }

  /** Record a rejected token. Returns true once the address has crossed the line. */
  fail(address: string | undefined): boolean {
    const key = this.key(address);
    this.prune();
    const rec = this.seen.get(key);
    const now = this.now();
    if (!rec || now - rec.last >= this.windowMs) {
      this.seen.set(key, { failures: 1, last: now });
      return 1 >= this.maxFailures;
    }
    rec.failures += 1;
    rec.last = now;
    return rec.failures >= this.maxFailures;
  }

  /** A good token wipes the slate for that address. */
  succeed(address: string | undefined): void {
    this.seen.delete(this.key(address));
  }

  /** Test/diagnostic view: how many failures this address currently carries. */
  failures(address: string | undefined): number {
    return this.seen.get(this.key(address))?.failures ?? 0;
  }

  /**
   * Drop records that can no longer matter. Without this the map grows for the
   * life of the host, one entry per address that ever mistyped a token — small,
   * but unbounded is unbounded.
   */
  private prune(): void {
    const now = this.now();
    for (const [key, rec] of this.seen) {
      const expiry = rec.failures >= this.maxFailures ? this.blockMs : this.windowMs;
      if (now - rec.last >= expiry) this.seen.delete(key);
    }
  }

  /** Unknown address (a socket that died mid-handshake) is still one bucket. */
  private key(address: string | undefined): string {
    return address ?? 'unknown';
  }
}
