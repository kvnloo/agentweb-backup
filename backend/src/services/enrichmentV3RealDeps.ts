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
import { nameTokensMatch } from '../utils/nameMatch';
import type { IdentityResolverDeps } from './enrichmentIdentityResolver';
import { resolveIdentity as pureResolveIdentity } from './enrichmentIdentityResolver';
import { runWaterfall as pureRunWaterfall, type LLMFilledValue, type EnrichSoFetchResult } from './enrichmentGroupWaterfall';
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
import { extractJson } from './util/extractJson';
import { getUnipileCompanyService } from './unipileCompanyServiceFactory';
import { getUnipileProfileService } from './unipileProfileServiceFactory';

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
          fromCache: result.fromCache,
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
          // Raw lead rows already carry enrichmentMetadata (no projection is
          // applied to these GSI queries), so Tier 0b can read each copied
          // field's provenance and re-verify web-sourced copies via the critic.
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
          fromCache: result.fromCache,
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

    findLinkedInUrl: ({ firstName, lastName, company, listContext }) =>
      findLinkedInUrlImpl(userId, firstName, lastName, company, listContext),

    findUnipileProfileByUrl: ({ linkedinUrl }) =>
      findUnipileProfileByUrlImpl(userId, linkedinUrl),

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
          { userId, feature: 'enrichment' },
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
      // `website` is a top-level AW-Leads attribute but not in STANDARD_ENRICHABLE_FIELDS
      // (which is the user-configurable enrichment set). Include it here so the
      // resolver's Tier 0.5 website write lands at item.website, not customFields.website.
      const STANDARD = new Set<string>([...STANDARD_ENRICHABLE_FIELDS, 'website']);
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
  listId?: string,
): Promise<{ webContext: string } | null> {
  const groupCfg = FIELD_GROUPS[groupName];
  if (!groupCfg) return null;
  const wtag = `[v3:${listId ? `${listId}:` : ''}${lead.leadId ?? lead.email ?? '?'}:web:${groupName}]`;

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
    console.log(`${wtag} SKIP no lead-specific signal in query`);
    return null;
  }
  console.log(`${wtag} query="${query.slice(0, 120)}"`);

  // 3. Google CSE — for company_technographic also run a job-postings query
  let webResults: any[] = [];
  try {
    const search = await agentModeService.searchWeb(query, 10);
    if (search?.success && Array.isArray(search.results)) {
      webResults = search.results;
    }
  } catch (err) {
    console.warn(`${wtag} searchWeb ERROR ${(err as Error).message}`);
    return null;
  }

  if (groupName === 'company_technographic') {
    const jobsQuery = CrmEnrichmentService.applySearchTemplate(
      '{{emailDomain}} job posting required tools technologies software',
      lead,
    );
    try {
      const jobsSearch = await agentModeService.searchWeb(jobsQuery, 5);
      if (jobsSearch?.success && Array.isArray(jobsSearch.results)) {
        const existingUrls = new Set(webResults.map((r: any) => r.url || r.link).filter(Boolean));
        for (const r of jobsSearch.results) {
          const key = r.url || r.link;
          if (key && !existingUrls.has(key)) { existingUrls.add(key); webResults.push(r); }
        }
      }
    } catch (err) {
      console.warn(`${wtag} jobsSearch ERROR ${(err as Error).message}`);
    }
  }

  if (webResults.length === 0) {
    console.log(`${wtag} MISS searchWeb returned 0 results`);
    return null;
  }

  // 4. Top-2 page fetch for richer context
  const urls = webResults.map((r: any) => r.url || r.link).filter(Boolean);
  console.log(`${wtag} got ${webResults.length} result(s) top_urls=[${urls.slice(0, 3).map((u: string) => u.slice(0, 80)).join(', ')}]`);
  let pages: Awaited<ReturnType<typeof fetchTopPages>> = [];
  try {
    pages = await fetchTopPages(urls, 2);
  } catch (err) {
    console.warn(`${wtag} page fetch ERROR ${(err as Error).message}`);
  }
  console.log(`${wtag} fetched ${pages.length} page(s)`);

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
    console.warn(`${wtag} cache write ERROR ${(err as Error).message}`);
  }

  // Build context = SERP + page bodies (truncated)
  let webContext = JSON.stringify(rawData.webResults, null, 2);
  if (pages.length > 0) {
    const pageText = pages
      .map(p => `--- ${p.title}\n${p.url}\n${p.text.slice(0, 4000)}`)
      .join('\n\n');
    webContext += '\n\nPage contents:\n' + pageText;
  }
  console.log(`${wtag} context built len=${webContext.length}`);
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
    } else if (name === 'tech_stack') {
      guidance = instr || `Extract all software tools, SaaS products, platforms, and technical services this company uses — including analytics, CMS, marketing automation, cloud infrastructure, payment processors, and other integrations. Look in job postings (required tools), integration/app pages, and tech profile data. Return as a comma-separated list. Return null if nothing found.`;
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
  listId?: string;
}, userId?: string): Promise<{ filled: Record<string, LLMFilledValue>; missing: string[] }> {
  if (input.fields.length === 0) return { filled: {}, missing: [] };
  const ltag = `[v3:${input.listId ? `${input.listId}:` : ''}${input.lead.leadId ?? input.lead.email ?? '?'}:llm:${input.groupName}:${input.tier}]`;
  console.log(`${ltag} START fields=[${input.fields.join(',')}] contextLen=${input.sourceContext.length}`);

  const fieldGuide = buildFieldGuidanceV3(input.fields, input.configFieldsByName);

  const leadContext = JSON.stringify({
    email: input.lead.email,
    firstName: input.lead.firstName,
    lastName: input.lead.lastName,
    title: input.lead.title || undefined,
    company: input.lead.company,
    website: input.lead.website,
    location: input.lead.location || undefined,
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
      `Return strict JSON only, no markdown. If you have no data for any field, return {} — never return explanations or apologies.\n` +
      `IMPORTANT — for linkedin_url: name alone is never sufficient to confirm a match (e.g. "John Smith" is too common). ` +
      `Use ALL available lead signals — email address, email domain, company name, job title, location — to verify the profile belongs to this specific person. ` +
      `The more signals match (domain + title + company), the more confident you can be. ` +
      `Only return a URL when you are confident the profile is the right person; otherwise return null.`
    : `You extract structured CRM data from the provided context. Return strict JSON: ` +
      `an object with one key per requested field. Use null when the value isn't ` +
      `explicitly present. Do NOT infer or fabricate. Strings only, no markdown. ` +
      `If you have no data for any field, return {} — never return explanations or apologies.`;

  const userPrompt = isWebTier
    ? `Lead: ${leadContext}\n\n` +
      `Source (${input.tier}):\n${input.sourceContext.slice(0, 16000)}\n\n` +
      `Extract these fields (return one JSON object with these exact keys):\n${fieldGuide}\n\n` +
      `Return ONLY a JSON object like ` +
      `{"field_name": {"value": "...", "sourceUrl": "...", "sourceQuote": "..."}, "other_field": null}. ` +
      `No prose. If nothing is found, return {}.`
    : `Lead: ${leadContext}\n\n` +
      `Source (${input.tier}):\n${input.sourceContext.slice(0, 16000)}\n\n` +
      `Extract these fields (return one JSON object with these exact keys):\n${fieldGuide}\n\n` +
      `Return ONLY a JSON object like {"field_name": "value", "other_field": null}. No prose. If nothing is found, return {}.`;

  try {
    let parsed: Record<string, any>;
    if (isWebTier) {
      const llm = createLLMService(WEB_SEARCH_MODEL, 0.0);
      parsed = await llm.generateJSONContentWithWebSearch<Record<string, any>>(systemPrompt, userPrompt, { userId, feature: 'enrichment' });
    } else {
      const llm = createLLMService(EXTRACT_MODEL, 0.0);
      parsed = await llm.generateJSONContent<Record<string, any>>(systemPrompt, userPrompt, 'json', undefined, { userId, feature: 'enrichment' });
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
    console.log(`${ltag} DONE filled=[${Object.keys(verified).join(',')}] missing=[${verifiedMissing.join(',')}]`);
    return { filled: verified, missing: [...new Set([...missing, ...verifiedMissing])] };
  } catch (err) {
    console.warn(`${ltag} ERROR ${(err as Error).message}`);
    return { filled: {}, missing: input.fields };
  }
}

// ─── Critic over web-tier fills ───────────────────────────────────────────────

async function runCriticReal(input: {
  lead: LeadRecord;
  fills: Array<{ field: string; value: string; meta: any }>;
}, userId?: string): Promise<{ verdicts: Record<string, 'supported' | 'partially-supported' | 'unsupported' | 'contradicted'> }> {
  if (input.fills.length === 0) return { verdicts: {} };

  const claims = input.fills.map(f => ({
    field: f.field,
    value: f.value,
    sourceQuote: f.meta?.sourceQuote || '',
    sourceUrl: f.meta?.sourceUrl || '',
  }));

  const systemPrompt =
    `You are a fact-checker for CRM enrichment. Each claim has a field, value, and ` +
    `a source quote/URL the value was extracted from. Decide whether the claim is ` +
    `"supported", "partially-supported", "unsupported", or "contradicted" by the source.\n\n` +
    `CRITICAL — entity identity: the claim must describe the SAME company as the lead. ` +
    `Use the lead's company name, website domain, and email domain to judge identity. ` +
    `If the source quote/URL is about a DIFFERENT company — including a similarly-named ` +
    `but distinct one (e.g. "Slash" vs "Slashy", "Stripe" vs "Stripes") — the claim is ` +
    `"contradicted", no matter how clearly the source states the value. Only treat the ` +
    `source as a match when the company name AND/OR domain plausibly refer to the lead's ` +
    `company. When identity is genuinely ambiguous, use "unsupported", not "supported".\n\n` +
    `Return strict JSON: an object keyed by field name with one verdict string per field.`;

  const userPrompt =
    `Lead: ${JSON.stringify({
      email: input.lead.email,
      company: input.lead.company,
      website: input.lead.website,
    })}\n\n` +
    `Claims to verify:\n${JSON.stringify(claims, null, 2)}\n\n` +
    `Return ONLY JSON like {"field_a": "supported", "field_b": "contradicted"}.`;

  try {
    const llm = createLLMService(CRITIC_MODEL, 0.0);
    const parsed = await llm.generateJSONContent<Record<string, string>>(systemPrompt, userPrompt, 'json', undefined, { userId, feature: 'enrichment' });
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

export async function findLinkedInUrlImpl(
  userId: string,
  firstName: string | undefined,
  lastName: string | undefined,
  company: string | undefined,
  listContext?: string,
): Promise<string | null> {
  const { linkedInOutreachService } = await import('./linkedInOutreachService');
  let accountId: string | null = null;
  try {
    accountId = await linkedInOutreachService.resolveAccountIdForEnrichment(userId);
    if (!accountId) return null;
    const name = [firstName, lastName].filter(Boolean).join(' ');
    if (!name) return null;
    // IMPORTANT: keywords stay NAME-ONLY. LinkedIn keyword search matches the
    // FULL profile text, so appending a company or list-context phrase (e.g.
    // "YC Poker Night — YC alumni…") collapses a 10-hit name search to zero.
    // The company filter is sent as the structured `company` param (its own
    // field), and list context is applied AFTER the fetch as a re-ranking
    // signal over the candidates' headline/location/industry — never folded
    // into the query string. (Verified empirically: name → 10 hits,
    // name+context → 0 hits.)
    const ctx = (listContext || '').trim();
    console.log(`[v3 linkedin-search] name="${name}" company="${company ?? '∅'}" context="${ctx || '∅'}"`);
    const result = await linkedInOutreachService.searchPeople(accountId, {
      keywords: name,
      company: company || undefined,
    });
    const candidates = result?.items ?? [];
    console.log(`[v3 linkedin-search] got ${candidates.length} result(s)`);
    // Keep only candidates whose name actually matches the lead — guards the
    // whole selection, not just the first item.
    const nameMatched = candidates.filter((c: any) => unipileNameMatches(c, firstName, lastName));
    if (nameMatched.length === 0) {
      console.log(`[v3 linkedin-search] MISS no name match among ${candidates.length} result(s)`);
      return null;
    }

    let chosen: any;
    if (!company && ctx && nameMatched.length > 1) {
      // Name-only + list-context path with MULTIPLE same-name people: a bare
      // name can return many distinct profiles, so taking candidates[0] would
      // risk attaching the wrong person. Ask a cheap LLM which candidate's
      // profile best fits the list context (e.g. "YC alumni" → "Founder at Y
      // Combinator"). The LLM bridges semantic gaps token overlap can't
      // (YC ↔ Y Combinator) and may answer "none" to refuse a wrong guess.
      const idx = await pickCandidateByContextLLM(ctx, name, nameMatched, userId);
      if (idx == null) {
        console.log(`[v3 linkedin-search] MISS LLM found no confident context match among ${nameMatched.length} same-name candidate(s) for context="${ctx}"`);
        return null;
      }
      chosen = nameMatched[idx];
      console.log(`[v3 linkedin-search] context-picked idx=${idx} headline="${(chosen.headline || '').slice(0, 60)}"`);
    } else {
      // Company-known, no-context, or single-candidate path: take the first
      // name-matched candidate. With company present the structured filter
      // already narrowed server-side; with a single candidate there is nothing
      // to disambiguate.
      chosen = nameMatched[0];
    }

    if (!chosen?.public_identifier) return null;
    console.log(`[v3 linkedin-search] HIT url=https://www.linkedin.com/in/${chosen.public_identifier}`);
    return `https://www.linkedin.com/in/${chosen.public_identifier}`;
  } catch (err) {
    // Any failure after accountId was resolved — purge both caches so next call
    // re-resolves to a live account (covers NOT_FOUND + newly-connected replacements).
    linkedInOutreachService.invalidateResolvedAccount(userId);
    if (accountId) linkedInOutreachService.clearStatusCache(accountId);
    console.warn('[v3 deps] findLinkedInUrl failed:', (err as Error).message);
    return null;
  }
}

/**
 * Identity-resolution Tier 3.5: resolve name/title/company directly from a
 * LinkedIn /in/ URL via Unipile getProfile. Mirrors findUnipilePerson Case A
 * (account resolution + 429 rotation across connected accounts) but is callable
 * from the identity resolver, BEFORE the person-completeness gate — so a
 * LinkedIn-only lead Apollo can't match still gets a name and isn't skipped.
 */
export async function findUnipileProfileByUrlImpl(
  userId: string,
  linkedinUrl: string,
): Promise<{ firstName?: string; lastName?: string; title?: string; company?: string; fromCache?: boolean } | null> {
  if (!linkedinUrl || !linkedinUrl.includes('/in/')) return null;
  const tag = `[v3 deps:findUnipileProfileByUrl]`;
  const { linkedInOutreachService } = await import('./linkedInOutreachService');
  const triedAccounts = new Set<string>();

  for (let attempt = 0; attempt < 3; attempt++) {
    let accountId: string | null = null;
    try {
      accountId = await linkedInOutreachService.resolveAccountIdForEnrichment(
        userId,
        triedAccounts.size > 0 ? triedAccounts : undefined,
      );
      if (!accountId) { console.warn(`${tag} no accountId → skip`); return null; }

      console.log(`${tag} getProfile url=${linkedinUrl}`);
      const profileResult = await getUnipileProfileService().getProfile(linkedinUrl, accountId);
      if (!profileResult?.found || !profileResult.rawData) {
        console.log(`${tag} MISS profile not found`);
        return null;
      }
      const raw = profileResult.rawData;
      const current = (raw.work_experience as any[] | undefined)?.find((e: any) => !e.end);
      const trimStr = (v: unknown): string | undefined => {
        const s = typeof v === 'string' ? v.trim() : '';
        return s || undefined;
      };
      const result = {
        firstName: trimStr(raw.first_name),
        lastName:  trimStr(raw.last_name),
        title:     trimStr(current?.position),
        company:   trimStr(current?.company),
        fromCache: profileResult.fromCache,
      };
      console.log(`${tag} HIT name="${result.firstName ?? '∅'} ${result.lastName ?? '∅'}" title="${result.title ?? '∅'}" company="${result.company ?? '∅'}"`);
      return result;
    } catch (err) {
      if ((err as any)?.structuredError?.classification === 'RATE_LIMIT_ERROR') {
        console.warn(`${tag} 429 on account ${accountId} — rotating (attempt ${attempt + 1}/3)`);
        if (accountId) triedAccounts.add(accountId);
        linkedInOutreachService.invalidateResolvedAccount(userId);
        continue;
      }
      linkedInOutreachService.invalidateResolvedAccount(userId);
      if (accountId) linkedInOutreachService.clearStatusCache(accountId);
      console.warn(`${tag} ERROR ${(err as Error).message}`);
      return null;
    }
  }
  console.warn(`${tag} all accounts rate-limited (tried ${triedAccounts.size})`);
  return null;
}

/** Lowercase + collapse whitespace so evidence corroboration is robust to
 *  spacing/case differences between the LLM's quote and the profile text. */
function normalizeForMatch(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Disambiguate among multiple same-name LinkedIn candidates using the list
 * context. Asks a cheap extraction LLM to pick the 0-based index of the
 * candidate whose profile (headline / location / industry) best fits the
 * context, to rate its own confidence, and to QUOTE the profile snippet that
 * justifies the pick.
 *
 * Three guards before a pick is accepted (defense against wrong-person fills):
 *   1. Index in range and ≥ 0 (LLM may answer -1 to decline).
 *   2. confidence must be 'high' or 'medium' — a 'low' self-rating is refused.
 *   3. `evidence` must be a non-empty substring of the chosen candidate's own
 *      profile text — guards against a hallucinated justification (the LLM
 *      citing "Sequoia" for a profile that never mentions it).
 *
 * Returns the chosen index, or null when any guard fails / the LLM declines /
 * errors — callers treat null as "refuse" so a low-confidence or fabricated
 * guess never attaches the wrong person to a lead.
 *
 * Exported for unit testing.
 */
export async function pickCandidateByContextLLM(
  listContext: string,
  name: string,
  candidates: any[],
  userId: string,
): Promise<number | null> {
  const profileText = (c: any): string =>
    [c?.headline, c?.location, c?.industry]
      .filter((s: unknown): s is string => typeof s === 'string' && s.trim().length > 0)
      .map((s: string) => s.trim())
      .join(' — ');
  try {
    const profiles = candidates
      .map((c: any, i: number) => `${i}: ${profileText(c) || '(no profile details)'}`)
      .join('\n');

    const systemPrompt =
      'You disambiguate between multiple LinkedIn profiles that share the same ' +
      'name. Given a piece of list context describing a group the target person ' +
      'belongs to, pick the ONE candidate profile that best fits that context. ' +
      'Use real-world knowledge to bridge synonyms (e.g. "YC" means "Y ' +
      'Combinator"). Rate your confidence and QUOTE the exact words from the ' +
      'chosen profile that justify the match. If NO candidate is a confident ' +
      'match, use index -1. Respond ONLY with JSON: ' +
      '{"index": <number>, "confidence": "high"|"medium"|"low", "evidence": "<verbatim words copied from the chosen profile>"}.';
    const userPrompt =
      `List context: "${listContext}"\n` +
      `Person name: "${name}"\n\n` +
      `Candidates (index: profile):\n${profiles}\n\n` +
      `Which index best matches? Quote the chosen profile's exact words as evidence. Use index -1 if none confidently match.`;

    const llm = createLLMService(EXTRACT_MODEL, 0.0);
    const parsed = await llm.generateJSONContent<{ index?: number; confidence?: string; evidence?: string }>(
      systemPrompt, userPrompt, 'json', undefined, { userId, feature: 'enrichment' },
    );

    const idx = typeof parsed?.index === 'number' ? parsed.index : Number(parsed?.index);
    if (!Number.isInteger(idx) || idx < 0 || idx >= candidates.length) return null;

    // Guard 2 — confidence threshold. Only 'high'/'medium' accepted.
    const confidence = typeof parsed?.confidence === 'string' ? parsed.confidence.toLowerCase() : '';
    if (confidence !== 'high' && confidence !== 'medium') {
      console.log(`[v3 linkedin-search] context LLM refused: confidence="${confidence || '∅'}"`);
      return null;
    }

    // Guard 3 — evidence must be grounded in the chosen profile's text.
    const evidence = typeof parsed?.evidence === 'string' ? parsed.evidence.trim() : '';
    if (!evidence) {
      console.log('[v3 linkedin-search] context LLM refused: no evidence quoted');
      return null;
    }
    const haystack = normalizeForMatch(profileText(candidates[idx]));
    if (!haystack.includes(normalizeForMatch(evidence))) {
      console.log(`[v3 linkedin-search] context LLM refused: evidence="${evidence}" not found in chosen profile`);
      return null;
    }

    return idx;
  } catch (err) {
    console.warn('[v3 linkedin-search] context LLM pick failed:', (err as Error).message);
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

  // Bidirectional-prefix token comparison shared with the Apollo identity gate.
  return nameTokensMatch(itemFirst, itemLast, leadFirst, leadLast);
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
        const domain = lead.emailDomain || (lead.email ? lead.email.split('@')[1]?.trim() || null : null) || extractDomain(lead.website);
        if (!domain) {
          console.log(`[v3:${lead.leadId ?? lead.email ?? '?'}:apollo:org] SKIP no domain`);
          return null;
        }
        console.log(`[v3:${lead.leadId ?? lead.email ?? '?'}:apollo:org] matchOrg domain=${domain}`);
        try {
          const result = await getApolloService().matchOrg(domain);
          if (!result?.organization) {
            console.log(`[v3:${lead.leadId ?? lead.email ?? '?'}:apollo:org] MISS no organization`);
            return null;
          }
          console.log(`[v3:${lead.leadId ?? lead.email ?? '?'}:apollo:org] HIT name="${result.organization.name}" website="${result.organization.websiteUrl ?? '∅'}"`);
          return {
            mapped: mapApolloOrgToCrmFields(result.organization),
            raw: result.organizationRaw ?? null,
            fromCache: result.fromCache,
          };
        } catch (err) {
          console.warn(`[v3:${lead.leadId ?? lead.email ?? '?'}:apollo:org] ERROR ${(err as Error).message}`);
          throw err;
        }
      },

      fetchApolloPerson: async (lead) => {
        if (!isApolloServiceReady()) return null;
        const domain = extractDomain(lead.website) || lead.emailDomain || extractDomain(lead.email) || null;
        const personalDomain = !!domain && CrmEnrichmentService.isPersonalEmailDomain(`x@${domain}`);
        const hasNameAndDomain = !!(lead.firstName || lead.lastName) && !!domain && !personalDomain;
        if (!lead.email && !hasNameAndDomain) {
          console.log(`[v3:${lead.leadId ?? lead.email ?? '?'}:apollo:person] SKIP no email and no name+domain`);
          return null;
        }
        try {
          // Always pass the lead's name alongside the email. Apollo's cache key
          // prefers email (so this neither changes the key nor costs an extra
          // call), but matchPerson's identity gate needs the lead name to reject
          // a name-fallback match where Apollo echoes the input email onto a
          // DIFFERENT person (prod: joe@us.com → "Awais Haider"). Without the
          // name the gate has nothing to compare and trusts the wrong profile.
          const apolloInput = lead.email
            ? { email: lead.email, firstName: lead.firstName ?? undefined, lastName: lead.lastName ?? undefined }
            : { firstName: lead.firstName ?? undefined, lastName: lead.lastName ?? undefined, domain: domain! };
          console.log(`[v3:${lead.leadId ?? lead.email ?? '?'}:apollo:person] matchPerson input=${JSON.stringify(apolloInput)}`);
          const result = await getApolloService().matchPerson(apolloInput);
          if (!result?.match?.person) {
            console.log(`[v3:${lead.leadId ?? lead.email ?? '?'}:apollo:person] MISS no person`);
            return null;
          }
          const p = result.match.person;
          console.log(`[v3:${lead.leadId ?? lead.email ?? '?'}:apollo:person] HIT name="${p.firstName ?? ''} ${p.lastName ?? ''}" title="${(p as any).title ?? '∅'}" company="${(p as any).organizationName ?? '∅'}"`);
          return {
            mapped: mapApolloPersonToCrmFields(result.match.person),
            raw: result.personRaw ?? null,
            fromCache: result.fromCache,
          };
        } catch (err) {
          console.warn(`[v3:${lead.leadId ?? lead.email ?? '?'}:apollo:person] ERROR ${(err as Error).message}`);
          throw err;
        }
      },

      extractFieldsViaLLM: (input) => extractFieldsViaLLMReal(input, userId),
      fetchWebForGroup: fetchWebForGroupReal,

      // Tier 3.5b: person enrichment via Unipile.
      // Case A: lead.linkedin present → getProfile → extract name/title directly.
      // Case B: no lead.linkedin, have name → searchPeople (5 candidates) → LLM picks
      //         best match and extracts title from headline.
      findUnipilePerson: async (lead: LeadRecord) => {
        const tag = `[v3:${lead.leadId ?? lead.email ?? '?'}:unipile:person]`;
        const { linkedInOutreachService } = await import('./linkedInOutreachService');
        const triedAccounts = new Set<string>();

        for (let attempt = 0; attempt < 3; attempt++) {
          let accountId: string | null = null;
          try {
            accountId = await linkedInOutreachService.resolveAccountIdForEnrichment(
              userId,
              triedAccounts.size > 0 ? triedAccounts : undefined,
            );
            if (!accountId) { console.warn(`${tag} no accountId → skip`); return null; }

            // Case A: have linkedin → getProfile (no search needed)
            if (lead.linkedin?.includes('/in/')) {
              console.log(`${tag} Case A getProfile url=${lead.linkedin}`);
              const profileResult = await getUnipileProfileService().getProfile(lead.linkedin, accountId);
              if (!profileResult?.found || !profileResult.rawData) {
                console.log(`${tag} Case A MISS profile not found`);
                return null;
              }
              const raw = profileResult.rawData;
              const current = (raw.work_experience as any[] | undefined)?.find((e: any) => !e.end);
              const trimStr = (v: unknown): string | undefined => {
                const s = typeof v === 'string' ? v.trim() : '';
                return s || undefined;
              };
              const profileFirst = trimStr(raw.first_name);
              const profileLast = trimStr(raw.last_name);

              // Identity guard: the lead's stored linkedin URL may be wrong (e.g.
              // copied from a sibling lead or a bad prior enrichment). If the
              // fetched profile's name contradicts the lead's name, the URL points
              // at the wrong person — reject so we don't re-affirm awais-haider
              // onto "Joe Hio". Skip the check only when we have no name on either
              // side to compare (can't verify → no worse than before).
              if ((lead.firstName || lead.lastName) && (profileFirst || profileLast) &&
                  !nameTokensMatch(profileFirst, profileLast, lead.firstName, lead.lastName)) {
                console.log(`${tag} Case A REJECT name mismatch profile="${profileFirst ?? '∅'} ${profileLast ?? '∅'}" lead="${lead.firstName ?? '∅'} ${lead.lastName ?? '∅'}"`);
                return null;
              }

              const result = {
                first_name:   profileFirst,
                last_name:    profileLast,
                linkedin_url: raw.public_identifier ? `https://www.linkedin.com/in/${raw.public_identifier}` : undefined,
                title:        trimStr(current?.position),
                fromCache:    profileResult.fromCache,
              };
              console.log(`${tag} Case A HIT name="${result.first_name ?? '∅'} ${result.last_name ?? '∅'}" title="${result.title ?? '∅'}" company="${current?.company ?? '∅'}"`);
              return result;
            }

            // Case B: no linkedin — search by name, LLM picks from top 5
            if (!lead.firstName || !lead.lastName) {
              console.log(`${tag} Case B SKIP no firstName/lastName`);
              return null;
            }
            if (!lead.company && !lead.title) {
              console.log(`${tag} Case B SKIP no company or title — name-only search too ambiguous`);
              return null;
            }
            // searchPeople resolves company → company_id internally (cached LRU → DynamoDB → Unipile).
            // Pass company and title as separate params; searchPeople handles ID resolution and
            // advanced_keywords fallback. No pre-resolve needed here.
            const nameKeywords = `${lead.firstName} ${lead.lastName}`;
            const searchParams: Parameters<typeof linkedInOutreachService.searchPeople>[1] = {
              keywords: nameKeywords,
              ...(lead.company ? { company: lead.company } : {}),
              ...(!lead.company && lead.title ? { title: lead.title } : {}),
            };
            console.log(`${tag} Case B searchPeople params=${JSON.stringify(searchParams)}`);
            const searchResult = await linkedInOutreachService.searchPeople(accountId, searchParams);
            const candidates = (searchResult?.items ?? []).slice(0, 5);
            console.log(`${tag} Case B got ${candidates.length} candidate(s)`);
            if (candidates.length === 0) return null;

            // LLM picks the best candidate and extracts title + company from headline
            const llm = createLLMService(EXTRACT_MODEL, 0.1);
            const systemPrompt =
              'You are a lead researcher. Given a lead and LinkedIn search candidates, pick the best match and extract their current title and company.\n\n' +
              'RULES:\n' +
              '- Match primarily on first name and last name.\n' +
              '- Ignore professional suffixes (MS, MBA, PhD, II, III, Jr, Sr) when comparing names.\n' +
              '- If the candidate last name is abbreviated to an initial (e.g. "Jason H." for lead lastName="Hurkmans"), treat it as a match if the initial matches.\n' +
              '- The correct person is most likely the first candidate, but verify.\n' +
              '- Parse the headline to extract current title and company (e.g. "CMO at Acme Inc" → title=CMO, company=Acme Inc).\n' +
              '- When multiple candidates match the name, prefer the one whose headline/location aligns with the lead\'s emailDomain, company, title, or location. These fields may be stale (job change, relocation) so treat alignment as a tiebreaker, not a hard requirement.\n' +
              '- If NO candidate name matches the lead name, return null for chosenIndex.\n' +
              '- Return ONLY valid JSON, no explanation.\n\n' +
              'Return: { "chosenIndex": 0-4 or null, "title": string or null, "company_name": string or null, "first_name": string or null, "last_name": string or null }';
            const userPrompt =
              `Lead: firstName="${lead.firstName}" lastName="${lead.lastName}" company="${lead.company ?? ''}" title="${lead.title ?? ''}" emailDomain="${lead.emailDomain ?? ''}" location="${lead.location ?? ''}"\n\n` +
              `Candidates:\n${candidates.map((c: any, i: number) =>
                `[${i}] name="${c.name ?? `${c.first_name ?? ''} ${c.last_name ?? ''}`.trim()}" headline="${c.headline ?? ''}" location="${c.location ?? ''}"`,
              ).join('\n')}`;
            let picked: { chosenIndex: number | null; title: string | null; company_name: string | null; first_name: string | null; last_name: string | null } | null = null;
            try {
              const raw = await llm.generateRaw(systemPrompt, userPrompt, undefined, { userId, feature: 'enrichment' });
              picked = extractJson(raw);
            } catch (err) {
              console.warn(`${tag} Case B LLM parse failed: ${(err as Error).message}`);
              return null;
            }
            if (picked?.chosenIndex == null) {
              console.log(`${tag} Case B LLM chose null — no match`);
              return null;
            }
            const chosen = candidates[picked.chosenIndex];
            if (!chosen?.public_identifier) {
              console.log(`${tag} Case B chosen candidate has no public_identifier`);
              return null;
            }
            const result = {
              first_name:   picked.first_name   ?? (typeof chosen.first_name === 'string' ? chosen.first_name : undefined),
              last_name:    picked.last_name    ?? (typeof chosen.last_name  === 'string' ? chosen.last_name  : undefined),
              linkedin_url: `https://www.linkedin.com/in/${chosen.public_identifier}`,
              title:        picked.title        ?? undefined,
              fromCache:    false,
            };
            console.log(`${tag} Case B HIT candidate[${picked.chosenIndex}] linkedin=${result.linkedin_url} title="${result.title ?? '∅'}" company="${picked.company_name ?? '∅'}"`);
            return result;
          } catch (err) {
            if ((err as any)?.structuredError?.classification === 'RATE_LIMIT_ERROR') {
              console.warn(`${tag} 429 on account ${accountId} — rotating (attempt ${attempt + 1}/3)`);
              if (accountId) triedAccounts.add(accountId);
              linkedInOutreachService.invalidateResolvedAccount(userId);
              continue;
            }
            linkedInOutreachService.invalidateResolvedAccount(userId);
            if (accountId) linkedInOutreachService.clearStatusCache(accountId);
            console.warn(`${tag} ERROR ${(err as Error).message}`);
            return null;
          }
        }
        console.warn(`${tag} all accounts rate-limited (tried ${triedAccounts.size})`);
        return null;
      },

      // Tier 5: company enrichment via Unipile (runs after Tier 4 web).
      // Only fires when lead.linkedin is present. getProfile → company_id → getCompany.
      findUnipileCompany: async (lead: LeadRecord) => {
        const tag = `[v3:${lead.leadId ?? lead.email ?? '?'}:unipile:company]`;
        if (!lead.linkedin?.includes('/in/')) {
          console.log(`${tag} SKIP no lead.linkedin`);
          return null;
        }
        const { linkedInOutreachService } = await import('./linkedInOutreachService');
        const triedAccounts = new Set<string>();

        for (let attempt = 0; attempt < 3; attempt++) {
          let accountId: string | null = null;
          try {
            accountId = await linkedInOutreachService.resolveAccountIdForEnrichment(
              userId,
              triedAccounts.size > 0 ? triedAccounts : undefined,
            );
            if (!accountId) { console.warn(`${tag} no accountId → skip`); return null; }

            console.log(`${tag} getProfile url=${lead.linkedin}`);
            const profileResult = await getUnipileProfileService().getProfile(lead.linkedin, accountId);
            if (!profileResult?.found || !profileResult.rawData) {
              console.log(`${tag} MISS profile not found`);
              return null;
            }
            const current = (profileResult.rawData.work_experience as any[] | undefined)?.find((e: any) => !e.end);
            const company_name: string | undefined = current?.company ?? undefined;
            const companyId: string | null = current?.company_id ? String(current.company_id) : null;
            console.log(`${tag} profile HIT current_role="${current?.position ?? '∅'}" at="${company_name ?? '∅'}" company_id=${companyId ?? 'none'}`);

            if (!companyId) {
              console.log(`${tag} no company_id in work_experience → return company_name only`);
              return { company_name, companyRaw: null, fromCache: profileResult.fromCache };
            }

            console.log(`${tag} getCompany company_id=${companyId}`);
            const companyResult = await getUnipileCompanyService().getCompany(companyId, accountId);
            if (!companyResult.found || !companyResult.rawData) {
              console.warn(`${tag} getCompany MISS found=${companyResult.found} → return company_name only`);
              return { company_name, companyRaw: null, fromCache: profileResult.fromCache };
            }
            const cRaw = companyResult.rawData;
            console.log(`${tag} companyRaw HIT name="${cRaw.name ?? '∅'}" website="${cRaw.website ?? '∅'}" employees=${cRaw.employee_count ?? '∅'}`);
            return { company_name: company_name ?? cRaw.name ?? undefined, companyRaw: cRaw, fromCache: companyResult.fromCache };
          } catch (err) {
            if ((err as any)?.structuredError?.classification === 'RATE_LIMIT_ERROR') {
              console.warn(`${tag} 429 on account ${accountId} — rotating (attempt ${attempt + 1}/3)`);
              if (accountId) triedAccounts.add(accountId);
              linkedInOutreachService.invalidateResolvedAccount(userId);
              continue;
            }
            linkedInOutreachService.invalidateResolvedAccount(userId);
            if (accountId) linkedInOutreachService.clearStatusCache(accountId);
            console.warn(`${tag} ERROR ${(err as Error).message}`);
            return null;
          }
        }
        console.warn(`${tag} all accounts rate-limited (tried ${triedAccounts.size})`);
        return null;
      },

      apolloBrokerChain: async ({ firstName, lastName, emailDomain, company, linkedin }, leadHint) => {
        const result = await identityDeps.apolloBrokerChain(
          { firstName, lastName, domain: emailDomain, company, linkedinUrl: linkedin },
          leadHint,
        );
        if (result?.email) return { email: result.email, emailStatus: result.emailStatus };
        return null;
      },

      // Tier 3.5b-enrich.so: reverse-lookup by email → person + company fields.
      findEnrichSoPerson: async (email: string): Promise<EnrichSoFetchResult | null> => {
        try {
          const enrichSo = getEnrichSoService();
          const result = await enrichSo.reverseLookup(email, { userId });
          if (!result?.found) return null;
          return {
            firstName: result.firstName,
            lastName: result.lastName,
            jobTitle: result.jobTitle,
            profileUrl: result.profileUrl,
            companyName: result.companyName,
            companyLocation: result.companyLocation,
            companyLinkedInUrl: result.companyLinkedInUrl,
            pastCompanies: result.pastCompanies,
            education: result.education,
            fromCache: result.fromCache,
          };
        } catch (err) {
          console.warn('[v3 deps] findEnrichSoPerson failed:', (err as Error).message);
          return null;
        }
      },
    }),

    // Ungrouped fields → synthetic web fetch using a generic "{{emailDomain}}"
    // query, then LLM extraction. No canonical group → no cache key → no
    // AW-EnrichmentRawCache reuse (one fetch per lead per run).
    extractUngroupedFieldsViaWeb: async ({ listId, lead, fields, configFieldsByName }) => {
      if (fields.length === 0) {
        return { fields: [], missing: [], tierFills: { crm: 0, apollo: 0, enrichSo: 0, unipile: 0, web: 0, missing: 0 } };
      }
      const domain = lead.emailDomain || extractDomain(lead.email) || extractDomain(lead.website);
      if (!domain) {
        return {
          fields: [], missing: fields,
          tierFills: { crm: 0, apollo: 0, enrichSo: 0, unipile: 0, web: 0, missing: fields.length },
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
          tierFills: { crm: 0, apollo: 0, enrichSo: 0, unipile: 0, web: 0, missing: fields.length },
        };
      }
      const llmResult = await extractFieldsViaLLMReal({
        tier: 'web', sourceContext: webContext, fields, groupName: '__ungrouped__',
        lead, configFieldsByName, listId,
      }, userId);
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
        tierFills: { crm: 0, apollo: 0, enrichSo: 0, unipile: 0, web: filled.length, missing: llmResult.missing.length },
      };
    },

    evaluateSmartField: async ({ lead, fieldName, condition, depValues }) => {
      const {
        buildSmartFieldEvalSystemPrompt,
        buildSmartFieldEvalUserPrompt,
      } = await import('./enrichmentPrompts');
      try {
        const sanitize = (s: string) => s.replace(/["\n`]/g, ' ').trim();
        const raw: Record<string, string> = {
          name: [lead.firstName, lead.lastName].filter(Boolean).join(' '),
          firstName: lead.firstName || '',
          lastName: lead.lastName || '',
          company: lead.company || '',
          title: lead.title || '',
          emailDomain: lead.emailDomain || '',
          website: lead.website || '',
          linkedin: lead.linkedin || '',
        };
        const nativeValues = Object.fromEntries(
          Object.entries(raw)
            .filter(([, v]) => v)
            .map(([k, v]) => [k, sanitize(v.slice(0, 200))])
        );
        const mergedDepValues = { ...nativeValues, ...depValues };
        const llm = createLLMService(EXTRACT_MODEL, 0.0);
        const result = await llm.generateJSONContent<{ value: string | null; reasoning: string }>(
          buildSmartFieldEvalSystemPrompt(),
          buildSmartFieldEvalUserPrompt(fieldName, condition, mergedDepValues),
          'json',
          undefined,
          { userId, feature: 'enrichment' },
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

    runCriticOverWebFills: (input) => runCriticReal(input, userId),

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
