// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { moneyContext } from '../src/content/money.js';

function at(html: string, selector: string): Element {
  document.body.innerHTML = html;
  return document.querySelector(selector)!;
}

/**
 * Which parts of a page really take money.
 *
 * A backstop behind the wording check, and one that has to be precise. A false
 * positive puts a red "this cannot be undone" on an ordinary button, and a user
 * who sees that warning somewhere obviously harmless learns to ignore it
 * everywhere -- which costs more than the check ever saves.
 */

describe('places that do take money', () => {
  it('recognises an explicit checkout or payment container', () => {
    for (const html of [
      '<div id="checkout"><button>Go</button></div>',
      '<div class="checkout-panel"><button>Go</button></div>',
      '<div class="checkoutPanel"><button>Go</button></div>',
      '<section class="payment-details"><button>Go</button></section>',
      '<div class="billing_section"><button>Go</button></div>',
    ]) {
      expect(moneyContext(at(html, 'button')), html).toBeDefined();
    }
  });

  it('recognises a form that posts to a payment endpoint', () => {
    for (const action of ['/checkout', '/api/payment/submit', '/pay', '/orders/new']) {
      const html = `<form action="${action}"><button>Continue</button></form>`;
      expect(moneyContext(at(html, 'button')), action).toBeDefined();
    }
  });

  it('recognises a labelled payment region', () => {
    const html = '<section aria-label="Payment details"><button>Go</button></section>';
    expect(moneyContext(at(html, 'button'))).toContain('Payment details');
  });

  it('says what it matched, so a wrong warning can be reported', () => {
    const html = '<div class="checkout-panel"><button>Go</button></div>';
    expect(moneyContext(at(html, 'button'))).toContain('checkout');
  });
});

describe('places that do not', () => {
  it('does not fire on LinkedIn-style job markup', () => {
    // The bug this replaced: substring matching against generated class names
    // put "this cannot be undone" on LinkedIn's Apply button.
    const html = `
      <div class="jobs-search__results">
        <div class="job-card-container artdeco-card">
          <div class="jobs-apply-button--top-card">
            <button class="jobs-apply-button artdeco-button">LinkedIn Apply</button>
          </div>
        </div>
      </div>`;
    expect(moneyContext(at(html, 'button'))).toBeUndefined();
  });

  it('does not treat a cart as a commitment, because it is reversible', () => {
    // It is the checkout that cannot be undone, not the cart -- and "cart"
    // appears in far too many unrelated class names to be worth its cost.
    const html = '<div class="mini-cart"><button>Add to bag</button></div>';
    expect(moneyContext(at(html, 'button'))).toBeUndefined();
  });

  it('does not match a token inside a longer word', () => {
    for (const html of [
      '<div class="top-card"><button>Go</button></div>',
      '<div class="descartes-panel"><button>Go</button></div>',
      '<div class="repayments-info"><button>Go</button></div>',
    ]) {
      expect(moneyContext(at(html, 'button')), html).toBeUndefined();
    }
  });

  it('does not match a payment word inside an unrelated URL path', () => {
    // `/company/paypal-inc` is a company page, not a payment endpoint.
    const html = '<form action="/company/paypal-inc"><button>Follow</button></form>';
    expect(moneyContext(at(html, 'button'))).toBeUndefined();
  });

  it('ignores a query string, which is not where this form posts', () => {
    const html = '<form action="/search?redirect=/checkout"><button>Search</button></form>';
    expect(moneyContext(at(html, 'button'))).toBeUndefined();
  });

  it('leaves an ordinary page alone', () => {
    const html = '<main><article><button>Read more</button></article></main>';
    expect(moneyContext(at(html, 'button'))).toBeUndefined();
  });
});
