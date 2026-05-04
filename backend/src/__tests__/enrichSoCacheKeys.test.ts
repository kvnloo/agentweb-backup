// Tests for enrichSoCacheKeys.ts — namespaced cache key builders for enrich.so
// reads/writes against AW-EnrichmentRawCache.

import {
  buildEnrichSoCanonicalKey,
  toEnrichSoSk,
  enrichSoCacheKey,
  ENRICHSO_SCHEMA_VERSION,
  type EnrichSoEndpoint,
} from '../services/enrichSoCacheKeys';
import { toCanonicalId } from '../services/enrichmentGroups';

describe('buildEnrichSoCanonicalKey — validate', () => {
  // FAIL: invalid inputs
  it('returns null for empty email', () => {
    expect(buildEnrichSoCanonicalKey('validate', { email: '' })).toBeNull();
  });

  it('returns null for whitespace-only email', () => {
    expect(buildEnrichSoCanonicalKey('validate', { email: '   ' })).toBeNull();
  });

  it('returns null when email is missing entirely', () => {
    expect(buildEnrichSoCanonicalKey('validate', {} as any)).toBeNull();
  });

  // SUCCESS
  it('builds enrichso:email:<lower-email> for a valid email', () => {
    expect(buildEnrichSoCanonicalKey('validate', { email: 'alice@acme.com' }))
      .toBe('enrichso:email:alice@acme.com');
  });

  it('lowercases mixed-case emails', () => {
    expect(buildEnrichSoCanonicalKey('validate', { email: 'Alice.Smith@ACME.com' }))
      .toBe('enrichso:email:alice.smith@acme.com');
  });

  it('trims surrounding whitespace', () => {
    expect(buildEnrichSoCanonicalKey('validate', { email: '  alice@acme.com  ' }))
      .toBe('enrichso:email:alice@acme.com');
  });
});

describe('buildEnrichSoCanonicalKey — reverse', () => {
  it('shares the same namespace as validate so a single PK lookup covers both', () => {
    const v = buildEnrichSoCanonicalKey('validate', { email: 'alice@acme.com' });
    const r = buildEnrichSoCanonicalKey('reverse', { email: 'alice@acme.com' });
    expect(v).toBe(r);
  });

  it('returns null for empty email', () => {
    expect(buildEnrichSoCanonicalKey('reverse', { email: '' })).toBeNull();
  });
});

describe('buildEnrichSoCanonicalKey — find', () => {
  // FAIL: invalid inputs
  it('returns null when firstName + lastName both missing', () => {
    expect(buildEnrichSoCanonicalKey('find', { domain: 'acme.com' } as any)).toBeNull();
  });

  it('returns null when neither domain nor company is provided', () => {
    expect(buildEnrichSoCanonicalKey('find', { firstName: 'Alice', lastName: 'Smith' } as any))
      .toBeNull();
  });

  it('returns null when all parts are whitespace', () => {
    expect(buildEnrichSoCanonicalKey('find', {
      firstName: '  ', lastName: '  ', domain: '  ',
    } as any)).toBeNull();
  });

  // SUCCESS
  it('builds enrichso:find:<fname>|<lname>|<domain> when domain provided', () => {
    expect(buildEnrichSoCanonicalKey('find', {
      firstName: 'Alice', lastName: 'Smith', domain: 'acme.com',
    })).toBe('enrichso:find:alice|smith|acme.com');
  });

  it('prefers domain over company when both are provided (domain is more stable)', () => {
    expect(buildEnrichSoCanonicalKey('find', {
      firstName: 'Alice', lastName: 'Smith', domain: 'acme.com', company: 'Acme Inc',
    })).toBe('enrichso:find:alice|smith|acme.com');
  });

  it('falls back to normalized company when domain is absent', () => {
    // Strips legal suffixes + lowercases — same convention as buildCompanyCanonicalKey
    expect(buildEnrichSoCanonicalKey('find', {
      firstName: 'Alice', lastName: 'Smith', company: 'Acme Corp',
    })).toBe('enrichso:find:alice|smith|acme');
  });

  it('lowercases all parts', () => {
    expect(buildEnrichSoCanonicalKey('find', {
      firstName: 'ALICE', lastName: 'Smith', domain: 'ACME.COM',
    })).toBe('enrichso:find:alice|smith|acme.com');
  });

  it('trims whitespace from each part', () => {
    expect(buildEnrichSoCanonicalKey('find', {
      firstName: '  Alice  ', lastName: ' Smith ', domain: ' acme.com ',
    })).toBe('enrichso:find:alice|smith|acme.com');
  });

  it('allows missing firstName when lastName + domain are present', () => {
    expect(buildEnrichSoCanonicalKey('find', {
      lastName: 'Smith', domain: 'acme.com',
    } as any)).toBe('enrichso:find:|smith|acme.com');
  });

  it('allows missing lastName when firstName + domain are present', () => {
    expect(buildEnrichSoCanonicalKey('find', {
      firstName: 'Alice', domain: 'acme.com',
    } as any)).toBe('enrichso:find:alice||acme.com');
  });
});

describe('toEnrichSoSk', () => {
  it('formats validate SK as enrichso:validate#v1', () => {
    expect(toEnrichSoSk('validate', 1)).toBe('enrichso:validate#v1');
  });

  it('formats find SK as enrichso:find#v1', () => {
    expect(toEnrichSoSk('find', 1)).toBe('enrichso:find#v1');
  });

  it('formats reverse SK as enrichso:reverse#v1', () => {
    expect(toEnrichSoSk('reverse', 1)).toBe('enrichso:reverse#v1');
  });

  it('includes higher version numbers verbatim', () => {
    expect(toEnrichSoSk('validate', 7)).toBe('enrichso:validate#v7');
  });
});

describe('enrichSoCacheKey — combined (canonicalId, sk) pair', () => {
  it('returns null for inputs that produce a null canonicalKey', () => {
    expect(enrichSoCacheKey('validate', { email: '' })).toBeNull();
  });

  it('returns sha256 canonicalId + versioned SK for valid input', () => {
    const result = enrichSoCacheKey('validate', { email: 'alice@acme.com' });
    expect(result).not.toBeNull();
    expect(result!.canonicalId).toBe(toCanonicalId('enrichso:email:alice@acme.com'));
    expect(result!.canonicalId).toMatch(/^[a-f0-9]{64}$/);
    expect(result!.sk).toBe(`enrichso:validate#v${ENRICHSO_SCHEMA_VERSION}`);
    expect(result!.entityKey).toBe('enrichso:email:alice@acme.com');
  });

  it('reverse and validate share canonicalId but differ in SK', () => {
    const v = enrichSoCacheKey('validate', { email: 'alice@acme.com' })!;
    const r = enrichSoCacheKey('reverse', { email: 'alice@acme.com' })!;
    expect(v.canonicalId).toBe(r.canonicalId);
    expect(v.sk).not.toBe(r.sk);
  });

  it('different emails produce different canonicalIds', () => {
    const a = enrichSoCacheKey('validate', { email: 'alice@acme.com' })!;
    const b = enrichSoCacheKey('validate', { email: 'bob@acme.com' })!;
    expect(a.canonicalId).not.toBe(b.canonicalId);
  });

  it('find result populates entityKey with email when caller passes one', () => {
    const result = enrichSoCacheKey('find', {
      firstName: 'Alice', lastName: 'Smith', domain: 'acme.com', linkedToEmail: 'alice@acme.com',
    });
    expect(result!.entityKey).toBe('enrichso:email:alice@acme.com');
  });

  it('find result falls back to canonicalKey as entityKey when no linkedToEmail', () => {
    const result = enrichSoCacheKey('find', {
      firstName: 'Alice', lastName: 'Smith', domain: 'acme.com',
    });
    expect(result!.entityKey).toBe('enrichso:find:alice|smith|acme.com');
  });
});

describe('namespace isolation from existing field-group cache', () => {
  // The whole point of the discriminator: canonicalIds for enrichso must never
  // collide with company:/person: canonicalIds even if someone happens to
  // create a "company" named "enrichso:email:alice@acme.com". The sha256 of
  // the namespaced string is what protects us — so this test pins the actual
  // pre-hash strings to confirm they all start with the enrichso: prefix.
  it('all enrichso canonical keys start with the enrichso: prefix', () => {
    const inputs: Array<[EnrichSoEndpoint, any]> = [
      ['validate', { email: 'a@b.com' }],
      ['reverse', { email: 'a@b.com' }],
      ['find', { firstName: 'A', lastName: 'B', domain: 'b.com' }],
    ];
    for (const [endpoint, input] of inputs) {
      const key = buildEnrichSoCanonicalKey(endpoint, input);
      expect(key).not.toBeNull();
      expect(key!.startsWith('enrichso:')).toBe(true);
    }
  });
});
