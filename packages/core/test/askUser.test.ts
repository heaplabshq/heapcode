import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ASK_USER_COUNTDOWN_MS,
  ASK_USER_NO_ANSWER,
  IdleDeadline,
  askUserBlocksAction,
  askUserIdleMessage,
  parseIdleTimeout,
  sharedAgentTools,
} from '../src/index.js';

/**
 * The shared half of `ask_user`'s optional idle timeout. Both hosts bound the
 * wait themselves — see askUser.ts's note on why the wait is host-side — so
 * what lives here is the parsing, the wording, and the reset-on-activity rule
 * that would otherwise be written twice and drift.
 */

describe('parseIdleTimeout', () => {
  it('defaults to no timeout for everything unset or empty', () => {
    // The default is what most users get, so it is the case worth being loud
    // about: an unbounded wait, exactly as before this feature existed.
    for (const raw of [undefined, null, '', '   ', 'off', 'none', '0']) {
      expect(parseIdleTimeout(raw), String(raw)).toBeUndefined();
    }
  });

  it('reads the durations Claude Code offers', () => {
    expect(parseIdleTimeout('60s')).toBe(60_000);
    expect(parseIdleTimeout('5m')).toBe(300_000);
    expect(parseIdleTimeout('10m')).toBe(600_000);
  });

  it('accepts other units, spacing, and a bare number of seconds', () => {
    expect(parseIdleTimeout('1h')).toBe(3_600_000);
    expect(parseIdleTimeout('500ms')).toBe(500);
    expect(parseIdleTimeout(' 90 s ')).toBe(90_000);
    expect(parseIdleTimeout('45')).toBe(45_000);
    expect(parseIdleTimeout(30)).toBe(30_000);
  });

  it('falls back to no timeout on nonsense rather than throwing', () => {
    // A typo in a config file must leave the wait unbounded, not break a run.
    for (const raw of ['soon', '5 minutes', '-30s', 'NaN', '1x']) {
      expect(parseIdleTimeout(raw), raw).toBeUndefined();
    }
  });
});

describe('askUserBlocksAction', () => {
  it('is false unless the model explicitly set the flag', () => {
    expect(askUserBlocksAction({})).toBe(false);
    expect(askUserBlocksAction({ question: 'which db?' })).toBe(false);
    expect(askUserBlocksAction({ blocksAction: false })).toBe(false);
    // Only a real boolean true counts — a stringly-typed model reply does not
    // accidentally opt a clarifying question out of the timeout.
    expect(askUserBlocksAction({ blocksAction: 'true' })).toBe(false);
  });

  it('is true when the model marked the question as gating an action', () => {
    expect(askUserBlocksAction({ blocksAction: true })).toBe(true);
  });
});

describe('ask_user tool definition', () => {
  it('offers blocksAction so a gating question can say so', () => {
    const props = sharedAgentTools.ask_user.parameters.properties as Record<string, { type?: string }>;
    expect(props.blocksAction?.type).toBe('boolean');
    // Not required: omitting it means "an ordinary question", which is the
    // common case and the safe default for the timeout.
    expect(sharedAgentTools.ask_user.parameters.required).toEqual(['question']);
  });
});

describe('askUserIdleMessage', () => {
  it('tells the agent to proceed, and that this is not approval', () => {
    const message = askUserIdleMessage();

    expect(message).toContain('may be away');
    expect(message).toContain('Proceed on your own judgment');
    expect(message).toContain('ask again later');
    // The belt-and-braces half. blocksAction relies on the model classifying
    // its own question; when that is wrong, this sentence is what stops
    // "proceed on your own judgment" reading as consent to a destructive act.
    expect(message).toContain('NOT approval');
    expect(message).toContain('do not treat this as a yes');
  });

  it('carries whatever partial answer the user had typed', () => {
    expect(askUserIdleMessage('postgres, prob')).toContain('partial answer so far was: "postgres, prob"');
  });

  it('says nothing about a partial answer when there was none', () => {
    for (const partial of [undefined, '', '   ']) {
      expect(askUserIdleMessage(partial)).not.toContain('partial answer');
    }
  });

  it('is distinguishable from the plain no-answer result', () => {
    // Cancellation and headless still use ASK_USER_NO_ANSWER; only an idle
    // timeout produces the longer message.
    expect(askUserIdleMessage()).not.toBe(ASK_USER_NO_ANSWER);
  });
});

describe('IdleDeadline', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('never fires when no timeout is configured', () => {
    const onExpire = vi.fn();
    const deadline = new IdleDeadline(undefined, onExpire);
    deadline.start();

    vi.advanceTimersByTime(60 * 60_000);

    expect(deadline.enabled).toBe(false);
    expect(onExpire).not.toHaveBeenCalled();
    expect(deadline.remainingMs()).toBe(Number.POSITIVE_INFINITY);
  });

  it('fires once the configured window passes with no activity', () => {
    const onExpire = vi.fn();
    new IdleDeadline(1_000, onExpire).start();

    vi.advanceTimersByTime(999);
    expect(onExpire).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onExpire).toHaveBeenCalledTimes(1);
  });

  it('activity pushes the deadline back rather than letting it expire on schedule', () => {
    // The property that protects a present-but-slow person: they keep typing,
    // the clock keeps restarting.
    const onExpire = vi.fn();
    const deadline = new IdleDeadline(1_000, onExpire);
    deadline.start();

    for (let i = 0; i < 5; i++) {
      vi.advanceTimersByTime(900);
      deadline.touch();
    }
    expect(onExpire).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1_000);
    expect(onExpire).toHaveBeenCalledTimes(1);
  });

  it('reports the time left, which is what a countdown renders', () => {
    const deadline = new IdleDeadline(30_000, vi.fn());
    deadline.start();

    vi.advanceTimersByTime(11_000);

    expect(deadline.remainingMs()).toBe(19_000);
    expect(deadline.remainingMs()).toBeLessThan(ASK_USER_COUNTDOWN_MS);
  });

  it('stops firing once stopped, so an answered question cannot time out afterwards', () => {
    const onExpire = vi.fn();
    const deadline = new IdleDeadline(1_000, onExpire);
    deadline.start();

    deadline.stop();
    vi.advanceTimersByTime(10_000);

    expect(onExpire).not.toHaveBeenCalled();
    // And a late activity ping cannot resurrect it.
    deadline.touch();
    vi.advanceTimersByTime(10_000);
    expect(onExpire).not.toHaveBeenCalled();
  });

  it('ignores activity before it started', () => {
    const onExpire = vi.fn();
    const deadline = new IdleDeadline(1_000, onExpire);

    deadline.touch();
    vi.advanceTimersByTime(10_000);

    expect(onExpire).not.toHaveBeenCalled();
  });
});
