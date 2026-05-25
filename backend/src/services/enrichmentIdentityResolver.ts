// Identity resolution — Req B step 0 of the v3.1 enrichment waterfall.
// Resolves missing emailDomain / firstName / lastName / company / website
// BEFORE the per-group waterfall runs. Stateless logic, injected dependencies.
//
// Design ref: tasks/crm-enrichment-v3.1-design.md §5.1.

import type { LeadRecord } from './crmEnrichmentService';
import { CrmEnrichmentService } from './crmEnrichmentService';
import type { EnrichedFieldMeta } from '../utils/enrichedFieldValue';
import { extractDomainFromEmail } from '../utils/leadSchema';
import { apolloEmailStatusToConfidence } from './apolloFieldMapper';
import { getFieldConfidence } from './fieldConfidenceRegistry';

const IDENTITY_FIELD_TTL_MS = 90 * 86400 * 1000; // 90 days — no FIELD_GROUP for identity fields

export type IdentityProvider = 'apollo' | 'enrich.so' | 'unipile' | 'pattern';

export interface ApolloPersonResult {
  firstName?: string;
  lastName?: string;
  title?: string;
  linkedin?: string;
  email?: string;
  emailStatus?: string;
  company?: string;          // from embedded person.organization
  website?: string;          // from embedded person.organization
  city?: string;
  state?: string;
  country?: string;
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
    firstName?: string;
    lastName?: string;
    domain?: string;
    company?: string;
  }): Promise<ApolloPersonResult | null>;
  enrichSoReverseLookup(input: { email: string }): Promise<EnrichSoReverseResult | null>;
  enrichSoFindEmail(input: { firstName: string; lastName: string; domain: string }): Promise<{ email: string } | null>;
  apolloBrokerChain(
    input: {
      firstName: string;
      lastName: string;
      domain?: string;
      company?: string;
      linkedinUrl?: string;
      linkedToEmail?: string;
    },
    leadHint: { listId: string; leadId: string },
  ): Promise<{ email?: string; emailStatus?: string } | null>;
  findEmailViaPatterns(input: {
    firstName: string;
    lastName: string;
    domain: string;
  }): Promise<{ email: string; pattern?: string } | null>;
  /** Step 2 — Unipile LinkedIn people search. Finds linkedin_url from name+company.
   *  Returns null when no connected LinkedIn account or no confident match. */
  findLinkedInUrl(input: { firstName: string; lastName: string; company: string }): Promise<string | null>;
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
  /** Tier 6.5 only. When set, the resolver may call Apollo's broker chain
   *  (run_waterfall_email) via `deps.apolloBrokerChain`. Without this hint
   *  there is no lead to write the async result back to, so Tier 6.5 is skipped. */
  leadHint?: { listId: string; leadId: string };
}

export type ResolveIdentityResult =
  | { ok: true; resolved: Partial<LeadRecord> & { emailDomain?: string }; siblings: SiblingLeadResult[]; emailPattern?: string }
  | { ok: false; reason: 'no_identity_signal' | 'identity_unresolvable' };

function makeApiMeta(provider: IdentityProvider, field?: string): EnrichedFieldMeta {
  // Per-field confidence: apollo / enrich.so use the registry (so e.g.
  // enrich.so firstName='high' but company='medium'); unipile and pattern have
  // no registry entry and default to 'medium'. A missing field name also
  // defaults to 'medium'.
  let confidence: EnrichedFieldMeta['confidence'] = 'medium';
  if (field && (provider === 'apollo' || provider === 'enrich.so')) {
    confidence = getFieldConfidence(provider, field);
  }
  return {
    source: 'api',
    provider,
    confidence,
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
  let validSiblings: SiblingLeadResult[] = [];

  // 2. CRM-history Tier 0 — cross-tenant sibling-lead lookup. Queries all
  // three GSIs in parallel and does per-field best-of-N merge across the
  // returned candidates so complementary siblings (one has firstName only,
  // another has company only) can both contribute. Fills empties; respects
  // refreshFields. Per-field audit meta records WHICH sibling supplied each
  // field — different fields may point to different siblings. The response
  // sanitizer (utils/enrichmentMetadataPresentation.ts) strips the sibling
  // identifiers before sending to the customer-portal.
  try {
    const fetchedSiblings = await deps.findSiblingLeads({
      excludeLeadId: lead.leadId,
      email: email || undefined,
      linkedinUrl: linkedinUrl || undefined,
      firstName: hasName ? lead.firstName : undefined,
      lastName: hasName ? lead.lastName : undefined,
      company: lead.company || undefined,
    });
    const now = Date.now();
    validSiblings = fetchedSiblings.filter(s =>
      !s.updatedAt || now - new Date(s.updatedAt).getTime() <= IDENTITY_FIELD_TTL_MS,
    );
    const siblings = validSiblings;
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

  // 2.7. Unipile LinkedIn search. Fires when linkedin is still missing but
  // firstName + lastName + company are known. Finds the linkedin_url so
  // step 3 (Apollo-by-LinkedIn) can fire and resolve email + org in one shot.
  const linkedinEffective = lead.linkedin || resolved.linkedin || linkedinUrl;
  const firstNameEffective = lead.firstName || resolved.firstName;
  const lastNameEffective = lead.lastName || resolved.lastName;
  if (!linkedinEffective && firstNameEffective && lastNameEffective && (lead.company || resolved.company)) {
    try {
      const firstName = (lead.firstName || resolved.firstName)!;
      const lastName = (lead.lastName || resolved.lastName)!;
      const company = (lead.company || resolved.company)!;
      const foundLinkedin = await deps.findLinkedInUrl({ firstName, lastName, company });
      if (foundLinkedin) {
        resolved.linkedin = foundLinkedin;
        meta.linkedin = makeApiMeta('unipile', 'linkedin');
      }
    } catch (err) {
      console.warn(`${logTag} step 2 findLinkedInUrl failed:`, (err as Error).message);
    }
  }

  // 3. Unified Apollo call — fires when any signal is available AND fields are still
  // incomplete. Sends all available signals combined so Apollo can return the best
  // match. Merges the former two-tier split (linkedin-first + email-first) into one
  // call: more signals → higher Apollo match confidence → better field coverage.
  const linkedinForApollo = linkedinUrl || resolved.linkedin;
  const firstNameEff = lead.firstName || resolved.firstName;
  const lastNameEff = lead.lastName || resolved.lastName;
  const rawEmailDomain = extractDomainFromEmail(email);
  const domainForApollo =
    lead.emailDomain || resolved.emailDomain ||
    (rawEmailDomain && !CrmEnrichmentService.isPersonalDomain(rawEmailDomain) ? rawEmailDomain : undefined) ||
    deriveDomainFromWebsite(lead.website || resolved.website || '') ||
    undefined;
  const companyForApollo = lead.company || resolved.company;
  const hasNameOrg = !!(firstNameEff && lastNameEff && (domainForApollo || companyForApollo));
  const apolloSignalAvailable = !!(email || linkedinForApollo || hasNameOrg);
  const apolloNeeded =
    !email ||
    (needsPersonFields && (!(lead.firstName || resolved.firstName) || !(lead.lastName || resolved.lastName))) ||
    (needsCompanyFields && !(lead.company || resolved.company));

  if (apolloSignalAvailable && apolloNeeded) {
    try {
      const apolloInput: Parameters<IdentityResolverDeps['apolloPeopleMatch']>[0] = {};
      if (email) apolloInput.email = email;
      if (linkedinForApollo) apolloInput.linkedinUrl = linkedinForApollo;
      if (firstNameEff) apolloInput.firstName = firstNameEff;
      if (lastNameEff) apolloInput.lastName = lastNameEff;
      if (domainForApollo) apolloInput.domain = domainForApollo;
      else if (companyForApollo) apolloInput.company = companyForApollo;

      // weakSignalOnly = no email/linkedin anchor — name+domain/company only.
      // Used below to gate non-email field fills (prevents false-positive person match).
      const weakSignalOnly = !email && !linkedinForApollo;

      const apolloResult = await deps.apolloPeopleMatch(apolloInput);
      if (apolloResult) {
        let emailTrusted = false;
        if (apolloResult.email && !email && !resolved.email) {
          email = apolloResult.email;
          resolved.email = apolloResult.email;
          meta.email = {
            ...makeApiMeta('apollo', 'email'),
            confidence: apolloEmailStatusToConfidence(apolloResult.emailStatus ?? ''),
          };
          emailTrusted = true;
        }

        // Non-email fields: fill only when match is confident.
        // Strong anchor (email/linkedin present) → always confident.
        // Weak anchor (name+domain only) → confident only if Apollo returned a
        // trusted email (confirms it found the right person record).
        const matchConfident = !weakSignalOnly || emailTrusted;
        if (matchConfident) {
          if (apolloResult.firstName && !lead.firstName && !resolved.firstName) {
            resolved.firstName = apolloResult.firstName;
            meta.firstName = makeApiMeta('apollo', 'firstName');
          }
          if (apolloResult.lastName && !lead.lastName && !resolved.lastName) {
            resolved.lastName = apolloResult.lastName;
            meta.lastName = makeApiMeta('apollo', 'lastName');
          }
          if (apolloResult.title && !lead.title && !resolved.title) {
            resolved.title = apolloResult.title;
            meta.title = makeApiMeta('apollo', 'title');
          }
          if (apolloResult.linkedin && !lead.linkedin && !resolved.linkedin) {
            resolved.linkedin = apolloResult.linkedin;
            meta.linkedin = makeApiMeta('apollo', 'linkedin');
          }
          if (apolloResult.company && !lead.company && !resolved.company) {
            resolved.company = apolloResult.company;
            meta.company = makeApiMeta('apollo', 'company');
          }
          if (apolloResult.website && !lead.website && !resolved.website) {
            resolved.website = apolloResult.website;
            meta.website = makeApiMeta('apollo', 'website');
          }
        }
      }
    } catch (err) {
      console.warn(`${logTag} unified Apollo match failed:`, (err as Error).message);
    }
  }

  // 4. Derive emailDomain from email if present. Pure local op, no API call.
  if (email && !lead.emailDomain) {
    const derived = extractDomainFromEmail(email);
    if (derived) resolved.emailDomain = derived;
  }
  const emailDomain = lead.emailDomain || resolved.emailDomain;

  // (Tier 5 merged into unified Apollo call above.)

  // 5.5. enrich.so email-finder → reverse-lookup chain. Fires when email is
  // still absent but we have firstName + lastName + emailDomain. email-finder
  // resolves the email; reverse-lookup then fills company + person fields.
  if (!email && emailDomain && (lead.firstName || resolved.firstName) && (lead.lastName || resolved.lastName)) {
    try {
      const firstName = (lead.firstName || resolved.firstName)!;
      const lastName = (lead.lastName || resolved.lastName)!;
      const found = await deps.enrichSoFindEmail({ firstName, lastName, domain: emailDomain });
      if (found?.email) {
        email = found.email;
        resolved.email = found.email;
        meta.email = makeApiMeta('enrich.so', 'email');
        // Chain: reverse-lookup on the resolved email fills company.
        // Names are already known (gate ensures firstName+lastName present).
        try {
          const enrichSo = await deps.enrichSoReverseLookup({ email });
          if (enrichSo?.company && !lead.company && !resolved.company) {
            resolved.company = enrichSo.company;
            meta.company = makeApiMeta('enrich.so', 'company');
          }
        } catch (err) {
          console.warn(`${logTag} step 5.5 enrichSoReverseLookup chain failed:`, (err as Error).message);
        }
      }
    } catch (err) {
      console.warn(`${logTag} step 5.5 enrichSoFindEmail failed:`, (err as Error).message);
    }
  }

  // 6.5. Apollo broker chain — fires when email is still absent AND a leadHint
  // is present (so the async result can be written back) AND we have name +
  // (emailDomain or company). Respects the same emailStatus gate as the
  // unified Apollo Tier 3: weak signal (no linkedin) → only verified/unverified/
  // extrapolated accepted; strong signal (has linkedin) → anything except guessed.
  const emailDomainForBroker = lead.emailDomain || resolved.emailDomain;
  const firstNameForBroker = lead.firstName || resolved.firstName;
  const lastNameForBroker = lead.lastName || resolved.lastName;
  const companyForBroker = lead.company || resolved.company;
  if (
    !email &&
    input.leadHint &&
    firstNameForBroker &&
    lastNameForBroker &&
    (emailDomainForBroker || companyForBroker)
  ) {
    try {
      const linkedinForBroker = lead.linkedin || resolved.linkedin;
      const brokerInput: Parameters<IdentityResolverDeps['apolloBrokerChain']>[0] = {
        firstName: firstNameForBroker,
        lastName: lastNameForBroker,
      };
      if (emailDomainForBroker) brokerInput.domain = emailDomainForBroker;
      else if (companyForBroker) brokerInput.company = companyForBroker;
      if (linkedinForBroker) brokerInput.linkedinUrl = linkedinForBroker;

      const brokerResult = await deps.apolloBrokerChain(brokerInput, input.leadHint);
      if (brokerResult?.email) {
        email = brokerResult.email;
        resolved.email = brokerResult.email;
        meta.email = {
          ...makeApiMeta('apollo', 'email'),
          confidence: apolloEmailStatusToConfidence(brokerResult.emailStatus ?? ''),
        };
      }
    } catch (err) {
      console.warn(`${logTag} tier 6.5 apolloBrokerChain failed:`, (err as Error).message);
    }
  }

  // 7. Pattern matching — fires when email is still absent AND emailDomain +
  // firstName + lastName are known. Does NOT require leadHint. Quality is
  // inherent (enrich.so deliverability check); no emailStatus gate needed.
  let emailPattern: string | undefined;
  const emailDomainForPatterns = lead.emailDomain || resolved.emailDomain;
  const firstNameForPatterns = lead.firstName || resolved.firstName;
  const lastNameForPatterns = lead.lastName || resolved.lastName;
  if (!email && emailDomainForPatterns && firstNameForPatterns && lastNameForPatterns) {
    try {
      const patternResult = await deps.findEmailViaPatterns({
        firstName: firstNameForPatterns,
        lastName: lastNameForPatterns,
        domain: emailDomainForPatterns,
      });
      if (patternResult?.email) {
        email = patternResult.email;
        resolved.email = patternResult.email;
        meta.email = {
          source: 'api',
          provider: 'pattern',
          confidence: 'medium',
          ...(patternResult.pattern ? { sourceQuote: `pattern: ${patternResult.pattern}` } : {}),
          enrichedAt: new Date().toISOString(),
        };
        emailPattern = patternResult.pattern;
      }
    } catch (err) {
      console.warn(`${logTag} tier 7 findEmailViaPatterns failed:`, (err as Error).message);
    }
  }

  // After Tier 6.5 / 7: re-derive emailDomain from the newly-found email
  // when neither the lead nor the resolved object already has one.
  if (email && !lead.emailDomain && !resolved.emailDomain) {
    const derived = extractDomainFromEmail(email);
    if (derived) resolved.emailDomain = derived;
  }

  // 6. enrich.so reverse-lookup — fires when company is still missing and we
  // have an email (either from the lead or resolved in earlier steps).
  // Covers personal email leads where enrich.so reverses personal → work.
  const companyEffective = lead.company || resolved.company;
  const websiteEffective = lead.website || resolved.website;
  if (needsCompanyFields && (!companyEffective || !websiteEffective)) {
    const companyStillMissing = !lead.company && !resolved.company;
    if (companyStillMissing && email) {
      try {
        const enrichSo = await deps.enrichSoReverseLookup({ email });
        if (enrichSo) {
          if (enrichSo.company) {
            resolved.company = enrichSo.company;
            meta.company = makeApiMeta('enrich.so', 'company');
          }
          if (enrichSo.firstName && !lead.firstName && !resolved.firstName) {
            resolved.firstName = enrichSo.firstName;
            meta.firstName = makeApiMeta('enrich.so', 'firstName');
          }
          if (enrichSo.lastName && !lead.lastName && !resolved.lastName) {
            resolved.lastName = enrichSo.lastName;
            meta.lastName = makeApiMeta('enrich.so', 'lastName');
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

  return { ok: true, resolved, siblings: validSiblings, emailPattern };
}
