import {
  apolloMatchCacheKey,
  apolloFindCacheKey,
  apolloOrgCacheKey,
  apolloEmailFanoutCacheKey,
  buildMatchCanonicalKey,
  buildFindCanonicalKey,
  buildOrgCanonicalKey,
  toApolloSk,
  APOLLO_SCHEMA_VERSION,
} from '../services/apolloCacheKeys';

describe('apolloCacheKeys', () => {
  describe('buildMatchCanonicalKey', () => {
    it('prefers linkedin URL over email and name+org', () => {
      const k = buildMatchCanonicalKey({
        linkedinUrl: 'https://www.linkedin.com/in/jdoe/',
        email: 'JDoe@Acme.com',
        firstName: 'John',
        lastName: 'Doe',
        domain: 'acme.com',
      });
      expect(k).toBe('apollo:linkedin:https://www.linkedin.com/in/jdoe');
    });

    it('canonicalizes linkedin URL (scheme, www, query, trailing slash)', () => {
      const a = buildMatchCanonicalKey({ linkedinUrl: 'http://linkedin.com/in/jdoe/?miniProfileUrn=xyz' });
      const b = buildMatchCanonicalKey({ linkedinUrl: 'https://www.linkedin.com/in/jdoe' });
      const c = buildMatchCanonicalKey({ linkedinUrl: 'HTTPS://WWW.LINKEDIN.COM/in/jdoe///' });
      expect(a).toBe('apollo:linkedin:https://www.linkedin.com/in/jdoe');
      expect(b).toBe(a);
      expect(c).toBe(a);
    });

    it('falls back to email when linkedin missing', () => {
      const k = buildMatchCanonicalKey({ email: '  Jdoe@Acme.com  ' });
      expect(k).toBe('apollo:email:jdoe@acme.com');
    });

    it('falls back to name+domain when both linkedin and email missing', () => {
      const k = buildMatchCanonicalKey({ firstName: 'John', lastName: 'Doe', domain: 'Acme.COM' });
      expect(k).toBe('apollo:name:john|doe|acme.com');
    });

    it('strips schemes/path off domain inputs', () => {
      expect(buildMatchCanonicalKey({ firstName: 'a', lastName: 'b', domain: 'https://www.acme.com/contact' }))
        .toBe('apollo:name:a|b|acme.com');
    });

    it('uses normalized company name when no domain', () => {
      expect(buildMatchCanonicalKey({ firstName: 'a', lastName: 'b', organizationName: 'Acme, Inc.' }))
        .toBe('apollo:name:a|b|acme');
    });

    it('returns null when nothing identifying provided', () => {
      expect(buildMatchCanonicalKey({})).toBeNull();
      expect(buildMatchCanonicalKey({ firstName: 'John' })).toBeNull();      // no last name + no org
      expect(buildMatchCanonicalKey({ firstName: 'John', lastName: 'Doe' })).toBeNull(); // missing org
    });

    it('returns null when domain has no dot', () => {
      expect(buildMatchCanonicalKey({ firstName: 'a', lastName: 'b', domain: 'localhost' })).toBeNull();
    });
  });

  describe('buildFindCanonicalKey', () => {
    it('builds find key with name + domain', () => {
      expect(buildFindCanonicalKey({ firstName: 'A', lastName: 'B', domain: 'Acme.com' }))
        .toBe('apollo:find:a|b|acme.com');
    });
    it('returns null when name missing', () => {
      expect(buildFindCanonicalKey({ domain: 'acme.com' })).toBeNull();
    });
    it('returns null when both domain and company missing', () => {
      expect(buildFindCanonicalKey({ firstName: 'A', lastName: 'B' })).toBeNull();
    });
  });

  describe('buildOrgCanonicalKey', () => {
    it('builds org key from a domain', () => {
      expect(buildOrgCanonicalKey({ domain: 'Acme.COM' })).toBe('apollo:org:acme.com');
    });
    it('returns null on garbage', () => {
      expect(buildOrgCanonicalKey({ domain: 'localhost' })).toBeNull();
      expect(buildOrgCanonicalKey({ domain: '' })).toBeNull();
    });
  });

  describe('full cache key shape', () => {
    it('produces deterministic canonicalId hashes', () => {
      const a = apolloMatchCacheKey({ linkedinUrl: 'https://linkedin.com/in/x/' });
      const b = apolloMatchCacheKey({ linkedinUrl: 'https://www.linkedin.com/in/x' });
      expect(a).not.toBeNull();
      expect(b).not.toBeNull();
      expect(a!.canonicalId).toBe(b!.canonicalId);
    });

    it('uses sk apollo:<endpoint>#v<version>', () => {
      expect(toApolloSk('match', APOLLO_SCHEMA_VERSION)).toBe('apollo:match#v1');
      expect(toApolloSk('org', APOLLO_SCHEMA_VERSION)).toBe('apollo:org#v1');
    });

    it('namespaces never collide across endpoints for same input', () => {
      const m = apolloMatchCacheKey({ email: 'x@y.com' })!;
      const f = apolloFindCacheKey({ firstName: 'x', lastName: 'y', domain: 'y.com' })!;
      expect(m.sk).not.toBe(f.sk);
      expect(m.canonicalKey).not.toBe(f.canonicalKey);
    });

    it('email fanout shares match SK so a later email-keyed match is a free hit', () => {
      const fanout = apolloEmailFanoutCacheKey('Foo@Bar.com')!;
      const direct = apolloMatchCacheKey({ email: 'foo@bar.com' })!;
      expect(fanout.canonicalId).toBe(direct.canonicalId);
      expect(fanout.sk).toBe(direct.sk);
    });

    it('entityKey defaults to canonicalKey but uses linkedToEmail when provided', () => {
      const a = apolloMatchCacheKey({ linkedinUrl: 'https://linkedin.com/in/x' })!;
      expect(a.entityKey).toBe(a.canonicalKey);

      const b = apolloMatchCacheKey({ linkedinUrl: 'https://linkedin.com/in/x', linkedToEmail: 'X@Y.com' })!;
      expect(b.entityKey).toBe('apollo:email:x@y.com');
    });
  });
});
