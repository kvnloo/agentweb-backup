// Identity resolution — Req B step 0 of the v3.1 enrichment waterfall.
// Resolves missing emailDomain / firstName / lastName / company / website
// BEFORE the per-group waterfall runs. Stateless logic, injected dependencies.
//
// Design ref: tasks/crm-enrichment-v3.1-design.md §5.1.

import type { LeadRecord } from './crmEnrichmentService';
import type { EnrichedFieldMeta } from '../utils/enrichedFieldValue';
import { extractDomainFromEmail } from '../utils/leadSchema';

export type IdentityProvider = 'apollo' | 'enrich.so';

export interface ApolloPersonResult {
  firstName?: string;
  lastName?: string;
  title?: string;
  linkedin?: string;
  email?: string;            // Apollo returns email when match is by linkedinUrl
  city?: string;
  state?: string;
  country?: string;
}

export interface ApolloOrgResult {
  company?: string;
  website?: string;
}

export interface EnrichSoReverseResult {
  firstName?: string;
  lastName?: string;
  company?: string;
}

/**
 * CRM-history Tier 0 sibling. The resolver only cares about the identity
 * fields it might copy — the real impl returns a richer record but only
 * these get read here.
 */
export interface SiblingLeadResult {
  leadId: string;
  listId?: string;
  userId?: string;
  firstName?: string;
  lastName?: string;
  email?: string;
  linkedin?: string;
  company?: string;
  website?: string;
  title?: string;
}

export interface IdentityResolverDeps {
  apolloPeopleMatch(input: {
    email?: string;
    linkedinUrl?: string;
  }): Promise<ApolloPersonResult | null>;
  apolloOrgMatch(input: { emailDomain: string }): Promise<ApolloOrgResult | null>;
  enrichSoReverseLookup(input: { email: string }): Promise<EnrichSoReverseResult | null>;
  /**
   * Cross-tenant lookup. Returns the freshest non-self lead matching by email,
   * linkedin, or exact name+company across ALL users. Returns null if no
   * match. Tier 0 of the v3.1 identity resolution waterfall.
   */
  findSiblingLead(input: {
    excludeLeadId: string;
    email?: string;
    linkedinUrl?: string;
    firstName?: string;
    lastName?: string;
    company?: string;
  }): Promise<SiblingLeadResult | null>;
  writeLeadFields(input: {
    listId: string;
    leadId: string;
    fields: Record<string, string>;
    meta: Record<string, EnrichedFieldMeta>;
  }): Promise<void>;
}

export interface ResolveIdentityInput {
  listId: string;
  lead: LeadRecord;
  needsPersonFields: boolean;
  needsCompanyFields: boolean;
  mode: 'preview' | 'enrich';
  /** Optional set of "<leadId>:<fieldName>" the user wants force-refreshed.
   *  CRM-history Tier 0 skips any field present in this set so Apollo runs
   *  for it instead. Same shape used by the waterfall (`enrichmentGroupWaterfall.ts:215`). */
  refreshFields?: Set<string>;
}

export type ResolveIdentityResult =
  | { ok: true; resolved: Partial<LeadRecord> & { emailDomain?: string } }
  | { ok: false; reason: 'no_email' | 'identity_unresolvable' };

function makeApiMeta(provider: IdentityProvider): EnrichedFieldMeta {
  return {
    source: 'api',
    provider,
    enrichedAt: new Date().toISOString(),
  };
}

export async function resolveIdentity(
  input: ResolveIdentityInput,
  deps: IdentityResolverDeps,
): Promise<ResolveIdentityResult> {
  const { lead, needsPersonFields, needsCompanyFields, mode, listId } = input;

  // 1. Need at least one of: email, LinkedIn URL, or (firstName + lastName).
  // Apollo matches on email/linkedin; the waterfall's web tier (Unipile
  // tier 3.5) can resolve LinkedIn from name+company. If none of these
  // are present we can't resolve the lead's identity.
  let email = typeof lead.email === 'string' ? lead.email.trim() : '';
  const linkedinUrl = typeof lead.linkedin === 'string' ? lead.linkedin.trim() : '';
  const hasName =
    typeof lead.firstName === 'string' && lead.firstName.trim() !== '' &&
    typeof lead.lastName === 'string' && lead.lastName.trim() !== '';
  if (!email && !linkedinUrl && !hasName) return { ok: false, reason: 'no_email' };

  const resolved: Partial<LeadRecord> & { emailDomain?: string } = {};
  const meta: Record<string, EnrichedFieldMeta> = {};

  // 1.5. CRM-history Tier 0 — cross-tenant sibling-lead lookup. Before any
  // external API call, see if any user's existing lead matches by email,
  // linkedin, or exact name+company. Fills empties only; respects refreshFields.
  // Sibling identifiers are kept in stored meta for audit; the response-layer
  // sanitizer (utils/enrichmentMetadataPresentation.ts) strips them before
  // they reach the customer-portal.
  try {
    const sibling = await deps.findSiblingLead({
      excludeLeadId: lead.leadId,
      email: email || undefined,
      linkedinUrl: linkedinUrl || undefined,
      firstName: hasName ? lead.firstName : undefined,
      lastName: hasName ? lead.lastName : undefined,
      company: lead.company || undefined,
    });
    if (sibling) {
      const enrichedAt = new Date().toISOString();
      const baseMeta: EnrichedFieldMeta = {
        source: 'crm-history',
        provider: 'agentweb',
        enrichedAt,
        siblingLeadId: sibling.leadId,
        siblingListId: sibling.listId,
        siblingUserId: sibling.userId,
      };
      const refresh = input.refreshFields;
      const copyableFields: Array<keyof SiblingLeadResult & keyof LeadRecord> = [
        'firstName', 'lastName', 'email', 'linkedin', 'company', 'website', 'title',
      ];
      for (const field of copyableFields) {
        const siblingValue = sibling[field];
        if (typeof siblingValue !== 'string' || siblingValue.trim() === '') continue;
        const currentValue = (lead as any)[field];
        if (typeof currentValue === 'string' && currentValue.trim() !== '') continue;
        if (refresh && refresh.has(`${lead.leadId}:${field}`)) continue;
        (resolved as any)[field] = siblingValue;
        meta[field] = { ...baseMeta };
      }
      // If Tier 0 filled email, downstream Apollo-by-email paths can use it.
      if (resolved.email && !email) email = resolved.email;
    }
  } catch (err) {
    // findSiblingLead failures must NEVER block enrichment — Apollo path
    // can still resolve identity. Log and continue.
    console.warn('[resolveIdentity] tier 0 findSiblingLead failed:', (err as Error).message);
  }

  // 2. LinkedIn-first path: if we have a LinkedIn URL but no email, use
  //    Apollo people-match on linkedinUrl — that returns email plus other
  //    person fields. Once email is back, the rest of the flow uses it.
  if (!email && linkedinUrl) {
    const byLinkedin = await deps.apolloPeopleMatch({ linkedinUrl });
    if (byLinkedin) {
      const apolloMeta = makeApiMeta('apollo');
      if (byLinkedin.email) {
        email = byLinkedin.email;
        resolved.email = byLinkedin.email;
        meta.email = apolloMeta;
      }
      // Fill other person fields from the same Apollo response — saves a
      // second people-match call in step 3.
      if (byLinkedin.firstName && !lead.firstName) {
        resolved.firstName = byLinkedin.firstName;
        meta.firstName = apolloMeta;
      }
      if (byLinkedin.lastName && !lead.lastName) {
        resolved.lastName = byLinkedin.lastName;
        meta.lastName = apolloMeta;
      }
      if (byLinkedin.title && !lead.title) {
        resolved.title = byLinkedin.title;
        meta.title = apolloMeta;
      }
    }
  }

  // After LinkedIn fallback, we still might not have an email. Without it,
  // Apollo person/org match by email can't run — but the waterfall's web
  // tier can still resolve fields from name+company, so don't fail-early.
  // Skip the email-dependent steps and let the completeness check below
  // decide whether we resolved enough.

  // 3. Derive emailDomain from email if present. Pure local op, no API call.
  if (email && !lead.emailDomain) {
    const derived = extractDomainFromEmail(email);
    if (derived) resolved.emailDomain = derived;
  }
  const emailDomain = lead.emailDomain || resolved.emailDomain;

  // 4. Person resolution — only when needed AND still missing AND we have
  // email for Apollo. Without email, the downstream web tier handles it.
  const personStillMissing =
    needsPersonFields &&
    (!lead.firstName || !lead.lastName) &&
    (!resolved.firstName || !resolved.lastName);
  if (personStillMissing && email) {
    const apolloPerson = await deps.apolloPeopleMatch({ email });
    if (apolloPerson) {
      const apolloMeta = makeApiMeta('apollo');
      if (apolloPerson.firstName && !lead.firstName && !resolved.firstName) {
        resolved.firstName = apolloPerson.firstName;
        meta.firstName = apolloMeta;
      }
      if (apolloPerson.lastName && !lead.lastName && !resolved.lastName) {
        resolved.lastName = apolloPerson.lastName;
        meta.lastName = apolloMeta;
      }
      if (apolloPerson.title && !lead.title && !resolved.title) {
        resolved.title = apolloPerson.title;
        meta.title = apolloMeta;
      }
      if (apolloPerson.linkedin && !lead.linkedin) {
        resolved.linkedin = apolloPerson.linkedin;
        meta.linkedin = apolloMeta;
      }
    }
  }

  // 4. Company resolution — Apollo first, enrich.so fallback.
  // Note: completeness requires `company` only — `website` is a bonus.
  // Canonical key building (enrichmentGroups.ts) can resolve company-level
  // canonical IDs from email domain or normalized company name, so missing
  // website doesn't block downstream waterfall tiers.
  // Tier 0 may have already filled company/website — check `resolved` too so
  // we don't make a redundant Apollo call when the sibling supplied both.
  const companyEffective = lead.company || resolved.company;
  const websiteEffective = lead.website || resolved.website;
  if (needsCompanyFields && (!companyEffective || !websiteEffective)) {
    if (emailDomain) {
      const apolloOrg = await deps.apolloOrgMatch({ emailDomain });
      if (apolloOrg) {
        const apolloMeta = makeApiMeta('apollo');
        if (apolloOrg.company && !lead.company && !resolved.company) {
          resolved.company = apolloOrg.company;
          meta.company = apolloMeta;
        }
        if (apolloOrg.website && !lead.website && !resolved.website) {
          resolved.website = apolloOrg.website;
          meta.website = apolloMeta;
        }
      }
    }

    // Fallback to enrich.so if company is still missing — requires email.
    const companyStillMissing = !lead.company && !resolved.company;
    if (companyStillMissing && email) {
      const enrichSo = await deps.enrichSoReverseLookup({ email });
      if (enrichSo) {
        const enrichSoMeta = makeApiMeta('enrich.so');
        if (enrichSo.company && !lead.company) {
          resolved.company = enrichSo.company;
          meta.company = enrichSoMeta;
        }
      }
    }
  }

  // 5. Did we resolve everything that was needed?
  if (needsPersonFields) {
    const personOk = (lead.firstName || resolved.firstName) &&
                     (lead.lastName  || resolved.lastName);
    if (!personOk) return { ok: false, reason: 'identity_unresolvable' };
  }
  if (needsCompanyFields) {
    const companyOk = lead.company || resolved.company;
    if (!companyOk) return { ok: false, reason: 'identity_unresolvable' };
  }

  // 6. Persist newly-resolved attributes ONLY in enrich mode.
  const writableFields: Record<string, string> = {};
  for (const [key, value] of Object.entries(resolved)) {
    if (key === 'emailDomain') continue;  // derived locally, not an API result
    if (typeof value === 'string' && value.length > 0) {
      writableFields[key] = value;
    }
  }
  if (mode === 'enrich' && Object.keys(writableFields).length > 0) {
    await deps.writeLeadFields({
      listId,
      leadId: lead.leadId,
      fields: writableFields,
      meta,
    });
  }

  return { ok: true, resolved };
}
