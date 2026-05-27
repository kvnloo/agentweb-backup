/**
 * Tests for normalizeFills() — phone sanitization branch.
 *
 * Also includes regression tests for money and date branches so that adding
 * phone handling didn't break existing normalization.
 */

import { normalizeFills, normalizeMoney, normalizeDate } from '../services/enrichmentNormalizer';
import type { FieldFill } from '../services/enrichmentGroupWaterfall';

function fill(field: string, value: string): FieldFill {
  return { field, value, meta: { source: 'api', enrichedAt: '2026-01-01T00:00:00Z' } };
}

// ─── Phone field — normalization ──────────────────────────────────────────────

describe('normalizeFills — phone field', () => {
  it('normalizes a valid US E.164 phone to international format', () => {
    const result = normalizeFills([fill('phone', '+14155552671')]);
    expect(result).toHaveLength(1);
    expect(result[0].value).toBe('+1 415 555 2671');
  });

  it('normalizes a valid US national format phone', () => {
    const result = normalizeFills([fill('phone', '(415) 555-2671')]);
    expect(result).toHaveLength(1);
    expect(result[0].value).toBe('+1 415 555 2671');
  });

  it('drops a vanity phone fill entirely (does not persist)', () => {
    const result = normalizeFills([fill('phone', '1-800-THE-WOLVES')]);
    expect(result).toHaveLength(0);
  });

  it('drops a too-short phone fill', () => {
    const result = normalizeFills([fill('phone', '12345')]);
    expect(result).toHaveLength(0);
  });

  it('drops a phone fill with letters mixed in', () => {
    const result = normalizeFills([fill('phone', '+1800FLOWERS')]);
    expect(result).toHaveLength(0);
  });

  it('preserves a valid local-format phone as-is (tier-2 fallback)', () => {
    const raw = '97000 41411';
    const result = normalizeFills([fill('phone', raw)]);
    expect(result).toHaveLength(1);
    expect(result[0].value).toBe(raw);
  });

  it('keeps the original fill object reference when value is already normalized', () => {
    const f = fill('phone', '+1 415 555 2671');
    const result = normalizeFills([f]);
    expect(result[0]).toBe(f);
  });

  it('returns a new fill object when the value changes', () => {
    const f = fill('phone', '+14155552671');
    const result = normalizeFills([f]);
    expect(result[0]).not.toBe(f);
    expect(result[0].value).toBe('+1 415 555 2671');
  });
});

// ─── company_phone field ──────────────────────────────────────────────────────

describe('normalizeFills — company_phone field', () => {
  it('normalizes company_phone the same as phone', () => {
    const result = normalizeFills([fill('company_phone', '+14155552671')]);
    expect(result).toHaveLength(1);
    expect(result[0].value).toBe('+1 415 555 2671');
  });

  it('drops invalid company_phone fill', () => {
    const result = normalizeFills([fill('company_phone', 'not-a-phone')]);
    expect(result).toHaveLength(0);
  });
});

// ─── Alias resolution ─────────────────────────────────────────────────────────

describe('normalizeFills — phone alias resolution', () => {
  it('sanitizes a user-named phone field via alias map', () => {
    const aliases = { myPhone: 'phone' };
    const result = normalizeFills([fill('myPhone', '1-800-THE-WOLVES')], aliases);
    expect(result).toHaveLength(0);
  });

  it('sanitizes a user-named company_phone field via alias map', () => {
    const aliases = { officePhone: 'company_phone' };
    const result = normalizeFills([fill('officePhone', '+14155552671')], aliases);
    expect(result).toHaveLength(1);
    expect(result[0].value).toBe('+1 415 555 2671');
  });

  it('leaves a non-phone field with the same value as a phone alias untouched when no alias', () => {
    // No alias provided — 'myPhone' is not in PHONE_FIELDS → passthrough
    const result = normalizeFills([fill('myPhone', '1-800-THE-WOLVES')]);
    expect(result).toHaveLength(1);
    expect(result[0].value).toBe('1-800-THE-WOLVES');
  });
});

// ─── Multiple fills — mixed valid/invalid phones ──────────────────────────────

describe('normalizeFills — multiple fills', () => {
  it('drops invalid fills and keeps valid ones in a batch', () => {
    const result = normalizeFills([
      fill('phone', '1-800-FLOWERS'),
      fill('company_phone', '+14155552671'),
      fill('title', 'CEO'),
    ]);
    expect(result).toHaveLength(2);
    expect(result[0].field).toBe('company_phone');
    expect(result[0].value).toBe('+1 415 555 2671');
    expect(result[1].field).toBe('title');
  });

  it('preserves fill order for non-phone fields', () => {
    const result = normalizeFills([
      fill('title', 'CEO'),
      fill('phone', '+14155552671'),
      fill('company', 'Acme'),
    ]);
    expect(result.map(f => f.field)).toEqual(['title', 'phone', 'company']);
  });
});

// ─── Empty / falsy value passthrough ─────────────────────────────────────────

describe('normalizeFills — empty values', () => {
  it('passes through a fill with empty value without calling sanitizePhone', () => {
    const result = normalizeFills([fill('phone', '')]);
    // falsy value path — pushed as-is
    expect(result).toHaveLength(1);
    expect(result[0].value).toBe('');
  });
});

// ─── Regression: money normalization unaffected ───────────────────────────────

describe('normalizeFills — money regression', () => {
  it('normalizes total_funding from raw number string', () => {
    const result = normalizeFills([fill('total_funding', '5000000')]);
    expect(result[0].value).toBe('$5M');
  });

  it('normalizes annual_revenue with B suffix', () => {
    const result = normalizeFills([fill('annual_revenue', '1.5B')]);
    expect(result[0].value).toBe('$1.5B');
  });
});

// ─── Regression: date normalization unaffected ────────────────────────────────

describe('normalizeFills — date regression', () => {
  it('normalizes ISO date in a _date field', () => {
    const result = normalizeFills([fill('last_funding_date', '2025-10-14')]);
    expect(result[0].value).toBe('10/14/2025');
  });

  it('normalizes ISO datetime in a _date field', () => {
    const result = normalizeFills([fill('last_funding_date', '2026-03-01T00:00:00.000+00:00')]);
    expect(result[0].value).toBe('03/01/2026');
  });
});

// ─── normalizeMoney unit tests ────────────────────────────────────────────────

describe('normalizeMoney', () => {
  it('formats billions', () => expect(normalizeMoney('1500000000')).toBe('$1.5B'));
  it('formats millions', () => expect(normalizeMoney('287250000')).toBe('$287.25M'));
  it('formats thousands', () => expect(normalizeMoney('5000')).toBe('$5K'));
  it('handles "billion" word', () => expect(normalizeMoney('852 billion')).toBe('$852B'));
  it('handles "M" suffix', () => expect(normalizeMoney('287.25M')).toBe('$287.25M'));
  it('handles "$" prefix', () => expect(normalizeMoney('$5,000,000')).toBe('$5M'));
  it('handles trillions', () => expect(normalizeMoney('2T')).toBe('$2T'));
  it('returns raw string for unparseable input', () => expect(normalizeMoney('unknown')).toBe('unknown'));
});

// ─── normalizeDate unit tests ─────────────────────────────────────────────────

describe('normalizeDate', () => {
  it('passes through already-formatted MM/DD/YYYY', () => {
    expect(normalizeDate('10/14/2025')).toBe('10/14/2025');
  });

  it('converts ISO date YYYY-MM-DD', () => {
    expect(normalizeDate('2025-10-14')).toBe('10/14/2025');
  });

  it('converts "14-Nov-2025"', () => {
    expect(normalizeDate('14-Nov-2025')).toBe('11/14/2025');
  });

  it('converts "Nov 14, 2025"', () => {
    expect(normalizeDate('Nov 14, 2025')).toBe('11/14/2025');
  });

  it('returns raw string for unparseable input', () => {
    expect(normalizeDate('not-a-date')).toBe('not-a-date');
  });
});
