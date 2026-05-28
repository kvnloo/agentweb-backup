import { sanitizePhone } from '../utils/phoneValidation';

// ─── Null / empty / non-string ────────────────────────────────────────────────

describe('sanitizePhone — null / empty / non-string inputs', () => {
  it('returns null for empty string', () => expect(sanitizePhone('')).toBeNull());
  it('returns null for whitespace-only string', () => expect(sanitizePhone('   ')).toBeNull());
  it('returns null for null (cast)', () => expect(sanitizePhone(null as unknown as string)).toBeNull());
  it('returns null for undefined (cast)', () => expect(sanitizePhone(undefined as unknown as string)).toBeNull());
  it('returns null for a number (cast)', () => expect(sanitizePhone(12345 as unknown as string)).toBeNull());
});

// ─── Vanity numbers ───────────────────────────────────────────────────────────

describe('sanitizePhone — vanity numbers (letters present)', () => {
  it('rejects 1-800-THE-WOLVES', () => expect(sanitizePhone('1-800-THE-WOLVES')).toBeNull());
  it('rejects 1-800-FLOWERS', () => expect(sanitizePhone('1-800-FLOWERS')).toBeNull());
  it('rejects mixed alpha-digit like +1800ABC1234', () => expect(sanitizePhone('+1800ABC1234')).toBeNull());
  it('rejects string with no digits at all', () => expect(sanitizePhone('call-me-maybe')).toBeNull());
});

// ─── Tier 1a: E.164 / + prefix ───────────────────────────────────────────────

describe('sanitizePhone — Tier 1a: E.164 / + prefix', () => {
  it('normalizes a US E.164 number', () => {
    expect(sanitizePhone('+14155552671')).toBe('+1 415 555 2671');
  });

  it('normalizes a US E.164 number with spaces', () => {
    expect(sanitizePhone('+1 415 555 2671')).toBe('+1 415 555 2671');
  });

  it('normalizes a UK number', () => {
    expect(sanitizePhone('+447911123456')).toBe('+44 7911 123456');
  });

  it('normalizes a German number', () => {
    expect(sanitizePhone('+4930123456')).toBe('+49 30 123456');
  });

  it('normalizes an Indian number', () => {
    expect(sanitizePhone('+919876543210')).toBe('+91 98765 43210');
  });

  it('normalizes a French number', () => {
    expect(sanitizePhone('+33612345678')).toBe('+33 6 12 34 56 78');
  });

  it('normalizes with dashes and parentheses', () => {
    const result = sanitizePhone('+1 (415) 555-2671');
    expect(result).toBe('+1 415 555 2671');
  });

  it('returns null for invalid + prefix number (too short)', () => {
    expect(sanitizePhone('+123')).toBeNull();
  });

  it('returns null for + prefix with too many digits', () => {
    // 16 digits after +
    expect(sanitizePhone('+1234567890123456')).toBeNull();
  });
});

// ─── Tier 1b: US national format ─────────────────────────────────────────────

describe('sanitizePhone — Tier 1b: US national format', () => {
  it('normalizes 10-digit US number', () => {
    expect(sanitizePhone('4155552671')).toBe('+1 415 555 2671');
  });

  it('normalizes formatted US number (415) 555-2671', () => {
    expect(sanitizePhone('(415) 555-2671')).toBe('+1 415 555 2671');
  });

  it('normalizes US number with dashes', () => {
    expect(sanitizePhone('415-555-2671')).toBe('+1 415 555 2671');
  });

  it('normalizes US number with dots', () => {
    expect(sanitizePhone('415.555.2671')).toBe('+1 415 555 2671');
  });
});

// ─── Tier 1c: full country code without + ────────────────────────────────────
// libphonenumber cannot parse 00-prefix numbers without a country hint, so
// these fall through to Tier 2 (digit-count fallback) and are stored as-is.

describe('sanitizePhone — Tier 1c: 00-prefix numbers (digit-count fallback path)', () => {
  it('preserves 00-prefix German number via digit-count fallback', () => {
    // 12 digits — within 7-15 range → Tier 2 pass, stored as-is
    expect(sanitizePhone('004930123456')).toBe('004930123456');
  });

  it('preserves 00-prefix UK number via digit-count fallback', () => {
    // 14 digits — within 7-15 range → Tier 2 pass, stored as-is
    expect(sanitizePhone('00447911123456')).toBe('00447911123456');
  });
});

// ─── Tier 2: digit-count fallback ────────────────────────────────────────────

describe('sanitizePhone — Tier 2: digit-count fallback (local format, no country code)', () => {
  it('preserves a 10-digit local number libphonenumber cannot parse without country', () => {
    // "97000 41411" — 10 digits, no country code, not a US number format
    const raw = '97000 41411';
    const result = sanitizePhone(raw);
    // Should be stored as-is since it passes the digit-count check
    expect(result).toBe(raw);
  });

  it('preserves a 7-digit local number (minimum valid length)', () => {
    const raw = '5552671';
    const result = sanitizePhone(raw);
    expect(result).toBe(raw);
  });

  it('preserves a 15-digit number (maximum valid length)', () => {
    const raw = '123456789012345';
    const result = sanitizePhone(raw);
    expect(result).toBe(raw);
  });

  it('returns null for 6-digit number (below minimum)', () => {
    expect(sanitizePhone('123456')).toBeNull();
  });

  it('returns null for 16-digit number (above maximum)', () => {
    expect(sanitizePhone('1234567890123456')).toBeNull();
  });

  it('returns null when non-digit non-separator characters are present', () => {
    // Has a non-separator non-digit character — fails digit-only check
    expect(sanitizePhone('9700x 41411')).toBeNull();
  });

  it('preserves original formatting (spaces/dashes) in fallback result', () => {
    const raw = '970-004-1411';
    const result = sanitizePhone(raw);
    expect(result).toBe(raw);
  });
});

// ─── Edge cases ───────────────────────────────────────────────────────────────

describe('sanitizePhone — edge cases', () => {
  it('trims leading/trailing whitespace before processing', () => {
    expect(sanitizePhone('  +14155552671  ')).toBe('+1 415 555 2671');
  });

  it('returns null for a string containing only separators', () => {
    expect(sanitizePhone('--- ---')).toBeNull();
  });

  it('returns null for a plus sign with no digits', () => {
    expect(sanitizePhone('+')).toBeNull();
  });
});
