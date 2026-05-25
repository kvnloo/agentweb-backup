// Real-service adapters that satisfy the v3.1 orchestrator deps
// (OrchestratorDeps + IdentityResolverDeps).
//
// Wires the orchestrator and waterfall to production services: Apollo
// (people / org), enrich.so, Unipile, Google CSE web search + LLM extraction,
// the critic pass, and DynamoDB read/write via crmDb. All external dependency
// construction lives here so the orchestrator and waterfall stay pure and
// unit-testable.

import { crmDb } from './db';
import { getApolloService, isApolloServiceReady } from './apolloService';
import { getEnrichSoService } from './enrichSoService';
import type { MappedPerson, MappedOrganization } from './apolloFieldMapper';
import type { OrchestratorDeps } from './crmEnrichmentServiceV3';
import { CrmEnrichmentService, type LeadRecord } from './crmEnrichmentService';
import { sanitizePhone } from '../utils/phoneValidation';
import type { IdentityResolverDeps } from './enrichmentIdentityResolver';
import { resolveIdentity as pureResolveIdentity } from './enrichmentIdentityResolver';
import { runWaterfall as pureRunWaterfall, type LLMFilledValue } from './enrichmentGroupWaterfall';
import { apolloAsyncRequestCacheKey, APOLLO_SCHEMA_VERSION } from './apolloCacheKeys';
import { FIELD_GROUPS } from './enrichmentGroups';
import { trimQuote } from '../utils/enrichedFieldValue';
import { waitForApolloAsyncResult } from './enrichmentWaterfall';
import { STANDARD_ENRICHABLE_FIELDS } from './enrichmentConfigService';
import {
  getRawDataFromCache,
  writeRawDataToCache,
  buildWebContextFromCache,
} from './enrichmentCacheService';
import { fetchTopPages } from './webContentFetcher';
import { agentModeService } from './agentModeService';
import { createLLMService } from '../utils/llmService';
import { getUnipileCompanyService } from './unipileCompanyServiceFactory';
import { getUnipileProfileService } from './unipileProfileServiceFactory';
import { extractCompanyIdentifierFromInput } from './unipileCompanyCacheKeys';

// Models — match what v2 enrichment uses (gpt-5-chat-2 via Azure OpenAI; see
// `crmEnrichmentService.ts:260-261`). Overridable via env for cost tuning.
const EXTRACT_MODEL      = process.env.CRM_ENRICH_V3_EXTRACT_MODEL      || 'gpt-5-chat-2';
const CRITIC_MODEL       = process.env.CRM_ENRICH_V3_CRITIC_MODEL       || 'gpt-5-chat-2';
// Model used for Tier 4 web extraction — must support web search tool.
// Set to a Gemini model (e.g. "gemini-2.0-flash") for Google Search grounding,
// or an Azure deployment of gpt-4o-search-preview for OpenAI web_search_preview.
const WEB_SEARCH_MODEL   = process.env.CRM_ENRICH_V3_WEB_SEARCH_MODEL   || EXTRACT_MODEL;

// ─── Identity resolver deps ───────────────────────────────────────────────────

export function buildIdentityDeps(userId: string): IdentityResolverDeps {
  return {
    apolloPeopleMatch: async ({ email, linkedinUrl, firstName, lastName, domain, company }) => {
      if (!isApolloServiceReady()) return null;
      if (!email && !linkedinUrl && !firstName && !lastName) return null;
      // Personal emails are allowed — Apollo can still return person+org data.
      // Domain filtering is handled upstream (domainForApollo strips freemail domains).
      try {
        const apollo = getApolloService();
        const input: Parameters<typeof apollo.matchPerson>[0] = {};
        if (email) input.email = email;
        if (linkedinUrl) input.linkedinUrl = linkedinUrl;
        if (firstName) input.firstName = firstName;
        if (lastName) input.lastName = lastName;
        if (domain) input.domain = domain;
        else if (company) input.organizationName = company;
        const result = await apollo.matchPerson(input);
        const p = result?.match?.person;
        if (!p) return null;
        const org = result?.match?.organization;
        // Fall back to current employment entry when top-level org is absent.
        // Apollo sometimes omits the organization object for personal-email matches
        // but still populates employment_history with the current employer.
        const currentJob = p.employmentHistory?.find(e => e.current);
        return {
          firstName: p.firstName,
          lastName: p.lastName,
          title: p.title ?? currentJob?.title,
          linkedin: p.linkedin,
          email: p.email,
          emailStatus: p.emailStatus,
          company: org?.name ?? currentJob?.organizationName ?? undefined,
          website: org?.websiteUrl ?? undefined,
          city: p.city,
          state: p.state,
          country: p.country,
        };
      } catch (err) {
        console.warn('[v3 deps] apolloPeopleMatch failed:', (err as Error).message);
        return null;
      }
    },

    findSiblingLeads: async ({ excludeLeadId, email, linkedinUrl, firstName, lastName, company }) => {
      // Query all three Lookup GSIs in parallel. Email and linkedin can each
      // miss; both are cheap (single GSI Query per key). Combining the result
      // sets lets per-field best-of-N merge pick complementary data across
      // siblings that only matched one key.
      const trimmedEmail = email?.trim().toLowerCase();
      const trimmedLinkedin = linkedinUrl?.trim();
      const hasNameTriple = !!(firstName && lastName && company);

      const [byEmail, byLinkedin, byNameCompany] = await Promise.all([
        trimmedEmail ? crmDb.findLeadsByEmail(trimmedEmail) : Promise.resolve([]),
        trimmedLinkedin ? crmDb.findLeadsByLinkedin(trimmedLinkedin) : Promise.resolve([]),
        hasNameTriple ? crmDb.findLeadsByNameCompany(firstName!, lastName!, company!) : Promise.resolve([]),
      ]);

      // Dedupe by leadId (a sibling can match both email AND linkedin), then
      // sort freshest-first so the resolver's per-field walk picks the most
      // recent non-empty value per field. Cap at 30 candidates to bound work
      // when an email is unusually shared across many tenants.
      const seen = new Set<string>();
      const merged: any[] = [];
      for (const set of [byEmail, byLinkedin, byNameCompany]) {
        for (const item of (set || [])) {
          if (!item || !item.leadId || item.leadId === excludeLeadId) continue;
          if (seen.has(item.leadId)) continue;
          seen.add(item.leadId);
          merged.push(item);
        }
      }
      merged.sort((a, b) => {
        const ua = typeof a.updatedAt === 'string' ? a.updatedAt : '';
        const ub = typeof b.updatedAt === 'string' ? b.updatedAt : '';
        if (ua === ub) return 0;
        return ua > ub ? -1 : 1;
      });
      return merged.slice(0, 30);
    },

    enrichSoReverseLookup: async ({ email }) => {
      try {
        const enrichSo = getEnrichSoService();
        const result = await enrichSo.reverseLookup(email);
        if (!result?.found) return null;
        return {
          firstName: result.firstName,
          lastName: result.lastName,
          company: result.companyName,
        };
      } catch (err) {
        console.warn('[v3 deps] enrichSoReverseLookup failed:', (err as Error).message);
        return null;
      }
    },

    enrichSoFindEmail: async ({ firstName, lastName, domain }) => {
      if (CrmEnrichmentService.isPersonalEmailDomain(`x@${domain}`)) return null;
      try {
        const enrichSo = getEnrichSoService();
        const result = await enrichSo.findEmail({ firstName, lastName, domain });
        if (!result?.found || !result.email) return null;
        return { email: result.email };
      } catch (err) {
        console.warn('[v3 deps] enrichSoFindEmail failed:', (err as Error).message);
        return null;
      }
    },

    findLinkedInUrl: ({ firstName, lastName, company }) =>
      findLinkedInUrlImpl(userId, firstName, lastName, company),

    resolveCompanyDomainViaWebSearch: async ({ company, domain, linkedin, title, firstName, lastName }) => {
      try {
        const llm = createLLMService(WEB_SEARCH_MODEL, 0.2);
        const systemPrompt =
          'You are a company researcher. Given information about a person or company, find the official company website and company name.\n\n' +
          'LOOKUP PRIORITY (follow in order):\n' +
          '1. Search the web — prefer confirmed, live results.\n' +
          '2. Use your own knowledge only if web search returns nothing useful.\n' +
          '3. If neither source gives a confident answer, return null for that field.\n\n' +
          'STRICT RULES:\n' +
          '- Do NOT fabricate, guess, or construct any answer.\n' +
          '- Do NOT infer a website from a company name pattern (e.g. acme.com from "Acme Inc") without confirmation.\n' +
          '- If uncertain, set the field to null — empty is better than wrong.\n\n' +
          'Return JSON with keys:\n' +
          '"website" (full URL, e.g. "https://acme.com" — null if not confirmed),\n' +
          '"company" (official company name — null if not confirmed),\n' +
          '"searchedDomain" (exact domain you confirmed, e.g. "acme.com" — include ONLY when an email domain was provided as input, otherwise omit).\n' +
          'Return ONLY valid JSON, no explanation.';
        const parts: string[] = [];
        if (company) parts.push(`Company name: ${company}`);
        if (domain) parts.push(`Email domain: ${domain}`);
        if (firstName || lastName) parts.push(`Contact name: ${[firstName, lastName].filter(Boolean).join(' ')}`);
        if (title) parts.push(`Contact title: ${title}`);
        if (linkedin) parts.push(`Contact LinkedIn: ${linkedin}`);
        parts.push('Find the official company website and company name.');
        const userPrompt = parts.join('\n');
        const result = await llm.generateJSONContentWithWebSearch<{ website: string | null; company?: string | null; searchedDomain?: string | null }>(
          systemPrompt,
          userPrompt,
        );
        const website = typeof result?.website === 'string' ? result.website.trim() : undefined;
        const companyName = typeof result?.company === 'string' ? result.company.trim() : undefined;
        const searchedDomain = typeof result?.searchedDomain === 'string' ? result.searchedDomain.trim() : undefined;
        if (!website && !companyName) return null;
        return { website, company: companyName, searchedDomain };
      } catch (err) {
        console.warn('[v3 deps] resolveCompanyDomainViaWebSearch failed:', (err as Error).message);
        return null;
      }
    },

    apolloBrokerChain: async (input, leadHint) => {
      if (!isApolloServiceReady()) return null;
      if (input.domain && CrmEnrichmentService.isPersonalEmailDomain(`x@${input.domain}`)) return null;
      try {
        const apollo = getApolloService();
        const f = await apollo.findEmail(
          {
            firstName: input.firstName,
            lastName: input.lastName,
            domain: input.domain,
            company: input.domain ? undefined : input.company,
            linkedinUrl: input.linkedinUrl,
            linkedToEmail: input.linkedToEmail,
          },
          { userId, runWaterfall: true, leadHint },
        );
        if (f.found && f.email) {
          return { email: f.email, emailStatus: f.emailStatus };
        }
        if (f.asyncPending && f.asyncRequestId) {
          const key = apolloAsyncRequestCacheKey({ requestId: f.asyncRequestId });
          if (key) {
            const ttl = 7 * 86400;
            await crmDb.putEnrichmentCacheItem({
              canonicalId: key.canonicalId,
              fieldGroup: key.sk,
              canonicalKey: key.canonicalKey,
              entityKey: key.entityKey,
              entityType: 'apollo',
              rawData: {
                listId: leadHint.listId,
                leadId: leadHint.leadId,
                userId,
                status: 'pending',
                firstName: input.firstName,
                lastName: input.lastName,
                domain: input.domain ?? null,
              },
              queryUsed: '',
              sourcesUsed: ['apollo'],
              resultCount: 0,
              schemaVersion: APOLLO_SCHEMA_VERSION,
              fetchedAt: new Date().toISOString(),
              expiresAt: Math.floor(Date.now() / 1000) + ttl,
              cacheType: 'apollo',
            });
          }
          // Poll the placeholder row for the webhook result — shared logic
          // with the Tier 3 waterfall path. 30s budget: the identity path
          // waits less than the waterfall's configurable 90s default.
          const polled = await waitForApolloAsyncResult(f.asyncRequestId, 30_000);
          if (polled?.email) {
            return { email: polled.email, emailStatus: polled.emailStatus };
          }
        }
        return null;
      } catch (err) {
        console.warn('[v3 deps] apolloBrokerChain failed:', (err as Error).message);
        return null;
      }
    },

    findEmailViaPatterns: async ({ firstName, lastName, domain }) => {
      if (CrmEnrichmentService.isPersonalEmailDomain(`x@${domain}`)) return null;
      try {
        const { findEmailViaPatterns: patternFinder } = await import('./emailPatternFinder');
        const result = await patternFinder(firstName, lastName, domain, { userId });
        if (!result.found || !result.email) return null;
        return { email: result.email, pattern: result.pattern };
      } catch (err) {
        console.warn('[v3 deps] findEmailViaPatterns failed:', (err as Error).message);
        return null;
      }
    },

    writeLeadFields: async ({ listId, leadId, fields, meta }) => {
      // Split by destination: standard lead columns go to top-level (where
      // the lead table reads them); custom names go to customFields.
      // Matches STANDARD_LEAD_COLUMNS in crmEnrichmentServiceV3.ts.
      const STANDARD = new Set<string>(STANDARD_ENRICHABLE_FIELDS);
      const topLevel: Record<string, string> = {};
      const customFields: Record<string, string> = {};
      const removeCustomFieldKeys: string[] = [];
      for (const [k, v] of Object.entries(fields)) {
        if (STANDARD.has(k)) {
          topLevel[k] = v;
          // Clean up any stale customFields.X left over from older code
          // paths that wrote standard names there.
          removeCustomFieldKeys.push(k);
        } else {
          customFields[k] = v;
        }
      }
      await crmDb.setLeadFields(listId, leadId, {
        topLevel: Object.keys(topLevel).length > 0 ? topLevel : undefined,
        customFields: Object.keys(customFields).length > 0 ? customFields : undefined,
        removeCustomFieldKeys: removeCustomFieldKeys.length > 0 ? removeCustomFieldKeys : undefined,
        enrichmentMetadata: meta,
        // Identity resolver only writes fields the lead is missing (filtered
        // app-side in resolveIdentity), so we don't need DDB's if_not_exists
        // guard — and using it would skip writes when the lead has a "" empty
        // string for the column (DDB treats "" as "attribute exists").
        ifNotExists: false,
      });
    },
  };
}

// ─── Apollo→CRM field-name mapping for waterfall tiers ────────────────────────
// Translates apolloFieldMapper's camelCase shape into the snake_case CRM field
// names declared in FIELD_GROUPS (see APOLLO_GROUP_COVERAGE).

// Note: `org` is ALREADY a MappedOrganization from `apolloService.matchOrg`,
// no need to re-map. Function name kept for clarity at call site.
export function mapApolloOrgToCrmFields(m: MappedOrganization): Record<string, string> {
  const out: Record<string, string> = {};
  if (m.name) out.company_name = m.name;
  if (m.websiteUrl) out.website = m.websiteUrl;
  if (m.industry) out.industry = m.industry;
  if (m.estimatedNumEmployees != null) out.employee_count = String(m.estimatedNumEmployees);
  if (m.foundedYear != null) out.founded_year = String(m.foundedYear);
  if (m.shortDescription) out.company_description = m.shortDescription;
  if (m.linkedinUrl) out.company_linkedin_url = m.linkedinUrl;
  if (m.annualRevenuePrinted) out.revenue_range = m.annualRevenuePrinted;
  if (m.latestFundingStage) out.funding_stage = m.latestFundingStage;
  if (m.totalFunding != null) out.total_funding = String(m.totalFunding);
  if (m.latestFundingRoundDate) out.last_funding_date = m.latestFundingRoundDate;
  if (m.techStack && m.techStack.length) out.tech_stack = m.techStack.join(', ');
  if (m.hqCountry) out.country = m.hqCountry;
  if (m.hqState) out.region = m.hqState;
  if (m.hqCity || m.hqState || m.hqCountry) {
    const loc = [m.hqCity, m.hqState, m.hqCountry].filter(Boolean).join(', ');
    if (loc) out.hq_location = loc;
  }
  if (m.hqRawAddress) out.hq_address = m.hqRawAddress;
  if (m.phone) { const p = sanitizePhone(m.phone); if (p) out.company_phone = p; }
  if (m.twitterUrl) {
    const handle = m.twitterUrl.replace(/\/$/, '').split('/').pop();
    if (handle) out.twitter_handle = handle;
  }
  return out;
}

export function mapApolloPersonToCrmFields(p: MappedPerson): Record<string, string> {
  const out: Record<string, string> = {};
  if (p.firstName) out.first_name = p.firstName;
  if (p.lastName) out.last_name = p.lastName;
  if (p.title) out.title = p.title;
  if (p.linkedin) out.linkedin_url = p.linkedin;
  if (p.email) out.email = p.email;
  if (p.phone) { const ph = sanitizePhone(p.phone); if (ph) out.phone = ph; }
  if (p.seniority) out.seniority = p.seniority;
  if (p.departments && p.departments.length) out.department = p.departments[0];
  // Compose location from city / state / country — Apollo returns these
  // separately but the canonical `location` field is a single string.
  const loc = [p.city, p.state, p.country].filter(Boolean).join(', ');
  if (loc) out.location = loc;
  return out;
}

// ─── Web fetch (Tier 4) — cache-first, Google CSE + page extraction ───────────

async function fetchWebForGroupReal(
  lead: LeadRecord,
  groupName: string,
): Promise<{ webContext: string } | null> {
  const groupCfg = FIELD_GROUPS[groupName];
  if (!groupCfg) return null;

  // 1. Cache check (shared across leads at the same canonical entity)
  try {
    const cached = await getRawDataFromCache(lead as any, groupName, false);
    if (cached) {
      const ctx = buildWebContextFromCache(cached, false);
      if (ctx) return { webContext: ctx };
    }
  } catch (err) {
    console.warn('[v3 deps] cache read failed:', (err as Error).message);
  }

  // 2. Build query from the group's searchTemplate
  const query = CrmEnrichmentService.applySearchTemplate(groupCfg.searchTemplate, lead);
  if (!query || query === groupCfg.searchTemplate.replace(/\{\{[^}]+\}\}/g, '').trim().replace(/\s+/g, ' ')) {
    // No lead-specific signal — skip rather than fetch generic top hits
    return null;
  }

  // 3. Google CSE
  let webResults: any[] = [];
  try {
    const search = await agentModeService.searchWeb(query, 10);
    if (search?.success && Array.isArray(search.results)) {
      webResults = search.results;
    }
  } catch (err) {
    console.warn('[v3 deps] searchWeb failed:', (err as Error).message);
    return null;
  }
  if (webResults.length === 0) return null;

  // 4. Top-2 page fetch for richer context
  const urls = webResults.map((r: any) => r.url || r.link).filter(Boolean);
  let pages: Awaited<ReturnType<typeof fetchTopPages>> = [];
  try {
    pages = await fetchTopPages(urls, 2);
  } catch (err) {
    console.warn('[v3 deps] page fetch failed:', (err as Error).message);
  }

  // 5. Cache + return
  const rawData = {
    webResults: webResults.map((r: any) => ({
      title: String(r.title ?? ''),
      url: String(r.url ?? r.link ?? ''),
      snippet: String(r.snippet ?? r.description ?? ''),
      publishedDate: String(r.publishedDate ?? r.publishedAt ?? ''),
      thumbnail: r.thumbnail ?? null,
    })),
    linkedinCompanyResults: null,
    linkedinData: null,
  };
  try {
    await writeRawDataToCache(lead as any, groupName, rawData, query, ['web_search']);
  } catch (err) {
    console.warn('[v3 deps] cache write failed:', (err as Error).message);
  }

  // Build context = SERP + page bodies (truncated)
  let webContext = JSON.stringify(rawData.webResults, null, 2);
  if (pages.length > 0) {
    const pageText = pages
      .map(p => `--- ${p.title}\n${p.url}\n${p.text.slice(0, 4000)}`)
      .join('\n\n');
    webContext += '\n\nPage contents:\n' + pageText;
  }
  return { webContext };
}

// ─── LLM extraction (Tier 3 over Apollo / Tier 4 over web) ────────────────────

export function buildFieldGuidanceV3(fields: string[], configFieldsByName: Record<string, { instruction?: string } | undefined>): string {
  return fields.map(name => {
    const fl = name.toLowerCase();
    const instr = configFieldsByName[name]?.instruction || '';
    let guidance: string;
    if (/company_linkedin|company.*linkedin|linkedin.*company/.test(fl)) {
      guidance = `ONLY copy a LinkedIn company page URL that appears verbatim in the source data above. The URL must start with "https://www.linkedin.com/company/". Do NOT construct, guess, or complete a URL. Return null if no exact /company/ URL is present in the data.`;
    } else if (/linkedin/.test(fl)) {
      guidance = `ONLY copy a linkedin.com/in/ URL that appears verbatim in the provided data. Do NOT construct, guess, or complete a URL — even if you think you know the person's LinkedIn handle. Do NOT use /pub/dir/ or /search/ URLs. Return null if no exact /in/ URL is present in the data.`;
    } else if (instr) {
      guidance = instr;
    } else {
      guidance = `Return only what is explicitly stated in the provided data. Return null if not present.`;
    }
    return `- ${name}: ${guidance}`;
  }).join('\n');
}

export function rejectHallucinatedLinkedInUrls(
  filled: Record<string, LLMFilledValue>,
  sourceContext: string,
): Record<string, LLMFilledValue> {
  const normalizedSource = sourceContext.toLowerCase().replace(/\s+/g, ' ').trim();
  const result: Record<string, LLMFilledValue> = {};
  for (const [field, entry] of Object.entries(filled)) {
    if (/linkedin/i.test(field)) {
      const slugMatch = entry.value.match(/linkedin\.com\/(in|company)\/([^/?#\s]+)/i);
      if (!slugMatch) {
        console.warn(`[v3 deps] Rejected LinkedIn URL "${entry.value}" for field "${field}" — no valid /in/ or /company/ path`);
        continue;
      }
      const slug = slugMatch[2].toLowerCase();
      if (!normalizedSource.includes(slug)) {
        console.warn(`[v3 deps] Rejected hallucinated LinkedIn URL "${entry.value}" for field "${field}" — slug "${slug}" not in source data`);
        continue;
      }
    }
    result[field] = entry;
  }
  return result;
}

async function extractFieldsViaLLMReal(input: {
  tier: 'apollo' | 'web';
  sourceContext: string;
  fields: string[];
  groupName: string;
  lead: LeadRecord;
  configFieldsByName: Record<string, { instruction?: string } | undefined>;
}): Promise<{ filled: Record<string, LLMFilledValue>; missing: string[] }> {
  if (input.fields.length === 0) return { filled: {}, missing: [] };

  const fieldGuide = buildFieldGuidanceV3(input.fields, input.configFieldsByName);

  const leadContext = JSON.stringify({
    email: input.lead.email,
    company: input.lead.company,
    website: input.lead.website,
    firstName: input.lead.firstName,
    lastName: input.lead.lastName,
  });

  const isWebTier = input.tier === 'web';

  // Web tier asks for per-field provenance objects so the value carries the
  // sourceUrl / sourceQuote the critic and provenance UI need. Apollo tier
  // keeps the bare-string prompt (Apollo JSON has no URLs) and the bare result
  // is normalized into the unified {value} shape below.
  const systemPrompt = isWebTier
    ? `You extract structured CRM data for a given lead. Follow this priority order:\n` +
      `1. Extract from the provided web context if the information is clearly present.\n` +
      `2. If information is missing or insufficient, use your web search capability to look it up.\n` +
      `3. If web search yields no result, use your own training knowledge if you are FULLY confident.\n` +
      `4. If you do not know a value with confidence, return null for that field.\n` +
      `NEVER guess, infer, or fabricate. For each field return an object ` +
      `{"value": <string>, "sourceUrl": <url or null>, "sourceQuote": <short verbatim snippet or null>}. ` +
      `Return strict JSON only, no markdown.`
    : `You extract structured CRM data from the provided context. Return strict JSON: ` +
      `an object with one key per requested field. Use null when the value isn't ` +
      `explicitly present. Do NOT infer or fabricate. Strings only, no markdown.`;

  const userPrompt = isWebTier
    ? `Lead: ${leadContext}\n\n` +
      `Source (${input.tier}):\n${input.sourceContext.slice(0, 16000)}\n\n` +
      `Extract these fields (return one JSON object with these exact keys):\n${fieldGuide}\n\n` +
      `Return ONLY a JSON object like ` +
      `{"field_name": {"value": "...", "sourceUrl": "...", "sourceQuote": "..."}, "other_field": null}. No prose.`
    : `Lead: ${leadContext}\n\n` +
      `Source (${input.tier}):\n${input.sourceContext.slice(0, 16000)}\n\n` +
      `Extract these fields (return one JSON object with these exact keys):\n${fieldGuide}\n\n` +
      `Return ONLY a JSON object like {"field_name": "value", "other_field": null}. No prose.`;

  try {
    let parsed: Record<string, any>;
    if (isWebTier) {
      const llm = createLLMService(WEB_SEARCH_MODEL, 0.0);
      parsed = await llm.generateJSONContentWithWebSearch<Record<string, any>>(systemPrompt, userPrompt);
    } else {
      const llm = createLLMService(EXTRACT_MODEL, 0.0);
      parsed = await llm.generateJSONContent<Record<string, any>>(systemPrompt, userPrompt);
    }
    const filled: Record<string, LLMFilledValue> = {};
    const missing: string[] = [];
    for (const field of input.fields) {
      const raw = parsed?.[field];
      // Web tier returns objects; Apollo tier returns bare strings. Normalize
      // both into LLMFilledValue. A web-tier null/empty value → missing.
      let entry: LLMFilledValue | null = null;
      if (raw != null) {
        if (isWebTier && typeof raw === 'object' && !Array.isArray(raw)) {
          const v = raw.value;
          if (v != null && String(v).trim().length > 0 && String(v).toLowerCase() !== 'null') {
            entry = { value: String(v).trim() };
            if (typeof raw.sourceUrl === 'string' && raw.sourceUrl.trim() && raw.sourceUrl.toLowerCase() !== 'null') {
              entry.sourceUrl = raw.sourceUrl.trim();
            }
            if (typeof raw.sourceQuote === 'string' && raw.sourceQuote.trim() && raw.sourceQuote.toLowerCase() !== 'null') {
              entry.sourceQuote = trimQuote(raw.sourceQuote) ?? undefined;
            }
          }
        } else if (!isWebTier && String(raw).trim().length > 0 && String(raw).toLowerCase() !== 'null') {
          entry = { value: String(raw).trim() };
        } else if (isWebTier && String(raw).trim().length > 0 && String(raw).toLowerCase() !== 'null') {
          // LLM returned a bare string for the web tier despite the object-shape
          // instruction — accept the value but flag the lost provenance.
          console.warn(`[v3 deps] web-tier LLM returned bare string for field "${field}" — provenance unavailable`);
          entry = { value: String(raw).trim() };
        }
      }
      if (entry) {
        filled[field] = entry;
      } else {
        missing.push(field);
      }
    }
    const verified = rejectHallucinatedLinkedInUrls(filled, input.sourceContext);
    const verifiedMissing = input.fields.filter(f => !(f in verified));
    return { filled: verified, missing: [...new Set([...missing, ...verifiedMissing])] };
  } catch (err) {
    console.warn('[v3 deps] extractFieldsViaLLM failed:', (err as Error).message);
    return { filled: {}, missing: input.fields };
  }
}

// ─── Critic over web-tier fills ───────────────────────────────────────────────

async function runCriticReal(input: {
  lead: LeadRecord;
  fills: Array<{ field: string; value: string; meta: any }>;
}): Promise<{ verdicts: Record<string, 'supported' | 'partially-supported' | 'unsupported' | 'contradicted'> }> {
  if (input.fills.length === 0) return { verdicts: {} };

  const claims = input.fills.map(f => ({
    field: f.field,
    value: f.value,
    sourceQuote: f.meta?.sourceQuote || '',
    sourceUrl: f.meta?.sourceUrl || '',
  }));

  const systemPrompt =
    `You are a fact-checker for CRM enrichment. Given each claim (field, value, ` +
    `and source quote/URL when available), decide if the claim is "supported", ` +
    `"partially-supported", "unsupported", or "contradicted" by the source. ` +
    `Return strict JSON: an object keyed by field name.`;

  const userPrompt =
    `Lead: ${JSON.stringify({ email: input.lead.email, company: input.lead.company })}\n\n` +
    `Claims to verify:\n${JSON.stringify(claims, null, 2)}\n\n` +
    `Return ONLY JSON like {"field_a": "supported", "field_b": "partially-supported"}.`;

  try {
    const llm = createLLMService(CRITIC_MODEL, 0.0);
    const parsed = await llm.generateJSONContent<Record<string, string>>(systemPrompt, userPrompt);
    const verdicts: Record<string, any> = {};
    for (const claim of claims) {
      const v = parsed?.[claim.field];
      if (v === 'supported' || v === 'partially-supported' || v === 'unsupported' || v === 'contradicted') {
        verdicts[claim.field] = v;
      }
    }
    return { verdicts };
  } catch (err) {
    console.warn('[v3 deps] critic failed:', (err as Error).message);
    return { verdicts: {} };
  }
}

// ─── Shared Unipile LinkedIn lookup ──────────────────────────────────────────

async function findLinkedInUrlImpl(
  userId: string,
  firstName: string | undefined,
  lastName: string | undefined,
  company: string | undefined,
): Promise<string | null> {
  try {
    const { linkedInOutreachService } = await import('./linkedInOutreachService');
    const accountId = await linkedInOutreachService.resolveAccountId(userId);
    if (!accountId) return null;
    const keywords = [firstName, lastName].filter(Boolean).join(' ');
    if (!keywords) return null;
    const result = await linkedInOutreachService.searchPeople(accountId, {
      keywords,
      company: company || undefined,
    });
    const first = result?.items?.[0];
    if (!first?.public_identifier) return null;
    if (!unipileNameMatches(first, firstName, lastName)) return null;
    return `https://www.linkedin.com/in/${first.public_identifier}`;
  } catch (err) {
    console.warn('[v3 deps] findLinkedInUrl failed:', (err as Error).message);
    return null;
  }
}

// ─── Orchestrator deps ────────────────────────────────────────────────────────

/**
 * Verify a Unipile search result item's name matches the lead's name before
 * accepting it as the correct LinkedIn profile. Case-insensitive prefix match
 * on both first and last name — rejects if the result carries name fields that
 * don't match, or if no name info can be parsed (can't verify → reject).
 *
 * Unipile's people-search response typically carries the combined `name`
 * field ("Ayush Jha") rather than separate `first_name` / `last_name`, so we
 * fall back to splitting `name` on whitespace when those split fields are
 * absent.
 */
export function unipileNameMatches(
  item: any,
  leadFirst: string | undefined,
  leadLast: string | undefined,
): boolean {
  let itemFirst = typeof item.first_name === 'string' ? item.first_name.trim().toLowerCase() : null;
  let itemLast  = typeof item.last_name  === 'string' ? item.last_name.trim().toLowerCase()  : null;

  // Fallback: derive first/last from the combined `name` field. Split on
  // whitespace — first token → first name, last token → last name. Handles
  // middle names by ignoring everything between.
  if (itemFirst === null && itemLast === null && typeof item.name === 'string') {
    const tokens = item.name.trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (tokens.length >= 1) itemFirst = tokens[0];
    if (tokens.length >= 2) itemLast = tokens[tokens.length - 1];
  }

  // Can't verify without at least one name field — reject for correctness.
  if (itemFirst === null && itemLast === null) return false;

  const normFirst = (leadFirst ?? '').trim().toLowerCase();
  const normLast  = (leadLast  ?? '').trim().toLowerCase();

  if (itemFirst !== null && normFirst && !itemFirst.startsWith(normFirst) && !normFirst.startsWith(itemFirst)) return false;
  if (itemLast  !== null && normLast  && !itemLast.startsWith(normLast)   && !normLast.startsWith(itemLast))   return false;

  return true;
}

export function buildOrchestratorDeps(userId: string): OrchestratorDeps {
  const identityDeps = buildIdentityDeps(userId);

  return {
    loadLeads: async ({ listId, leadIds }) => {
      // Selection-scoped run (bulk-actions bar) → BatchGetItem on the
      // requested keys, no over-fetch.
      if (leadIds && leadIds.length > 0) {
        const items = await crmDb.batchGetLeads(listId, leadIds);
        return items as LeadRecord[];
      }
      // Whole-list run → page through the Query fully. A single
      // getLeadsByListId call returns at most one ~1MB DDB page; without this
      // loop, lists larger than that page are silently truncated and the
      // remaining leads are never enriched.
      const all: LeadRecord[] = [];
      let startKey: any = undefined;
      do {
        const page = await crmDb.getLeadsByListId(listId, undefined, startKey);
        all.push(...((page?.items ?? []) as LeadRecord[]));
        startKey = page?.lastEvaluatedKey ?? null;
      } while (startKey);
      return all;
    },

    resolveIdentity: (input) => pureResolveIdentity(input, identityDeps),

    runWaterfall: (input) => pureRunWaterfall(input, {
      fetchApolloOrg: async (lead) => {
        if (!isApolloServiceReady()) return null;
        const domain = lead.emailDomain || extractDomain(lead.email) || extractDomain(lead.website);
        if (!domain) return null;
        try {
          const result = await getApolloService().matchOrg(domain);
          if (!result?.organization) return null;
          return {
            mapped: mapApolloOrgToCrmFields(result.organization),
            raw: result.organizationRaw ?? null,
          };
        } catch (err) {
          console.warn('[v3 deps] fetchApolloOrg failed:', (err as Error).message);
          throw err;
        }
      },

      fetchApolloPerson: async (lead) => {
        if (!isApolloServiceReady()) return null;
        const domain = extractDomain(lead.website) || lead.emailDomain || extractDomain(lead.email) || null;
        const personalDomain = !!domain && CrmEnrichmentService.isPersonalEmailDomain(`x@${domain}`);
        const hasNameAndDomain = !!(lead.firstName || lead.lastName) && !!domain && !personalDomain;
        if (!lead.email && !hasNameAndDomain) return null;
        try {
          const input = lead.email
            ? { email: lead.email }
            : { firstName: lead.firstName ?? undefined, lastName: lead.lastName ?? undefined, domain: domain! };
          const result = await getApolloService().matchPerson(input);
          if (!result?.match?.person) return null;
          return {
            mapped: mapApolloPersonToCrmFields(result.match.person),
            raw: result.personRaw ?? null,
          };
        } catch (err) {
          console.warn('[v3 deps] fetchApolloPerson failed:', (err as Error).message);
          throw err;
        }
      },

      extractFieldsViaLLM: extractFieldsViaLLMReal,
      fetchWebForGroup: fetchWebForGroupReal,

      findLinkedInUrl: (lead: LeadRecord) =>
        findLinkedInUrlImpl(userId, lead.firstName, lead.lastName, lead.company),

      findUnipileCompany: async (lead: LeadRecord, companyLinkedInUrl?: string): Promise<any | null> => {
        try {
          const { linkedInOutreachService } = await import('./linkedInOutreachService');
          const accountId = await linkedInOutreachService.resolveAccountId(userId);
          if (!accountId) return null;

          let companyIdentifier: string | null = null;

          // Approach 2: company LinkedIn URL → extract identifier directly (1 API call)
          if (companyLinkedInUrl) {
            companyIdentifier = extractCompanyIdentifierFromInput(companyLinkedInUrl);
          }

          // Approach 1: person LinkedIn URL → profile → current work_experience company_id (2 API calls)
          if (!companyIdentifier && lead.linkedin) {
            try {
              const profileResult = await getUnipileProfileService().getProfile(lead.linkedin, accountId);
              if (profileResult?.found && profileResult.rawData?.work_experience) {
                const current = (profileResult.rawData.work_experience as any[]).find((e) => !e.end);
                if (current?.company_id) companyIdentifier = String(current.company_id);
              }
            } catch {
              // Approach 1 failed — continue to Approach 3
            }
          }

          // Approach 3: name + company search → profile → company_id (3 API calls)
          if (!companyIdentifier && lead.firstName && lead.lastName && lead.company) {
            try {
              const searchResult = await linkedInOutreachService.searchPeople(accountId, {
                keywords: `${lead.firstName} ${lead.lastName}`,
                company: lead.company,
              });
              const first = searchResult?.items?.[0];
              if (first?.public_identifier && unipileNameMatches(first, lead.firstName, lead.lastName)) {
                const profileUrl = `https://www.linkedin.com/in/${first.public_identifier}`;
                const profileResult = await getUnipileProfileService().getProfile(profileUrl, accountId);
                if (profileResult?.found && profileResult.rawData?.work_experience) {
                  const current = (profileResult.rawData.work_experience as any[]).find((e) => !e.end);
                  if (current?.company_id) companyIdentifier = String(current.company_id);
                }
              }
            } catch {
              // Approach 3 failed — no identifier resolved
            }
          }

          if (!companyIdentifier) return null;

          const companyResult = await getUnipileCompanyService().getCompany(companyIdentifier, accountId);
          if (!companyResult.found || !companyResult.rawData) return null;
          return companyResult.rawData;
        } catch (err) {
          console.warn('[v3 deps] findUnipileCompany failed:', (err as Error).message);
          return null;
        }
      },

      apolloBrokerChain: async ({ firstName, lastName, emailDomain, company, linkedin }, leadHint) => {
        const result = await identityDeps.apolloBrokerChain(
          { firstName, lastName, domain: emailDomain, company, linkedinUrl: linkedin },
          leadHint,
        );
        if (result?.email) return { email: result.email, emailStatus: result.emailStatus };
        return null;
      },
    }),

    // Ungrouped fields → synthetic web fetch using a generic "{{emailDomain}}"
    // query, then LLM extraction. No canonical group → no cache key → no
    // AW-EnrichmentRawCache reuse (one fetch per lead per run).
    extractUngroupedFieldsViaWeb: async ({ lead, fields, configFieldsByName }) => {
      if (fields.length === 0) {
        return { fields: [], missing: [], tierFills: { crm: 0, apollo: 0, web: 0, missing: 0 } };
      }
      const domain = lead.emailDomain || extractDomain(lead.email) || extractDomain(lead.website);
      if (!domain) {
        return {
          fields: [], missing: fields,
          tierFills: { crm: 0, apollo: 0, web: 0, missing: fields.length },
        };
      }
      // Build search query from field INSTRUCTIONS, not field names — a custom
      // field called "stag" is meaningless to Google, but its instruction
      // ("most recent funding stage") is a usable query.
      const queryParts = fields.slice(0, 3).map(f => {
        const instr = configFieldsByName[f]?.instruction?.trim();
        return instr ? instr.split(/\s+/).slice(0, 6).join(' ') : f;
      });
      const query = `${domain} ${queryParts.join(' ')}`;
      let webContext = '';
      try {
        const search = await agentModeService.searchWeb(query, 5);
        if (search?.success && Array.isArray(search.results)) {
          webContext = JSON.stringify(search.results.slice(0, 5), null, 2);
        }
      } catch (err) {
        console.warn('[v3 deps] ungrouped searchWeb failed:', (err as Error).message);
      }
      if (!webContext) {
        return {
          fields: [], missing: fields,
          tierFills: { crm: 0, apollo: 0, web: 0, missing: fields.length },
        };
      }
      const llmResult = await extractFieldsViaLLMReal({
        tier: 'web', sourceContext: webContext, fields, groupName: '__ungrouped__',
        lead, configFieldsByName,
      });
      const filled: any[] = [];
      for (const field of fields) {
        const entry = llmResult.filled[field];
        if (entry && typeof entry.value === 'string' && entry.value.length > 0) {
          filled.push({
            field,
            value: entry.value,
            meta: {
              source: 'web_search',
              provider: 'llm_web_search',
              confidence: 'medium',
              ...(entry.sourceUrl ? { sourceUrl: entry.sourceUrl } : {}),
              ...(entry.sourceQuote ? { sourceQuote: entry.sourceQuote } : {}),
              enrichedAt: new Date().toISOString(),
            },
          });
        }
      }
      return {
        fields: filled,
        missing: llmResult.missing,
        tierFills: { crm: 0, apollo: 0, web: filled.length, missing: llmResult.missing.length },
      };
    },

    evaluateSmartField: async ({ fieldName, condition, depValues }) => {
      const {
        buildSmartFieldEvalSystemPrompt,
        buildSmartFieldEvalUserPrompt,
      } = await import('./enrichmentPrompts');
      try {
        const llm = createLLMService(EXTRACT_MODEL, 0.0);
        const result = await llm.generateJSONContent<{ value: string | null; reasoning: string }>(
          buildSmartFieldEvalSystemPrompt(),
          buildSmartFieldEvalUserPrompt(fieldName, condition, depValues),
        );
        return {
          value: result?.value != null ? String(result.value) : null,
          reasoning: result?.reasoning ?? '',
          model: EXTRACT_MODEL,
        };
      } catch (err) {
        console.warn('[v3 deps] evaluateSmartField failed:', (err as Error).message);
        return { value: null, reasoning: '' };
      }
    },

    runCriticOverWebFills: runCriticReal,

    setLeadFields: async ({ listId, leadId, topLevel, customFields, enrichmentMetadata, ifNotExists }) => {
      // When writing to topLevel, also clear stale customFields[name] entries
      // left over from when older code wrote standard names there.
      const removeCustomFieldKeys = topLevel ? Object.keys(topLevel) : [];
      await crmDb.setLeadFields(listId, leadId, {
        topLevel,
        customFields,
        removeCustomFieldKeys: removeCustomFieldKeys.length > 0 ? removeCustomFieldKeys : undefined,
        enrichmentMetadata,
        ifNotExists,
      });
    },
  };
}

function extractDomain(input: string | undefined): string | null {
  if (!input) return null;
  const atIdx = input.indexOf('@');
  const tail = atIdx >= 0 ? input.slice(atIdx + 1) : input;
  const stripped = tail.replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0];
  return stripped || null;
}
