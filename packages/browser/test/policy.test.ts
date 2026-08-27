import { describe, expect, it } from 'vitest';
import { classifyClick, classifyNavigate, classifyType } from '../src/agent/destructive.js';
import { decide, isHighHarm, mayOfferAlwaysAllow } from '../src/agent/originPolicy.js';
import type { Control } from '../src/shared/snapshot.js';

function control(name: string, extra: Partial<Control> = {}): Control {
  return { handle: 1, role: 'button', name, score: 10, ...extra };
}

/**
 * The safety rules, tested before anything can act on a real page.
 *
 * These are the whole reason M3 is not just "add a click tool". A wrong click
 * in heapcode corrupts a working tree that git can restore; a wrong click here
 * spends the user's money inside their own logged-in session.
 */

describe('inferring that a click commits something', () => {
  it('escalates committing language in the control name', () => {
    for (const name of ['Buy now', 'Place order', 'Pay 979', 'Delete account', 'Transfer funds']) {
      expect(classifyClick(control(name)).permission, name).toBe('destructive');
    }
  });

  it('escalates a form submit whose wording gives nothing away', () => {
    expect(classifyClick(control('Go', { submits: true })).permission).toBe('destructive');
    expect(classifyClick(control('OK', { submits: true })).permission).toBe('destructive');
  });

  it('does not escalate a wizard step, which submits merely to advance', () => {
    // Found in real use: applying for a job meant approving every page of the
    // wizard. That is the fatigue that makes the confirmation at the *end* --
    // the one that matters -- get clicked through without reading.
    for (const name of ['Next', 'Continue', 'Save and continue', 'Next step', 'Skip', 'Back']) {
      expect(classifyClick(control(name, { submits: true })).permission, name).toBe('write');
    }
  });

  it('still escalates a wizard-looking button inside a checkout', () => {
    // "Continue" on a payment page is exactly as irreversible as "Buy now".
    expect(
      classifyClick(control('Continue', { submits: true, checkout: true })).permission,
    ).toBe('destructive');
  });

  it('still escalates the button that actually finishes the application', () => {
    for (const name of ['Submit application', 'Submit', 'Confirm and submit']) {
      expect(classifyClick(control(name, { submits: true })).permission, name).toBe('destructive');
    }
  });

  it('escalates anything inside a checkout or payment area', () => {
    expect(classifyClick(control('Yes', { checkout: true })).permission).toBe('destructive');
  });

  it('leaves ordinary navigation and filtering as a plain write', () => {
    for (const name of ['Next page', 'Sort by price', '16GB', 'Show more', 'Read reviews']) {
      expect(classifyClick(control(name)).permission, name).toBe('write');
    }
  });

  it('does not fire on phrases that only look committing', () => {
    // Over-confirming is not free: a confirmation on "Apply filters" teaches
    // the user to click through without reading, which makes every later
    // confirmation worthless.
    for (const name of ['Apply filters', 'Payment methods', 'Order history', 'Remove filter']) {
      expect(classifyClick(control(name)).permission, name).toBe('write');
    }
  });

  it('matches whole words, so "buy" does not fire inside another word', () => {
    expect(classifyClick(control('Buyer protection details')).permission).toBe('write');
  });

  it('explains itself, because the reason is shown to the user', () => {
    expect(classifyClick(control('Place order')).reason).toContain('Place order');
  });
});

describe('typing', () => {
  it('is an ordinary write in an ordinary field', () => {
    expect(classifyType(control('Search', { role: 'input' })).permission).toBe('write');
  });

  it('escalates inside checkout, where a field is part of a payment', () => {
    expect(
      classifyType(control('Name on card', { role: 'input', checkout: true })).permission,
    ).toBe('destructive');
  });
});

describe('navigation', () => {
  it('treats staying on the site as a plain write', () => {
    expect(
      classifyNavigate('https://shop.example.com/a', 'https://shop.example.com/b').permission,
    ).toBe('write');
    expect(classifyNavigate('https://shop.example.com/a', '/b').permission).toBe('write');
  });

  it('escalates leaving the site', () => {
    // This is how an agent following a hostile page ends up somewhere the user
    // never intended, still carrying their session.
    const result = classifyNavigate('https://shop.example.com/a', 'https://evil.example/steal');
    expect(result.permission).toBe('destructive');
    expect(result.reason).toContain('evil.example');
  });

  it('escalates anything it cannot parse rather than assuming it is safe', () => {
    expect(classifyNavigate('https://shop.example.com', 'javascript:alert(1)').permission).toBe(
      'destructive',
    );
  });
});

describe('the high-harm blocklist', () => {
  it('covers subdomains, not just the exact host', () => {
    expect(isHighHarm('hdfcbank.com')).toBe(true);
    expect(isHighHarm('netbanking.hdfcbank.com')).toBe(true);
    expect(isHighHarm('kite.zerodha.com')).toBe(true);
  });

  it('does not fire on a lookalike that merely ends in the same letters', () => {
    expect(isHighHarm('nothdfcbank.com')).toBe(false);
    expect(isHighHarm('mychase.com.evil.example')).toBe(false);
  });

  it('leaves ordinary sites alone', () => {
    expect(isHighHarm('amazon.in')).toBe(false);
    expect(isHighHarm('news.ycombinator.com')).toBe(false);
  });
});

describe('the decision', () => {
  const none = new Set<string>();

  it('never asks about reading', () => {
    expect(
      decide({ permission: 'read', host: 'amazon.in', mode: 'confirm', trustedHosts: none }),
    ).toEqual({ effect: 'allow' });
  });

  it('asks before writing on an ordinary site', () => {
    expect(
      decide({ permission: 'write', host: 'amazon.in', mode: 'confirm', trustedHosts: none }).effect,
    ).toBe('ask');
  });

  it('refuses to act on a blocklisted site whatever the mode or grant', () => {
    for (const mode of ['confirm', 'auto-approve', 'read-only'] as const) {
      const result = decide({
        permission: 'write',
        host: 'netbanking.hdfcbank.com',
        mode,
        trustedHosts: new Set(['netbanking.hdfcbank.com']),
      });
      expect(result.effect, mode).toBe('deny');
    }
  });

  it('still allows reading a blocklisted site', () => {
    expect(
      decide({ permission: 'read', host: 'hdfcbank.com', mode: 'confirm', trustedHosts: none })
        .effect,
    ).toBe('allow');
  });

  it('stops asking about writes on a site the user trusted', () => {
    expect(
      decide({
        permission: 'write',
        host: 'amazon.in',
        mode: 'confirm',
        trustedHosts: new Set(['amazon.in']),
      }).effect,
    ).toBe('allow');
  });

  it('keeps asking about destructive actions even on a trusted site', () => {
    // "Always allow" was answered about filling a field, not about placing an
    // order. There is no mode in which buying something happens silently.
    expect(
      decide({
        permission: 'destructive',
        host: 'amazon.in',
        mode: 'auto-approve',
        trustedHosts: new Set(['amazon.in']),
      }).effect,
    ).toBe('ask');
  });

  it('blocks every action in read-only mode', () => {
    expect(
      decide({ permission: 'write', host: 'amazon.in', mode: 'read-only', trustedHosts: none })
        .effect,
    ).toBe('deny');
  });
});

describe('offering "always allow on this site"', () => {
  it('is offered for writes on an ordinary site', () => {
    expect(mayOfferAlwaysAllow('write', 'amazon.in')).toBe(true);
  });

  it('is never offered for a destructive action', () => {
    expect(mayOfferAlwaysAllow('destructive', 'amazon.in')).toBe(false);
  });

  it('is never offered on a blocklisted site', () => {
    expect(mayOfferAlwaysAllow('write', 'hdfcbank.com')).toBe(false);
  });
});
