// Tests for computeNameCompanyKey — the synthesized lookup key used by
// NameCompanyLookupIndex GSI for CRM-history Tier 0 sibling lookup.

import { computeNameCompanyKey } from '../utils/leadSchema';

describe('computeNameCompanyKey', () => {
  it('returns lowercased pipe-joined key when all three are present', () => {
    expect(computeNameCompanyKey('Jane', 'Doe', 'Acme Inc')).toBe('jane|doe|acme inc');
  });

  it('trims whitespace from all three inputs', () => {
    expect(computeNameCompanyKey('  Jane  ', '  Doe  ', '  Acme  ')).toBe('jane|doe|acme');
  });

  it('returns undefined when firstName is missing', () => {
    expect(computeNameCompanyKey(undefined, 'Doe', 'Acme')).toBeUndefined();
    expect(computeNameCompanyKey('', 'Doe', 'Acme')).toBeUndefined();
    expect(computeNameCompanyKey('   ', 'Doe', 'Acme')).toBeUndefined();
  });

  it('returns undefined when lastName is missing', () => {
    expect(computeNameCompanyKey('Jane', undefined, 'Acme')).toBeUndefined();
    expect(computeNameCompanyKey('Jane', '', 'Acme')).toBeUndefined();
  });

  it('returns undefined when company is missing', () => {
    expect(computeNameCompanyKey('Jane', 'Doe', undefined)).toBeUndefined();
    expect(computeNameCompanyKey('Jane', 'Doe', '')).toBeUndefined();
  });

  it('preserves spaces within tokens (Acme Inc stays as "acme inc")', () => {
    expect(computeNameCompanyKey('Mary', 'Van Der Berg', 'Big Co')).toBe('mary|van der berg|big co');
  });
});
