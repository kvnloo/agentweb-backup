/**
 * Tests for the Apollo identity-verification gate.
 *
 * Reproduces the production bug where lead "Joe Hio" (joe@us.com) was enriched
 * by Apollo /people/match and received the LinkedIn URL of an unrelated person
 * ("Awais Haider"). Apollo's name-fallback match returned a different person
 * AND echoed the input email back onto it with email_status:null, so an
 * email-equality check alone would have trusted the wrong profile.
 *
 * The gate (apolloMatchIsTrustworthy) decides whether a mapped match belongs
 * to the lead it was looked up for, before any identity field (linkedin,
 * firstName, lastName, title, ...) is persisted.
 */

import { apolloMatchIsTrustworthy, type MapMatchInputs } from '../services/apolloFieldMapper';

// Mirrors the exact production payload Apollo returned for joe@us.com.
const JOE_HIO_INPUTS: MapMatchInputs = {
  hadEmail: true,
  hadNameAndOrg: false,
  leadFirstName: 'Joe',
  leadLastName: 'Hio',
};
const JOE_HIO_PERSON = {
  firstName: 'Awais',
  lastName: 'Haider',
  email: 'joe@us.com',          // Apollo echoed the input email back
  emailStatus: undefined,        // NOT verified
  linkedin: 'http://www.linkedin.com/in/awais-haider-8291b2179',
};

describe('apolloMatchIsTrustworthy — the Joe Hio bug', () => {
  it('REJECTS a name-fallback match whose name does not match the lead, even when Apollo echoes the input email', () => {
    expect(apolloMatchIsTrustworthy(JOE_HIO_PERSON, JOE_HIO_INPUTS)).toBe(false);
  });

  it('REJECTS when both name tokens differ and email is unverified', () => {
    expect(
      apolloMatchIsTrustworthy(
        { firstName: 'Awais', lastName: 'Haider', email: 'joe@us.com' },
        { hadEmail: true, leadFirstName: 'Joe', leadLastName: 'Hio' },
      ),
    ).toBe(false);
  });

  it('REJECTS when only first name differs (last name happens to collide)', () => {
    expect(
      apolloMatchIsTrustworthy(
        { firstName: 'Bob', lastName: 'Hio' },
        { leadFirstName: 'Joe', leadLastName: 'Hio' },
      ),
    ).toBe(false);
  });
});

describe('apolloMatchIsTrustworthy — trust paths', () => {
  it('TRUSTS a linkedin-keyed lookup regardless of name (URL match is authoritative)', () => {
    expect(
      apolloMatchIsTrustworthy(
        { firstName: 'Awais', lastName: 'Haider' },
        { hadLinkedinUrl: true, leadFirstName: 'Joe', leadLastName: 'Hio' },
      ),
    ).toBe(true);
  });

  it('TRUSTS when Apollo reports email_status verified, even if the lead name is sparse', () => {
    expect(
      apolloMatchIsTrustworthy(
        { firstName: 'Awais', lastName: 'Haider', email: 'joe@us.com', emailStatus: 'verified' },
        { hadEmail: true, leadFirstName: 'Joe', leadLastName: 'Hio' },
      ),
    ).toBe(true);
  });

  it('TRUSTS (lenient) when the lead has no name to compare', () => {
    expect(
      apolloMatchIsTrustworthy(
        { firstName: 'Awais', lastName: 'Haider' },
        { hadEmail: true },
      ),
    ).toBe(true);
  });

  it('TRUSTS when the returned name matches the lead name', () => {
    expect(
      apolloMatchIsTrustworthy(
        { firstName: 'Joe', lastName: 'Hio', email: 'joe@us.com' },
        { hadEmail: true, leadFirstName: 'Joe', leadLastName: 'Hio' },
      ),
    ).toBe(true);
  });

  it('TRUSTS a nickname / prefix name match (Rob vs Robert)', () => {
    expect(
      apolloMatchIsTrustworthy(
        { firstName: 'Robert', lastName: 'Hio' },
        { leadFirstName: 'Rob', leadLastName: 'Hio' },
      ),
    ).toBe(true);
  });

  it('REJECTS when the lead has a name but Apollo returned no name to verify against', () => {
    // Can't confirm identity and email is unverified → reject for correctness.
    expect(
      apolloMatchIsTrustworthy(
        { email: 'joe@us.com' },
        { hadEmail: true, leadFirstName: 'Joe', leadLastName: 'Hio' },
      ),
    ).toBe(false);
  });
});
