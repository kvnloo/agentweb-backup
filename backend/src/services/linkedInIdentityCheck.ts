/**
 * ENG-1026 — LinkedIn identity cross-check before personalized sends.
 *
 * Stored/enriched LinkedIn URLs on CRM leads can point to the wrong person
 * (name-only matching at enrichment time). Before any LinkedIn send with CRM
 * lead context, cross-check the live profile's name and employer/headline
 * against the lead record and REFUSE on a positive mismatch.
 *
 * Policy:
 *  - Fail OPEN on infrastructure problems (profile fetch fails, no signal on
 *    either side) — behavior is unchanged from today, no stamp is written.
 *  - Fail CLOSED only on positive mismatch evidence (wrong company or clearly
 *    different person's name).
 *  - A successful cross-check stamps the lead (linkedinIdentityVerifiedAt +
 *    the verified canonical URL) so subsequent sends skip the re-fetch.
 *
 * This is the ONE shared guard used by all four send surfaces: the two CRM
 * REST routes (send-linkedin-message / send-linkedin-invite) and the two
 * agent-tool paths (linkedinOutreach send-message / send-invite).
 */

import { unipileNameMatches } from '../utils/nameMatch';
import { normalizeLinkedInUrl } from './enrichmentGroups';

export type IdentityVerdict = 'match' | 'mismatch' | 'unverifiable';

export interface IdentityCheckResult {
  verdict: IdentityVerdict;
  reason: string;
  profileName?: string;
  profileCompany?: string;
  profileHeadline?: string;
}

export interface IdentityLeadFields {
  firstName?: string;
  lastName?: string;
  company?: string;
  linkedin?: string;
  linkedinIdentityVerifiedAt?: string;
  linkedinIdentityVerifiedUrl?: string;
  [key: string]: any;
}

export interface IdentityRefusal {
  code: 'linkedin_identity_mismatch';
  message: string;
  details: {
    leadCompany?: string;
    leadName?: string;
    profileCompany?: string;
    profileHeadline?: string;
    profileName?: string;
    reason: string;
  };
}

export type IdentityGuardResult =
  | { allowed: true; verified: boolean; verdict: IdentityVerdict | 'skipped' }
  | { allowed: false; refusal: IdentityRefusal };

/**
 * Normalize a company string for tolerant comparison: strip accents, case,
 * punctuation, and trailing legal suffixes (Inc, LLC, Ltd, Co, Corp,
 * Corporation, Limited, Company, GmbH). Word boundaries (single spaces) are
 * DELIBERATELY preserved (not stripped) so callers can do word/phrase-bounded
 * containment matching -- see companyOrPhraseContains below. Stripping all
 * whitespace here is what let a raw substring match slip through unrelated
 * words (ENG-1026 Greptile P1: lead company "AI" false-matched profile
 * company "Krai Group" because "ai" is a bare substring of "krai").
 */
function normalizeCompany(value: string | undefined | null): string {
  const base = (value ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    // drop legal suffixes as trailing words (possibly repeated: "Co., Ltd.")
    .replace(/[.,]/g, ' ')
    .replace(/\s+(inc|llc|ltd|co|corp|corporation|limited|company|gmbh)(?=\s|$)/g, ' ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return base;
}

/**
 * Word/phrase-bounded containment: does `haystack` contain `needle` as a
 * whole phrase, bounded by start/end-of-string or whitespace on both sides
 * -- never as an arbitrary embedded substring. Both inputs are expected to
 * already be normalizeCompany() output (lowercase, single-spaced, alnum
 * only), so no character in `needle` requires regex escaping in practice;
 * escaped defensively anyway in case normalization ever changes.
 */
function companyOrPhraseContains(haystack: string, needle: string): boolean {
  if (!needle || !haystack) return false;
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|\\s)${escaped}(\\s|$)`).test(haystack);
}

/** Extract the profile's display name from the Unipile profile shape. */
function extractProfileName(profile: any): string {
  const first = typeof profile?.first_name === 'string' ? profile.first_name.trim() : '';
  const last = typeof profile?.last_name === 'string' ? profile.last_name.trim() : '';
  if (first || last) return [first, last].filter(Boolean).join(' ');
  return typeof profile?.name === 'string' ? profile.name.trim() : '';
}

/** Collect company-name candidates from the real Unipile profile fields. */
function extractProfileCompanies(profile: any): string[] {
  const companies: string[] = [];
  const work = Array.isArray(profile?.work_experience) ? profile.work_experience : [];
  const current = work.filter((w: any) => w && w.current === true);
  const considered = current.length > 0 ? current : work.slice(0, 1);
  for (const w of considered) {
    if (typeof w?.company === 'string' && w.company.trim()) companies.push(w.company.trim());
  }
  // Some Unipile shapes carry a flat position/company
  if (typeof profile?.company === 'string' && profile.company.trim()) companies.push(profile.company.trim());
  return companies;
}

/**
 * Pure cross-check of a fetched LinkedIn profile against a CRM lead.
 * Only positive contradiction evidence yields 'mismatch'.
 */
export function crossCheckProfileIdentity(
  profile: any,
  lead: IdentityLeadFields,
): IdentityCheckResult {
  const profileName = extractProfileName(profile);
  const profileHeadline = typeof profile?.headline === 'string' ? profile.headline : undefined;
  const profileCompanies = extractProfileCompanies(profile);
  const profileCompany = profileCompanies[0];

  const base = { profileName: profileName || undefined, profileCompany, profileHeadline };

  // Name check (contract 4): refuse only when the profile actually carries
  // name fields that contradict the lead's name — reuses unipileNameMatches.
  const leadFirst = lead.firstName?.trim() || undefined;
  const leadLast = lead.lastName?.trim() || undefined;
  const profileHasName = !!profileName;
  if ((leadFirst || leadLast) && profileHasName) {
    if (!unipileNameMatches(profile, leadFirst, leadLast)) {
      return {
        ...base,
        verdict: 'mismatch',
        reason: `Profile name "${profileName}" does not match lead name "${[leadFirst, leadLast].filter(Boolean).join(' ')}"`,
      };
    }
  }

  // Company check (contracts 1 and 3).
  const leadCompany = lead.company?.trim();
  if (!leadCompany) {
    return { ...base, verdict: 'unverifiable', reason: 'Lead has no company to check against' };
  }
  const normLead = normalizeCompany(leadCompany);
  if (!normLead) {
    return { ...base, verdict: 'unverifiable', reason: 'Lead company normalizes to empty' };
  }

  const normCandidates = profileCompanies.map(normalizeCompany).filter(Boolean);
  const normHeadline = normalizeCompany(profileHeadline);

  if (normCandidates.length === 0 && !normHeadline) {
    return { ...base, verdict: 'unverifiable', reason: 'Profile carries no company or headline signal' };
  }

  const companyMatch = normCandidates.some(
    (c) =>
      c === normLead ||
      companyOrPhraseContains(c, normLead) ||
      companyOrPhraseContains(normLead, c),
  );
  // Headline is free text ("VP Marketing @ Vivian Health") — phrase-bounded
  // containment only (never a raw substring — see companyOrPhraseContains).
  const headlineMatch = !!normHeadline && companyOrPhraseContains(normHeadline, normLead);

  if (companyMatch || headlineMatch) {
    return { ...base, verdict: 'match', reason: 'Profile employer/headline matches lead company' };
  }

  return {
    ...base,
    verdict: 'mismatch',
    reason: `Lead company "${leadCompany}" not found in profile employer${profileCompany ? ` "${profileCompany}"` : ''}${profileHeadline ? ` or headline "${profileHeadline}"` : ''}`,
  };
}

export interface VerifyIdentityOptions {
  /** The CRM lead record; null/undefined = no lead context → no check. */
  lead: IdentityLeadFields | null | undefined;
  listId: string;
  leadId: string;
  /** The LinkedIn profile URL the send is targeting. */
  profileUrl: string;
  accountId: string;
}

/**
 * Shared pre-send identity guard: fetch the live profile, run the pure
 * cross-check, and either stamp the lead as verified or refuse the send.
 */
export async function verifyLinkedInIdentityForSend(
  opts: VerifyIdentityOptions,
): Promise<IdentityGuardResult> {
  const { lead, listId, leadId, profileUrl, accountId } = opts;

  // Contract 3: no lead context → behavior unchanged.
  if (!lead) return { allowed: true, verified: false, verdict: 'skipped' };

  // ENG-1026 Greptile P1 ("cached verification isn't bound to the actual send
  // target"): the cache/stamp check MUST key on the URL this send is actually
  // targeting (profileUrl), never on the lead's own stored URL (lead.linkedin).
  // profileUrl can be model-supplied and differ from the lead's stored URL --
  // keying on lead.linkedin let a stamp earned by verifying the lead's OWN
  // profile silently authorize a send to a DIFFERENT, unverified profile.
  // profileUrl is a required field on VerifyIdentityOptions, so there is no
  // need to fall back to lead.linkedin at all.
  const canonicalTargetUrl = normalizeLinkedInUrl(profileUrl);

  // Contract 5: previously verified for this exact target URL → skip the re-fetch.
  if (
    lead.linkedinIdentityVerifiedAt &&
    lead.linkedinIdentityVerifiedUrl &&
    canonicalTargetUrl &&
    normalizeLinkedInUrl(lead.linkedinIdentityVerifiedUrl) === canonicalTargetUrl
  ) {
    return { allowed: true, verified: true, verdict: 'match' };
  }

  // Nothing to check against → unchanged behavior, no stamp.
  const hasSignal = !!(lead.company?.trim() || lead.firstName?.trim() || lead.lastName?.trim());
  if (!hasSignal) return { allowed: true, verified: false, verdict: 'unverifiable' };

  let profile: any = null;
  try {
    const { linkedInOutreachService } = await import('./linkedInOutreachService');
    profile = await linkedInOutreachService.getLinkedInProfile(profileUrl, accountId);
  } catch (err) {
    // Fail OPEN on infra errors — only positive mismatch evidence refuses.
    console.warn(`[linkedInIdentityCheck] profile fetch failed for ${profileUrl} — proceeding unverified:`, err);
    return { allowed: true, verified: false, verdict: 'unverifiable' };
  }
  if (!profile || typeof profile !== 'object') {
    return { allowed: true, verified: false, verdict: 'unverifiable' };
  }

  const result = crossCheckProfileIdentity(profile, lead);

  if (result.verdict === 'mismatch') {
    const leadName = [lead.firstName, lead.lastName].filter(Boolean).join(' ') || undefined;
    console.warn(`[linkedInIdentityCheck] REFUSED send to ${profileUrl}: ${result.reason}`);
    return {
      allowed: false,
      refusal: {
        code: 'linkedin_identity_mismatch',
        message:
          `Refused to send: the LinkedIn profile at ${profileUrl} does not appear to belong to this lead` +
          `${leadName ? ` (${leadName}` : ''}${lead.company ? `${leadName ? ', ' : ' ('}${lead.company}` : ''}${leadName || lead.company ? ')' : ''}. ` +
          `${result.reason}. Verify or correct the lead's LinkedIn URL before contacting them.`,
        details: {
          leadCompany: lead.company,
          leadName,
          profileCompany: result.profileCompany,
          profileHeadline: result.profileHeadline,
          profileName: result.profileName,
          reason: result.reason,
        },
      },
    };
  }

  if (result.verdict === 'match') {
    // Contract 2: stamp the verified identity. Best-effort — a stamp failure
    // must never fail a send whose identity check passed.
    try {
      const { crmDb } = await import('./db');
      await crmDb.updateLead(listId, leadId, {
        linkedinIdentityVerifiedAt: new Date().toISOString(),
        linkedinIdentityVerifiedUrl: canonicalTargetUrl || profileUrl,
      });
    } catch (err) {
      console.warn(`[linkedInIdentityCheck] failed to stamp verified identity on lead ${leadId}:`, err);
    }
    return { allowed: true, verified: true, verdict: 'match' };
  }

  return { allowed: true, verified: false, verdict: 'unverifiable' };
}
