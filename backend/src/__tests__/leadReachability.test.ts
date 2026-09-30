/**
 * The predicates the enrol routes and dripSequenceWorker share.
 *
 * Both had to be rewritten after a review found each one STRICTER than the consumer it
 * claimed to mirror — the same defect this file was created to end, reintroduced inside
 * the fix for it. Refusing a reachable lead is not the safe direction: it costs a real
 * send, silently, and the count looks like clean data.
 */
import {
  isReachableEmail, isReachableLinkedIn, canonicalLinkedInProfile,
  requiredChannels, enrollmentIdentity, enrollmentIdentityCandidates,
} from '../utils/leadReachability';

describe('isReachableEmail', () => {
  /*
   * These all passed the previous regex, enrol, reach sendAsSender, take a provider 422,
   * and then sendEmailStep RETHROWS — so the claim is released and the step is retried
   * every five minutes forever. That jam is what this change set exists to remove.
   */
  it.each([
    ['a double dot in the domain', 'a@x..com'],
    ['angle brackets', '<a@x.com>'],
    ['a leading dot in the local part', '.a@x.com'],
    ['a trailing dot in the local part', 'a.@x.com'],
    ['a leading hyphen in the domain', 'a@-x.com'],
    ['a single-char TLD', 'a@x.c'],
    ['no domain', 'a@'],
    ['no local part', '@x.com'],
    ['a bare LinkedIn handle', '@ada-lovelace'],
    ['empty', ''],
    ['whitespace only', '   '],
  ])('rejects %s', (_label, value) => {
    expect(isReachableEmail(value)).toBe(false);
  });

  it.each([
    ['an ordinary address', 'ada@acme.io'],
    ['a plus tag', 'ada+seq@agentweb.pro'],
    ['a subdomain', 'ada@mail.agentweb.pro'],
    ['surrounding whitespace', '  ada@agentweb.pro  '],
  ])('accepts %s', (_label, value) => {
    expect(isReachableEmail(value)).toBe(true);
  });

  /*
   * A reserved test domain is UNREACHABLE, for the same reason a malformed address is.
   *
   * This previously asserted the opposite, on the grounds that example.com is a send
   * POLICY rather than a deliverability fact. It isn't: Resend answers these with a 422,
   * sendEmailStep rethrows, and processDueEnrollments retries every five minutes
   * forever — while sendAsSender has already reserved (and deliberately never releases)
   * a daily send slot, so one such lead burns ~288 of the user's sends a day. Admitting
   * it kept alive the exact jam this predicate was added to close.
   */
  it.each([
    ['example.com', 'lead@example.com'],
    ['example.org', 'lead@example.org'],
    ['an RFC 2606 .test TLD', 'lead@acme.test'],
    ['an RFC 2606 .invalid TLD', 'lead@acme.invalid'],
  ])('refuses a reserved test domain (%s) — the provider 422s it', (_label, value) => {
    expect(isReachableEmail(value)).toBe(false);
  });
});

describe('isReachableLinkedIn / canonicalLinkedInProfile', () => {
  /*
   * `?originalSubdomain=` is what LinkedIn itself emits for non-US profiles;
   * `?miniProfileUrn=` / `?trk=` is what a browser copy produces. The previous predicate
   * rejected any `?`, so these ordinary profiles were refused enrolment outright.
   */
  it.each([
    ['a plain profile', 'https://www.linkedin.com/in/ada'],
    ['a trailing slash', 'https://www.linkedin.com/in/ada/'],
    ['no www', 'https://linkedin.com/in/ada'],
    ['http', 'http://www.linkedin.com/in/ada'],
    ["LinkedIn's own non-US query", 'https://www.linkedin.com/in/ada-lovelace?originalSubdomain=uk'],
    ['a browser-copied query', 'https://www.linkedin.com/in/ada/?miniProfileUrn=urn%3Ali%3A123'],
    ['a tracking query', 'https://www.linkedin.com/in/ada?trk=public_profile'],
    ['a fragment', 'https://www.linkedin.com/in/ada#about'],
    ['mixed case', 'https://www.LinkedIn.com/IN/Ada'],
  ])('accepts %s', (_label, value) => {
    expect(isReachableLinkedIn(value)).toBe(true);
  });

  /*
   * These make linkedInOutreachService.sendMessage throw, and a throw is retried
   * forever rather than skipped — so they must stay refused.
   */
  it.each([
    ['free text', 'Acme Corp'],
    ['a company page', 'https://www.linkedin.com/company/acme'],
    ['a school page', 'https://www.linkedin.com/school/mit'],
    ['a legacy /pub/ URL', 'https://www.linkedin.com/pub/ada/1/2/3'],
    ['a bare handle', '@ada-lovelace'],
    ['/in/ with no slug', 'https://www.linkedin.com/in/'],
    ['a nested path under /in/', 'https://www.linkedin.com/in/ada/detail/recent-activity'],
    ['empty', ''],
  ])('rejects %s', (_label, value) => {
    expect(isReachableLinkedIn(value)).toBe(false);
  });

  it('canonicalises so the SENDER gets a URL the service can parse', () => {
    // getLinkedInProfile does a plain split('/in/') with no normalisation, so the query
    // string really would reach Unipile and 404. Normalising is the fix; refusing the
    // lead was not.
    expect(canonicalLinkedInProfile('https://linkedin.com/in/ada-lovelace?originalSubdomain=uk'))
      .toBe('https://www.linkedin.com/in/ada-lovelace/');
    expect(canonicalLinkedInProfile('HTTP://WWW.LinkedIn.com/in/Ada/'))
      .toBe('https://www.linkedin.com/in/ada/');
  });

  it('returns null rather than a half-formed URL for a non-profile', () => {
    expect(canonicalLinkedInProfile('Acme Corp')).toBeNull();
  });
});

describe('requiredChannels defaults', () => {
  /*
   * Review round 2, finding 11. The empty-steps default is a live branch, not a
   * defensive one: verify-variables' 'test' sentinel calls this with no sequence at all.
   * Returning an empty set there means "reachable on no channel", which filters out
   * every lead and reports leadCount 0 — a blank coverage screen with no error.
   */
  it('defaults to email when there is no sequence to read', () => {
    expect(Array.from(requiredChannels(null))).toEqual(['email']);
    expect(Array.from(requiredChannels(undefined))).toEqual(['email']);
    expect(Array.from(requiredChannels({}))).toEqual(['email']);
    expect(Array.from(requiredChannels({ steps: [] }))).toEqual(['email']);
  });

  it('never returns an empty set — that would filter out every lead', () => {
    for (const seq of [null, undefined, {}, { steps: [] }, { steps: [{}] }]) {
      expect(requiredChannels(seq).size).toBeGreaterThan(0);
    }
  });
});

describe('enrollmentIdentityCandidates', () => {
  /*
   * Review round 2, finding 2. The identity is derived from mutable lead data, so the
   * dedup check must look under the identity the lead HAD as well as the one it has now.
   */
  const profile = 'https://www.linkedin.com/in/ada/';

  it('offers both identities for a lead that has an email and a profile', () => {
    const got = enrollmentIdentityCandidates({ email: 'ada@acme.io', linkedin: profile });
    expect(got).toContain('ada@acme.io');
    expect(got).toContain(profile);
    // The identity actually written comes first.
    expect(got[0]).toBe('ada@acme.io');
  });

  it('canonicalises the profile candidate, so both URL spellings find the same row', () => {
    expect(enrollmentIdentityCandidates({ linkedin: 'https://www.LinkedIn.com/IN/Ada?trk=x' }))
      .toEqual([profile]);
  });

  it('offers just the address when there is no profile', () => {
    expect(enrollmentIdentityCandidates({ email: 'ada@acme.io' })).toEqual(['ada@acme.io']);
  });

  it('never offers a malformed address as an identity', () => {
    expect(enrollmentIdentityCandidates({ email: 'a@x..com', linkedin: profile })).toEqual([profile]);
  });

  it('returns nothing for a lead reachable on no channel', () => {
    expect(enrollmentIdentityCandidates({ email: 'a@x..com', linkedin: 'Acme Corp' })).toEqual([]);
    expect(enrollmentIdentityCandidates({})).toEqual([]);
  });

  it('never contains a duplicate or an empty string', () => {
    for (const lead of [
      { email: 'ada@acme.io', linkedin: profile },
      { linkedin: profile },
      { email: 'ada@acme.io' },
      {},
    ]) {
      const got = enrollmentIdentityCandidates(lead);
      expect(got).toEqual(Array.from(new Set(got)));
      expect(got.every((x) => x.length > 0)).toBe(true);
    }
  });

  it('always includes the identity enrollmentIdentity would write', () => {
    for (const lead of [
      { email: 'ada@acme.io', linkedin: profile },
      { linkedin: profile },
      { email: 'ada@acme.io' },
      { email: 'a@x..com', linkedin: profile },
    ]) {
      expect(enrollmentIdentityCandidates(lead)).toContain(enrollmentIdentity(lead));
    }
  });
});
