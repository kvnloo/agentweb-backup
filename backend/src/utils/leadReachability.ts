import { getGroupEmailRecipientIssue } from './groupEmailRecipientValidation';
import { normalizeLinkedInUrl } from './linkedInUrl';

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

/**
 * Which channels a sequence will actually try to use. A step with no `channel` is email
 * (backwards compatibility — see SequenceStep).
 */
export function requiredChannels(sequence: any): Set<string> {
  const steps = sequence?.steps ?? [];
  // No sequence in hand (the listId-only verify call) means no channel evidence. Default
  // to email rather than to the empty set, which would mean "reachable on no channels" —
  // i.e. filter nothing — and silently widen the population this screen reports on.
  if (steps.length === 0) return new Set<string>(['email']);
  // Mirror the WORKER'S dispatch exactly, rather than mapping the stored value.
  //
  // dripSequenceWorker does `channel === 'linkedin' ? sendLinkedInStep : sendEmailStep`,
  // so everything that is not literally 'linkedin' is an EMAIL step as far as delivery
  // is concerned. Mapping the raw value here instead produced a set the reachability
  // test could never satisfy: `channel: 'sms'`, a typo like 'linkedln', or an empty
  // string from an unselected dropdown all yielded {'sms'} / {''} , which matches
  // neither branch, so the route enrolled NOBODY while the worker would have emailed
  // them. Note `?? 'email'` does not catch '' — only null/undefined — so an empty
  // string was the easiest way to hit it.
  //
  // Lower-casing alone fixed only the mis-cased case ('Email'); this fixes the general
  // one. Erring toward email matches what actually gets sent, so the route can no
  // longer be stricter than the thing it is gating.
  return new Set<string>(steps.map((st: any) => {
    const raw = String(st?.channel ?? '').trim().toLowerCase();
    return raw === 'linkedin' ? 'linkedin' : 'email';
  }));
}
/**
 * Can this sequence reach this lead on AT LEAST ONE of the channels it uses?
 *
 * The first version of this guard tested `lead.email` only, which was wrong: sequences are
 * not email-only. `SequenceChannel = 'email' | 'linkedin'`, and dripSequenceWorker's
 * sendLinkedInStep reaches the lead through `lead.linkedin` after loading it by leadId —
 * it never touches the address. So a LinkedIn-only lead in a LinkedIn sequence WAS being
 * messaged, and an email-only test excluded it from enrolment entirely.
 *
 * AT LEAST ONE channel, not every one. Requiring every channel was my first answer and it
 * cost a real send: an email-only lead in a mixed email+LinkedIn sequence stopped being
 * enrolled at all, where before it received the email. The worker now SKIPS a step the
 * lead cannot receive instead of throwing (dripSequenceWorker.processEnrollment), so enrolling
 * such a lead no longer jams it — it gets the steps it can receive and completes.
 *
 * A lead that can receive NO step is still refused: enrolling it would create a row that
 * skips every step and completes having sent nothing.
 */
export function leadIsReachable(lead: any, channels: Set<string>): boolean {
  // Same predicates the WORKER uses. These used to be "non-empty string" here and
  // stricter there, so a lead with free text in `linkedin` enrolled and then skipped
  // every step — contradicting the promise two lines above.
  if (channels.has('email') && isReachableEmail(lead?.email)) return true;
  if (channels.has('linkedin') && isReachableLinkedIn(lead?.linkedin)) return true;
  return false;
}
/**
 * `skippedNoEmail` is the field existing callers know, and it is the right word only when
 * the sequence is email-only. A LinkedIn step makes "no email" a lie — a live run on env2
 * reported `skippedNoEmail: 1` for a lead skipped because it had no LinkedIn PROFILE.
 */
export function skipKeyForChannels(channels: Set<string>): string {
  return channels.has('linkedin') ? 'skippedUnreachable' : 'skippedNoEmail';
}
/**
 * The enrollment's dedup identity. `leadEmail` is the partition key of
 * `leadEmail-index`, which getExistingEnrollment queries — an empty one makes the row
 * invisible to the dedup check, so it is re-created on every run and the lead is
 * messaged again each time. For a lead with no address the LinkedIn URL is the stable
 * identity; dripSequenceWorker already treats the field that way at its reply-exit check.
 */
export function enrollmentIdentity(lead: any): string {
  // Use the PREDICATES, not truthiness, and the CANONICAL LinkedIn URL.
  //
  // Truthiness keyed an admitted lead on junk: `{email: 'not-an-address', linkedin:
  // <valid profile>}` in a LinkedIn sequence was admitted on the LinkedIn channel and
  // then keyed on the unusable address.
  //
  // And the raw URL made one person two identities — `.../in/ada/` and
  // `.../in/ada` differ by a byte. leadEmail is the PARTITION KEY of leadEmail-index,
  // which getExistingEnrollment queries for an exact match, so those enrol twice and
  // the whole sequence is delivered twice.
  const email = String(lead?.email ?? '').trim();
  if (isReachableEmail(email)) return email;
  return canonicalLinkedInProfile(lead?.linkedin) ?? '';
}
