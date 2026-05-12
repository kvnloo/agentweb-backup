// Real-service adapters that satisfy v3.1 orchestrator deps.
//
// Phase 1a status (matches what users see today):
//   ✓ Apollo people + org enrichment via existing apolloService
//   ✓ enrich.so reverse lookup via existing enrichSoService
//   ✓ DDB read/write via crmDb
//   ✗ Web fetch + LLM extraction + critic — stubbed (return empty / null)
//     until Phase 1b wires the existing v2 extraction pipeline.
//
// Apollo direct-map fields WILL populate on a real run. Web-only groups
// (intent_signals, company_social) will show 'missing' fields in the report,
// which is expected behavior pre-Phase-1b.

import { crmDb } from './db';
import { getApolloService, isApolloServiceReady } from './apolloService';
import { getEnrichSoService } from './enrichSoService';
import { mapApolloOrganization } from './apolloFieldMapper';
import type { MappedPerson, MappedOrganization } from './apolloFieldMapper';
import type { OrchestratorDeps } from './crmEnrichmentServiceV3';
import { CrmEnrichmentService, type LeadRecord } from './crmEnrichmentService';
import type { IdentityResolverDeps } from './enrichmentIdentityResolver';
import { resolveIdentity as pureResolveIdentity } from './enrichmentIdentityResolver';
import { runWaterfall as pureRunWaterfall } from './enrichmentGroupWaterfall';
import { FIELD_GROUPS } from './enrichmentGroups';
import {
  getRawDataFromCache,
  writeRawDataToCache,
  buildWebContextFromCache,
} from './enrichmentCacheService';
import { fetchTopPages } from './webContentFetcher';
import { agentModeService } from './agentModeService';
import { createLLMService } from '../utils/llmService';

// Models — match what v2 enrichment uses (gpt-5-chat-2 via Azure OpenAI; see
// `crmEnrichmentService.ts:260-261`). Overridable via env for cost tuning.
const EXTRACT_MODEL = process.env.CRM_ENRICH_V3_EXTRACT_MODEL || 'gpt-5-chat-2';
const CRITIC_MODEL  = process.env.CRM_ENRICH_V3_CRITIC_MODEL  || 'gpt-5-chat-2';

// ─── Identity resolver deps ───────────────────────────────────────────────────

function buildIdentityDeps(): IdentityResolverDeps {
  return {
    apolloPeopleMatch: async ({ email, linkedinUrl }) => {
      if (!isApolloServiceReady()) return null;
      if (!email && !linkedinUrl) return null;
      try {
        const apollo = getApolloService();
        const result = await apollo.matchPerson({ email, linkedinUrl });
        const p = result?.match?.person;
        if (!p) return null;
        return {
          firstName: p.firstName,
          lastName: p.lastName,
          title: p.title,
          linkedin: p.linkedin,
          email: p.email,           // returned when matched by linkedinUrl
          city: p.city,
          state: p.state,
          country: p.country,
        };
      } catch (err) {
        console.warn('[v3 deps] apolloPeopleMatch failed:', (err as Error).message);
        return null;
      }
    },

    apolloOrgMatch: async ({ emailDomain }) => {
      if (!isApolloServiceReady()) return null;
      try {
        const apollo = getApolloService();
        const result = await apollo.matchOrg(emailDomain);
        const o = result?.organization;
        if (!o) return null;
        return {
          company: o.name,
          website: (o as any).websiteUrl ?? (o as any).domain,
        };
      } catch (err) {
        console.warn('[v3 deps] apolloOrgMatch failed:', (err as Error).message);
        return null;
      }
    },

    findSiblingLead: async ({ excludeLeadId, email, linkedinUrl, firstName, lastName, company }) => {
      // Try email → linkedin → name+company, in that order of precision.
      // Cross-tenant: each crmDb method queries a global GSI with no userId
      // filter. excludeLeadId removes the current lead from results so the
      // resolver can't match against itself.
      const trySet = async (items: any[]): Promise<any | null> => {
        const candidates = (items || []).filter(it => it && it.leadId !== excludeLeadId);
        return candidates[0] || null;
      };

      const trimmedEmail = email?.trim().toLowerCase();
      if (trimmedEmail) {
        const items = await crmDb.findLeadsByEmail(trimmedEmail);
        const hit = await trySet(items);
        if (hit) return hit;
      }
      const trimmedLinkedin = linkedinUrl?.trim();
      if (trimmedLinkedin) {
        const items = await crmDb.findLeadsByLinkedin(trimmedLinkedin);
        const hit = await trySet(items);
        if (hit) return hit;
      }
      if (firstName && lastName && company) {
        const items = await crmDb.findLeadsByNameCompany(firstName, lastName, company);
        const hit = await trySet(items);
        if (hit) return hit;
      }
      return null;
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

    writeLeadFields: async ({ listId, leadId, fields, meta }) => {
      // Split by destination: standard lead columns go to top-level (where
      // the lead table reads them); custom names go to customFields.
      // Matches STANDARD_LEAD_COLUMNS in crmEnrichmentServiceV3.ts.
      const STANDARD = new Set(['firstName', 'lastName', 'email', 'company', 'phone', 'title', 'linkedin', 'notes']);
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
function mapApolloOrgToCrmFields(m: MappedOrganization): Record<string, string> {
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
  return out;
}

function mapApolloPersonToCrmFields(p: MappedPerson): Record<string, string> {
  const out: Record<string, string> = {};
  if (p.firstName) out.first_name = p.firstName;
  if (p.lastName) out.last_name = p.lastName;
  if (p.title) out.title = p.title;
  if (p.linkedin) out.linkedin_url = p.linkedin;
  if (p.email) out.email = p.email;
  if (p.phone) out.phone = p.phone;
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

async function extractFieldsViaLLMReal(input: {
  tier: 'apollo' | 'web';
  sourceContext: string;
  fields: string[];
  groupName: string;
  lead: LeadRecord;
  configFieldsByName: Record<string, { instruction?: string } | undefined>;
}): Promise<{ filled: Record<string, string>; missing: string[] }> {
  if (input.fields.length === 0) return { filled: {}, missing: [] };

  const fieldGuide = input.fields.map(name => {
    const instr = input.configFieldsByName[name]?.instruction || '';
    return `- ${name}${instr ? `: ${instr}` : ''}`;
  }).join('\n');

  const systemPrompt =
    `You extract structured CRM data from the provided context. Return strict JSON: ` +
    `an object with one key per requested field. Use null when the value isn't ` +
    `explicitly present. Do NOT infer or fabricate. Strings only, no markdown.`;

  const leadContext = JSON.stringify({
    email: input.lead.email,
    company: input.lead.company,
    website: input.lead.website,
    firstName: input.lead.firstName,
    lastName: input.lead.lastName,
  });

  const userPrompt =
    `Lead: ${leadContext}\n\n` +
    `Source (${input.tier}):\n${input.sourceContext.slice(0, 16000)}\n\n` +
    `Extract these fields (return one JSON object with these exact keys):\n${fieldGuide}\n\n` +
    `Return ONLY a JSON object like {"field_name": "value", "other_field": null}. No prose.`;

  try {
    const llm = createLLMService(EXTRACT_MODEL, 0.0);
    const parsed = await llm.generateJSONContent<Record<string, any>>(systemPrompt, userPrompt);
    const filled: Record<string, string> = {};
    const missing: string[] = [];
    for (const field of input.fields) {
      const value = parsed?.[field];
      if (value != null && String(value).trim().length > 0 && String(value).toLowerCase() !== 'null') {
        filled[field] = String(value).trim();
      } else {
        missing.push(field);
      }
    }
    return { filled, missing };
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
  const identityDeps = buildIdentityDeps();

  return {
    loadLeads: async ({ listId, leadIds }) => {
      // Selection-scoped run (bulk-actions bar) → BatchGetItem on the
      // requested keys, no over-fetch.
      if (leadIds && leadIds.length > 0) {
        const items = await crmDb.batchGetLeads(listId, leadIds);
        return items as LeadRecord[];
      }
      // Whole-list run → single Query page. No explicit limit: DDB returns
      // up to ~1MB worth of items in one round-trip.
      const result = await crmDb.getLeadsByListId(listId);
      return (result?.items ?? []) as LeadRecord[];
    },

    resolveIdentity: (input) => pureResolveIdentity(input, identityDeps),

    runWaterfall: (input) => pureRunWaterfall(input, {
      fetchApolloOrg: async (lead) => {
        if (!isApolloServiceReady()) return null;
        const domain = lead.emailDomain || extractDomain(lead.email) || extractDomain(lead.website);
        if (!domain) return null;
        try {
          const result = await getApolloService().matchOrg(domain);
          return result?.organization ? mapApolloOrgToCrmFields(result.organization) : null;
        } catch (err) {
          console.warn('[v3 deps] fetchApolloOrg failed:', (err as Error).message);
          throw err;
        }
      },

      fetchApolloPerson: async (lead) => {
        if (!isApolloServiceReady()) return null;
        if (!lead.email) return null;
        try {
          const result = await getApolloService().matchPerson({ email: lead.email });
          return result?.match?.person ? mapApolloPersonToCrmFields(result.match.person) : null;
        } catch (err) {
          console.warn('[v3 deps] fetchApolloPerson failed:', (err as Error).message);
          throw err;
        }
      },

      extractFieldsViaLLM: extractFieldsViaLLMReal,
      fetchWebForGroup: fetchWebForGroupReal,

      findLinkedInUrl: async (lead: LeadRecord): Promise<string | null> => {
        try {
          const { linkedInOutreachService } = await import('./linkedInOutreachService');
          const accountId = await linkedInOutreachService.resolveAccountId(userId);
          if (!accountId) return null;
          const keywords = [lead.firstName, lead.lastName].filter(Boolean).join(' ');
          if (!keywords) return null;
          const result = await linkedInOutreachService.searchPeople(accountId, {
            keywords,
            company: lead.company || undefined,
          });
          const first = result?.items?.[0];
          if (!first?.public_identifier) return null;
          if (!unipileNameMatches(first, lead.firstName, lead.lastName)) return null;
          return `https://www.linkedin.com/in/${first.public_identifier}`;
        } catch (err) {
          console.warn('[v3 deps] findLinkedInUrl failed:', (err as Error).message);
          return null;
        }
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
        const value = llmResult.filled[field];
        if (typeof value === 'string' && value.length > 0) {
          filled.push({
            field, value,
            meta: { source: 'web_search', enrichedAt: new Date().toISOString() },
          });
        }
      }
      return {
        fields: filled,
        missing: llmResult.missing,
        tierFills: { crm: 0, apollo: 0, web: filled.length, missing: llmResult.missing.length },
      };
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
