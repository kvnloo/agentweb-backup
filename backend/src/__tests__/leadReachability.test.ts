/**
 * The predicates the enrol routes and dripSequenceWorker share.
 *
 * Both had to be rewritten after a review found each one STRICTER than the consumer it
 * claimed to mirror — the same defect this file was created to end, reintroduced inside
 * the fix for it. Refusing a reachable lead is not the safe direction: it costs a real
 * send, silently, and the count looks like clean data.
 */
import { isReachableEmail, isReachableLinkedIn, canonicalLinkedInProfile } from '../utils/leadReachability';

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
    ['an ordinary address', 'ada@example.org'],
    ['a plus tag', 'ada+seq@agentweb.pro'],
    ['a subdomain', 'ada@mail.agentweb.pro'],
    ['surrounding whitespace', '  ada@agentweb.pro  '],
  ])('accepts %s', (_label, value) => {
    expect(isReachableEmail(value)).toBe(true);
  });

  /*
   * test-domain is a GROUP-SEND POLICY, not a statement about deliverability. A sequence
   * addressed to example.com is a deliberate choice, and treating it as unreachable would
   * silently refuse every lead in this repo's own fixtures.
   */
  it('accepts a reserved test domain — that is a send policy, not unreachability', () => {
    expect(isReachableEmail('lead@example.com')).toBe(true);
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
