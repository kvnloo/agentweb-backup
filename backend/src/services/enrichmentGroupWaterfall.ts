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
import { getFieldConfidence } from './fieldConfidenceRegistry';
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
  listId?: string;
}

/** One LLM-extracted field value plus its web provenance (web tier only —
 *  Apollo-tier values are normalized into this shape with no URL/quote). */
export interface LLMFilledValue {
  value: string;
  sourceUrl?: string;
  sourceQuote?: string;
}

export interface LLMExtractResult {
  filled: Record<string, LLMFilledValue>;
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
    listId?: string,
  ): Promise<{ webContext: string } | null>;
  /** Tier 3.5b: person enrichment via Unipile.
   *  Case A (has linkedin, missing name/title): getProfile → extract fields.
   *  Case B (no linkedin, has name, missing title): searchPeople → LLM picks
   *  best of 5 candidates → extracts title from headline. */
  findUnipilePerson?(lead: LeadRecord): Promise<{
    first_name?: string;
    last_name?: string;
    title?: string;
    linkedin_url?: string;
  } | null>;
  /** Tier 5: company enrichment via Unipile (runs after Tier 4 web).
   *  Only fires when lead.linkedin is present. getProfile → company_id → getCompany.
   *  Returns companyRaw (full company profile) and company_name from work_experience. */
  findUnipileCompany?(lead: LeadRecord): Promise<{ company_name?: string; companyRaw: any } | null>;
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
  listId?: string,
): Promise<Record<string, string> | null> {
  const atag = `[v3:${listId ? `${listId}:` : ''}${lead.leadId ?? lead.email ?? '?'}:apollo:${entityType}]`;
  if (entityType === 'company') {
    if (ctx.orgFetchAttempted) {
      console.log(`${atag} cache hit (already fetched)`);
      return ctx.orgRaw;
    }
    ctx.orgFetchAttempted = true;
    try {
      const result = await deps.fetchApolloOrg(lead);
      ctx.orgRaw = result?.mapped ?? null;
      ctx.orgRawJson = result?.raw ?? null;
      const mappedCount = ctx.orgRaw ? Object.keys(ctx.orgRaw).length : 0;
      const rawKeys = ctx.orgRawJson ? Object.keys(ctx.orgRawJson).length : 0;
      console.log(`${atag} ${ctx.orgRaw ? `HIT mapped_fields=${mappedCount} raw_keys=${rawKeys}` : 'MISS no org data'}`);
      return ctx.orgRaw;
    } catch (err) {
      ctx.orgFetchFailed = true;
      ctx.orgRaw = null;
      console.warn(`${atag} ERROR ${(err as Error).message}`);
      return null;
    }
  }
  if (ctx.personFetchAttempted) {
    console.log(`${atag} cache hit (already fetched)`);
    return ctx.personRaw;
  }
  ctx.personFetchAttempted = true;
  try {
    const result = await deps.fetchApolloPerson(lead);
    ctx.personRaw = result?.mapped ?? null;
    ctx.personRawJson = result?.raw ?? null;
    const mappedCount = ctx.personRaw ? Object.keys(ctx.personRaw).length : 0;
    const rawKeys = ctx.personRawJson ? Object.keys(ctx.personRawJson).length : 0;
    console.log(`${atag} ${ctx.personRaw ? `HIT mapped_fields=${mappedCount} raw_keys=${rawKeys}` : 'MISS no person data'}`);
    return ctx.personRaw;
  } catch (err) {
    ctx.personFetchFailed = true;
    ctx.personRaw = null;
    console.warn(`${atag} ERROR ${(err as Error).message}`);
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

function metaApollo(field: string, opts?: { llmExtracted?: boolean }): EnrichedFieldMeta {
  // Tier 2 (deterministic direct-map) uses the raw registry confidence; Tier 3
  // (LLM extraction over Apollo raw JSON) passes { llmExtracted: true }, which
  // downgrades one notch — LLM extraction is less reliable than a direct map.
  let confidence = getFieldConfidence('apollo', field);
  if (opts?.llmExtracted) {
    confidence = confidence === 'high' ? 'medium' : confidence === 'medium' ? 'low' : 'low';
  }
  return {
    source: 'api',
    provider: 'apollo',
    confidence,
    enrichedAt: new Date().toISOString(),
  };
}

function metaWeb(sourceUrl?: string, sourceQuote?: string): EnrichedFieldMeta {
  return {
    source: 'web_search',
    provider: 'llm_web_search',
    confidence: 'medium',
    ...(sourceUrl ? { sourceUrl } : {}),
    ...(sourceQuote ? { sourceQuote } : {}),
    enrichedAt: new Date().toISOString(),
  };
}

function metaUnipile(): EnrichedFieldMeta {
  return {
    source: 'api',
    provider: 'unipile',
    confidence: 'medium',
    enrichedAt: new Date().toISOString(),
  };
}

/** True when an LLM-extracted entry carries a non-empty value — i.e. it
 *  actually produced a fill. A present-but-empty entry counts as NOT filled
 *  (matching the bare-string era where `''` was falsy), so the field stays
 *  in `remaining` and is reported missing. */
function llmFilledHasValue(entry: LLMFilledValue | undefined): boolean {
  return !!entry && typeof entry.value === 'string' && entry.value.length > 0;
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
  const lid = lead.leadId ?? lead.email ?? '?';
  const tag = `[v3:${input.listId}:${lid}:wf:${groupName}]`;

  console.log(`${tag} START fields=[${fields.join(',')}]`);

  // ─ Tier 1: CRM ─────────────────────────────────────────────────────────────
  const crmHits: FieldFill[] = [];
  for (const f of fields) {
    if (refreshFields.has(`${lead.leadId}:${f}`)) {
      console.log(`${tag} T1 MISS field=${f} reason=refresh_forced`);
      continue;
    }
    const value = getLeadFieldValue(lead, f);
    if (!value) {
      console.log(`${tag} T1 MISS field=${f} reason=empty`);
      continue;
    }
    const meta = lead.enrichmentMetadata?.[f] as EnrichedFieldMeta | undefined;
    if (!isFresh(meta, f)) {
      console.log(`${tag} T1 MISS field=${f} reason=stale`);
      continue;
    }
    console.log(`${tag} T1 HIT  field=${f} value="${String(value).slice(0, 60)}"`);
    crmHits.push({ field: f, value, meta: meta! });
  }
  filled.push(...crmHits);
  remaining = remaining.filter(f => !crmHits.find(c => c.field === f));
  console.log(`${tag} T1 done crm_hits=${crmHits.length} remaining=[${remaining.join(',')}]`);

  if (remaining.length === 0) {
    console.log(`${tag} DONE all filled by T1`);
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
    console.log(`${tag} T2 fetch entity=${entityType} fields_in_coverage=[${remainingInCoverage.join(',')}]`);
    apolloRaw = await ensureApolloFetched(apolloCtx, lead, entityType, deps, input.listId);
    if (!apolloRaw) console.log(`${tag} T2 fetch returned null (no Apollo data)`);
  } else {
    console.log(`${tag} T2 SKIP no remaining fields in Apollo coverage`);
  }

  const apolloHits: FieldFill[] = [];
  if (apolloRaw) {
    for (const f of remaining) {
      const value = apolloRaw[f];
      if (typeof value === 'string' && value.length > 0) {
        console.log(`${tag} T2 HIT  field=${f} value="${String(value).slice(0, 60)}"`);
        apolloHits.push({ field: f, value, meta: metaApollo(f) });
      } else {
        console.log(`${tag} T2 MISS field=${f} reason=not_in_apollo_mapped`);
      }
    }
  }
  filled.push(...apolloHits);
  remaining = remaining.filter(f => !apolloHits.find(a => a.field === f));
  console.log(`${tag} T2 done apollo_hits=${apolloHits.length} remaining=[${remaining.join(',')}]`);

  // ─ Tier 3: LLM over full Apollo context ────────────────────────────────────
  // Uses the raw Apollo JSON (not the pre-mapped subset) so LLM can extract
  // fields we don't explicitly map in Tier 2 (e.g. raw_address, phone, etc.).
  // Noisy / large keys are stripped before sending to reduce token cost.
  const STRIP_ORG_KEYS = new Set(['suborganizations', 'current_technologies', 'keywords']);
  const STRIP_PERSON_KEYS = new Set(['employment_history']);

  let tier3Fills = 0;
  if (apolloRaw && remaining.some(f => coverage.includes(f))) {
    const tier3Targets = remaining.filter(f => coverage.includes(f));
    console.log(`${tag} T3 LLM/Apollo targets=[${tier3Targets.join(',')}]`);
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
      listId: input.listId,
    });
    for (const f of tier3Targets) {
      const entry = llmResult.filled[f];
      if (entry && typeof entry.value === 'string' && entry.value.length > 0) {
        console.log(`${tag} T3 HIT  field=${f} value="${String(entry.value).slice(0, 60)}"`);
        filled.push({ field: f, value: entry.value, meta: metaApollo(f, { llmExtracted: true }) });
        tier3Fills += 1;
      } else {
        console.log(`${tag} T3 MISS field=${f} reason=llm_returned_empty`);
      }
    }
    remaining = remaining.filter(f => !llmFilledHasValue(llmResult.filled[f]));
    console.log(`${tag} T3 done tier3_fills=${tier3Fills} remaining=[${remaining.join(',')}]`);
  } else if (!apolloRaw) {
    console.log(`${tag} T3 SKIP no apolloRaw`);
  } else {
    console.log(`${tag} T3 SKIP no remaining fields in Apollo coverage`);
  }

  if (remaining.length === 0) {
    console.log(`${tag} DONE all filled by T1-T3`);
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
      console.log(`${tag} T3.5a attempt name="${firstName} ${lastName}" domain=${emailDomain ?? '∅'} company=${company ?? '∅'}`);
      try {
        const brokerResult = await deps.apolloBrokerChain(
          { firstName, lastName, emailDomain, company, linkedin },
          input.leadHint,
        );
        if (brokerResult?.email) {
          console.log(`${tag} T3.5a HIT  email=${brokerResult.email} confidence=${apolloEmailStatusToConfidence(brokerResult.emailStatus ?? '')}`);
          filled.push({
            field: 'email',
            value: brokerResult.email,
            meta: { ...metaApollo('email'), confidence: apolloEmailStatusToConfidence(brokerResult.emailStatus ?? '') },
          });
          remaining = remaining.filter(f => f !== 'email');
        } else {
          console.log(`${tag} T3.5a MISS broker returned null`);
        }
      } catch (err) {
        console.warn(`${tag} T3.5a ERROR:`, (err as Error).message);
      }
    } else {
      console.log(`${tag} T3.5a SKIP missing name/domain/company (firstName=${!!firstName} lastName=${!!lastName} domain=${!!emailDomain} company=${!!company})`);
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

  // ─ Tier 3.5b: Unipile person enrichment ────────────────────────────────────
  // Person groups only. Two cases:
  //   Case A: lead.linkedin present, missing first_name/last_name/title
  //           → getProfile(linkedin) → extract fields directly from profile
  //   Case B: no lead.linkedin, have firstName+lastName, missing title
  //           → searchPeople → LLM picks best of 5 candidates from headline
  let unipileFills = 0;
  const PERSON_TIER35B_FIELDS = ['first_name', 'last_name', 'title', 'linkedin_url'];
  if (deps.findUnipilePerson && groupEntityType(groupName) === 'person') {
    const needsPersonFields = remaining.some(f => PERSON_TIER35B_FIELDS.includes(f));
    if (needsPersonFields) {
      console.log(`${tag} T3.5b attempt linkedin=${lead.linkedin ?? '∅'} name="${lead.firstName ?? '∅'} ${lead.lastName ?? '∅'}" company="${lead.company ?? '∅'}"`);
      // Prefer linkedin_url freshly filled this run (Tier 2/3) over original lead field
      const resolvedLinkedin = lead.linkedin || filled.find(f => f.field === 'linkedin_url')?.value;
      const leadForUnipile = resolvedLinkedin ? { ...lead, linkedin: resolvedLinkedin } : lead;
      const result = await deps.findUnipilePerson(leadForUnipile);
      if (result) {
        for (const f of remaining) {
          if (!PERSON_TIER35B_FIELDS.includes(f)) continue;
          const value = result[f as keyof typeof result];
          if (typeof value === 'string' && value.length > 0) {
            console.log(`${tag} T3.5b HIT  field=${f} value="${value.slice(0, 60)}"`);
            filled.push({ field: f, value, meta: metaUnipile() });
            unipileFills += 1;
          } else {
            console.log(`${tag} T3.5b MISS field=${f} reason=not_in_result`);
          }
        }
        remaining = remaining.filter(f => !filled.find(x => x.field === f));
      } else {
        console.log(`${tag} T3.5b MISS findUnipilePerson returned null`);
      }
    } else {
      console.log(`${tag} T3.5b SKIP no person fields in remaining`);
    }
  }

  if (remaining.length === 0) {
    console.log(`${tag} DONE all filled by T1-T3.5b`);
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
  console.log(`${tag} T4 fetch remaining=[${remaining.join(',')}]`);
  const webCache = await deps.fetchWebForGroup(lead, groupName, input.listId);
  let webFills = 0;
  if (webCache) {
    console.log(`${tag} T4 contextLen=${webCache.webContext.length} LLM fields=[${remaining.join(',')}]`);
    const llmResult = await deps.extractFieldsViaLLM({
      tier: 'web',
      sourceContext: webCache.webContext,
      fields: remaining,
      groupName,
      lead,
      configFieldsByName: input.configFieldsByName,
      listId: input.listId,
    });
    for (const f of remaining) {
      const entry = llmResult.filled[f];
      if (entry && typeof entry.value === 'string' && entry.value.length > 0) {
        console.log(`${tag} T4 HIT  field=${f} value="${String(entry.value).slice(0, 60)}" src=${entry.sourceUrl ?? '∅'}`);
        filled.push({ field: f, value: entry.value, meta: metaWeb(entry.sourceUrl, entry.sourceQuote) });
        webFills += 1;
      } else {
        console.log(`${tag} T4 MISS field=${f} reason=llm_returned_empty`);
      }
    }
    remaining = remaining.filter(f => !llmFilledHasValue(llmResult.filled[f]));
  } else {
    console.log(`${tag} T4 MISS no web data returned`);
    remaining.forEach(f => console.log(`${tag} T4 MISS field=${f} reason=no_web_data`));
  }

  // ─ Tier 5: Unipile company enrichment (after web) ──────────────────────────
  // Company groups only. Only fires when lead.linkedin is present — getProfile
  // gives us company_id → getCompany for full firmographic data.
  // Last resort: more expensive than web but authoritative.
  if (deps.findUnipileCompany && remaining.length > 0 && groupEntityType(groupName) === 'company') {
    const resolvedLinkedin = lead.linkedin || filled.find(f => f.field === 'linkedin_url')?.value;
    if (resolvedLinkedin) {
      const leadForCompany = resolvedLinkedin !== lead.linkedin ? { ...lead, linkedin: resolvedLinkedin } : lead;
      console.log(`${tag} T5 attempt linkedin=${resolvedLinkedin} remaining=[${remaining.join(',')}]`);
      const result = await deps.findUnipileCompany(leadForCompany);
      if (result?.companyRaw) {
        const cRaw = result.companyRaw;
        console.log(`${tag} T5 companyRaw: name="${cRaw.name ?? '∅'}" website="${cRaw.website ?? '∅'}" employees=${cRaw.employee_count ?? '∅'}`);
        const llmResult = await deps.extractFieldsViaLLM({
          tier: 'apollo',
          sourceContext: JSON.stringify(result.companyRaw),
          fields: remaining,
          groupName,
          lead,
          configFieldsByName: input.configFieldsByName,
          listId: input.listId,
        });
        for (const f of remaining) {
          const entry = llmResult.filled[f];
          if (entry && typeof entry.value === 'string' && entry.value.length > 0) {
            console.log(`${tag} T5 HIT  field=${f} value="${String(entry.value).slice(0, 60)}"`);
            filled.push({ field: f, value: entry.value, meta: metaUnipile() });
            unipileFills += 1;
          } else {
            console.log(`${tag} T5 MISS field=${f} reason=llm_returned_empty`);
          }
        }
        remaining = remaining.filter(f => !llmFilledHasValue(llmResult.filled[f]));
      } else if (result?.company_name && remaining.includes('company_name')) {
        // companyRaw unavailable but company_name from work_experience is enough
        console.log(`${tag} T5 HIT  field=company_name value="${result.company_name.slice(0, 60)}" (no companyRaw)`);
        filled.push({ field: 'company_name', value: result.company_name, meta: metaUnipile() });
        unipileFills += 1;
        remaining = remaining.filter(f => f !== 'company_name');
      } else {
        console.log(`${tag} T5 MISS no companyRaw returned (result=${result == null ? 'null' : 'no companyRaw'})`);
      }
    } else {
      console.log(`${tag} T5 SKIP no lead.linkedin available`);
    }
  }

  console.log(`${tag} DONE web_fills=${webFills} unipile_fills=${unipileFills} missing=[${remaining.join(',')}]`);
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
