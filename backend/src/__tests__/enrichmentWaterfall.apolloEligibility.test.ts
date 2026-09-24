/**
 * ENG-2082 / SW-10: getApolloMatchForLead bails when apolloDedupToken returns null, so the
 * token doubles as an eligibility gate. It used to accept only linkedin or email — but
 * buildMatchCanonicalKey (what the CACHE keys on) also accepts name + domain/org, and
 * matchPerson is passed firstName/lastName/organizationName precisely to support that
 * shape. The disagreement meant Apollo silently never ran for a lead with only a name and
 * a company: 22 fields unfilled, no diagnostic. A phone-only capture that collected a name
 * is exactly that shape.
 */
import { buildMatchCanonicalKey } from '../services/apolloCacheKeys';

// The token is module-private; this asserts the contract it now delegates to, which is the
// thing that actually decides eligibility.
describe('Apollo eligibility follows the canonical match key', () => {
  it('a name + company lead is identifiable', () => {
    expect(
      buildMatchCanonicalKey({ firstName: 'Ada', lastName: 'Lovelace', organizationName: 'Analytical Engines' }),
    ).toMatch(/^apollo:name:/);
  });

  it('a name + domain lead is identifiable', () => {
    expect(
      buildMatchCanonicalKey({ firstName: 'Ada', lastName: 'Lovelace', domain: 'example.com' }),
    ).toMatch(/^apollo:name:/);
  });

  it('linkedin and email still win, in that order', () => {
    expect(buildMatchCanonicalKey({ linkedinUrl: 'https://linkedin.com/in/ada', email: 'a@b.com' }))
      .toMatch(/^apollo:linkedin:/);
    expect(buildMatchCanonicalKey({ email: 'A@B.com' })).toBe('apollo:email:a@b.com');
  });

  it('a lead with nothing to match on is still ineligible', () => {
    expect(buildMatchCanonicalKey({})).toBeNull();
    expect(buildMatchCanonicalKey({ firstName: 'Ada' })).toBeNull();
    // a name with no org is not enough
    expect(buildMatchCanonicalKey({ firstName: 'Ada', lastName: 'Lovelace' })).toBeNull();
  });
});
