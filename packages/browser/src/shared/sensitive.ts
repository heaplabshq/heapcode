/**
 * Fields the agent must never read or type into.
 *
 * Lives in one place because the rule is applied twice -- extraction refuses to
 * report the value, and the executor refuses to write one -- and two copies of
 * a security rule is how one of them quietly stops matching (this repo already
 * has an example, in two `markdown.ts` files where only one was hardened).
 *
 * Matched on whole words after normalising, not on substrings. Substring
 * matching looked right and was not: `pass` matches "passenger_name" on every
 * flight booking form, and `card` matches "discard". Refusing those makes the
 * agent useless on ordinary forms, and an agent that refuses constantly gets
 * switched off, which protects nobody.
 */

/** `cardNumber` and `card-number` and `CARD_NUMBER` all become `card number`. */
function normalise(text: string): string {
  return text
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[^a-zA-Z0-9]+/g, ' ')
    .toLowerCase()
    .trim();
}

const SENSITIVE_WORDS = new Set([
  'password', 'passwd', 'passcode', 'passphrase', 'pass',
  'otp', 'totp', 'mfa', '2fa',
  'cvv', 'cvc', 'cid', 'csc',
  'pin',
  'ssn', 'sin', 'aadhaar', 'aadhar',
  'card', 'cardnumber', 'creditcard', 'debitcard',
  'secret', 'token', 'apikey',
  'securitycode', 'verificationcode',
]);

/** Two-word phrases that are sensitive together but harmless apart. */
const SENSITIVE_PHRASES = [
  'security code',
  'verification code',
  'card number',
  'account number',
  'one time',
];

/**
 * True when any of the strings describing a field names a credential.
 *
 * Every describing attribute is considered, not just `type=password`: a
 * one-time code is usually `type=text` and a card number frequently is too.
 */
export function namesSensitiveField(...descriptors: (string | null | undefined)[]): boolean {
  const text = normalise(descriptors.filter(Boolean).join(' '));
  if (!text) return false;

  if (SENSITIVE_PHRASES.some((phrase) => text.includes(phrase))) return true;

  return text.split(' ').some((word) => SENSITIVE_WORDS.has(word));
}
