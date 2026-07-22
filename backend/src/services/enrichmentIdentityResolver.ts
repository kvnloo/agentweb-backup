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
  fromCache?: boolean;
}

export interface EnrichSoReverseResult {
  firstName?: string;
  lastName?: string;
  company?: string;
  fromCache?: boolean;
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
  /** Per-field enrichment provenance from the sibling lead. Tier 0b reads this
   *  so a copied web-sourced value carries its originating sourceUrl/sourceQuote
   *  forward — letting the critic re-verify the copy instead of trusting it
   *  blindly (Slashy/Slash bug: a sibling's unverified cross-company value must
   *  not propagate uncritiqued). */
  enrichmentMetadata?: Record<string, EnrichedFieldMeta>;
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
   *  `listContext` (optional) carries list-level disambiguation — the lead
   *  list's name/description (e.g. "YC Poker Night"). The dep searches by name
   *  only (folding context into the query collapses results) and uses the
   *  context to pick the right profile among same-name candidates, so a
   *  name-only lead with no company can still be resolved against the right
   *  person. Returns null when no connected LinkedIn account or no confident
   *  match. */
  findLinkedInUrl(input: { firstName: string; lastName: string; company: string; listContext?: string }): Promise<string | null>;
  /** Step 3.5 — Unipile profile lookup BY LinkedIn URL. Resolves
   *  name/title/company directly from a /in/ URL — the one identity source
   *  that works for a LinkedIn-only lead Apollo doesn't cover. Without it such
   *  leads fail the person-completeness gate and are skipped before the
   *  waterfall's own Unipile tier (3.5b) ever runs. Returns null when there is
   *  no connected LinkedIn account or the profile cannot be fetched. */
  findUnipileProfileByUrl?(input: { linkedinUrl: string }): Promise<{
    firstName?: string;
    lastName?: string;
    title?: string;
    company?: string;
    fromCache?: boolean;
  } | null>;
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
    company?: string;
    domain?: string;
    linkedin?: string;
    title?: string;
    firstName?: string;
    lastName?: string;
  }): Promise<{ website?: string; company?: string; searchedDomain?: string } | null>;
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
  /** List-level disambiguation context — the lead list's name (and optionally
   *  description), e.g. "YC Poker Night". When a lead has a name but no company,
   *  Tier 2.7 runs a name-only Unipile LinkedIn search and uses this context to
   *  pick the right profile among same-name candidates, so a common name can
   *  still be resolved against the right person via the shared affiliation.
   *  Undefined/empty disables the name-only contextual search — a bare name
   *  search risks matching the wrong person, so we only attempt it when there
   *  is a disambiguating signal. */
  listContext?: string;
  /** Standard identity-signal field names (firstName, lastName, email,
   *  linkedin, company, website, title) the user did NOT opt into enriching.
   *  These are still resolved IN MEMORY — company/website are needed as signals
   *  to match the person (e.g. resolving a LinkedIn URL via Apollo) — but are
   *  NOT persisted to the lead. Without this, deselecting `company` in the
   *  enrichment config still wrote a company value discovered as a side effect
   *  of LinkedIn resolution. Omit (or empty set) to persist every resolved field. */
  excludePersistFields?: Set<string>;
}

export type ResolveIdentityResult =
  | {
      ok: true;
      resolved: Partial<LeadRecord> & { emailDomain?: string };
      siblings: SiblingLeadResult[];
      emailPattern?: string;
      /** True when identity was anchored ONLY on a name-only list-context
       *  LinkedIn guess (Tier 2.7 branch b). Signals the orchestrator to taint
       *  every downstream waterfall fill to low confidence — the persisted
       *  values overwrite the resolver's own meta, so the taint must also be
       *  applied there. */
      fromContextGuess?: boolean;
    }
  | { ok: false; reason: 'no_identity_signal' | 'identity_unresolvable' };

function makeApiMeta(provider: IdentityProvider, field?: string, fromCache?: boolean): EnrichedFieldMeta {
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
    fromCache,
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
  // Set when identity is anchored on a name-only list-context LinkedIn guess
  // (Tier 2.7 branch b). When true, ALL resolved fields are tainted to low
  // confidence before persistence — see the taint pass before step 7.
  let identityFromContextGuess = false;

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
      // `linkedin` and `title` are deliberately NOT copied across sibling leads.
      // They are profile-anchored: two leads sharing only an email (often a junk
      // address like joe@us.com) are not necessarily the same person, and a
      // sibling's linkedin URL may itself be a wrong-person value from a prior
      // enrichment. Copying it verbatim re-affirms the bad URL onto every sibling
      // and a name check can't catch it (the siblings share the same name). These
      // fields are instead re-derived per-lead through the gated Apollo/Unipile
      // paths. email/company/website are safe to copy — name is the match anchor
      // and these are not person-profile-specific.
      const copyableFields: Array<keyof SiblingLeadResult & keyof LeadRecord> = [
        'firstName', 'lastName', 'email', 'company', 'website',
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
  // rawEmailDomain computed once here — reused by Tier 0.5 Branch B gate and
  // by domainForApollo at Tier 3 so extractDomainFromEmail is only called once.
  const rawEmailDomain = extractDomainFromEmail(email);
  const hasBusinessEmailDomain = !!rawEmailDomain && !CrmEnrichmentService.isPersonalDomain(rawEmailDomain);

  const websiteAfterTier0 = lead.website || resolved.website;
  const emailDomainAfterTier0 = lead.emailDomain || resolved.emailDomain;
  const companyForDomainLookup = lead.company || resolved.company;

  // Tier 0.5 fires when website is still missing and we have at least one
  // searchable signal (company name OR business email domain). Passes all
  // available signals to the LLM so it can find website + company name.
  // Must run before Tier 3 Apollo so resolved domain/company improves the
  // Apollo org-match signal.
  const tier05HasSignal = !!companyForDomainLookup || hasBusinessEmailDomain;
  if (!websiteAfterTier0 && tier05HasSignal && needsCompanyFields) {
    try {
      const domainResult = await deps.resolveCompanyDomainViaWebSearch({
        company: companyForDomainLookup || undefined,
        domain: hasBusinessEmailDomain ? rawEmailDomain : undefined,
        linkedin: lead.linkedin || resolved.linkedin || undefined,
        title: lead.title || resolved.title || undefined,
        firstName: lead.firstName || resolved.firstName || undefined,
        lastName: lead.lastName || resolved.lastName || undefined,
      });
      if (domainResult?.website) {
        // Branch B validation (options 2 + 4): when we passed an email domain,
        // the returned website must resolve to that same domain. Guards against
        // LLM returning a plausible-but-wrong site (wrong TLD, similar name).
        let websiteAccepted = true;
        if (hasBusinessEmailDomain) {
          const derivedFromWebsite = deriveDomainFromWebsite(domainResult.website);
          const domainOrSubdomain = (d: string | null) =>
            !!d && (d === rawEmailDomain || d.endsWith(`.${rawEmailDomain}`) || rawEmailDomain!.endsWith(`.${d}`));
          const derivedMatches = domainOrSubdomain(derivedFromWebsite);                        // option 4
          const echoedDomain = domainResult.searchedDomain;
          const echoMatches = !echoedDomain || domainOrSubdomain(echoedDomain);               // option 2
          if (!derivedMatches || !echoMatches) {
            console.warn(`${logTag} tier 0.5 domain mismatch — expected=${rawEmailDomain} derived=${derivedFromWebsite} echoed=${echoedDomain ?? '∅'} — rejecting`);
            websiteAccepted = false;
          }
        }
        if (websiteAccepted) {
          resolved.website = domainResult.website;
          meta.website = { source: 'web_search', provider: 'llm_web_search', enrichedAt: new Date().toISOString() };
          const derivedDomain = deriveDomainFromWebsite(domainResult.website);
          if (derivedDomain && !lead.emailDomain && !resolved.emailDomain) {
            resolved.emailDomain = derivedDomain;
            meta.emailDomain = { source: 'web_search', provider: 'llm_web_search', enrichedAt: new Date().toISOString() };
          }
          // Company name accepted when website validation passed — the confirmed
          // domain corroborates the LLM's company attribution. Only fills when
          // lead has no company yet; never overwrites an existing company name.
          if (domainResult.company && !lead.company && !resolved.company) {
            resolved.company = domainResult.company;
            meta.company = { source: 'web_search', provider: 'llm_web_search', enrichedAt: new Date().toISOString() };
          }
          console.log(`${logTag} tier 0.5 website=${domainResult.website} emailDomain=${derivedDomain || '∅'} company=${domainResult.company || '∅'}`);
        }
      }
      // Company-only result: LLM returned a company name but no website.
      // Only accept when no domain hint was passed — without a website we
      // can't validate via domain match, so only trust it when there was
      // nothing to validate against.
      if (!domainResult?.website && domainResult?.company && !hasBusinessEmailDomain
          && !lead.company && !resolved.company) {
        resolved.company = domainResult.company;
        meta.company = { source: 'web_search', provider: 'llm_web_search', enrichedAt: new Date().toISOString() };
        console.log(`${logTag} tier 0.5 company-only (no website) company=${domainResult.company}`);
      }
    } catch (err) {
      console.warn(`${logTag} tier 0.5 resolveCompanyDomainViaWebSearch failed:`, (err as Error).message);
    }
  }

  // 2.7. Unipile LinkedIn search. Finds the linkedin_url so step 3
  // (Apollo-by-LinkedIn) can fire and resolve email + org in one shot.
  //
  // Two trigger conditions, both requiring name + missing linkedin:
  //  (a) company is known → search by name, narrowed by the company filter
  //      (original behavior).
  //  (b) company is UNKNOWN but list-level context is available AND company
  //      fields are requested → search by name only, then use listContext to
  //      pick the right profile among same-name candidates (e.g. a "YC Poker
  //      Night" list disambiguates a common name via the shared affiliation;
  //      the dep does NOT fold context into the query string — that collapses
  //      LinkedIn results to zero). This is the name-only fallback: without it
  //      such leads fail the company-completeness gate below and are skipped
  //      entirely. Gated on listContext because a bare name-only search risks
  //      matching the wrong person. The unipileNameMatches guard in the dep
  //      still rejects results whose name doesn't match.
  const linkedinEffective = lead.linkedin || resolved.linkedin || linkedinUrl;
  const firstNameEffective = lead.firstName || resolved.firstName;
  const lastNameEffective = lead.lastName || resolved.lastName;
  const companyEffectiveForSearch = lead.company || resolved.company;
  const listContext = (input.listContext || '').trim();
  const canSearchByCompany = !!companyEffectiveForSearch;
  const canSearchByContext = !companyEffectiveForSearch && needsCompanyFields && !!listContext;
  if (!linkedinEffective && firstNameEffective && lastNameEffective && (canSearchByCompany || canSearchByContext)) {
    try {
      const firstName = firstNameEffective;
      const lastName = lastNameEffective;
      const company = companyEffectiveForSearch || '';
      const foundLinkedin = await deps.findLinkedInUrl({
        firstName,
        lastName,
        company,
        ...(listContext ? { listContext } : {}),
      });
      if (foundLinkedin) {
        resolved.linkedin = foundLinkedin;
        // Provenance: a URL found via the name-only list-context path (no
        // company anchor) is an educated guess among same-name people, so it
        // must NOT carry the same confidence as a company-anchored match.
        // Stamp it 'low' (overriding makeApiMeta's default 'medium') so
        // fieldVerificationStatus() flags it unverified and the UI/critic
        // caveat it. company-anchored matches keep the default 'medium'.
        const linkedinMeta = makeApiMeta('unipile', 'linkedin', false);
        if (canSearchByContext && !canSearchByCompany) {
          linkedinMeta.confidence = 'low';
          linkedinMeta.sourceQuote = `Matched by list context "${listContext}" among same-name LinkedIn profiles — verify before outreach.`;
          // Mark the whole identity as context-guessed so EVERY downstream
          // field seeded from this URL (Apollo email/company/title, etc.) is
          // tainted to low confidence before persistence — the identity is
          // only as trustworthy as the guessed URL.
          identityFromContextGuess = true;
        }
        meta.linkedin = linkedinMeta;
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
            ...makeApiMeta('apollo', 'email', apolloResult.fromCache),
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
            meta.firstName = makeApiMeta('apollo', 'firstName', apolloResult.fromCache);
          }
          if (apolloResult.lastName && !lead.lastName && !resolved.lastName) {
            resolved.lastName = apolloResult.lastName;
            meta.lastName = makeApiMeta('apollo', 'lastName', apolloResult.fromCache);
          }
          if (apolloResult.title && !lead.title && !resolved.title) {
            resolved.title = apolloResult.title;
            meta.title = makeApiMeta('apollo', 'title', apolloResult.fromCache);
          }
          if (apolloResult.linkedin && !lead.linkedin && !resolved.linkedin) {
            resolved.linkedin = apolloResult.linkedin;
            meta.linkedin = makeApiMeta('apollo', 'linkedin', apolloResult.fromCache);
          }
          // ENG-433: for a personal/institutional email (gmail, .edu, .gov, ...)
          // Apollo's people-match enriches the "organization" from the email
          // DOMAIN when it can't pin the real person — echoing the free-mail
          // provider or university itself (xqvistgaard@dartmouth.edu → Dartmouth
          // College, website dartmouth.edu). That institution is never the lead's
          // employer. Reject the company/website when the returned org resolves to
          // the lead's own institutional email domain; a genuinely different
          // employer domain (a real person/LinkedIn match) is still trusted, so
          // LinkedIn/person data remains the source of truth. Mirrors the guard in
          // fetchApolloOrg.
          const emailIsInstitutional = !!email && CrmEnrichmentService.isPersonalEmailDomain(email);
          // Raw email domain, lower-cased, RETAINING free-mail providers.
          // extractDomainFromEmail() drops free-mail domains (rawEmailDomain is
          // undefined for gmail/yahoo/etc.), which would silently bypass this
          // echo check for free-mail leads — so derive it directly here.
          const emailDomainForEcho = email ? (email.split('@')[1] || '').toLowerCase().trim() : '';
          const apolloOrgDomain = apolloResult.website
            ? (deriveDomainFromWebsite(apolloResult.website) || '').toLowerCase()
            : '';
          // Reject ONLY on a positive echo: the returned org resolves to the
          // lead's own personal/institutional email domain (dartmouth.edu →
          // Dartmouth College, website dartmouth.edu; yahoo.com → Yahoo, website
          // yahoo.com). When Apollo returns no website there is nothing to
          // identify as an echo, so we trust the email/LinkedIn-anchored person
          // match rather than dropping a possibly-real employer (mit.edu person
          // whose real employer "Google" comes back without an org website).
          const orgEchoesEmailDomain =
            emailIsInstitutional && !!emailDomainForEcho && !!apolloOrgDomain &&
            (apolloOrgDomain === emailDomainForEcho ||
             emailDomainForEcho.endsWith(`.${apolloOrgDomain}`) ||
             apolloOrgDomain.endsWith(`.${emailDomainForEcho}`));
          if (orgEchoesEmailDomain) {
            console.log(`${logTag} unified Apollo org echoes institutional email domain=${rawEmailDomain} org="${apolloResult.company}" — rejecting company/website`);
          }
          if (apolloResult.company && !lead.company && !orgEchoesEmailDomain) {
            // Apollo wins over Tier 0.5 LLM company — only guard against
            // overwriting what the user explicitly imported on the lead.
            resolved.company = apolloResult.company;
            meta.company = makeApiMeta('apollo', 'company', apolloResult.fromCache);
          }
          if (apolloResult.website && !lead.website && !resolved.website && !orgEchoesEmailDomain) {
            resolved.website = apolloResult.website;
            meta.website = makeApiMeta('apollo', 'website', apolloResult.fromCache);
          }
        }
      }
    } catch (err) {
      console.warn(`${logTag} unified Apollo match failed:`, (err as Error).message);
    }
  }

  // 3.5. Unipile profile-by-URL — fires when a LinkedIn /in/ URL is present but
  // first/last name is STILL missing after Apollo. getProfile(url) resolves
  // name/title/company directly from the URL: the one identity source that
  // works for a LinkedIn-only lead Apollo doesn't cover. Without this, such
  // leads fail the person-completeness gate below and are skipped entirely —
  // before the waterfall's own Unipile tier (3.5b) ever runs.
  const linkedinForProfile = linkedinUrl || resolved.linkedin;
  const stillMissingName =
    !(lead.firstName || resolved.firstName) || !(lead.lastName || resolved.lastName);
  if (deps.findUnipileProfileByUrl && needsPersonFields && linkedinForProfile && stillMissingName) {
    try {
      const profile = await deps.findUnipileProfileByUrl({ linkedinUrl: linkedinForProfile });
      if (profile) {
        if (profile.firstName && !lead.firstName && !resolved.firstName) {
          resolved.firstName = profile.firstName;
          meta.firstName = makeApiMeta('unipile', 'firstName', profile.fromCache);
        }
        if (profile.lastName && !lead.lastName && !resolved.lastName) {
          resolved.lastName = profile.lastName;
          meta.lastName = makeApiMeta('unipile', 'lastName', profile.fromCache);
        }
        if (profile.title && !lead.title && !resolved.title) {
          resolved.title = profile.title;
          meta.title = makeApiMeta('unipile', 'title', profile.fromCache);
        }
        if (profile.company && !lead.company && !resolved.company) {
          resolved.company = profile.company;
          meta.company = makeApiMeta('unipile', 'company', profile.fromCache);
        }
      }
    } catch (err) {
      console.warn(`${logTag} step 3.5 findUnipileProfileByUrl failed:`, (err as Error).message);
    }
  }

  // 3.6. If a company was resolved above (step 3.5 Unipile or Apollo) but the
  // lead still has no email domain, resolve the company's website/domain now —
  // the SAME web-search lookup Tier 0.5 does. Tier 0.5 already ran (step 2.5),
  // before the company was known for a LinkedIn-only lead, so it skipped. Doing
  // it here lets the email finders below (5.5/6.5/7) run in THIS pass; without
  // it the domain is only discovered later in the waterfall, so email
  // resolution would otherwise need a second enrichment run.
  const domainKnown = !!(
    lead.emailDomain || resolved.emailDomain ||
    (rawEmailDomain && hasBusinessEmailDomain) ||
    lead.website || resolved.website
  );
  if (!email && needsPersonFields && resolved.company && !lead.company && !domainKnown) {
    try {
      const dr = await deps.resolveCompanyDomainViaWebSearch({
        company: resolved.company,
        linkedin: lead.linkedin || resolved.linkedin || undefined,
        title: resolved.title || lead.title || undefined,
        firstName: lead.firstName || resolved.firstName || undefined,
        lastName: lead.lastName || resolved.lastName || undefined,
      });
      if (dr?.website) {
        const derived = deriveDomainFromWebsite(dr.website);
        if (derived) {
          if (!lead.website && !resolved.website) {
            resolved.website = dr.website;
            meta.website = { source: 'web_search', provider: 'llm_web_search', enrichedAt: new Date().toISOString() };
          }
          resolved.emailDomain = derived;
          meta.emailDomain = { source: 'web_search', provider: 'llm_web_search', enrichedAt: new Date().toISOString() };
          console.log(`${logTag} step 3.6 domain-from-company website=${dr.website} emailDomain=${derived}`);
        }
      }
    } catch (err) {
      console.warn(`${logTag} step 3.6 resolveCompanyDomainViaWebSearch failed:`, (err as Error).message);
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
        meta.email = makeApiMeta('enrich.so', 'email', false);
        // Chain: reverse-lookup on the resolved email fills company.
        // Names are already known (gate ensures firstName+lastName present).
        try {
          const enrichSo = await deps.enrichSoReverseLookup({ email });
          if (enrichSo?.company && !lead.company && !resolved.company) {
            resolved.company = enrichSo.company;
            meta.company = makeApiMeta('enrich.so', 'company', enrichSo.fromCache);
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
          ...makeApiMeta('apollo', 'email', false),
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
            meta.company = makeApiMeta('enrich.so', 'company', enrichSo.fromCache);
          }
          if (enrichSo.firstName && !lead.firstName && !resolved.firstName) {
            resolved.firstName = enrichSo.firstName;
            meta.firstName = makeApiMeta('enrich.so', 'firstName', enrichSo.fromCache);
          }
          if (enrichSo.lastName && !lead.lastName && !resolved.lastName) {
            resolved.lastName = enrichSo.lastName;
            meta.lastName = makeApiMeta('enrich.so', 'lastName', enrichSo.fromCache);
          }
        }
      } catch (err) {
        console.warn(`${logTag} step 6 enrichSoReverseLookup failed:`, (err as Error).message);
      }
    }
  }

  // 6.9. Taint pass — when the entire identity was anchored on a name-only
  // list-context LinkedIn guess, downgrade EVERY resolved field's confidence
  // to 'low' so a wrong-person match can't surface a trustworthy-looking email
  // or company. The guessed linkedin URL seeds Apollo/enrich.so, which stamp
  // their own 'medium'/'high' confidence; this overrides that because those
  // values are only as reliable as the disambiguation that produced the URL.
  if (identityFromContextGuess) {
    for (const key of Object.keys(meta)) {
      if (meta[key].confidence !== 'low') {
        meta[key] = {
          ...meta[key],
          confidence: 'low',
          sourceQuote: meta[key].sourceQuote
            || `Derived from a list-context LinkedIn match — verify before outreach.`,
        };
      }
    }
  }

  // 7. Persist newly-resolved attributes ONLY in enrich mode. Runs BEFORE the
  // completeness gate so that partial signals (linkedin, title, website from
  // Tier 0.5) are written to the lead even when we can't resolve company —
  // preventing data loss for skipped leads.
  const writableFields: Record<string, string> = {};
  for (const [key, value] of Object.entries(resolved)) {
    // emailDomain is normally derived locally from email and not worth
    // persisting on its own. Exception: when Tier 0.5 derived it from a
    // web-search-resolved website, the lead has no email to re-derive
    // from on the next run — persist it so the value is not lost.
    if (key === 'emailDomain' && !meta.emailDomain) continue;
    // Fields the user deselected in the enrichment config are resolved
    // in-memory (used as matching signals above) but never persisted —
    // otherwise "LinkedIn only" would still write the company discovered
    // while resolving the LinkedIn URL.
    if (input.excludePersistFields?.has(key)) continue;
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

  // 8. Completeness gate — checked after partial writes so resolved fields
  // (linkedin, title, website) are never discarded even when gate fires.
  if (needsPersonFields) {
    const personOk = (lead.firstName || resolved.firstName) &&
                     (lead.lastName  || resolved.lastName);
    if (!personOk) return { ok: false, reason: 'identity_unresolvable' };
  }
  if (needsCompanyFields) {
    // Business email domain OR a LinkedIn URL is sufficient — the T2/T5 waterfall
    // tiers can discover company from either. A domain feeds Apollo org match /
    // Unipile company search; a LinkedIn URL feeds Tier 5 findUnipileCompany,
    // which resolves company directly from lead.linkedin via Unipile getProfile
    // (no company name or domain needed). Only block when we have none of
    // company name, a resolvable domain, or a LinkedIn URL.
    const hasLinkedin = !!(linkedinUrl || resolved.linkedin);
    const companyOk = lead.company || resolved.company || hasBusinessEmailDomain || hasLinkedin;
    if (!companyOk) return { ok: false, reason: 'identity_unresolvable' };
  }

  return { ok: true, resolved, siblings: validSiblings, emailPattern, fromContextGuess: identityFromContextGuess };
}
