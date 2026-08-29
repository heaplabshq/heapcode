import { describe, expect, it } from 'vitest';
import { namesSensitiveField } from '../src/shared/sensitive.js';

/**
 * The credential rule, which is applied in two places and must mean the same
 * thing in both.
 *
 * It is tuned in two directions at once, which is why it needs its own tests.
 * Missing a real credential field means a model types a password into a page.
 * Refusing ordinary fields means the agent cannot fill a booking form, gets
 * switched off, and protects nobody.
 */

describe('fields that must be refused', () => {
  it('catches passwords however they are spelled', () => {
    for (const name of ['password', 'passwd', 'user_password', 'passPhrase', 'PASSCODE', 'pass']) {
      expect(namesSensitiveField(name), name).toBe(true);
    }
  });

  it('catches one-time codes, which are almost never type=password', () => {
    for (const name of ['otp', 'OTP_input', 'one-time code', 'mfa', '2fa', 'verification code']) {
      expect(namesSensitiveField(name), name).toBe(true);
    }
  });

  it('catches payment fields in their usual spellings', () => {
    for (const name of ['cardNumber', 'card-number', 'CARD_NUMBER', 'cvv', 'cvc', 'csc', 'security code']) {
      expect(namesSensitiveField(name), name).toBe(true);
    }
  });

  it('catches national identifiers', () => {
    for (const name of ['ssn', 'aadhaar', 'aadhar_number']) {
      expect(namesSensitiveField(name), name).toBe(true);
    }
  });

  it('looks at every attribute that names a field, not just one', () => {
    expect(namesSensitiveField(null, 'field_3', 'cc-csc', undefined)).toBe(true);
    expect(namesSensitiveField(undefined, undefined, undefined, 'Enter your PIN')).toBe(true);
  });
});

describe('fields that must NOT be refused', () => {
  it('does not fire on words that merely contain a sensitive one', () => {
    // The bug this replaced: /pass/ matched "passenger_name" on every flight
    // booking form, and /card/ matched "discard".
    for (const name of [
      'passenger_name',
      'passport_country',
      'bypass_cache',
      'compass_heading',
      'discard_draft',
      'cardigan_size',
      'pinned_post',
      'shipping_address',
    ]) {
      expect(namesSensitiveField(name), name).toBe(false);
    }
  });

  it('leaves ordinary form fields alone', () => {
    for (const name of ['email', 'full name', 'searchTerm', 'quantity', 'postcode', 'phone']) {
      expect(namesSensitiveField(name), name).toBe(false);
    }
  });

  it('is false when nothing describes the field at all', () => {
    expect(namesSensitiveField()).toBe(false);
    expect(namesSensitiveField(null, undefined, '')).toBe(false);
  });
});
