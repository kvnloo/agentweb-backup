/**
 * ONE definition of "can this channel actually reach this lead", shared by the enrol
 * routes and dripSequenceWorker.
 *
 * They had two. The route accepted any non-empty string; the worker required a personal
 * `/in/` LinkedIn profile and an address-shaped email. So a lead with `linkedin: 'Acme
 * Corp'` — free text, which db.ts stores verbatim for anything that is not a /in/ URL —
 * enrolled into a LinkedIn sequence, skipped every step, and completed having sent
 * nothing. The route's own comment promised that could not happen.
 */

/** Resend rejects anything else, and `includes('@')` let a LinkedIn handle through. */
export const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isReachableEmail(value: unknown): boolean {
  return EMAIL_SHAPE.test(String(value ?? '').trim());
}

/**
 * A PERSONAL profile. linkedInOutreachService resolves a profile by splitting on `/in/`,
 * so company pages, school pages, `/pub/` legacy URLs and bare handles all throw there —
 * and a throw is retried forever rather than skipped.
 *
 * Case-sensitive on `/in/` deliberately: the service's own parser is
 * (`getLinkedInProfile` does a plain `split('/in/')`), so accepting `/IN/` here would
 * hand it a value it cannot parse. Matching the consumer beats being lenient.
 */
export function isReachableLinkedIn(value: unknown): boolean {
  const url = String(value ?? '').trim();
  if (!url.includes('/in/')) return false;
  const tail = url.split('/in/')[1] ?? '';
  // Must have a slug, and no query string — the service forwards it verbatim to Unipile,
  // which 404s on `ada?trk=x`.
  const slug = tail.replace(/\/+$/, '');
  return slug.length > 0 && !slug.includes('?') && !slug.includes('/');
}
