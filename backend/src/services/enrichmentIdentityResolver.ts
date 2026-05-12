// Identity resolution — Req B step 0 of the v3.1 enrichment waterfall.
// Resolves missing emailDomain / firstName / lastName / company / website
// BEFORE the per-group waterfall runs. Stateless logic, injected dependencies.
//
// Design ref: tasks/crm-enrichment-v3.1-design.md §5.1.

import type { LeadRecord } from './crmEnrichmentService';
import type { EnrichedFieldMeta } from '../utils/enrichedFieldValue';
import { extractDomainFromEmail } from '../utils/leadSchema';

const IDENTITY_FIELD_TTL_MS = 90 * 86400 * 1000; // 90 days — no FIELD_GROUP for identity fields

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
 * CRM-history Tier 0 sibling. The resolver copies identity fields from here;
 * Tier 0b (enrichmentSiblingConfigFields) copies config-requested custom fields.
 */
export interface SiblingLeadResult {
  leadId: string;
  listId?: string;
  userId?: string;
  updatedAt?: string;
  firstName?: string;
  lastName?: string;
  email?: string;
  linkedin?: string;
  company?: string;
  website?: string;
  title?: string;
  customFields?: Record<string, string>;
}

export interface IdentityResolverDeps {
  apolloPeopleMatch(input: {
    email?: string;
    linkedinUrl?: string;
  }): Promise<ApolloPersonResult | null>;
  apolloOrgMatch(input: { emailDomain: string }): Promise<ApolloOrgResult | null>;
  enrichSoReverseLookup(input: { email: string }): Promise<EnrichSoReverseResult | null>;
  /**
   * Cross-tenant lookup. Returns ALL non-self leads matching by email,
   * linkedin, or exact name+company across ALL users — deduped by leadId,
   * sorted freshest-first by `updatedAt`. The resolver does per-field
   * best-of-N merge across the returned candidates so a sibling with only
   * `firstName` and another with only `company` can complement each other.
   * Empty array on no match. Tier 0 of the v3.1 identity resolution waterfall.
   */
  findSiblingLeads(input: {
    excludeLeadId: string;
    email?: string;
    linkedinUrl?: string;
    firstName?: string;
    lastName?: string;
    company?: string;
  }): Promise<SiblingLeadResult[]>;
  /**
   * Tier 0.5 — LLM web-search domain lookup. Called when `website` is still
   * empty after Tier 0 sibling lookup but a company name is known. Uses a
   * web-search-capable LLM (Gemini) to find the official company website.
   * Returns null on failure or when no confident match is found.
   */
  resolveCompanyDomainViaWebSearch(input: {
    company: string;
    linkedin?: string;
    title?: string;
    firstName?: string;
    lastName?: string;
  }): Promise<{ website: string } | null>;
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
  | { ok: true; resolved: Partial<LeadRecord> & { emailDomain?: string }; siblings: SiblingLeadResult[] }
  | { ok: false; reason: 'no_identity_signal' | 'identity_unresolvable' };

function makeApiMeta(provider: IdentityProvider): EnrichedFieldMeta {
  return {
    source: 'api',
    provider,
    enrichedAt: new Date().toISOString(),
  };
}

// Best-effort: convert a website URL into a bare emailDomain (host, no www).
// Returns null when the input is not a parseable URL so downstream Apollo /
// enrich.so calls aren't fed garbage (e.g., if the LLM hallucinates).
function deriveDomainFromWebsite(website: string): string | null {
  const trimmed = (website || '').trim();
  if (!trimmed) return null;
  const candidate = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const host = new URL(candidate).hostname.toLowerCase();
    if (!host || !host.includes('.')) return null;
    return host.replace(/^www\./, '');
  } catch {
    return null;
  }
}

export async function resolveIdentity(
  input: ResolveIdentityInput,
  deps: IdentityResolverDeps,
): Promise<ResolveIdentityResult> {
  const { lead, needsPersonFields, needsCompanyFields, mode, listId } = input;
  const logTag = `[resolveIdentity ${lead.leadId}]`;

  // 1. Need at least one identity signal: email, linkedin, or (firstName + lastName).
  // Apollo matches on email/linkedin; the waterfall's web tier (Unipile
  // tier 3.5) resolves LinkedIn from name+company. Without ANY of these
  // we can't resolve the lead.
  // Email is normalized (trim+lowercase) once at entry so every downstream
  // dep sees the same cache key.
  let email = typeof lead.email === 'string' ? lead.email.trim().toLowerCase() : '';
  const linkedinUrl = typeof lead.linkedin === 'string' ? lead.linkedin.trim() : '';
  const hasName =
    typeof lead.firstName === 'string' && lead.firstName.trim() !== '' &&
    typeof lead.lastName === 'string' && lead.lastName.trim() !== '';
  if (!email && !linkedinUrl && !hasName) return { ok: false, reason: 'no_identity_signal' };

  const resolved: Partial<LeadRecord> & { emailDomain?: string } = {};
  const meta: Record<string, EnrichedFieldMeta> = {};
  let fetchedSiblings: SiblingLeadResult[] = [];

  // 2. CRM-history Tier 0 — cross-tenant sibling-lead lookup. Queries all
  // three GSIs in parallel and does per-field best-of-N merge across the
  // returned candidates so complementary siblings (one has firstName only,
  // another has company only) can both contribute. Fills empties; respects
  // refreshFields. Per-field audit meta records WHICH sibling supplied each
  // field — different fields may point to different siblings. The response
  // sanitizer (utils/enrichmentMetadataPresentation.ts) strips the sibling
  // identifiers before sending to the customer-portal.
  try {
    fetchedSiblings = await deps.findSiblingLeads({
      excludeLeadId: lead.leadId,
      email: email || undefined,
      linkedinUrl: linkedinUrl || undefined,
      firstName: hasName ? lead.firstName : undefined,
      lastName: hasName ? lead.lastName : undefined,
      company: lead.company || undefined,
    });
    const now = Date.now();
    const siblings = fetchedSiblings.filter(s =>
      !s.updatedAt || now - new Date(s.updatedAt).getTime() <= IDENTITY_FIELD_TTL_MS,
    );
    if (siblings && siblings.length > 0) {
      const enrichedAt = new Date().toISOString();
      const refresh = input.refreshFields;
      const copyableFields: Array<keyof SiblingLeadResult & keyof LeadRecord> = [
        'firstName', 'lastName', 'email', 'linkedin', 'company', 'website', 'title',
      ];
      for (const field of copyableFields) {
        const currentValue = (lead as any)[field];
        if (typeof currentValue === 'string' && currentValue.trim() !== '') continue;
        if (refresh && refresh.has(`${lead.leadId}:${field}`)) continue;
        for (const sib of siblings) {
          const v = sib[field];
          if (typeof v !== 'string' || v.trim() === '') continue;
          (resolved as any)[field] = v;
          meta[field] = {
            source: 'crm-history',
            provider: 'agentweb',
            enrichedAt,
            siblingLeadId: sib.leadId,
            siblingListId: sib.listId,
            siblingUserId: sib.userId,
          };
          break;
        }
      }
      // If Tier 0 filled email, downstream Apollo-by-email paths can use it.
      // Cross-tenant note: this email may have originated on another customer's
      // lead — the locked design accepts cross-tenant pooling. Sanitizer strips
      // the sibling audit IDs before responses leave the backend.
      if (resolved.email && !email) email = resolved.email;
    }
  } catch (err) {
    // findSiblingLeads failures must NEVER block enrichment — Apollo path
    // can still resolve identity. Log and continue.
    console.warn(`${logTag} tier 0 findSiblingLeads failed:`, (err as Error).message);
  }

  // 2.5. Tier 0.5 — LLM web-search domain lookup. Fires when `website` is
  // still empty after Tier 0 sibling lookup and a company name is known.
  // Resolves the official website via a web-search-capable LLM (Gemini), then
  // derives emailDomain from it in-memory so step 6's Apollo org-match can run
  // even when there is no email address to extract a domain from.
  const websiteAfterTier0 = lead.website || resolved.website;
  const emailDomainAfterTier0 = lead.emailDomain || resolved.emailDomain;
  const companyForDomainLookup = lead.company || resolved.company;
  if (!websiteAfterTier0 && !emailDomainAfterTier0 && !extractDomainFromEmail(email) && companyForDomainLookup) {
    try {
      const domainResult = await deps.resolveCompanyDomainViaWebSearch({
        company: companyForDomainLookup,
        linkedin: lead.linkedin || resolved.linkedin || undefined,
        title: lead.title || resolved.title || undefined,
        firstName: lead.firstName || resolved.firstName || undefined,
        lastName: lead.lastName || resolved.lastName || undefined,
      });
      if (domainResult?.website) {
        resolved.website = domainResult.website;
        meta.website = { source: 'web_search', provider: 'llm_web_search', enrichedAt: new Date().toISOString() };
        // Derive emailDomain from the resolved website so downstream
        // emailDomain-gated steps (step 6 Apollo org-match, enrich.so
        // find-email) can fire when the lead arrived with only a company
        // name. Without this the Tier 0.5 fix is cosmetic — the website
        // populates but no email is ever found.
        const derivedDomain = deriveDomainFromWebsite(domainResult.website);
        if (derivedDomain && !lead.emailDomain && !resolved.emailDomain) {
          resolved.emailDomain = derivedDomain;
          meta.emailDomain = { source: 'web_search', provider: 'llm_web_search', enrichedAt: new Date().toISOString() };
        }
        console.log(`${logTag} tier 0.5 website=${domainResult.website} emailDomain=${derivedDomain || '∅'} for company="${companyForDomainLookup}"`);
      }
    } catch (err) {
      console.warn(`${logTag} tier 0.5 resolveCompanyDomainViaWebSearch failed:`, (err as Error).message);
    }
  }

  // 3. LinkedIn-first Apollo. Fires only when local `email` is still empty
  // after Tier 0 — we have a linkedin URL but no email to match by. Apollo
  // returns the email plus optional person fields. Each field is guarded
  // by both `!lead.X` and `!resolved.X` so Tier 0 fills are not overwritten.
  if (!email && linkedinUrl) {
    try {
      const byLinkedin = await deps.apolloPeopleMatch({ linkedinUrl });
      if (byLinkedin) {
        const apolloMeta = makeApiMeta('apollo');
        if (byLinkedin.email && !resolved.email) {
          email = byLinkedin.email;
          resolved.email = byLinkedin.email;
          meta.email = apolloMeta;
        }
        if (byLinkedin.firstName && !lead.firstName && !resolved.firstName) {
          resolved.firstName = byLinkedin.firstName;
          meta.firstName = apolloMeta;
        }
        if (byLinkedin.lastName && !lead.lastName && !resolved.lastName) {
          resolved.lastName = byLinkedin.lastName;
          meta.lastName = apolloMeta;
        }
        if (byLinkedin.title && !lead.title && !resolved.title) {
          resolved.title = byLinkedin.title;
          meta.title = apolloMeta;
        }
      }
    } catch (err) {
      console.warn(`${logTag} step 3 apolloPeopleMatch(linkedinUrl) failed:`, (err as Error).message);
    }
  }

  // 4. Derive emailDomain from email if present. Pure local op, no API call.
  if (email && !lead.emailDomain) {
    const derived = extractDomainFromEmail(email);
    if (derived) resolved.emailDomain = derived;
  }
  const emailDomain = lead.emailDomain || resolved.emailDomain;

  // 5. Apollo person-match by email. Fires only when name fields are still
  // missing after Tier 0 and we have an email to match by.
  const personStillMissing =
    needsPersonFields &&
    (!lead.firstName || !lead.lastName) &&
    (!resolved.firstName || !resolved.lastName);
  if (personStillMissing && email) {
    try {
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
        if (apolloPerson.linkedin && !lead.linkedin && !resolved.linkedin) {
          resolved.linkedin = apolloPerson.linkedin;
          meta.linkedin = apolloMeta;
        }
      }
    } catch (err) {
      console.warn(`${logTag} step 5 apolloPeopleMatch(email) failed:`, (err as Error).message);
    }
  }

  // 6. Company resolution — Apollo org first, enrich.so reverse fallback.
  // Completeness requires `company` only — `website` is a bonus (the canonical
  // key builder in enrichmentGroups.ts can resolve company-level IDs from
  // email domain or normalized name). Tier 0 may have filled either or both;
  // we skip Apollo when both are already present.
  const companyEffective = lead.company || resolved.company;
  const websiteEffective = lead.website || resolved.website;
  if (needsCompanyFields && (!companyEffective || !websiteEffective)) {
    if (emailDomain) {
      try {
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
      } catch (err) {
        console.warn(`${logTag} step 6 apolloOrgMatch failed:`, (err as Error).message);
      }
    }

    // enrich.so reverse lookup — fires when company is still missing and we
    // have an email. Honors firstName/lastName the response carries — fills
    // them too if Tier 0 + Apollo didn't.
    const companyStillMissing = !lead.company && !resolved.company;
    if (companyStillMissing && email) {
      try {
        const enrichSo = await deps.enrichSoReverseLookup({ email });
        if (enrichSo) {
          const enrichSoMeta = makeApiMeta('enrich.so');
          if (enrichSo.company) {
            resolved.company = enrichSo.company;
            meta.company = enrichSoMeta;
          }
          if (enrichSo.firstName && !lead.firstName && !resolved.firstName) {
            resolved.firstName = enrichSo.firstName;
            meta.firstName = enrichSoMeta;
          }
          if (enrichSo.lastName && !lead.lastName && !resolved.lastName) {
            resolved.lastName = enrichSo.lastName;
            meta.lastName = enrichSoMeta;
          }
        }
      } catch (err) {
        console.warn(`${logTag} step 6 enrichSoReverseLookup failed:`, (err as Error).message);
      }
    }
  }

  // 7. Completeness gate.
  if (needsPersonFields) {
    const personOk = (lead.firstName || resolved.firstName) &&
                     (lead.lastName  || resolved.lastName);
    if (!personOk) return { ok: false, reason: 'identity_unresolvable' };
  }
  if (needsCompanyFields) {
    const companyOk = lead.company || resolved.company;
    if (!companyOk) return { ok: false, reason: 'identity_unresolvable' };
  }


  // 8. Persist newly-resolved attributes ONLY in enrich mode. We also project
  // `meta` down to only the fields that made it into writableFields so the
  // write never carries audit entries for absent attributes.
  const writableFields: Record<string, string> = {};
  for (const [key, value] of Object.entries(resolved)) {
    // emailDomain is normally derived locally from email and not worth
    // persisting on its own. Exception: when Tier 0.5 derived it from a
    // web-search-resolved website, the lead has no email to re-derive
    // from on the next run — persist it so the value is not lost.
    if (key === 'emailDomain' && !meta.emailDomain) continue;
    if (typeof value === 'string' && value.length > 0) {
      writableFields[key] = value;
    }
  }
  if (mode === 'enrich' && Object.keys(writableFields).length > 0) {
    const writableMeta: Record<string, EnrichedFieldMeta> = {};
    for (const k of Object.keys(writableFields)) {
      if (meta[k]) writableMeta[k] = meta[k];
    }
    await deps.writeLeadFields({
      listId,
      leadId: lead.leadId,
      fields: writableFields,
      meta: writableMeta,
    });
  }

  return { ok: true, resolved, siblings: fetchedSiblings };
}
