// Tests for unipileProfileCacheKeys.ts — namespaced cache key builders for
// Unipile LinkedIn profile reads/writes against AW-EnrichmentRawCache.

import {
  buildUnipileCanonicalKey,
  toUnipileSk,
  unipileCacheKey,
  extractIdentifierFromInput,
  UNIPILE_SCHEMA_VERSION,
} from '../services/unipileProfileCacheKeys';
import { toCanonicalId } from '../services/enrichmentGroups';

describe('extractIdentifierFromInput', () => {
  it('returns null for empty input', () => {
    expect(extractIdentifierFromInput('')).toBeNull();
  });

  it('returns null for whitespace-only input', () => {
    expect(extractIdentifierFromInput('   ')).toBeNull();
  });

  it('extracts identifier from a /in/ profile URL', () => {
    expect(extractIdentifierFromInput('https://www.linkedin.com/in/alice-smith/')).toBe('alice-smith');
  });

  it('extracts identifier from a /in/ URL without trailing slash', () => {
    expect(extractIdentifierFromInput('https://www.linkedin.com/in/alice-smith')).toBe('alice-smith');
  });

  it('lowercases the identifier extracted from URL', () => {
    expect(extractIdentifierFromInput('https://www.linkedin.com/in/Alice-Smith')).toBe('alice-smith');
  });

  it('returns the bare identifier when no URL is given', () => {
    expect(extractIdentifierFromInput('alice-smith')).toBe('alice-smith');
  });

  it('lowercases bare identifiers', () => {
    expect(extractIdentifierFromInput('Alice-Smith')).toBe('alice-smith');
  });

  it('trims surrounding whitespace', () => {
    expect(extractIdentifierFromInput('  alice-smith  ')).toBe('alice-smith');
  });

  it('preserves provider_id-style identifiers (URN-like) verbatim except lowercase', () => {
    expect(extractIdentifierFromInput('ACoAAA1234ABC')).toBe('acoaaa1234abc');
  });
});

describe('buildUnipileCanonicalKey', () => {
  it('returns null for empty identifier', () => {
    expect(buildUnipileCanonicalKey('')).toBeNull();
  });

  it('returns null for whitespace-only', () => {
    expect(buildUnipileCanonicalKey('   ')).toBeNull();
  });

  it('builds unipile:profile:<identifier> for a bare identifier', () => {
    expect(buildUnipileCanonicalKey('alice-smith')).toBe('unipile:profile:alice-smith');
  });

  it('extracts then namespaces a /in/ URL', () => {
    expect(buildUnipileCanonicalKey('https://www.linkedin.com/in/alice-smith/'))
      .toBe('unipile:profile:alice-smith');
  });

  it('lowercases the identifier', () => {
    expect(buildUnipileCanonicalKey('Alice-Smith')).toBe('unipile:profile:alice-smith');
  });
});

describe('toUnipileSk', () => {
  it('formats SK as unipile:profile#v1', () => {
    expect(toUnipileSk(1)).toBe('unipile:profile#v1');
  });

  it('includes higher version numbers verbatim', () => {
    expect(toUnipileSk(5)).toBe('unipile:profile#v5');
  });
});

describe('unipileCacheKey — combined (canonicalId, sk) pair', () => {
  it('returns null when identifier is empty', () => {
    expect(unipileCacheKey('')).toBeNull();
  });

  it('returns sha256 canonicalId + versioned SK for valid input', () => {
    const result = unipileCacheKey('alice-smith');
    expect(result).not.toBeNull();
    expect(result!.canonicalId).toBe(toCanonicalId('unipile:profile:alice-smith'));
    expect(result!.canonicalId).toMatch(/^[a-f0-9]{64}$/);
    expect(result!.sk).toBe(`unipile:profile#v${UNIPILE_SCHEMA_VERSION}`);
    expect(result!.canonicalKey).toBe('unipile:profile:alice-smith');
    expect(result!.entityKey).toBe('unipile:profile:alice-smith');
  });

  it('produces the same key for URL and bare identifier forms of the same person', () => {
    const fromUrl = unipileCacheKey('https://www.linkedin.com/in/alice-smith/');
    const fromBare = unipileCacheKey('alice-smith');
    expect(fromUrl!.canonicalId).toBe(fromBare!.canonicalId);
  });

  it('different identifiers produce different canonicalIds', () => {
    const a = unipileCacheKey('alice-smith');
    const b = unipileCacheKey('bob-jones');
    expect(a!.canonicalId).not.toBe(b!.canonicalId);
  });
});

describe('namespace isolation from other cache producers', () => {
  // The discriminator's job: canonicalIds for unipile must never collide with
  // enrichso: or company:/person: canonicalIds. We pin the pre-hash prefix
  // because that's what feeds sha256 — same protection as enrichSoCacheKeys.
  it('all unipile canonical keys start with the unipile: prefix', () => {
    const inputs = ['alice-smith', 'https://www.linkedin.com/in/bob/', 'ACoAAA123'];
    for (const input of inputs) {
      const key = buildUnipileCanonicalKey(input);
      expect(key).not.toBeNull();
      expect(key!.startsWith('unipile:')).toBe(true);
    }
  });
});
