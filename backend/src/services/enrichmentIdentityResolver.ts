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

export interface IdentityResolverDeps {
  apolloPeopleMatch(input: {
    email?: string;
    linkedinUrl?: string;
  }): Promise<ApolloPersonResult | null>;
  apolloOrgMatch(input: { emailDomain: string }): Promise<ApolloOrgResult | null>;
  enrichSoReverseLookup(input: { email: string }): Promise<EnrichSoReverseResult | null>;
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
  if (needsCompanyFields && (!lead.company || !lead.website)) {
    if (emailDomain) {
      const apolloOrg = await deps.apolloOrgMatch({ emailDomain });
      if (apolloOrg) {
        const apolloMeta = makeApiMeta('apollo');
        if (apolloOrg.company && !lead.company) {
          resolved.company = apolloOrg.company;
          meta.company = apolloMeta;
        }
        if (apolloOrg.website && !lead.website) {
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
