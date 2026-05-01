import {
  parseMoneyToNumber,
  parseEmployeeCount,
  normalizeFields,
  FIELD_TYPES,
} from '../services/enrichmentFieldTypes';

describe('parseMoneyToNumber', () => {
  it.each([
    ['$5M', 5_000_000],
    ['5M', 5_000_000],
    ['$1.2 billion', 1_200_000_000],
    ['1,000,000', 1_000_000],
    ['5K', 5_000],
    ['$50', 50],
  ])('parses %s -> %s', (raw, expected) => {
    expect(parseMoneyToNumber(raw)).toBe(expected);
  });

  it('returns null for nonsense', () => {
    expect(parseMoneyToNumber('abc')).toBeNull();
    expect(parseMoneyToNumber('')).toBeNull();
  });
});

describe('parseEmployeeCount', () => {
  it('parses ranges', () => {
    expect(parseEmployeeCount('11-50')).toEqual({ min: 11, max: 50 });
    expect(parseEmployeeCount('100 to 500')).toEqual({ min: 100, max: 500 });
    expect(parseEmployeeCount('11-50 employees')).toEqual({ min: 11, max: 50 });
  });

  it('parses "200+" as min-only', () => {
    const r = parseEmployeeCount('200+');
    expect(r?.min).toBe(200);
    expect(r?.max).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('parses single numbers as min===max', () => {
    expect(parseEmployeeCount('200')).toEqual({ min: 200, max: 200 });
    expect(parseEmployeeCount('~200')).toEqual({ min: 200, max: 200 });
    expect(parseEmployeeCount('approximately 1000')).toEqual({ min: 1000, max: 1000 });
  });

  it('returns null on garbage', () => {
    expect(parseEmployeeCount('lots')).toBeNull();
    expect(parseEmployeeCount('')).toBeNull();
  });
});

describe('FIELD_TYPES.funding_stage', () => {
  it('maps "series b" to "Series B"', () => {
    const r = FIELD_TYPES.funding_stage.normalize('series b');
    expect(r.value).toBe('Series B');
    expect(r.normalized).toBe('Series B');
  });

  it('maps "Bootstrapped" to "Bootstrapped"', () => {
    const r = FIELD_TYPES.funding_stage.normalize('bootstrapped');
    expect(r.value).toBe('Bootstrapped');
    expect(r.normalized).toBe('Bootstrapped');
  });

  it('preserves unknown stages as raw value with null normalized', () => {
    const r = FIELD_TYPES.funding_stage.normalize('Series Ω');
    expect(r.value).toBe('Series Ω');
    expect(r.normalized).toBeNull();
  });

  // The regex fallback (`if (/ipo|public/.test(lower)) return ...`) was
  // missing its `return` keyword, which silently dropped IPO/Public phrasing
  // to null when the enum loop missed it. With the fix in place these phrases
  // resolve to a canonical IPO or Public value rather than null.
  it.each([
    ['IPO',             ['IPO', 'Public']],
    ['ipo',             ['IPO', 'Public']],
    ['went public',     ['IPO', 'Public']],
    ['publicly listed', ['IPO', 'Public']],
  ])('maps "%s" to a canonical IPO/Public value (not null)', (raw, accepted) => {
    const r = FIELD_TYPES.funding_stage.normalize(raw);
    expect(accepted).toContain(r.value);
    expect(accepted).toContain(r.normalized);
  });
});

describe('FIELD_TYPES.revenue_range', () => {
  it('buckets $5M into $1-10M', () => {
    const r = FIELD_TYPES.revenue_range.normalize('$5M');
    expect(r.value).toBe('$1-10M');
    expect(r.normalized).toEqual({ min: 1_000_000, max: 10_000_000 });
  });

  it('buckets $500M into $100M-1B', () => {
    const r = FIELD_TYPES.revenue_range.normalize('$500M annual');
    expect(r.value).toBe('$100M-1B');
  });

  it('preserves raw text on unparseable input', () => {
    const r = FIELD_TYPES.revenue_range.normalize('not disclosed');
    expect(r.value).toBe('not disclosed');
    expect(r.normalized).toBeNull();
  });
});

describe('FIELD_TYPES.linkedin_url', () => {
  it('extracts a clean URL from text', () => {
    const r = FIELD_TYPES.linkedin_url.normalize('See https://linkedin.com/in/john-smith for details');
    expect(r.value).toBe('https://linkedin.com/in/john-smith');
  });

  it('rejects non-URL input', () => {
    const r = FIELD_TYPES.linkedin_url.normalize('john-smith');
    expect(r.value).toBeNull();
  });
});

describe('normalizeFields', () => {
  it('passes through fields without a spec', () => {
    const { fields, normalized } = normalizeFields({
      industry: 'SaaS',
      tech_stack: 'React, Node',
    });
    expect(fields.industry).toBe('SaaS');
    expect(fields.tech_stack).toBe('React, Node');
    expect(normalized).toEqual({});
  });

  it('normalizes recognized fields and accumulates normalized map', () => {
    const { fields, normalized } = normalizeFields({
      funding_stage: 'series a',
      employee_count: '50-200',
      industry: 'SaaS',
    });
    expect(fields.funding_stage).toBe('Series A');
    expect(normalized.funding_stage).toBe('Series A');
    expect(normalized.employee_count).toEqual({ min: 50, max: 200 });
    expect(fields.industry).toBe('SaaS'); // pass through
    expect(normalized.industry).toBeUndefined();
  });

  it('skips null values', () => {
    const { fields, normalized } = normalizeFields({ funding_stage: null });
    expect(fields.funding_stage).toBeNull();
    expect(normalized).toEqual({});
  });
});
