// Tests for unipileSearchParamCacheKeys — key + sk builders for the
// Unipile /linkedin/search/parameters resolver against AW-EnrichmentRawCache.

import {
  buildUnipileSearchParamCanonicalKey,
  toUnipileSearchParamSk,
  unipileSearchParamCacheKey,
  normalizeSearchParamKeywords,
  UNIPILE_SEARCH_PARAM_SCHEMA_VERSION,
  type SearchParamType,
} from '../services/unipileSearchParamCacheKeys';

describe('normalizeSearchParamKeywords', () => {
  it('lowercases and trims', () => {
    expect(normalizeSearchParamKeywords('  Acme Corp  ')).toBe('acme corp');
  });

  it('collapses internal whitespace', () => {
    expect(normalizeSearchParamKeywords('Acme   \t  Corp')).toBe('acme corp');
  });

  it('strips most punctuation', () => {
    expect(normalizeSearchParamKeywords('Acme, Inc.')).toBe('acme inc');
    expect(normalizeSearchParamKeywords('Acme & Co!')).toBe('acme co');
  });

  it('returns null for empty/whitespace-only input', () => {
    expect(normalizeSearchParamKeywords('')).toBeNull();
    expect(normalizeSearchParamKeywords('   ')).toBeNull();
    expect(normalizeSearchParamKeywords(undefined as any)).toBeNull();
  });
});

describe('buildUnipileSearchParamCanonicalKey', () => {
  it('builds key with type and normalized keywords', () => {
    expect(buildUnipileSearchParamCanonicalKey('COMPANY', 'Acme Corp'))
      .toBe('unipile-search-param:company:acme corp');
  });

  it('returns null when keywords normalize to empty', () => {
    expect(buildUnipileSearchParamCanonicalKey('COMPANY', '')).toBeNull();
    expect(buildUnipileSearchParamCanonicalKey('LOCATION', '   ')).toBeNull();
  });

  it('produces identical keys for input variants that should collapse', () => {
    const a = buildUnipileSearchParamCanonicalKey('COMPANY', 'Acme, Inc.');
    const b = buildUnipileSearchParamCanonicalKey('COMPANY', '  acme inc  ');
    expect(a).toBe(b);
  });

  it('lowercases the type discriminator', () => {
    const types: SearchParamType[] = ['COMPANY', 'LOCATION', 'INDUSTRY', 'SCHOOL', 'SERVICE'];
    for (const t of types) {
      expect(buildUnipileSearchParamCanonicalKey(t, 'foo')).toContain(`:${t.toLowerCase()}:`);
    }
  });
});

describe('toUnipileSearchParamSk', () => {
  it('builds sk with version', () => {
    expect(toUnipileSearchParamSk(7)).toBe('unipile-search-param#v7');
  });
});

describe('unipileSearchParamCacheKey', () => {
  it('returns a fully-formed key bundle for valid input', () => {
    const key = unipileSearchParamCacheKey('COMPANY', 'Acme Corp');
    expect(key).not.toBeNull();
    expect(key!.canonicalKey).toBe('unipile-search-param:company:acme corp');
    expect(key!.sk).toBe(`unipile-search-param#v${UNIPILE_SEARCH_PARAM_SCHEMA_VERSION}`);
    expect(key!.entityKey).toBe(key!.canonicalKey);
    // canonicalId should be a sha256 hex string (64 chars)
    expect(key!.canonicalId).toMatch(/^[a-f0-9]{64}$/);
  });

  it('returns null for invalid input', () => {
    expect(unipileSearchParamCacheKey('COMPANY', '')).toBeNull();
    expect(unipileSearchParamCacheKey('COMPANY', '   ')).toBeNull();
  });

  it('different inputs produce different canonicalIds', () => {
    const a = unipileSearchParamCacheKey('COMPANY', 'Acme')!;
    const b = unipileSearchParamCacheKey('COMPANY', 'Beta')!;
    const c = unipileSearchParamCacheKey('LOCATION', 'Acme')!;
    expect(a.canonicalId).not.toBe(b.canonicalId);
    expect(a.canonicalId).not.toBe(c.canonicalId);
  });
});
