/**
 * The money heuristic, as rules rather than as DOM code.
 *
 * `content/money.ts` had these inline, which was fine while the content script
 * was the only thing that needed them. It is not: the CDP driver builds its
 * controls from the accessibility tree, which knows nothing about class names or
 * form actions, and it has to reach the same verdict from a flat node snapshot.
 *
 * Two implementations of "is this a checkout" is precisely the failure
 * `shared/sensitive.ts` warns about, and this time it had already happened --
 * the CDP path simply never set `checkout` at all, so the whole landmark signal
 * was missing on the default driver. So the *rules* live here, as pure
 * functions over strings, and both walkers call them. Only the walking differs,
 * because only the walking genuinely differs.
 *
 * The tuning notes from the original still apply and are the reason these are
 * token-matched rather than substring-matched: a generated class name put a red
 * "this cannot be undone" on LinkedIn's Apply button twice.
 */

/** Splits `checkoutPanel`, `checkout-panel` and `checkout_panel` alike. */
export function moneyTokens(value: string): string[] {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((token) => token.toLowerCase());
}

export const MONEY_TOKENS = new Set(['checkout', 'payment', 'payments', 'billing', 'purchase']);

/** Path segments that mean the form itself posts money somewhere. */
export const MONEY_SEGMENTS = new Set([
  'checkout', 'payment', 'payments', 'pay', 'billing', 'order', 'orders', 'purchase',
]);

/**
 * The money-ish path segment in a form's action, if it has one.
 *
 * Path segments, not substrings: `/pay/` is a payment endpoint,
 * `/company/paypal-inc` is not, and `?redirect=/paylater` is not this form's
 * destination.
 */
export function moneySegmentOf(action: string | null | undefined): string | undefined {
  if (!action) return undefined;
  let path: string;
  try {
    path = new URL(action, 'https://example.invalid').pathname;
  } catch {
    return undefined;
  }
  for (const segment of path.split('/')) {
    if (MONEY_SEGMENTS.has(segment.toLowerCase())) return segment;
  }
  return undefined;
}

/**
 * The money-ish name on an element, given a way to read its attributes.
 *
 * Takes an accessor rather than an element so the CDP path -- which has an
 * attribute map and no element -- can ask the same question.
 */
export function namedForMoney(get: (attribute: string) => string | null | undefined): string | undefined {
  for (const attribute of ['id', 'class', 'data-testid'] as const) {
    const value = get(attribute);
    if (!value) continue;
    for (const token of moneyTokens(value)) {
      if (MONEY_TOKENS.has(token)) return `it sits inside "${token}"`;
    }
  }
  const label = get('aria-label');
  if (label && moneyTokens(label).some((token) => MONEY_TOKENS.has(token))) {
    return `it sits inside an area labelled "${label}"`;
  }
  return undefined;
}

/**
 * A field that only exists where money is actually being taken.
 *
 * The predicate form of the `PAYMENT_FIELD` selector, matched case-insensitively
 * on the same attributes so the two paths agree on what a card field is.
 */
export function isPaymentField(
  tag: string,
  get: (attribute: string) => string | null | undefined,
): boolean {
  if (tag.toUpperCase() !== 'INPUT') return false;

  const autocomplete = get('autocomplete') ?? '';
  if (autocomplete.includes('cc-')) return true;

  const name = (get('name') ?? '').toLowerCase();
  const id = (get('id') ?? '').toLowerCase();
  if (name.includes('cardnumber') || name.includes('card_number')) return true;
  if (name.includes('cvv') || name.includes('cvc')) return true;
  if (id.includes('cardnumber') || id.includes('cvv')) return true;

  return false;
}

/**
 * Does this control submit a form?
 *
 * A `<button>` inside a form defaults to `type=submit`, which is why the absence
 * of the attribute counts as a submit rather than against it.
 */
export function submitsForm(tag: string, type: string | null | undefined, inForm: boolean): boolean {
  if (!inForm) return false;
  const upper = tag.toUpperCase();
  const kind = (type ?? '').toLowerCase();
  if (upper === 'BUTTON') return kind === '' || kind === 'submit';
  if (upper === 'INPUT') return kind === 'submit' || kind === 'image';
  return false;
}
