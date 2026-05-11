// CRM Enrichment v3.1 — Phase 1 orchestrator.
// Wires together: loadLeads → per-lead pipeline (identity → groups (sequential)
// → ungrouped web → critic over web-tier → batched setLeadFields by policy).
//
// Design ref: tasks/crm-enrichment-v3.1-design.md §1 architecture, §5.x flow.
//
// All external dependencies are injected via OrchestratorDeps for testability.
// Tests mock resolveIdentity / runWaterfall / etc. directly; this file is pure
// coordination.

import { randomUUID } from 'crypto';
import {
  createApolloFetchContext,
  type GroupResult,
  type FieldFill,
  type ApolloFetchContext,
} from './enrichmentGroupWaterfall';
import { FIELD_GROUPS } from './enrichmentGroups';
import type { LeadRecord } from './crmEnrichmentService';
import type { EnrichedFieldMeta } from '../utils/enrichedFieldValue';
import type { ResolveIdentityResult } from './enrichmentIdentityResolver';

// ─── Public types ─────────────────────────────────────────────────────────────

export interface EnrichmentFieldConfig {
  name: string;
  type: 'string' | 'number' | 'boolean' | 'enum' | 'date';
  enumOptions?: string[];
  instruction: string;
  include: boolean;
  overwritePolicy: 'fill_if_empty' | 'always_overwrite';
  /**
   * Canonical FIELD_GROUPS field name this user-named field maps to.
   * When set, the waterfall routes the field through the canonical group
   * (gaining Apollo direct-map / cache reuse) and writes the result back
   * under the user's `name`. e.g. user names a field `stag` with
   * `aliasFor: 'funding_stage'` → Apollo's structured `latestFundingStage`
   * fills it directly. Undefined for custom fields with no canonical analog.
   */
  aliasFor?: string;
}

export interface EnrichmentConfig {
  fields: EnrichmentFieldConfig[];
  globalOverwriteDefault: 'fill_if_empty' | 'always_overwrite';
  schemaVersion: 1;
  updatedAt: string;
  updatedBy: string;
}

export interface RunEnrichmentInput {
  listId: string;
  userId: string;
  config: EnrichmentConfig;
  mode: 'preview' | 'enrich';
  refreshFields?: Array<{ leadId: string; fieldName: string }>;
}

interface TierCount {
  crm: number;
  apollo: number;
  web: number;
  missing: number;
}

export interface RunEnrichmentResult {
  runId: string;
  processed: number;
  failed: {
    identityResolutionFailed: number;
    apolloFailed: number;
    llmOrParseFailed: number;
    updateFailed: number;
    searchWebFailed: number;
  };
  tierFillBreakdown: { total: TierCount } & Record<string, TierCount>;
  durationMs: number;
  preview?: Array<{
    leadId: string;
    extractedFields: Record<string, string>;
    meta: Record<string, EnrichedFieldMeta>;
  }>;
}

export interface CriticInput {
  lead: LeadRecord;
  fills: FieldFill[];
}
export interface CriticResult {
  verdicts: Record<string, 'supported' | 'partially-supported' | 'unsupported' | 'contradicted'>;
}

export interface OrchestratorDeps {
  loadLeads(input: { listId: string; userId: string }): Promise<LeadRecord[]>;

  resolveIdentity(input: {
    listId: string;
    lead: LeadRecord;
    needsPersonFields: boolean;
    needsCompanyFields: boolean;
    mode: 'preview' | 'enrich';
  }): Promise<ResolveIdentityResult>;

  runWaterfall(input: {
    listId: string;
    lead: LeadRecord;
    groupName: string;
    requestedFields: string[];
    configFieldsByName: Record<string, { instruction?: string } | undefined>;
    apolloCtx: ApolloFetchContext;
    refreshFields: Set<string>;
  }): Promise<GroupResult>;

  extractUngroupedFieldsViaWeb(input: {
    listId: string;
    lead: LeadRecord;
    fields: string[];
    configFieldsByName: Record<string, { instruction?: string } | undefined>;
  }): Promise<GroupResult>;

  runCriticOverWebFills(input: CriticInput): Promise<CriticResult>;

  setLeadFields(input: {
    listId: string;
    leadId: string;
    /** Writes to the lead's standard CRM columns (top-level attributes
     *  on the AW-Leads item, not inside the customFields map). Use for
     *  firstName, lastName, email, etc. so enriched values populate the
     *  same columns shown in the lead table. */
    topLevel?: Record<string, string>;
    /** Writes to the customFields map for non-standard names. */
    customFields?: Record<string, string>;
    enrichmentMetadata: Record<string, EnrichedFieldMeta>;
    ifNotExists: boolean;
  }): Promise<void>;
}

/** Standard CRM lead columns — values for these field names go to top-level
 *  AW-Leads attributes via setLeadFields.topLevel (not customFields). Mirrors
 *  STANDARD_ENRICHABLE_FIELDS in enrichmentConfigService. */
const STANDARD_LEAD_COLUMNS = new Set<string>([
  'firstName', 'lastName', 'email', 'company', 'phone', 'title', 'linkedin', 'notes',
]);

// ─── Helpers ──────────────────────────────────────────────────────────────────

function emptyTierCount(): TierCount {
  return { crm: 0, apollo: 0, web: 0, missing: 0 };
}

function addTierCounts(a: TierCount, b: TierCount): TierCount {
  return {
    crm: a.crm + b.crm,
    apollo: a.apollo + b.apollo,
    web: a.web + b.web,
    missing: a.missing + b.missing,
  };
}

interface FieldRouting {
  groupedByGroup: Map<string, string[]>;     // groupName → CANONICAL field names
  ungrouped: string[];                       // user-facing names (no canonical analog)
  /** Map from canonical name (what the waterfall sees) → user-facing name
   *  (what gets written to the lead). Same name on both sides for fields
   *  whose own `name` matches a FIELD_GROUPS entry. */
  userNameByCanonical: Map<string, string>;
}

function routeFields(
  config: EnrichmentConfig,
): { routing: FieldRouting; needsPerson: boolean; needsCompany: boolean } {
  const groupedByGroup = new Map<string, string[]>();
  const ungrouped: string[] = [];
  const userNameByCanonical = new Map<string, string>();

  for (const field of config.fields) {
    if (!field.include) continue;
    // Canonical for routing: prefer explicit aliasFor; otherwise the field's own name.
    const canonical = field.aliasFor || field.name;
    let assigned = false;
    for (const [groupName, groupCfg] of Object.entries(FIELD_GROUPS)) {
      if (groupCfg.fields.includes(canonical)) {
        if (!groupedByGroup.has(groupName)) groupedByGroup.set(groupName, []);
        groupedByGroup.get(groupName)!.push(canonical);
        userNameByCanonical.set(canonical, field.name);
        assigned = true;
        break;
      }
    }
    if (!assigned) ungrouped.push(field.name);
  }

  let needsPerson = false;
  let needsCompany = false;
  for (const groupName of groupedByGroup.keys()) {
    const ent = FIELD_GROUPS[groupName].entityType;
    if (ent === 'person') needsPerson = true;
    if (ent === 'company') needsCompany = true;
  }

  return { routing: { groupedByGroup, ungrouped, userNameByCanonical }, needsPerson, needsCompany };
}

function buildRefreshFieldsSet(
  refreshFields: RunEnrichmentInput['refreshFields'],
): Set<string> {
  const s = new Set<string>();
  if (refreshFields) {
    for (const r of refreshFields) {
      s.add(`${r.leadId}:${r.fieldName}`);
    }
  }
  return s;
}

function leadValueIsEmpty(lead: LeadRecord, fieldName: string): boolean {
  // A value counts as "empty" if it's missing OR the empty string (covering
  // both undefined keys and DDB's empty-string default). Checks both
  // top-level columns and customFields.
  const top = (lead as any)[fieldName];
  if (typeof top === 'string' && top.trim().length > 0) return false;
  const custom = lead.customFields?.[fieldName];
  if (typeof custom === 'string' && custom.trim().length > 0) return false;
  return true;
}

function bucketByOverwritePolicy(
  lead: LeadRecord,
  fills: FieldFill[],
  config: EnrichmentConfig,
): { fillIfEmpty: FieldFill[]; alwaysOverwrite: FieldFill[] } {
  const policyByField = new Map<string, 'fill_if_empty' | 'always_overwrite'>();
  for (const f of config.fields) policyByField.set(f.name, f.overwritePolicy);

  const fillIfEmpty: FieldFill[] = [];
  const alwaysOverwrite: FieldFill[] = [];
  for (const fill of fills) {
    if (fill.meta.source === 'existing_data') continue;   // value already in DB
    const policy = policyByField.get(fill.field) ?? config.globalOverwriteDefault;
    if (policy === 'always_overwrite') {
      alwaysOverwrite.push(fill);
    } else {
      // fill_if_empty: skip if the lead already has a non-empty value for this
      // field (DDB's if_not_exists treats "" as "exists" which is wrong for
      // the user's "empty" intent — we check string content explicitly).
      if (leadValueIsEmpty(lead, fill.field)) {
        fillIfEmpty.push(fill);
      }
    }
  }
  return { fillIfEmpty, alwaysOverwrite };
}

// ─── Per-lead pipeline ────────────────────────────────────────────────────────

type LeadFailureCategory =
  | 'identityResolution'
  | 'llmOrParse'
  | 'searchWeb'
  | 'update';

interface PerLeadOutcome {
  fills: FieldFill[];
  perGroupTierFills: Map<string, TierCount>;
  failureCategory: LeadFailureCategory | null;   // null = success
  // Apollo failures are independent of the lead's pass/fail status — Apollo
  // errors trigger Tier 4 fall-through, the lead can still succeed overall.
  apolloOrgFailed: boolean;
  apolloPersonFailed: boolean;
}

async function processLead(
  lead: LeadRecord,
  input: RunEnrichmentInput,
  deps: OrchestratorDeps,
  routing: FieldRouting,
  needsPerson: boolean,
  needsCompany: boolean,
  refreshSet: Set<string>,
  configFieldsByName: Record<string, EnrichmentFieldConfig>,
): Promise<PerLeadOutcome> {
  const perGroupTierFills = new Map<string, TierCount>();
  const allFills: FieldFill[] = [];
  const apolloCtx = createApolloFetchContext();

  // Step 0: identity resolution
  let identity: ResolveIdentityResult;
  try {
    identity = await deps.resolveIdentity({
      listId: input.listId,
      lead,
      needsPersonFields: needsPerson,
      needsCompanyFields: needsCompany,
      mode: input.mode,
    });
  } catch (err) {
    // Resolver makes external API calls (Apollo / enrich.so) — classify as
    // llm-or-parse since these are LLM-adjacent providers.
    return {
      fills: [],
      perGroupTierFills,
      failureCategory: 'llmOrParse',
      apolloOrgFailed: false,
      apolloPersonFailed: false,
    };
  }
  if (!identity.ok) {
    return {
      fills: [],
      perGroupTierFills,
      failureCategory: 'identityResolution',
      apolloOrgFailed: false,
      apolloPersonFailed: false,
    };
  }
  // Apply identity-resolved attributes to the in-memory lead so the waterfall
  // (Tier 1) can see them — the DB write was already done by the resolver
  // in mode=enrich; in preview it wasn't, but the waterfall benefits regardless.
  const enrichedLead = { ...lead, ...identity.resolved };

  // Steps 1–3: waterfall + ungrouped + critic, wrapped together so any
  // mid-pipeline error is captured as llmOrParseFailed for this lead.
  try {
    // Step 1: canonical groups (SEQUENTIAL — preserves Apollo ctx memoization
    // without promise-caching; design §6)
    for (const [groupName, fields] of routing.groupedByGroup.entries()) {
      const groupResult = await deps.runWaterfall({
        listId: input.listId,
        lead: enrichedLead,
        groupName,
        requestedFields: fields,
        configFieldsByName,
        apolloCtx,
        refreshFields: refreshSet,
      });
      // Translate each fill from CANONICAL field name back to the user's
      // chosen name. e.g. waterfall fills `funding_stage` but the user
      // named the field `stag` (via aliasFor) — we store under `stag`.
      for (const fill of groupResult.fields) {
        const userName = routing.userNameByCanonical.get(fill.field);
        if (userName && userName !== fill.field) fill.field = userName;
      }
      allFills.push(...groupResult.fields);
      perGroupTierFills.set(
        groupName,
        addTierCounts(perGroupTierFills.get(groupName) ?? emptyTierCount(), groupResult.tierFills),
      );
    }

    // Step 2: ungrouped fields (web only — no canonical group means no Apollo
    // direct-map; LLM extracts using the field's instruction)
    if (routing.ungrouped.length > 0) {
      const ungroupedResult = await deps.extractUngroupedFieldsViaWeb({
        listId: input.listId,
        lead: enrichedLead,
        fields: routing.ungrouped,
        configFieldsByName,
      });
      allFills.push(...ungroupedResult.fields);
      perGroupTierFills.set(
        '__ungrouped__',
        addTierCounts(perGroupTierFills.get('__ungrouped__') ?? emptyTierCount(), ungroupedResult.tierFills),
      );
    }

    // Step 3: critic pass — only over web-tier fills.
    // Stamp the returned verdicts onto each web-fill's meta BEFORE the writer
    // sees it. Phase 1 doesn't drop fills based on verdict — UI/downstream
    // consumers filter by criticVerdict.
    const webFills = allFills.filter(f => f.meta.source === 'web_search');
    if (webFills.length > 0) {
      const criticResult = await deps.runCriticOverWebFills({ lead: enrichedLead, fills: webFills });
      for (const fill of webFills) {
        const verdict = criticResult.verdicts[fill.field];
        if (verdict) {
          fill.meta = { ...fill.meta, criticVerdict: verdict };
        }
      }
    }
  } catch (err) {
    return {
      fills: [],
      perGroupTierFills,
      failureCategory: 'llmOrParse',
      apolloOrgFailed: apolloCtx.orgFetchFailed,
      apolloPersonFailed: apolloCtx.personFetchFailed,
    };
  }

  return {
    fills: allFills,
    perGroupTierFills,
    failureCategory: null,
    apolloOrgFailed: apolloCtx.orgFetchFailed,
    apolloPersonFailed: apolloCtx.personFetchFailed,
  };
}

async function writeLeadOutcome(
  lead: LeadRecord,
  outcome: PerLeadOutcome,
  input: RunEnrichmentInput,
  deps: OrchestratorDeps,
): Promise<{ ok: true } | { ok: false; reason: 'update' }> {
  if (input.mode === 'preview') return { ok: true };
  const { fillIfEmpty, alwaysOverwrite } = bucketByOverwritePolicy(lead, outcome.fills, input.config);

  // Split each fill by destination — standard CRM columns write to the lead's
  // top-level attributes (so values appear in the same column shown in the
  // lead table); custom fields write to the customFields map.
  const splitBucket = (fills: FieldFill[]) => {
    const topLevel: Record<string, string> = {};
    const customFields: Record<string, string> = {};
    const enrichmentMetadata: Record<string, EnrichedFieldMeta> = {};
    for (const f of fills) {
      if (STANDARD_LEAD_COLUMNS.has(f.field)) {
        topLevel[f.field] = f.value;
      } else {
        customFields[f.field] = f.value;
      }
      enrichmentMetadata[f.field] = f.meta;
    }
    return { topLevel, customFields, enrichmentMetadata };
  };

  try {
    if (fillIfEmpty.length > 0) {
      const split = splitBucket(fillIfEmpty);
      await deps.setLeadFields({
        listId: input.listId,
        leadId: lead.leadId,
        topLevel: split.topLevel,
        customFields: split.customFields,
        enrichmentMetadata: split.enrichmentMetadata,
        // `fill_if_empty` is now enforced app-side by `leadValueIsEmpty`
        // (treats both missing and empty-string as empty). We can write
        // unconditionally at DDB level — bucketByOverwritePolicy already
        // dropped fields where the lead has a non-empty value.
        ifNotExists: false,
      });
    }

    if (alwaysOverwrite.length > 0) {
      const split = splitBucket(alwaysOverwrite);
      await deps.setLeadFields({
        listId: input.listId,
        leadId: lead.leadId,
        topLevel: split.topLevel,
        customFields: split.customFields,
        enrichmentMetadata: split.enrichmentMetadata,
        ifNotExists: false,
      });
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: 'update' };
  }
}

// ─── Public entry ─────────────────────────────────────────────────────────────

export async function runEnrichment(
  input: RunEnrichmentInput,
  deps: OrchestratorDeps,
): Promise<RunEnrichmentResult> {
  const runId = randomUUID();
  const startedAt = Date.now();

  const leads = await deps.loadLeads({ listId: input.listId, userId: input.userId });

  const { routing, needsPerson, needsCompany } = routeFields(input.config);
  const refreshSet = buildRefreshFieldsSet(input.refreshFields);
  const configFieldsByName: Record<string, EnrichmentFieldConfig> = {};
  for (const f of input.config.fields) configFieldsByName[f.name] = f;

  const tierBreakdown: Record<string, TierCount> = {};
  const previewSamples: NonNullable<RunEnrichmentResult['preview']> = [];
  let processed = 0;
  let identityResolutionFailed = 0;
  let apolloFailed = 0;
  let llmOrParseFailed = 0;
  let searchWebFailed = 0;
  let updateFailed = 0;

  // Process up to 20 leads in parallel (matches v2 web-mode setting).
  const CONCURRENCY = 20;
  // Phase 1 keeps the loop simple — slice by chunks to bound concurrency.
  // (A semaphore-based approach is the obvious upgrade if needed.)
  for (let i = 0; i < leads.length; i += CONCURRENCY) {
    const chunk = leads.slice(i, i + CONCURRENCY);
    const outcomes = await Promise.all(
      chunk.map(lead =>
        processLead(
          lead, input, deps, routing, needsPerson, needsCompany, refreshSet, configFieldsByName,
        ).then(outcome => ({ lead, outcome })),
      ),
    );

    for (const { lead, outcome } of outcomes) {
      // Apollo failures are independent of pass/fail — count them regardless of outcome.
      if (outcome.apolloOrgFailed) apolloFailed += 1;
      if (outcome.apolloPersonFailed) apolloFailed += 1;

      // Aggregate tier counts only on success or partial success — failed leads
      // (identity / waterfall errors) contribute nothing useful to the breakdown.
      if (outcome.failureCategory === null) {
        for (const [groupName, counts] of outcome.perGroupTierFills.entries()) {
          tierBreakdown[groupName] = addTierCounts(tierBreakdown[groupName] ?? emptyTierCount(), counts);
        }
      }

      switch (outcome.failureCategory) {
        case 'identityResolution':
          identityResolutionFailed += 1;
          continue;
        case 'llmOrParse':
          llmOrParseFailed += 1;
          continue;
        case 'searchWeb':
          searchWebFailed += 1;
          continue;
        case 'update':
          updateFailed += 1;
          continue;
        case null:
          break;     // success path falls through
      }

      if (input.mode === 'preview') {
        const extractedFields: Record<string, string> = {};
        const meta: Record<string, EnrichedFieldMeta> = {};
        for (const f of outcome.fills) {
          extractedFields[f.field] = f.value;
          meta[f.field] = f.meta;
        }
        previewSamples.push({ leadId: lead.leadId, extractedFields, meta });
        processed += 1;
      } else {
        const writeResult = await writeLeadOutcome(lead, outcome, input, deps);
        if (writeResult.ok) {
          processed += 1;
        } else {
          updateFailed += 1;
        }
      }
    }
  }

  // Compute total rollup
  const total = Object.values(tierBreakdown).reduce(
    (acc, x) => addTierCounts(acc, x),
    emptyTierCount(),
  );

  const result: RunEnrichmentResult = {
    runId,
    processed,
    failed: {
      identityResolutionFailed,
      apolloFailed,
      llmOrParseFailed,
      updateFailed,
      searchWebFailed,
    },
    tierFillBreakdown: { total, ...tierBreakdown },
    durationMs: Date.now() - startedAt,
  };

  if (input.mode === 'preview') {
    result.preview = previewSamples;
  }

  return result;
}
