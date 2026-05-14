// Per-group, per-lead tier waterfall — Req B core of v3.1 enrichment.
// (Named "GroupWaterfall" to disambiguate from the provider-level
//  enrichmentWaterfall.ts that wraps Apollo/enrich.so specialists.)
//
// Strict 4-tier order, first fresh source wins:
//
//   Tier 1: CRM        (lead-side; freshness via isFresh)
//   Tier 2: Apollo     (memoized per-lead-per-entity via ApolloFetchContext)
//   Tier 3: LLM/Apollo (conditional — Apollo non-null AND residuals in coverage)
//   Tier 4: Web        (one Google CSE call per group with residuals)
//
// Apollo is fetched ONCE per (lead, entity-type) — multiple company groups for
// the same lead share one org-enrichment call. Same for person groups.
//
// Design ref: tasks/crm-enrichment-v3.1-design.md §5.2.

import { isFresh } from './enrichmentTtl';
import { FIELD_GROUPS } from './enrichmentGroups';
import { apolloEmailStatusToConfidence } from './apolloFieldMapper';
import type { LeadRecord } from './crmEnrichmentService';
import type { EnrichedFieldMeta } from '../utils/enrichedFieldValue';

// ─── Apollo coverage map ──────────────────────────────────────────────────────
// Fields Apollo directly maps via apolloFieldMapper.ts:193-235.
// Fields NOT listed here fall straight from Tier 1 to Tier 4 (web) for the group.
// Phase 1 keeps this narrow — only fields with a direct Apollo→CRM mapping.

export const APOLLO_GROUP_COVERAGE: Record<string, string[]> = {
  company_firmographic: [
    'company_name', 'website', 'industry', 'employee_count',
    'founded_year', 'hq_location', 'company_description', 'company_linkedin_url',
    'company_phone',
  ],
  company_financial: [
    'revenue_range', 'funding_stage', 'total_funding', 'last_funding_date',
  ],
  company_technographic: [
    'tech_stack',
  ],
  company_social: [
    'twitter_handle',
  ],
  intent_signals: [],           // verified zero coverage (volatile data)
  company_geography: [
    'country', 'region', 'hq_address',
  ],
  company_product: [],          // verified zero coverage
  person_identity: [
    'first_name', 'last_name', 'title', 'linkedin_url', 'email', 'phone',
    'seniority', 'department',
  ],
  person_career: [],            // weak coverage in Phase 1 — treat as empty
};

// ─── Apollo fetch context (per-lead memoization) ──────────────────────────────

export interface ApolloFetchContext {
  orgRaw: Record<string, string> | null;
  personRaw: Record<string, string> | null;
  orgRawJson: any;
  personRawJson: any;
  orgFetchAttempted: boolean;
  personFetchAttempted: boolean;
  orgFetchFailed: boolean;
  personFetchFailed: boolean;
}

export function createApolloFetchContext(): ApolloFetchContext {
  return {
    orgRaw: null,
    personRaw: null,
    orgRawJson: null,
    personRawJson: null,
    orgFetchAttempted: false,
    personFetchAttempted: false,
    orgFetchFailed: false,
    personFetchFailed: false,
  };
}

// ─── Public types ─────────────────────────────────────────────────────────────

export interface FieldFill {
  field: string;
  value: string;
  meta: EnrichedFieldMeta;
}

export interface GroupResult {
  fields: FieldFill[];
  missing: string[];
  tierFills: { crm: number; apollo: number; web: number; missing: number };
}

export interface LLMExtractInput {
  tier: 'apollo' | 'web';
  sourceContext: string;
  fields: string[];
  groupName: string;
  lead: LeadRecord;
  configFieldsByName: Record<string, { instruction?: string } | undefined>;
}

export interface LLMExtractResult {
  filled: Record<string, string>;
  missing: string[];
}

export interface ApolloFetchResult {
  mapped: Record<string, string>;
  raw: any;
}

export interface WaterfallDeps {
  fetchApolloOrg(lead: LeadRecord): Promise<ApolloFetchResult | null>;
  fetchApolloPerson(lead: LeadRecord): Promise<ApolloFetchResult | null>;
  extractFieldsViaLLM(input: LLMExtractInput): Promise<LLMExtractResult>;
  fetchWebForGroup(
    lead: LeadRecord,
    groupName: string,
  ): Promise<{ webContext: string } | null>;
  findLinkedInUrl(lead: LeadRecord): Promise<string | null>;
  /** Tier 3.5: Apollo broker chain (run_waterfall_email). Optional — only
   *  wired when the caller has a persisted lead to receive the webhook result. */
  apolloBrokerChain?: (
    input: { firstName: string; lastName: string; emailDomain?: string; company?: string; linkedin?: string },
    leadHint: { listId: string; leadId: string },
  ) => Promise<{ email: string; emailStatus?: string } | null>;
}

export interface RunWaterfallInput {
  listId: string;
  lead: LeadRecord;
  groupName: string;
  requestedFields: string[];
  configFieldsByName: Record<string, { instruction?: string } | undefined>;
  apolloCtx: ApolloFetchContext;
  refreshFields: Set<string>;   // entries shaped "<leadId>:<fieldName>"
  /** When set, enables Tier 3.5 Apollo broker chain for the person_identity
   *  group. The webhook writes the async result back to this lead. */
  leadHint?: { listId: string; leadId: string };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function groupEntityType(groupName: string): 'company' | 'person' {
  const cfg = FIELD_GROUPS[groupName];
  return cfg?.entityType === 'person' ? 'person' : 'company';
}

async function ensureApolloFetched(
  ctx: ApolloFetchContext,
  lead: LeadRecord,
  entityType: 'company' | 'person',
  deps: WaterfallDeps,
): Promise<Record<string, string> | null> {
  if (entityType === 'company') {
    if (ctx.orgFetchAttempted) return ctx.orgRaw;
    ctx.orgFetchAttempted = true;
    try {
      const result = await deps.fetchApolloOrg(lead);
      ctx.orgRaw = result?.mapped ?? null;
      ctx.orgRawJson = result?.raw ?? null;
      return ctx.orgRaw;
    } catch {
      ctx.orgFetchFailed = true;
      ctx.orgRaw = null;
      return null;
    }
  }
  if (ctx.personFetchAttempted) return ctx.personRaw;
  ctx.personFetchAttempted = true;
  try {
    const result = await deps.fetchApolloPerson(lead);
    ctx.personRaw = result?.mapped ?? null;
    ctx.personRawJson = result?.raw ?? null;
    return ctx.personRaw;
  } catch {
    ctx.personFetchFailed = true;
    ctx.personRaw = null;
    return null;
  }
}

function getLeadFieldValue(lead: LeadRecord, field: string): string | undefined {
  const top = (lead as any)[field];
  if (typeof top === 'string' && top.length > 0) return top;
  const custom = lead.customFields?.[field];
  if (typeof custom === 'string' && custom.length > 0) return custom;
  return undefined;
}

function metaApollo(): EnrichedFieldMeta {
  return {
    source: 'api',
    provider: 'apollo',
    enrichedAt: new Date().toISOString(),
  };
}

function metaWeb(): EnrichedFieldMeta {
  return {
    source: 'web_search',
    enrichedAt: new Date().toISOString(),
  };
}

function metaUnipile(): EnrichedFieldMeta {
  return {
    source: 'api',
    provider: 'unipile',
    enrichedAt: new Date().toISOString(),
  };
}

// ─── Main entry ───────────────────────────────────────────────────────────────

export async function runWaterfall(
  input: RunWaterfallInput,
  deps: WaterfallDeps,
): Promise<GroupResult> {
  const { lead, groupName, requestedFields, apolloCtx, refreshFields } = input;
  const groupConfig = FIELD_GROUPS[groupName];

  // Filter to fields actually in this group.
  const groupFields = groupConfig ? groupConfig.fields : [];
  const fields = requestedFields.filter(f => groupFields.includes(f));
  if (fields.length === 0) {
    return {
      fields: [],
      missing: [],
      tierFills: { crm: 0, apollo: 0, web: 0, missing: 0 },
    };
  }

  const filled: FieldFill[] = [];
  let remaining = [...fields];

  // ─ Tier 1: CRM ─────────────────────────────────────────────────────────────
  const crmHits: FieldFill[] = [];
  for (const f of fields) {
    if (refreshFields.has(`${lead.leadId}:${f}`)) continue;
    const value = getLeadFieldValue(lead, f);
    if (!value) continue;
    const meta = lead.enrichmentMetadata?.[f] as EnrichedFieldMeta | undefined;
    if (!isFresh(meta, f)) continue;
    crmHits.push({ field: f, value, meta: meta! });
  }
  filled.push(...crmHits);
  remaining = remaining.filter(f => !crmHits.find(c => c.field === f));

  if (remaining.length === 0) {
    return {
      fields: filled,
      missing: [],
      tierFills: { crm: crmHits.length, apollo: 0, web: 0, missing: 0 },
    };
  }

  // ─ Tier 2: Apollo ──────────────────────────────────────────────────────────
  const coverage = APOLLO_GROUP_COVERAGE[groupName] ?? [];
  const remainingInCoverage = remaining.filter(f => coverage.includes(f));
  let apolloRaw: Record<string, string> | null = null;
  if (remainingInCoverage.length > 0) {
    const entityType = groupEntityType(groupName);
    apolloRaw = await ensureApolloFetched(apolloCtx, lead, entityType, deps);
  }

  const apolloHits: FieldFill[] = [];
  if (apolloRaw) {
    for (const f of remaining) {
      const value = apolloRaw[f];
      if (typeof value === 'string' && value.length > 0) {
        apolloHits.push({ field: f, value, meta: metaApollo() });
      }
    }
  }
  filled.push(...apolloHits);
  remaining = remaining.filter(f => !apolloHits.find(a => a.field === f));

  // ─ Tier 3: LLM over full Apollo context ────────────────────────────────────
  // Uses the raw Apollo JSON (not the pre-mapped subset) so LLM can extract
  // fields we don't explicitly map in Tier 2 (e.g. raw_address, phone, etc.).
  // Noisy / large keys are stripped before sending to reduce token cost.
  const STRIP_ORG_KEYS = new Set(['suborganizations', 'current_technologies', 'keywords']);
  const STRIP_PERSON_KEYS = new Set(['employment_history']);

  let tier3Fills = 0;
  if (apolloRaw && remaining.some(f => coverage.includes(f))) {
    const tier3Targets = remaining.filter(f => coverage.includes(f));
    const entityType = groupEntityType(groupName);
    const rawJson = entityType === 'person' ? apolloCtx.personRawJson : apolloCtx.orgRawJson;
    const stripKeys = entityType === 'person' ? STRIP_PERSON_KEYS : STRIP_ORG_KEYS;
    const sourceContext = rawJson
      ? JSON.stringify(Object.fromEntries(
          Object.entries(rawJson).filter(([k]) => !stripKeys.has(k)),
        ))
      : JSON.stringify(apolloRaw);
    const llmResult = await deps.extractFieldsViaLLM({
      tier: 'apollo',
      sourceContext,
      fields: tier3Targets,
      groupName,
      lead,
      configFieldsByName: input.configFieldsByName,
    });
    for (const f of tier3Targets) {
      const value = llmResult.filled[f];
      if (typeof value === 'string' && value.length > 0) {
        filled.push({ field: f, value, meta: metaApollo() });
        tier3Fills += 1;
      }
    }
    remaining = remaining.filter(f => !llmResult.filled[f]);
  }

  if (remaining.length === 0) {
    return {
      fields: filled,
      missing: [],
      tierFills: {
        crm: crmHits.length,
        apollo: apolloHits.length + tier3Fills,
        web: 0,
        missing: 0,
      },
    };
  }

  // ─ Tier 3.5a: Apollo broker chain (run_waterfall_email) ────────────────────
  // Only for person_identity when email is still missing after Apollo tiers.
  // Fires Apollo's async run_waterfall_email; result arrives via webhook and
  // is written directly to the lead. Same weak/strong-signal quality gate as
  // identity resolver Tier 6.5.
  if (
    groupName === 'person_identity' &&
    remaining.includes('email') &&
    input.leadHint &&
    deps.apolloBrokerChain
  ) {
    const firstName = (lead.firstName ?? '').trim();
    const lastName  = (lead.lastName  ?? '').trim();
    const emailDomain = lead.emailDomain || undefined;
    const company     = lead.company    || undefined;
    const linkedin    = lead.linkedin   || undefined;
    if (firstName && lastName && (emailDomain || company)) {
      try {
        const brokerResult = await deps.apolloBrokerChain(
          { firstName, lastName, emailDomain, company, linkedin },
          input.leadHint,
        );
        if (brokerResult?.email) {
          filled.push({
            field: 'email',
            value: brokerResult.email,
            meta: { ...metaApollo(), confidence: apolloEmailStatusToConfidence(brokerResult.emailStatus ?? '') },
          });
          remaining = remaining.filter(f => f !== 'email');
        }
      } catch (err) {
        console.warn('[waterfall tier3.5a] apolloBrokerChain failed:', (err as Error).message);
      }
    }
  }

  if (remaining.length === 0) {
    return {
      fields: filled,
      missing: [],
      tierFills: {
        crm: crmHits.length,
        apollo: apolloHits.length + tier3Fills,
        web: 0,
        missing: 0,
      },
    };
  }

  // ─ Tier 3.5b: Unipile LinkedIn search ───────────────────────────────────────
  // Only for person_identity group when linkedin_url still missing after Apollo tiers.
  // Searches by firstName + lastName + company to find the LinkedIn public_identifier.
  let unipileFills = 0;
  if (groupName === 'person_identity' && remaining.includes('linkedin_url')) {
    const linkedInUrl = await deps.findLinkedInUrl(lead);
    if (linkedInUrl) {
      filled.push({ field: 'linkedin_url', value: linkedInUrl, meta: metaUnipile() });
      remaining = remaining.filter(f => f !== 'linkedin_url');
      unipileFills = 1;
    }
  }

  if (remaining.length === 0) {
    return {
      fields: filled,
      missing: [],
      tierFills: {
        crm: crmHits.length,
        apollo: apolloHits.length + tier3Fills + unipileFills,
        web: 0,
        missing: 0,
      },
    };
  }

  // ─ Tier 4: Web ─────────────────────────────────────────────────────────────
  const webCache = await deps.fetchWebForGroup(lead, groupName);
  let webFills = 0;
  if (webCache) {
    const llmResult = await deps.extractFieldsViaLLM({
      tier: 'web',
      sourceContext: webCache.webContext,
      fields: remaining,
      groupName,
      lead,
      configFieldsByName: input.configFieldsByName,
    });
    for (const f of remaining) {
      const value = llmResult.filled[f];
      if (typeof value === 'string' && value.length > 0) {
        filled.push({ field: f, value, meta: metaWeb() });
        webFills += 1;
      }
    }
    remaining = remaining.filter(f => !llmResult.filled[f]);
  }

  return {
    fields: filled,
    missing: remaining,
    tierFills: {
      crm: crmHits.length,
      apollo: apolloHits.length + tier3Fills + unipileFills,
      web: webFills,
      missing: remaining.length,
    },
  };
}
