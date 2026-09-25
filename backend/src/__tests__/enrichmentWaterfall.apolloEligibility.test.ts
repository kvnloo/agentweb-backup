/**
 * ENG-2082 / SW-10: `apolloDedupToken` doubles as Apollo's ELIGIBILITY GATE —
 * getApolloMatchForLead returns early on a null token — while the cache layer
 * (buildMatchCanonicalKey) happily keys on name + domain/org. The two disagreed, so Apollo
 * silently never ran for a lead with only a name and a company: 22 fields unfilled, no
 * diagnostic. A phone-only capture that collected a name is exactly that shape.
 *
 * This suite calls the TOKEN, not the cache key. The previous version asserted
 * buildMatchCanonicalKey — unchanged code — and therefore passed with the fix reverted.
 */
import { __apolloDedupTokenForTesting as tokenFor } from '../services/enrichmentWaterfall';

describe('apolloDedupToken — Apollo eligibility', () => {
  it('a name + company lead is eligible (the case that was silently skipped)', () => {
    expect(tokenFor({ firstName: 'Ada', lastName: 'Lovelace', company: 'Analytical Engines' }))
      .toMatch(/^apollo:name:/);
  });

  it('a name + website-derived domain lead is eligible', () => {
    expect(tokenFor({ firstName: 'Ada', lastName: 'Lovelace', website: 'https://www.example.com/x' }))
      .toMatch(/^apollo:name:/);
  });

  it('linkedin still wins over email', () => {
    expect(tokenFor({ linkedin: 'https://linkedin.com/in/ada', email: 'a@b.com' }))
      .toMatch(/^apollo:linkedin:/);
  });

  it('email is used when there is no linkedin', () => {
    expect(tokenFor({ email: 'A@B.com' })).toBe('apollo:email:a@b.com');
  });

  it('a lead with nothing to match on stays ineligible', () => {
    expect(tokenFor({})).toBeNull();
    expect(tokenFor({ firstName: 'Ada' })).toBeNull();
    expect(tokenFor({ firstName: 'Ada', lastName: 'Lovelace' })).toBeNull();
  });

  it('the same lead yields a stable token, so in-flight dedup still works', () => {
    const lead = { firstName: 'Ada', lastName: 'Lovelace', company: 'Analytical Engines' };
    expect(tokenFor(lead)).toBe(tokenFor({ ...lead }));
  });
});
