/**
 * Tests for Apollo → CRM field mappers in enrichmentV3RealDeps.
 *
 * Focused on phone sanitization: mapApolloOrgToCrmFields and
 * mapApolloPersonToCrmFields must filter invalid phones via sanitizePhone.
 */

import { mapApolloOrgToCrmFields, mapApolloPersonToCrmFields } from '../services/enrichmentV3RealDeps';
import type { MappedOrganization } from '../services/apolloFieldMapper';
import type { MappedPerson } from '../services/apolloFieldMapper';

function makeOrg(overrides: Partial<MappedOrganization> = {}): MappedOrganization {
  return { name: 'Acme Inc', ...overrides } as MappedOrganization;
}

function makePerson(overrides: Partial<MappedPerson> = {}): MappedPerson {
  return { firstName: 'Jane', lastName: 'Doe', ...overrides } as MappedPerson;
}

// ─── mapApolloOrgToCrmFields — phone ──────────────────────────────────────────

describe('mapApolloOrgToCrmFields — phone sanitization', () => {
  it('maps a valid E.164 phone to company_phone in international format', () => {
    const out = mapApolloOrgToCrmFields(makeOrg({ phone: '+14155552671' }));
    expect(out.company_phone).toBe('+1 415 555 2671');
  });

  it('maps a valid US national phone to company_phone', () => {
    const out = mapApolloOrgToCrmFields(makeOrg({ phone: '(415) 555-2671' }));
    expect(out.company_phone).toBe('+1 415 555 2671');
  });

  it('omits company_phone when phone is a vanity number', () => {
    const out = mapApolloOrgToCrmFields(makeOrg({ phone: '1-800-FLOWERS' }));
    expect(out).not.toHaveProperty('company_phone');
  });

  it('omits company_phone when phone is too short', () => {
    const out = mapApolloOrgToCrmFields(makeOrg({ phone: '123' }));
    expect(out).not.toHaveProperty('company_phone');
  });

  it('omits company_phone when phone field is absent', () => {
    const out = mapApolloOrgToCrmFields(makeOrg({ phone: undefined }));
    expect(out).not.toHaveProperty('company_phone');
  });

  it('maps a valid international phone (non-US)', () => {
    const out = mapApolloOrgToCrmFields(makeOrg({ phone: '+447911123456' }));
    expect(out.company_phone).toBe('+44 7911 123456');
  });

  it('preserves other org fields alongside phone', () => {
    const out = mapApolloOrgToCrmFields(makeOrg({
      name: 'Acme',
      websiteUrl: 'https://acme.com',
      phone: '+14155552671',
    }));
    expect(out.company_name).toBe('Acme');
    expect(out.website).toBe('https://acme.com');
    expect(out.company_phone).toBe('+1 415 555 2671');
  });
});

// ─── mapApolloPersonToCrmFields — phone ───────────────────────────────────────

describe('mapApolloPersonToCrmFields — phone sanitization', () => {
  it('maps a valid E.164 phone to phone in international format', () => {
    const out = mapApolloPersonToCrmFields(makePerson({ phone: '+14155552671' }));
    expect(out.phone).toBe('+1 415 555 2671');
  });

  it('maps a valid US national phone to phone field', () => {
    const out = mapApolloPersonToCrmFields(makePerson({ phone: '415-555-2671' }));
    expect(out.phone).toBe('+1 415 555 2671');
  });

  it('omits phone when value is a vanity number', () => {
    const out = mapApolloPersonToCrmFields(makePerson({ phone: '1-800-THE-WOLVES' }));
    expect(out).not.toHaveProperty('phone');
  });

  it('omits phone when value is too short', () => {
    const out = mapApolloPersonToCrmFields(makePerson({ phone: '12345' }));
    expect(out).not.toHaveProperty('phone');
  });

  it('omits phone when phone field is absent', () => {
    const out = mapApolloPersonToCrmFields(makePerson({ phone: undefined }));
    expect(out).not.toHaveProperty('phone');
  });

  it('maps a valid Indian number', () => {
    const out = mapApolloPersonToCrmFields(makePerson({ phone: '+919876543210' }));
    expect(out.phone).toBe('+91 98765 43210');
  });

  it('preserves tier-2 fallback phone (local format, no country code)', () => {
    // 10-digit number that libphonenumber doesn't parse as a US number
    // falls through to digit-count check → stored as-is
    const out = mapApolloPersonToCrmFields(makePerson({ phone: '97000 41411' }));
    expect(out.phone).toBe('97000 41411');
  });

  it('preserves other person fields alongside phone', () => {
    const out = mapApolloPersonToCrmFields(makePerson({
      firstName: 'Jane',
      lastName: 'Doe',
      title: 'CEO',
      phone: '+14155552671',
    }));
    expect(out.first_name).toBe('Jane');
    expect(out.last_name).toBe('Doe');
    expect(out.title).toBe('CEO');
    expect(out.phone).toBe('+1 415 555 2671');
  });
});
