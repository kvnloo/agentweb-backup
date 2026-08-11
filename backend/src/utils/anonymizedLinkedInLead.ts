/**
 * ENG-1002: recognising LinkedIn's anonymized people-search results.
 *
 * LinkedIn anonymizes search hits that fall outside the connected account's
 * network — the result comes back with a placeholder name and no resolvable
 * public identifier. Mapped naively into the CRM that becomes a lead with
 * firstName="LinkedIn", lastName="Member", no email and no profile URL:
 * useless for outreach, and — having neither an email nor a LinkedIn URL —
 * invisible to `batchCreateLeads`' dedup, so a recurring search re-creates it
 * on every run.
 *
 * "LinkedIn Member" is only the en-US spelling. LinkedIn also renders the
 * placeholder as "Anonymous LinkedIn Member" and "LinkedIn User", and
 * localizes it to the viewer's interface language ("Miembro de LinkedIn",
 * "LinkedIn Mitglied", "领英会员", ...). Matching just the one English string
 * would leave the bug open for every non-English connected account.
 *
 * This module is the single home for that rule. It is shared by every path
 * that turns LinkedIn search results into CRM leads — Emma's
 * `import_leads_from_search` and the outreach-onboarding prospect preview /
 * save — so the two cannot drift apart.
 */

/** The placeholder wordings LinkedIn uses in English. */
const LINKEDIN_PLACEHOLDER_NAME = /^(anonymous\s+)?linkedin\s+(member|user)$/i;

/** LinkedIn's own brand token, latin and CJK, as it appears inside every
 *  localized spelling of the placeholder. */
const LINKEDIN_BRAND_TOKEN = /linkedin|领英/i;

/**
 * True when a mapped lead is an anonymized placeholder rather than a person,
 * or carries neither a name nor a profile URL (same reasoning: nothing to
 * persist and nothing to dedup on).
 *
 * A hit with a real name is kept even when it has no URL. The brand-token
 * rule is deliberately gated on there being NO profile URL: real people do put
 * badges like "Jane Doe | LinkedIn Top Voice" in their name field, and those
 * hits are linkable and dedup-able, so they must survive.
 */
export function isAnonymizedSearchLead(lead: {
  firstName?: string;
  lastName?: string;
  linkedin?: string;
}): boolean {
  const fullName = `${lead.firstName ?? ''} ${lead.lastName ?? ''}`.trim().replace(/\s+/g, ' ');
  if (LINKEDIN_PLACEHOLDER_NAME.test(fullName)) return true;
  if (lead.linkedin) return false;
  return !fullName || LINKEDIN_BRAND_TOKEN.test(fullName);
}

/**
 * True only when the lead is named with one of LinkedIn's placeholder
 * spellings. This is the narrow half of `isAnonymizedSearchLead`, for use at
 * the CRM write boundary (`batchCreateLeads`) where every path lands — CSV
 * import, bulk import, outreach save, `add_leads_to_list`.
 *
 * The full search-boundary rule must NOT be used there. It also rejects rows
 * with no name and no profile URL, which is right for a LinkedIn search hit
 * (anonymized) but wrong for a CRM write: an email-only lead — a newsletter
 * signup, a form fill, a CSV of bare addresses — has no name by design and is
 * perfectly legitimate. Applying the wide rule at the write boundary would
 * silently destroy it.
 *
 * Nobody is legitimately named "LinkedIn Member", so this half is safe
 * everywhere. Callers report the count rather than dropping silently — a
 * response that does not match what was written is the original ENG-1002 bug.
 */
export function isLinkedInPlaceholderName(lead: {
  firstName?: string;
  lastName?: string;
}): boolean {
  const fullName = `${lead.firstName ?? ''} ${lead.lastName ?? ''}`.trim().replace(/\s+/g, ' ');
  if (!fullName) return false;
  if (LINKEDIN_PLACEHOLDER_NAME.test(fullName)) return true;
  // Localized spellings ("Miembro de LinkedIn", "领英会员") are not enumerable,
  // so fall back to the brand token. Safe here because a real person's badge
  // name ("Jane Doe | LinkedIn Top Voice") carries other name words too.
  return LINKEDIN_BRAND_TOKEN.test(fullName) && wordsOutsideBrandToken(fullName) === 0;
}

/** Count the name's words that are not LinkedIn branding or a connective. */
function wordsOutsideBrandToken(fullName: string): number {
  return fullName
    .split(/[\s|·,]+/)
    .filter((w) => w && !LINKEDIN_BRAND_TOKEN.test(w) && !/^(de|del|di|van|von|der|the|a)$/i.test(w))
    .filter((w) => !/^(member|user|anonymous|miembro|mitglied|utente|membre|会员)$/i.test(w))
    .length;
}

/**
 * Same rule, applied to a raw Unipile people-search item. Mirrors how callers
 * derive a name and profile URL from the item, so a caller that filters before
 * mapping gets the identical verdict to one that filters after.
 */
export function isAnonymizedSearchItem(item: any): boolean {
  const safe = (item && typeof item === 'object') ? item : {};
  const fullName = typeof safe.name === 'string' && safe.name.trim()
    ? safe.name
    : `${safe.first_name ?? ''} ${safe.last_name ?? ''}`;
  const linkedin = safe.public_identifier
    ? `https://www.linkedin.com/in/${safe.public_identifier}`
    : (typeof safe.profile_url === 'string' ? safe.profile_url.split('?')[0] : undefined);
  const parts = String(fullName).trim().split(/\s+/);
  return isAnonymizedSearchLead({
    firstName: parts[0] || undefined,
    lastName: parts.slice(1).join(' ') || undefined,
    linkedin: linkedin || undefined,
  });
}
