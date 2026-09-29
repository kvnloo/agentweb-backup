import { getGroupEmailRecipientIssue } from './groupEmailRecipientValidation';
import { normalizeLinkedInUrl } from '../services/unipileConnectionsDb';

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

/**
 * Deliberately the repo's OWN validator, not a second regex.
 *
 * The first version used a loose shape that accepted `a@x..com`, `<a@x.com>`,
 * `.a@x.com`, `a@-x.com` and `a@x.c`. Each of those enrols, reaches sendAsSender, gets a
 * provider 422, and sendEmailStep RETHROWS — so processDueEnrollments releases the claim
 * and retries it every five minutes forever. That jam is the failure this whole change
 * set exists to remove, so leaving a third email definition in the tree was working
 * against itself. groupEmailRecipientValidation is the single validator the group-send
 * preview and send routes already share (ENG-1194).
 *
 * Only `malformed` counts as unreachable. `test-domain` is a group-send POLICY — a
 * sequence addressed to example.com is a deliberate choice by the user, and the address
 * is perfectly deliverable in the sense this predicate is asking about. Conflating the
 * two would silently refuse every lead in the repo's own fixtures.
 */
export function isReachableEmail(value: unknown): boolean {
  const email = String(value ?? '').trim();
  if (!email) return false;
  return getGroupEmailRecipientIssue(email) !== 'malformed';
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
  return canonicalLinkedInProfile(value) !== null;
}

/**
 * The canonical profile URL for a lead, or null when there isn't one.
 *
 * NORMALISE, don't refuse. The first version rejected any URL containing `?` — but
 * `?originalSubdomain=uk` is what LinkedIn itself emits for non-US profiles, and
 * `?miniProfileUrn=`/`?trk=` is what a browser copy produces. Those are ordinary,
 * valid profiles, and refusing them cost real sends: the lead was never enrolled, or
 * had every LinkedIn step skipped. That is the same "predicate stricter than its
 * consumer" mistake this file was created to end.
 *
 * The rejection wasn't baseless — linkedInOutreachService.getLinkedInProfile does a
 * plain `split('/in/')` with no normalisation, so a query string really would reach
 * Unipile and 404. But the repo already has the canonicaliser for exactly this:
 * normalizeLinkedInUrl strips query and fragment, lower-cases, and fixes the scheme.
 * So the answer is to hand the consumer something it can parse, not to drop the lead.
 *
 * Callers that SEND should use this value rather than the raw field, so the route's
 * verdict and the worker's request agree on the same URL.
 */
export function canonicalLinkedInProfile(value: unknown): string | null {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  const url = normalizeLinkedInUrl(raw);
  if (!url.includes('/in/')) return null;
  const slug = (url.split('/in/')[1] ?? '').replace(/\/+$/, '');
  // A slug, and nothing after it: company/school pages and nested paths are not
  // personal profiles and make sendMessage throw, which is retried forever.
  if (!slug || slug.includes('/')) return null;
  return url;
}
