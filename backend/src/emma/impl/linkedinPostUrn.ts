/**
 * ENG-3176: normalize the post identifier the model hands `linkedin_manage_post`
 * before it is put into a `/rest/socialActions/{urn}/...` path.
 *
 * The model often passes a post URL, a URL-encoded URN, or a bare numeric id.
 * LinkedIn answers those with "Syntax exception in path variables", which the
 * model cannot act on. Here we recover the URN when it is unambiguous and
 * otherwise return a validation message that says exactly what to send.
 */

const URN_RE = /urn:li:(share|ugcPost|activity):(\d+)/;
const BARE_URN_RE = /^urn:li:(share|ugcPost|activity):(\d+)$/;
const LINKEDIN_URL_RE = /^https?:\/\/([a-z0-9-]+\.)*linkedin\.com\/(feed\/update|posts)\//i;
// Public post URL slug, e.g. linkedin.com/posts/acme_title-activity-7123456789-AbCd
const ACTIVITY_SLUG_RE = /[-_]activity[-_](\d{6,})(?:[-_/?#]|$)/;

export const LINKEDIN_POST_URN_HINT =
  'post_urn must be a LinkedIn post URN such as urn:li:share:123, urn:li:ugcPost:123 or urn:li:activity:123, ' +
  'or a linkedin.com post URL that contains one.';

export type PostUrnResult = { ok: true; urn: string } | { ok: false; message: string };

export function normalizeLinkedInPostUrn(raw: unknown): PostUrnResult {
  if (typeof raw !== 'string' || !raw.trim()) {
    return { ok: false, message: `Invalid post_urn. ${LINKEDIN_POST_URN_HINT}` };
  }
  let value = raw.trim();
  // Undo one or two layers of URL-encoding (the service encodes once itself).
  for (let i = 0; i < 2 && /%[0-9A-Fa-f]{2}/.test(value); i++) {
    try {
      value = decodeURIComponent(value);
    } catch {
      break;
    }
  }

  const bare = value.match(BARE_URN_RE);
  if (bare) return { ok: true, urn: `urn:li:${bare[1]}:${bare[2]}` };

  // URLs are only trusted on a linkedin.com post path (feed/update or posts).
  if (LINKEDIN_URL_RE.test(value)) {
    const path = value.replace(/[?#].*$/, '');
    const urn = path.match(new RegExp(URN_RE.source + '(?:/|$)'));
    if (urn) return { ok: true, urn: `urn:li:${urn[1]}:${urn[2]}` };
    const slug = path.match(ACTIVITY_SLUG_RE);
    if (slug) return { ok: true, urn: `urn:li:activity:${slug[1]}` };
  }

  if (/^\d+$/.test(value)) {
    return {
      ok: false,
      message:
        `Invalid post_urn "${raw}": a bare number is ambiguous (share, ugcPost or activity). ${LINKEDIN_POST_URN_HINT}`,
    };
  }
  return { ok: false, message: `Invalid post_urn "${raw}". ${LINKEDIN_POST_URN_HINT}` };
}
