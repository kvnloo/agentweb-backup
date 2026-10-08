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

  /*
   * Review round 3, finding 14. Candidates are LOOKUP-ONLY — never written, never
   * passed to enrollmentIdentity's own reachability rules — so an address that fails
   * isReachableEmail still belongs here. Pre-PR enrollments were written under the raw
   * `l.email` with no reachability gate at all, and after this PR shipped,
   * isReachableEmail started rejecting reserved test domains it used to accept. Gating
   * this list on the same predicate made it impossible to find those old rows: the
   * dedup check would look under the profile URL, miss, and re-deliver the sequence.
   */
  it('still offers a malformed/reserved-domain address as a LOOKUP candidate', () => {
    expect(enrollmentIdentityCandidates({ email: 'a@x..com', linkedin: profile }))
      .toEqual(expect.arrayContaining([profile, 'a@x..com']));
  });

  it('offers the raw address even for a lead reachable on no channel today', () => {
    expect(enrollmentIdentityCandidates({ email: 'a@x..com', linkedin: 'Acme Corp' }))
      .toEqual(['a@x..com']);
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

describe('canonicalLinkedInProfile collapses every host spelling of one profile', () => {
  /*
   * Review round 3, finding 13. normalizeLinkedInUrl strips scheme/query/fragment but
   * not the host, so a regional subdomain (uk./de./m.), a protocol-relative URL, a bare
   * host with no scheme, and the /mwlite/ mobile path all survived as DISTINCT
   * identities for one person — each an extra LinkedIn DM. The consumer
   * (linkedInOutreachService.getLinkedInProfile) only reads the slug after `/in/` and
   * discards the host entirely, so the host was never part of what gets sent — only of
   * what got hashed into the dedup key. New in this PR (canonicalLinkedInProfile has
   * exactly three callers, all in this diff), so collapsing the host carries no
   * migration risk: nothing in production is keyed on the old form.
   */
  const CANONICAL = 'https://www.linkedin.com/in/ada/';

  it.each([
    ['https', 'https://www.linkedin.com/in/ada'],
    ['http, no www', 'http://linkedin.com/in/ada'],
    ['UK regional host', 'https://uk.linkedin.com/in/ada'],
    ['DE regional host', 'https://de.linkedin.com/in/ada'],
    ['mobile host', 'https://m.linkedin.com/in/ada'],
    ['mobile-lite path', 'https://www.linkedin.com/mwlite/in/ada'],
    ['protocol-relative', '//www.linkedin.com/in/ada'],
    ['bare, no protocol', 'linkedin.com/in/ada'],
    ['bare with www', 'www.linkedin.com/in/ada'],
  ])('%s collapses to the one canonical identity', (_label, input) => {
    expect(canonicalLinkedInProfile(input)).toBe(CANONICAL);
  });

  it('the send-path identifier is unaffected by the host rebuild', () => {
    // The consumer's own parse: split('/in/'), take the tail.
    const canon = canonicalLinkedInProfile('https://uk.linkedin.com/in/ada?originalSubdomain=uk')!;
    expect(canon.split('/in/')[1].replace(/\/$/, '')).toBe('ada');
  });
});

describe('canonicalLinkedInProfile refuses a slug the consumer cannot resolve', () => {
  /*
   * Review round 3, finding 16. The gate validated shape (no nested path) but not slug
   * plausibility. A trailing comma, space or parenthesis from a CSV paste survived an
   * otherwise well-formed URL, reached Unipile as part of the identifier, 404'd, and
   * retried every five minutes forever — the last remaining route to the exact jam this
   * function exists to close.
   */
  it.each([
    ['a trailing comma', 'https://www.linkedin.com/in/ada,'],
    ['a stray parenthesis', 'https://www.linkedin.com/in/ada)'],
    ['embedded whitespace', 'https://www.linkedin.com/in/ada smith'],
  ])('refuses %s rather than sending an unresolvable identifier', (_label, input) => {
    expect(canonicalLinkedInProfile(input)).toBeNull();
  });

  it('still accepts a hyphenated slug, an underscore, and a percent-encoded name', () => {
    expect(canonicalLinkedInProfile('https://www.linkedin.com/in/ada-lovelace')).toBe(
      'https://www.linkedin.com/in/ada-lovelace/',
    );
    expect(canonicalLinkedInProfile('https://www.linkedin.com/in/ada_lovelace')).toBe(
      'https://www.linkedin.com/in/ada_lovelace/',
    );
    expect(canonicalLinkedInProfile('https://www.linkedin.com/in/jos%c3%a9-p%c3%a9rez')).toBe(
      'https://www.linkedin.com/in/jos%c3%a9-p%c3%a9rez/',
    );
  });
});
