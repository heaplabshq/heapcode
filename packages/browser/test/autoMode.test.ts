import { describe, expect, it } from 'vitest';
import { decide, mayOfferAlwaysAllow } from '../src/agent/originPolicy.js';
import { ASK_USER, READ_ONLY_TOOLS } from '../src/agent/tools.js';

/**
 * The two things asked for after real use: a mode that stops asking, and a way
 * for the agent to ask *us* something.
 */

describe('the auto mode', () => {
  const none = new Set<string>();

  it('approves routine actions without asking', () => {
    expect(decide({ permission: 'write', host: 'linkedin.com', mode: 'auto', trustedHosts: none }))
      .toEqual({ effect: 'allow' });
  });

  it('approves irreversible actions too — that is the point of it', () => {
    // Ruled out in the PRD on the user's behalf, then asked for twice after
    // using the product. Refusing a capability someone has understood and asked
    // for is paternalism, and the practical result was worse: a confirmation on
    // every wizard step teaches people to click through the one that matters.
    expect(
      decide({ permission: 'destructive', host: 'linkedin.com', mode: 'auto', trustedHosts: none })
        .effect,
    ).toBe('allow');
  });

  it('still cannot act on a bank, because that is a floor and not a preference', () => {
    for (const host of ['netbanking.hdfcbank.com', 'kite.zerodha.com', 'mail.google.com']) {
      const result = decide({ permission: 'write', host, mode: 'auto', trustedHosts: none });
      expect(result.effect, host).toBe('deny');
    }
  });

  it('still allows reading anywhere, including a blocklisted site', () => {
    expect(
      decide({ permission: 'read', host: 'hdfcbank.com', mode: 'auto', trustedHosts: none }).effect,
    ).toBe('allow');
  });

  it('makes "always allow on this site" moot rather than contradictory', () => {
    // Nothing is being asked, so nothing offers a per-site grant either.
    expect(mayOfferAlwaysAllow('destructive', 'linkedin.com')).toBe(false);
  });
});

describe('asking the user', () => {
  it('is offered in every mode, because it is not an action', () => {
    expect(READ_ONLY_TOOLS.some((tool) => tool.name === 'ask_user')).toBe(true);
    expect(ASK_USER.permission).toBe('read');
  });

  it('keeps core’s schema, so blocksAction means what the loop expects', () => {
    const properties = (ASK_USER.parameters as { properties: Record<string, unknown> }).properties;
    expect(properties.question).toBeDefined();
    expect(properties.options).toBeDefined();
    expect(properties.blocksAction).toBeDefined();
  });

  it('tells the model to ask rather than invent a value for a real form', () => {
    // The failure it exists to prevent: a plausible guess typed into a live
    // job application is much worse than a question.
    expect(ASK_USER.description).toMatch(/instead of guessing/i);
    expect(ASK_USER.description).toMatch(/not on the page/i);
  });
});
