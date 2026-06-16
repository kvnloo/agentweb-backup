/**
 * Tests for secureRandom — the CSPRNG password generator (existing) plus the
 * initial-password expiry helpers used to keep a system-generated initial
 * password from becoming a long-term password.
 */

import {
  generateSecurePassword,
  INITIAL_PASSWORD_TTL_MS,
  getInitialPasswordExpiry,
  isInitialPasswordExpired,
} from '../secureRandom';

describe('generateSecurePassword', () => {
  it('throws on a non-positive or non-integer length', () => {
    expect(() => generateSecurePassword(0)).toThrow(/positive integer/i);
    expect(() => generateSecurePassword(-4)).toThrow(/positive integer/i);
    expect(() => generateSecurePassword(3.5)).toThrow(/positive integer/i);
  });

  it('throws on an empty charset', () => {
    expect(() => generateSecurePassword(8, '')).toThrow(/charset/i);
  });

  it('returns a password of the requested length', () => {
    expect(generateSecurePassword(16)).toHaveLength(16);
    expect(generateSecurePassword(8)).toHaveLength(8);
  });

  it('only draws from the provided charset', () => {
    const pw = generateSecurePassword(200, 'abc');
    expect(pw).toMatch(/^[abc]+$/);
  });

  it('produces distinct values across calls (random, not constant)', () => {
    const values = new Set(Array.from({ length: 50 }, () => generateSecurePassword(16)));
    expect(values.size).toBe(50);
  });
});

describe('initial-password expiry helpers', () => {
  it('TTL is one month (~30 days)', () => {
    expect(INITIAL_PASSWORD_TTL_MS).toBe(30 * 24 * 60 * 60 * 1000);
  });

  it('getInitialPasswordExpiry returns an ISO string ~30 days out', () => {
    const before = Date.now();
    const expiryMs = new Date(getInitialPasswordExpiry()).getTime();
    expect(expiryMs).toBeGreaterThanOrEqual(before + INITIAL_PASSWORD_TTL_MS - 1000);
    expect(expiryMs).toBeLessThanOrEqual(Date.now() + INITIAL_PASSWORD_TTL_MS + 1000);
  });

  it('isInitialPasswordExpired is false for a future expiry', () => {
    expect(isInitialPasswordExpired(new Date(Date.now() + 60_000).toISOString())).toBe(false);
  });

  it('isInitialPasswordExpired is true for a past expiry', () => {
    expect(isInitialPasswordExpired(new Date(Date.now() - 60_000).toISOString())).toBe(true);
  });

  it('isInitialPasswordExpired is false for undefined/null/empty (no temp password set)', () => {
    expect(isInitialPasswordExpired(undefined)).toBe(false);
    expect(isInitialPasswordExpired(null)).toBe(false);
    expect(isInitialPasswordExpired('')).toBe(false);
  });

  it('isInitialPasswordExpired is false for an unparseable timestamp', () => {
    expect(isInitialPasswordExpired('not-a-date')).toBe(false);
  });
});
