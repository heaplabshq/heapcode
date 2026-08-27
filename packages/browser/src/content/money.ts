/**
 * Is this element inside a part of the page that takes money?
 *
 * A backstop behind the wording check: a button reading "Continue" means
 * something different on a payment page. But it is only a backstop, and it has
 * to be precise, because a false positive here is expensive in a way that is
 * easy to miss -- it puts a red "this cannot be undone" warning on an ordinary
 * button, and a user who sees that on LinkedIn's Apply button learns to ignore
 * the red warning everywhere else.
 *
 * Matched on whole tokens, never substrings. Substring matching against `class`
 * and `id` is hopeless on a real site: generated and BEM-ish class names are
 * long, numerous, and full of accidental matches, and every element inherits
 * every ancestor's classes through `closest`. This is the same mistake that
 * made `/pass/` match `passenger_name`, one level further out.
 *
 * `cart` is deliberately not a signal. Adding something to a cart is reversible
 * -- it is the checkout that is not -- and "cart" appears in far too many
 * unrelated class names to be worth its false positives.
 */

/** Splits `checkoutPanel`, `checkout-panel` and `checkout_panel` alike. */
function tokens(value: string): string[] {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((token) => token.toLowerCase());
}

const MONEY_TOKENS = new Set(['checkout', 'payment', 'payments', 'billing', 'purchase']);

/** Path segments that mean the form itself posts money somewhere. */
const MONEY_SEGMENTS = new Set(['checkout', 'payment', 'payments', 'pay', 'billing', 'order', 'orders', 'purchase']);

function actionTakesMoney(form: HTMLFormElement): string | undefined {
  const action = form.getAttribute('action');
  if (!action) return undefined;
  // Path segments, not substrings: `/pay/` is a payment endpoint, `/company/paypal-inc`
  // is not, and `?redirect=/paylater` is not this form's destination.
  let path: string;
  try {
    path = new URL(action, 'https://example.invalid').pathname;
  } catch {
    return undefined;
  }
  for (const segment of path.split('/')) {
    if (MONEY_SEGMENTS.has(segment.toLowerCase())) return `the form posts to /${segment}`;
  }
  return undefined;
}

/**
 * The reason this element counts as being in a money area, or undefined.
 *
 * Returns the reason rather than a boolean so the confirmation can say what it
 * matched. A warning that explains itself is one the user can tell us is wrong.
 */
export function moneyContext(element: Element): string | undefined {
  let node: Element | null = element;
  while (node) {
    if (node instanceof HTMLFormElement) {
      const reason = actionTakesMoney(node);
      if (reason) return reason;
    }

    for (const attribute of ['id', 'class', 'data-testid'] as const) {
      const value = node.getAttribute(attribute);
      if (!value) continue;
      for (const token of tokens(value)) {
        if (MONEY_TOKENS.has(token)) return `it sits inside "${token}"`;
      }
    }

    // An explicit landmark is a deliberate statement by the page, so it is
    // trusted where a class name is not.
    const label = node.getAttribute('aria-label');
    if (label && tokens(label).some((token) => MONEY_TOKENS.has(token))) {
      return `it sits inside an area labelled "${label}"`;
    }

    node = node.parentElement;
  }
  return undefined;
}
