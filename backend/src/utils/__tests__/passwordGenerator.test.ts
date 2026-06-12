/**
 * Tests for the crypto-secure initial-password generator.
 *
 * System-generated initial passwords / activation codes must be:
 *  - securely randomly generated (crypto, not Math.random)
 *  - at least 6 characters long
 *  - composed of letters and numbers
 *  - paired with a short-lived expiry so they cannot become a long-term password
 */

import {
  generateInitialPassword,
  INITIAL_PASSWORD_TTL_MS,
  getInitialPasswordExpiry,
  isInitialPasswordExpired,
} from '../passwordGenerator';

describe('generateInitialPassword', () => {
  // ---- Invalid inputs / boundary conditions --------------------------------

  it('throws when requested length is below the 6-char minimum', () => {
    expect(() => generateInitialPassword(5)).toThrow(/at least 6/i);
  });

  it('throws on a zero or negative length', () => {
    expect(() => generateInitialPassword(0)).toThrow(/at least 6/i);
    expect(() => generateInitialPassword(-3)).toThrow(/at least 6/i);
  });

  it('accepts the boundary length of exactly 6', () => {
    expect(generateInitialPassword(6)).toHaveLength(6);
  });

  // ---- Happy path ----------------------------------------------------------

  it('defaults to a length of at least 6 when called with no argument', () => {
    const pw = generateInitialPassword();
    expect(pw.length).toBeGreaterThanOrEqual(6);
  });

  it('returns a password of the requested length', () => {
    expect(generateInitialPassword(16)).toHaveLength(16);
  });

  it('only contains letters and numbers (no symbols)', () => {
    for (let i = 0; i < 50; i++) {
      expect(generateInitialPassword(12)).toMatch(/^[A-Za-z0-9]+$/);
    }
  });

  it('produces distinct values across calls (random, not constant)', () => {
    const values = new Set(
      Array.from({ length: 100 }, () => generateInitialPassword(12))
    );
    // With 62^12 of entropy, 100 calls should never collide.
    expect(values.size).toBe(100);
  });
});

describe('initial password expiry helpers', () => {
  it('TTL is one month (~30 days)', () => {
    expect(INITIAL_PASSWORD_TTL_MS).toBe(30 * 24 * 60 * 60 * 1000);
  });

  it('getInitialPasswordExpiry returns an ISO string ~30 days out', () => {
    const before = Date.now();
    const expiryIso = getInitialPasswordExpiry();
    const expiryMs = new Date(expiryIso).getTime();
    expect(expiryMs).toBeGreaterThanOrEqual(before + INITIAL_PASSWORD_TTL_MS - 1000);
    expect(expiryMs).toBeLessThanOrEqual(Date.now() + INITIAL_PASSWORD_TTL_MS + 1000);
  });

  it('isInitialPasswordExpired is false for a future expiry', () => {
    const future = new Date(Date.now() + 60_000).toISOString();
    expect(isInitialPasswordExpired(future)).toBe(false);
  });

  it('isInitialPasswordExpired is true for a past expiry', () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    expect(isInitialPasswordExpired(past)).toBe(true);
  });

  it('isInitialPasswordExpired is false for undefined/empty (no temp password set)', () => {
    expect(isInitialPasswordExpired(undefined)).toBe(false);
    expect(isInitialPasswordExpired('')).toBe(false);
  });

  it('isInitialPasswordExpired is false for an unparseable timestamp', () => {
    expect(isInitialPasswordExpired('not-a-date')).toBe(false);
  });
});
