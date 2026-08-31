/**
 * Group-email recipient eligibility check (ENG-1194).
 *
 * The group-email preflight only checked `!!lead.email` for eligibility, so
 * syntactically malformed addresses (missing/invalid domain, repeated-dot
 * local part) and provider-disallowed test domains (example.com) counted as
 * eligible in the preview. The send loop then attempted them individually and
 * the provider (Resend) rejected each with a 422 — preview's "eligible" total
 * didn't match what actually sent. This is the single validator the preview
 * and send routes both call so their counts always agree.
 */

const PROVIDER_DISALLOWED_TEST_DOMAINS = new Set([
  'example.com', 'example.net', 'example.org', 'example.edu',
]);

// RFC 5322-ish local part: dot-separated atoms, no leading/trailing/repeated dots.
const LOCAL_PART_RE = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/;
// Domain: at least one label + a dot + an alphabetic TLD of 2+ chars.
const DOMAIN_RE = /^([A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?\.)+[A-Za-z]{2,}$/;

export type GroupEmailRecipientIssue = 'malformed' | 'test-domain';

/**
 * Returns the reason a recipient would be rejected by the send provider, or
 * null if the address is syntactically valid and not a disallowed test domain.
 */
export function getGroupEmailRecipientIssue(email: string | undefined | null): GroupEmailRecipientIssue | null {
  const trimmed = (email ?? '').trim();
  const atIdx = trimmed.lastIndexOf('@');
  if (atIdx <= 0 || atIdx === trimmed.length - 1) return 'malformed';

  const local = trimmed.slice(0, atIdx);
  const domain = trimmed.slice(atIdx + 1).toLowerCase();

  if (!LOCAL_PART_RE.test(local) || !DOMAIN_RE.test(domain)) return 'malformed';
  if (PROVIDER_DISALLOWED_TEST_DOMAINS.has(domain)) return 'test-domain';
  return null;
}

export function isEligibleGroupEmailRecipient(email: string | undefined | null): boolean {
  return getGroupEmailRecipientIssue(email) === null;
}
