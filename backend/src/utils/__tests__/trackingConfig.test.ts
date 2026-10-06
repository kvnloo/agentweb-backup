/**
 * ENG-2315 — trackingConfig is customer-typed config later compared against an attacker-controlled
 * Origin header. The contract: only an exact scheme+host[:port] can be stored, and an empty or
 * malformed stored value denies browsers instead of throwing or matching loosely.
 */
import {
  isOriginAllowed,
  normalizeAllowedOrigin,
  normalizeAllowedOrigins,
  normalizePageLabel,
  MAX_ALLOWED_ORIGINS,
} from '../trackingConfig';

describe('normalizeAllowedOrigin', () => {
  it.each([
    ['https://go.example.com', 'https://go.example.com'],
    ['HTTPS://Go.Example.com/', 'https://go.example.com'],
    ['https://go.example.com:443', 'https://go.example.com'],
    ['https://go.example.com:8443', 'https://go.example.com:8443'],
    ['http://localhost:3000', 'http://localhost:3000'],
  ])('accepts %s as %s', (raw, canonical) => {
    expect(normalizeAllowedOrigin(raw)).toBe(canonical);
  });

  it.each([
    ['wildcard', 'https://*.example.com'],
    ['bare host', 'example.com'],
    ['path', 'https://example.com/lp'],
    ['query', 'https://example.com?x=1'],
    ['credentials', 'https://user:pw@example.com'],
    ['plain http on a real host', 'http://example.com'],
    ['non-http scheme', 'ftp://example.com'],
    ['javascript scheme', 'javascript:alert(1)'],
    ['single-label host', 'https://intranet'],
    ['empty', ''],
    ['too long', `https://${'a'.repeat(250)}.com`],
  ])('rejects %s', (_label, raw) => {
    expect(() => normalizeAllowedOrigin(raw)).toThrow(/origin|http|wildcard/i);
  });

  it('rejects non-strings', () => {
    expect(() => normalizeAllowedOrigin(42)).toThrow();
    expect(() => normalizeAllowedOrigin(null)).toThrow();
    expect(() => normalizeAllowedOrigin({})).toThrow();
  });
});

describe('normalizeAllowedOrigins', () => {
  it('caps at 10, dedupes after canonicalising, requires an array', () => {
    expect(normalizeAllowedOrigins(['https://a.com', 'https://A.com/', 'https://b.com'])).toEqual(['https://a.com', 'https://b.com']);
    const eleven = Array.from({ length: MAX_ALLOWED_ORIGINS + 1 }, (_, i) => `https://s${i}.example.com`);
    expect(() => normalizeAllowedOrigins(eleven)).toThrow(/at most 10/);
    expect(normalizeAllowedOrigins(eleven.slice(0, 10))).toHaveLength(10);
    expect(() => normalizeAllowedOrigins('https://a.com')).toThrow(/array/);
  });
});

describe('normalizePageLabel', () => {
  it('trims, caps at 60, refuses markup and control characters', () => {
    expect(normalizePageLabel('  Guilty v2 ')).toBe('Guilty v2');
    expect(normalizePageLabel('')).toBeUndefined();
    expect(() => normalizePageLabel('x'.repeat(61))).toThrow(/60/);
    expect(() => normalizePageLabel('<script>')).toThrow();
    expect(() => normalizePageLabel('a\nb')).toThrow();
    expect(() => normalizePageLabel(5)).toThrow();
  });
});

describe('isOriginAllowed', () => {
  it('is an exact match and fails closed on empty / malformed stored config', () => {
    const cfg = { allowedOrigins: ['https://go.example.com'] };
    expect(isOriginAllowed(cfg, 'https://go.example.com')).toBe(true);
    expect(isOriginAllowed(cfg, 'https://go.example.com.evil.test')).toBe(false);
    expect(isOriginAllowed(cfg, 'https://evil.test')).toBe(false);
    expect(isOriginAllowed(cfg, 'null')).toBe(false);
    expect(isOriginAllowed({ allowedOrigins: [] }, 'https://go.example.com')).toBe(false);
    expect(isOriginAllowed({ allowedOrigins: 'https://go.example.com' }, 'https://go.example.com')).toBe(false);
    expect(isOriginAllowed({}, 'https://go.example.com')).toBe(false);
    expect(isOriginAllowed(undefined, 'https://go.example.com')).toBe(false);
  });
});
