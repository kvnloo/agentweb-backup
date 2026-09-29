/**
 * ENG-2082: the STORED lifecycle and the COMPUTED lifecycle must agree on what makes a lead
 * contactable. computeLifecycle learned that a phone counts; buildLeadCrmFields — the only
 * derivation createLead uses — still keyed on email alone, so every phone-only capture was
 * written with no `lifecycle` attribute at all. `lifecycle` is in LEAD_STANDARD_FILTER_FIELDS,
 * so `lifecycle is_empty` in delete_leads_by_filter then selects exactly those rows — the same
 * footgun already fixed for `email is_empty`.
 */
import { buildLeadCrmFields } from '../utils/leadSchema';
import { computeLifecycle } from '../services/lifecycleService';

const now = new Date('2026-09-25T00:00:00.000Z');

describe('stored lifecycle agrees with computed lifecycle', () => {
  it('a phone-only lead is stored as inbox, not left unset', () => {
    expect(buildLeadCrmFields(undefined, { phone: '2125559876' }).lifecycle).toBe('inbox');
  });

  it('an email lead is still stored as inbox', () => {
    expect(buildLeadCrmFields('ada@example.com', {}).lifecycle).toBe('inbox');
  });

  it('a lead with no contact channel is still left unset', () => {
    expect(buildLeadCrmFields(undefined, {}).lifecycle).toBeUndefined();
    expect(buildLeadCrmFields(undefined, { phone: '   ' }).lifecycle).toBeUndefined();
  });

  it('an explicit lifecycle still wins', () => {
    expect(buildLeadCrmFields(undefined, { phone: '2125559876', lifecycle: 'paying' }).lifecycle).toBe('paying');
  });

  // The invariant that matters: the two must not disagree for any contactability shape.
  it.each([
    ['email only', 'ada@example.com', undefined],
    ['phone only', undefined, '2125559876'],
    ['both', 'ada@example.com', '2125559876'],
  ])('%s — stored and computed both say inbox', (_label, email, phone) => {
    expect(buildLeadCrmFields(email, phone ? { phone } : {}).lifecycle).toBe('inbox');
    expect(computeLifecycle({ email, phone }, now)).toBe('inbox');
  });
});
