// Tests for unipileCompanyCacheKeys.ts — namespaced cache key builders for
// Unipile LinkedIn company-profile reads/writes against AW-EnrichmentRawCache.

import {
  buildUnipileCompanyCanonicalKey,
  toUnipileCompanySk,
  unipileCompanyCacheKey,
  extractCompanyIdentifierFromInput,
  UNIPILE_COMPANY_SCHEMA_VERSION,
} from '../services/unipileCompanyCacheKeys';
import { toCanonicalId } from '../services/enrichmentGroups';

describe('extractCompanyIdentifierFromInput', () => {
  it('returns null for empty input', () => {
    expect(extractCompanyIdentifierFromInput('')).toBeNull();
  });

  it('returns null for whitespace-only input', () => {
    expect(extractCompanyIdentifierFromInput('   ')).toBeNull();
  });

  it('extracts identifier from a /company/ URL', () => {
    expect(extractCompanyIdentifierFromInput('https://www.linkedin.com/company/microsoft/'))
      .toBe('microsoft');
  });

  it('extracts identifier from a /company/ URL without trailing slash', () => {
    expect(extractCompanyIdentifierFromInput('https://www.linkedin.com/company/microsoft'))
      .toBe('microsoft');
  });

  it('lowercases the identifier extracted from URL', () => {
    expect(extractCompanyIdentifierFromInput('https://www.linkedin.com/company/Microsoft'))
      .toBe('microsoft');
  });

  it('returns the bare vanity name when no URL is given', () => {
    expect(extractCompanyIdentifierFromInput('microsoft')).toBe('microsoft');
  });

  it('lowercases bare identifiers', () => {
    expect(extractCompanyIdentifierFromInput('Microsoft')).toBe('microsoft');
  });

  it('trims surrounding whitespace', () => {
    expect(extractCompanyIdentifierFromInput('  microsoft  ')).toBe('microsoft');
  });

  it('preserves URN-style identifiers (lowercased)', () => {
    expect(extractCompanyIdentifierFromInput('urn:li:organization:1035'))
      .toBe('urn:li:organization:1035');
  });

  it('strips trailing query/fragment from URL form', () => {
    expect(extractCompanyIdentifierFromInput('https://www.linkedin.com/company/microsoft/?utm=x'))
      .toBe('microsoft');
  });

  it('extracts identifier from a /school/ URL', () => {
    expect(extractCompanyIdentifierFromInput('http://www.linkedin.com/school/ucsandiego'))
      .toBe('ucsandiego');
  });

  it('extracts identifier from a /school/ URL with trailing slash', () => {
    expect(extractCompanyIdentifierFromInput('https://www.linkedin.com/school/mit/'))
      .toBe('mit');
  });

  it('does not return full URL for school URLs (regression guard)', () => {
    const result = extractCompanyIdentifierFromInput('http://www.linkedin.com/school/ucsandiego');
    expect(result).not.toContain('http');
    expect(result).not.toContain('linkedin.com');
  });
});

describe('buildUnipileCompanyCanonicalKey', () => {
  it('returns null for empty', () => {
    expect(buildUnipileCompanyCanonicalKey('')).toBeNull();
  });

  it('builds unipile:company:<identifier> for a vanity name', () => {
    expect(buildUnipileCompanyCanonicalKey('microsoft')).toBe('unipile:company:microsoft');
  });

  it('extracts then namespaces a /company/ URL', () => {
    expect(buildUnipileCompanyCanonicalKey('https://www.linkedin.com/company/microsoft/'))
      .toBe('unipile:company:microsoft');
  });

  it('builds for URN-style identifier', () => {
    expect(buildUnipileCompanyCanonicalKey('urn:li:organization:1035'))
      .toBe('unipile:company:urn:li:organization:1035');
  });
});

describe('toUnipileCompanySk', () => {
  it('formats SK as unipile:company#v1', () => {
    expect(toUnipileCompanySk(1)).toBe('unipile:company#v1');
  });

  it('includes higher version numbers verbatim', () => {
    expect(toUnipileCompanySk(7)).toBe('unipile:company#v7');
  });
});

describe('unipileCompanyCacheKey', () => {
  it('returns null when input is empty', () => {
    expect(unipileCompanyCacheKey('')).toBeNull();
  });

  it('returns sha256 canonicalId + versioned SK for valid input', () => {
    const result = unipileCompanyCacheKey('microsoft');
    expect(result).not.toBeNull();
    expect(result!.canonicalId).toBe(toCanonicalId('unipile:company:microsoft'));
    expect(result!.canonicalId).toMatch(/^[a-f0-9]{64}$/);
    expect(result!.sk).toBe(`unipile:company#v${UNIPILE_COMPANY_SCHEMA_VERSION}`);
    expect(result!.canonicalKey).toBe('unipile:company:microsoft');
    expect(result!.entityKey).toBe('unipile:company:microsoft');
  });

  it('produces the same key for URL and bare identifier forms of the same company', () => {
    const fromUrl = unipileCompanyCacheKey('https://www.linkedin.com/company/microsoft/');
    const fromBare = unipileCompanyCacheKey('microsoft');
    expect(fromUrl!.canonicalId).toBe(fromBare!.canonicalId);
  });

  it('different identifiers produce different canonicalIds', () => {
    const a = unipileCompanyCacheKey('microsoft');
    const b = unipileCompanyCacheKey('apple');
    expect(a!.canonicalId).not.toBe(b!.canonicalId);
  });

  it('vanity name and URN are NOT collapsed by the key builder (response-time dedup is the wrapper job)', () => {
    // Until the API tells us "microsoft" === "urn:li:organization:1035", the keys differ.
    // The cache wrapper writes both rows on a successful response, similar to the
    // public_identifier ↔ provider_id dual-write for person profiles.
    const vanity = unipileCompanyCacheKey('microsoft');
    const urn = unipileCompanyCacheKey('urn:li:organization:1035');
    expect(vanity!.canonicalId).not.toBe(urn!.canonicalId);
  });
});

describe('namespace isolation from other cache producers', () => {
  it('all unipile:company keys start with the unipile:company: prefix', () => {
    const inputs = ['microsoft', 'https://www.linkedin.com/company/apple/', 'urn:li:organization:1'];
    for (const i of inputs) {
      const k = buildUnipileCompanyCanonicalKey(i);
      expect(k!.startsWith('unipile:company:')).toBe(true);
    }
  });

  it('company keys never collide with profile keys for the same string', () => {
    // 'microsoft' as a person handle vs as a company vanity → distinct rows
    const { unipileCacheKey } = require('../services/unipileProfileCacheKeys');
    const company = unipileCompanyCacheKey('microsoft')!;
    const person = unipileCacheKey('microsoft')!;
    expect(company.canonicalId).not.toBe(person.canonicalId);
    expect(company.sk).not.toBe(person.sk);
  });
});
