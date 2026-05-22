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
import { normalizeFills } from './enrichmentNormalizer';
import { FIELD_GROUPS } from './enrichmentGroups';
import type { LeadRecord, SocketEmitFn } from './crmEnrichmentService';
import type { EnrichedFieldMeta } from '../utils/enrichedFieldValue';
import type { ResolveIdentityResult } from './enrichmentIdentityResolver';
import {
  buildSiblingFieldMappingTable,
  copySiblingConfigFields,
  type SiblingFieldMappingTable,
} from './enrichmentSiblingConfigFields';
import { mergeCustomFields } from '../utils/customFieldsGuard';
import { STANDARD_ENRICHABLE_FIELDS } from './enrichmentConfigService';

// ─── Socket progress options ─────────────────────────────────────────────────
//
// Phase 1b — emit live progress + completion events so the customer-portal
// CRM page can show a progress banner and a final toast (mirrors the v2
// `crm-enrichment-progress` / `crm-enrichment-complete` contract).
export interface RunEnrichmentOptions {
  /** User-scoped — events are always emitted to `user:${userId}` for the CRM
   *  page's persistent socket listener. Required when socketEmit is given. */
  userId?: string;
  /** Optional explicit socket id. When present, events also go to that room
   *  (matches v2 behavior for the dialog that initiated the run). */
  socketId?: string;
  /** Injected by callers (route handler or tests). When omitted the service
   *  emits no events — keeps unit tests silent and unblocks back-compat. */
  socketEmit?: SocketEmitFn;
  progressEvent?: string;
  completeEvent?: string;
}

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
  /**
   * Natural-language condition set by the user. Presence marks this as a
   * "smart field" — its value is COMPUTED in the POST phase using enriched
   * dependency field values, never fetched directly from a data source.
   * Populated at config-save time by LLM classification; never sent by client.
   */
  smartCondition?: string;
  /**
   * Canonical FIELD_GROUPS names needed to evaluate this smart field's condition.
   * Dependencies absent from the user's config are auto-injected into the
   * regular enrichment run so they exist before POST evaluation.
   * Populated at config-save time alongside smartCondition.
   */
  smartDependencies?: string[];
  /**
   * The instruction text that was last classified as NOT a smart field.
   * When this equals the current instruction, classification is skipped
   * (LLM already determined this is a regular field with this exact instruction).
   * Populated at config-save time; never sent by client.
   */
  notSmartInstruction?: string;
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
  /** Optional filter — when provided and non-empty, only leads whose
   *  `leadId` is in this set get enriched. Used by the bulk-action bar
   *  "Enrichment" button to scope a run to the user's selection. */
  leadIds?: string[];
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
  /** When `leadIds` is set and non-empty, the dep must return only those
   *  leads (real impl uses BatchGetItem). When undefined/empty the dep
   *  returns every lead in the list. The orchestrator does not re-filter. */
  loadLeads(input: {
    listId: string;
    userId: string;
    leadIds?: string[];
  }): Promise<LeadRecord[]>;

  resolveIdentity(input: {
    listId: string;
    lead: LeadRecord;
    needsPersonFields: boolean;
    needsCompanyFields: boolean;
    mode: 'preview' | 'enrich';
    /** Forwarded to enable Tier 0a (CRM-history) per-field bypass. */
    refreshFields?: Set<string>;
  }): Promise<ResolveIdentityResult>; // success result now includes `siblings` for Tier 0b

  runWaterfall(input: {
    listId: string;
    lead: LeadRecord;
    groupName: string;
    requestedFields: string[];
    configFieldsByName: Record<string, { instruction?: string } | undefined>;
    apolloCtx: ApolloFetchContext;
    refreshFields: Set<string>;
    leadHint?: { listId: string; leadId: string };
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

  /**
   * Evaluate a smart field's natural-language condition given the lead's
   * enriched dependency values. Called once per (lead, smart field) in the
   * POST phase, after all regular waterfall fills are available.
   * Must fail soft — return { value: null } on error rather than throwing.
   */
  evaluateSmartField(input: {
    lead: LeadRecord;
    fieldName: string;
    condition: string;
    /** Canonical dep name → enriched value, gathered from waterfall fills
     *  and the lead's existing field data. */
    depValues: Record<string, string>;
  }): Promise<{ value: string | null; reasoning: string; model?: string }>;
}

/** Standard CRM lead columns — values for these field names go to top-level
 *  AW-Leads attributes via setLeadFields.topLevel (not customFields). Derived
 *  from STANDARD_ENRICHABLE_FIELDS plus `website` — a genuine top-level
 *  AW-Leads column that is not part of the enrichable-fields list. */
const STANDARD_LEAD_COLUMNS = new Set<string>([...STANDARD_ENRICHABLE_FIELDS, 'website']);

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
  groupedByGroup: Map<string, string[]>;     // groupName → CANONICAL field names (deduped)
  ungrouped: string[];                       // user-facing names (no canonical analog)
  /** Map from canonical name (what the waterfall sees) → list of user-facing
   *  names to fan the fill out to. Multiple user fields may alias the same
   *  canonical (e.g. legacy lists with both `company` and `company_name`);
   *  one canonical fill becomes one fill per user name. */
  userNamesByCanonical: Map<string, string[]>;
}

function routeFields(
  config: EnrichmentConfig,
): { routing: FieldRouting; needsPerson: boolean; needsCompany: boolean } {
  const groupedByGroup = new Map<string, string[]>();
  const ungrouped: string[] = [];
  const userNamesByCanonical = new Map<string, string[]>();

  for (const field of config.fields) {
    if (!field.include) continue;
    if (field.smartCondition) continue;  // smart fields evaluated in POST phase, not fetched
    // Canonical for routing: prefer explicit aliasFor; otherwise the field's own name.
    const canonical = field.aliasFor || field.name;
    let assigned = false;
    for (const [groupName, groupCfg] of Object.entries(FIELD_GROUPS)) {
      if (groupCfg.fields.includes(canonical)) {
        if (!groupedByGroup.has(groupName)) groupedByGroup.set(groupName, []);
        const groupFields = groupedByGroup.get(groupName)!;
        if (!groupFields.includes(canonical)) groupFields.push(canonical);
        const userNames = userNamesByCanonical.get(canonical) ?? [];
        if (!userNames.includes(field.name)) userNames.push(field.name);
        userNamesByCanonical.set(canonical, userNames);
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

  return { routing: { groupedByGroup, ungrouped, userNamesByCanonical }, needsPerson, needsCompany };
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

// Minimal counting semaphore — limits concurrent async operations to `max`.
class Semaphore {
  private count: number;
  private readonly queue: Array<() => void> = [];
  constructor(private readonly max: number) { this.count = max; }
  acquire(): Promise<void> {
    if (this.count > 0) { this.count--; return Promise.resolve(); }
    return new Promise(resolve => this.queue.push(resolve));
  }
  release(): void {
    const next = this.queue.shift();
    if (next) { next(); } else { this.count++; }
  }
}

// Max concurrent smart-field LLM eval calls across all leads in a single run.
// 20 leads × N smart fields can fan out to 20×N calls without this cap.
const SMART_EVAL_CONCURRENCY = 15;

interface ProcessLeadContext {
  input: RunEnrichmentInput;
  deps: OrchestratorDeps;
  routing: FieldRouting;
  needsPerson: boolean;
  needsCompany: boolean;
  refreshSet: Set<string>;
  configFieldsByName: Record<string, EnrichmentFieldConfig>;
  siblingMappingTable: SiblingFieldMappingTable;
  smartFields: EnrichmentFieldConfig[];
  injectedDepNames: Set<string>;
  smartEvalSemaphore: Semaphore;
}

async function processLead(
  lead: LeadRecord,
  ctx: ProcessLeadContext,
): Promise<PerLeadOutcome> {
  const { input, deps, routing, needsPerson, needsCompany, refreshSet, configFieldsByName, siblingMappingTable, smartFields, injectedDepNames, smartEvalSemaphore } = ctx;
  const perGroupTierFills = new Map<string, TierCount>();
  const allFills: FieldFill[] = [];
  const apolloCtx = createApolloFetchContext();
  const leadStart = Date.now();
  console.log(`[v3][lead ${lead.leadId}] start (email=${lead.email ?? '∅'}, company=${lead.company ?? '∅'})`);

  // Step 0: identity resolution
  let identity: ResolveIdentityResult;
  const idStart = Date.now();
  try {
    identity = await deps.resolveIdentity({
      listId: input.listId,
      lead,
      needsPersonFields: needsPerson,
      needsCompanyFields: needsCompany,
      mode: input.mode,
      refreshFields: refreshSet,
    });
    console.log(`[v3][lead ${lead.leadId}] identity resolved in ${Date.now() - idStart}ms (ok=${identity.ok})`);
  } catch (err) {
    console.log(`[v3][lead ${lead.leadId}] identity threw after ${Date.now() - idStart}ms: ${(err as Error).message}`);
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
    console.log(`[v3][lead ${lead.leadId}] identity unresolved → skipping`);
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

  // Tier 0b — sibling config-field copy. Uses siblings already fetched by
  // resolveIdentity (zero extra DDB queries). Fills config-requested custom
  // fields from siblings before the waterfall runs, potentially skipping
  // Apollo/web calls entirely for fields already present in the system.
  const tier0bResult = copySiblingConfigFields(
    enrichedLead,
    identity.siblings,
    input.config.fields,
    siblingMappingTable,
    refreshSet,
  );
  if (tier0bResult.fills.length > 0) {
    allFills.push(...tier0bResult.fills.map(f => ({
      field: f.field,
      value: f.value,
      meta: f.meta,
    })));
    // Merge into enrichedLead so waterfall sees these fields as already filled
    for (const f of tier0bResult.fills) {
      if ((enrichedLead as any)[f.field] !== undefined) {
        (enrichedLead as any)[f.field] = f.value;
      } else {
        enrichedLead.customFields = mergeCustomFields(
          enrichedLead.customFields,
          { [f.field]: f.value },
          { source: 'crmEnrichmentV3.tier0b', listId: input.listId, leadId: lead.leadId },
        );
      }
    }
    console.log(`[v3][lead ${lead.leadId}] tier0b filled ${tier0bResult.fills.length} config field(s) from siblings`);
  }

  // Steps 1–3: waterfall + ungrouped + critic, wrapped together so any
  // mid-pipeline error is captured as llmOrParseFailed for this lead.
  try {
    // Step 1: canonical groups (SEQUENTIAL — preserves Apollo ctx memoization
    // without promise-caching; design §6)
    for (const [groupName, fields] of routing.groupedByGroup.entries()) {
      const gStart = Date.now();
      console.log(`[v3][lead ${lead.leadId}] waterfall group=${groupName} fields=${fields.join(',')} START`);
      const groupResult = await deps.runWaterfall({
        listId: input.listId,
        lead: enrichedLead,
        groupName,
        requestedFields: fields,
        configFieldsByName,
        apolloCtx,
        refreshFields: refreshSet,
        leadHint: { listId: input.listId, leadId: lead.leadId },
      });
      // Translate each fill from CANONICAL field name back to the user's
      // chosen names. e.g. waterfall fills `funding_stage` but the user
      // named the field `stag` (via aliasFor) — we store under `stag`.
      // Legacy lists may have multiple user fields aliased to the same
      // canonical (e.g. both `company` and `company_name`), so one
      // canonical fill fans out to every user-facing name.
      const renamedFills: typeof groupResult.fields = [];
      for (const fill of groupResult.fields) {
        const userNames = routing.userNamesByCanonical.get(fill.field) ?? [fill.field];
        for (const userName of userNames) {
          renamedFills.push(userName === fill.field ? fill : { ...fill, field: userName });
        }
      }
      allFills.push(...renamedFills);
      perGroupTierFills.set(
        groupName,
        addTierCounts(perGroupTierFills.get(groupName) ?? emptyTierCount(), groupResult.tierFills),
      );
      console.log(`[v3][lead ${lead.leadId}] waterfall group=${groupName} done in ${Date.now() - gStart}ms (fills=${groupResult.fields.length}, tier=${JSON.stringify(groupResult.tierFills)})`);
    }

    // Step 2: ungrouped fields (web only — no canonical group means no Apollo
    // direct-map; LLM extracts using the field's instruction)
    if (routing.ungrouped.length > 0) {
      const ugStart = Date.now();
      console.log(`[v3][lead ${lead.leadId}] ungrouped-web START fields=${routing.ungrouped.join(',')}`);
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
      console.log(`[v3][lead ${lead.leadId}] ungrouped-web done in ${Date.now() - ugStart}ms (fills=${ungroupedResult.fields.length})`);
    }

    // Step 3: critic pass — only over web-tier fills.
    // Stamp the returned verdicts onto each web-fill's meta BEFORE the writer
    // sees it. Phase 1 doesn't drop fills based on verdict — UI/downstream
    // consumers filter by criticVerdict.
    const webFills = allFills.filter(f => f.meta.source === 'web_search');
    if (webFills.length > 0) {
      const cStart = Date.now();
      console.log(`[v3][lead ${lead.leadId}] critic START over ${webFills.length} web-fill(s)`);
      const criticResult = await deps.runCriticOverWebFills({ lead: enrichedLead, fills: webFills });
      for (const fill of webFills) {
        const verdict = criticResult.verdicts[fill.field];
        if (verdict) {
          fill.meta = { ...fill.meta, criticVerdict: verdict };
        }
      }
      console.log(`[v3][lead ${lead.leadId}] critic done in ${Date.now() - cStart}ms`);
    }
  } catch (err) {
    console.log(`[v3][lead ${lead.leadId}] processing threw after ${Date.now() - leadStart}ms: ${(err as Error).message}`);
    return {
      fills: [],
      perGroupTierFills,
      failureCategory: 'llmOrParse',
      apolloOrgFailed: apolloCtx.orgFetchFailed,
      apolloPersonFailed: apolloCtx.personFetchFailed,
    };
  }

  // Step 4: smart field POST evaluation — fail-soft per field, never fails the lead.
  // Runs AFTER the waterfall try/catch so a smart field error can't clobber the
  // regular fills already collected.
  if (smartFields.length > 0) {
    // Build a value map keyed by BOTH user-facing name and canonical alias so
    // dep lookups work regardless of how the user named the dep field.
    const fillValueMap: Record<string, string> = {};
    for (const fill of allFills) {
      fillValueMap[fill.field] = fill.value;
      const fieldCfg = configFieldsByName[fill.field];
      if (fieldCfg?.aliasFor) fillValueMap[fieldCfg.aliasFor] = fill.value;
    }
    // Reverse alias map: canonical name → user-facing field name(s) in workingConfig.
    // Needed because customFields is keyed by user-facing name, not canonical name.
    const canonicalToUserFieldName: Record<string, string> = {};
    for (const [fieldName, fieldCfg] of Object.entries(configFieldsByName)) {
      if (fieldCfg.aliasFor) canonicalToUserFieldName[fieldCfg.aliasFor] = fieldName;
    }

    // Fallback: pull dep values from the lead's existing fields (pre-run data).
    for (const sf of smartFields) {
      for (const dep of sf.smartDependencies ?? []) {
        if (fillValueMap[dep] != null && fillValueMap[dep].trim()) continue;
        // Check customFields by canonical name (injected deps) and by user-facing name (aliased fields).
        const customValDirect = enrichedLead.customFields?.[dep];
        const userFacingName = canonicalToUserFieldName[dep];
        const customValAlias = userFacingName ? enrichedLead.customFields?.[userFacingName] : undefined;
        const existing =
          (typeof customValDirect === 'string' && customValDirect.trim()) ? customValDirect :
          (typeof customValAlias === 'string' && customValAlias.trim()) ? customValAlias :
          null;
        if (existing) fillValueMap[dep] = existing;
      }
    }

    // Known limitation: smart fields cannot depend on other smart fields.
    // smartDependencies only accepts canonical FIELD_GROUPS names — user-field
    // names (including other smart fields like `isQualified`) are filtered out
    // at classification time. A smart field B whose instruction references
    // another smart field A will receive no value for A in its depValues, and
    // the LLM eval will likely return null. Fix requires a separate
    // `smartFieldDependencies` array + topological sort before this loop.
    for (const sf of smartFields) {
      const depValues: Record<string, string> = {};
      for (const dep of sf.smartDependencies ?? []) {
        if (fillValueMap[dep]) depValues[dep] = fillValueMap[dep];
      }
      // Skip eval when no dep data is available — LLM would return null anyway.
      const hasDeps = (sf.smartDependencies ?? []).length > 0;
      if (hasDeps && Object.keys(depValues).length === 0) {
        console.log(`[v3][lead ${lead.leadId}] smart-eval SKIP field=${sf.name} (no dep data)`);
        continue;
      }
      const smartStart = Date.now();
      console.log(`[v3][lead ${lead.leadId}] smart-eval START field=${sf.name} deps=${JSON.stringify(Object.keys(depValues))}`);
      await smartEvalSemaphore.acquire();
      try {
        const evalResult = await deps.evaluateSmartField({
          lead: enrichedLead,
          fieldName: sf.name,
          condition: sf.smartCondition!,
          depValues,
        });
        console.log(`[v3][lead ${lead.leadId}] smart-eval DONE field=${sf.name} value=${evalResult.value} in ${Date.now() - smartStart}ms`);
        if (evalResult.value !== null) {
          allFills.push({
            field: sf.name,
            value: evalResult.value,
            meta: {
              source: 'llm',
              enrichedAt: new Date().toISOString(),
              confidence: 'medium',
              ...(evalResult.model ? { provider: evalResult.model } : {}),
              ...(evalResult.reasoning ? { sourceQuote: evalResult.reasoning } : {}),
            },
          });
        }
      } catch (err) {
        // Fail soft — smart field miss never fails the whole lead.
        console.warn(`[v3][lead ${lead.leadId}] smart-eval failed for ${sf.name}: ${(err as Error).message}`);
      } finally {
        smartEvalSemaphore.release();
      }
    }
  }

  // Strip injected dep fills — they were never part of the user's config so should
  // not be persisted on the lead. allFills stays intact above for fillValueMap use.
  const writableFills = injectedDepNames.size > 0
    ? allFills.filter(f => !injectedDepNames.has(f.field))
    : allFills;

  console.log(`[v3][lead ${lead.leadId}] done in ${Date.now() - leadStart}ms (fills=${writableFills.length})`);
  return {
    fills: writableFills,
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
  runId: string,
): Promise<{ ok: true } | { ok: false; reason: 'update' }> {
  if (input.mode === 'preview') return { ok: true };
  const { fillIfEmpty, alwaysOverwrite } = bucketByOverwritePolicy(lead, outcome.fills, input.config);

  // Split each fill by destination — standard CRM columns write to the lead's
  // top-level attributes (so values appear in the same column shown in the
  // lead table); custom fields write to the customFields map. Every persisted
  // fill is stamped with this run's id so the field is traceable to the job
  // that produced it (V2-parity — see crmEnrichmentService.ts).
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
      enrichmentMetadata[f.field] = { ...f.meta, enrichedJobId: runId };
    }
    return { topLevel, customFields, enrichmentMetadata };
  };

  try {
    const allFills = [...fillIfEmpty, ...alwaysOverwrite];
    if (allFills.length > 0) {
      const split = splitBucket(allFills);
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
  options?: RunEnrichmentOptions,
): Promise<RunEnrichmentResult> {
  const runId = randomUUID();
  const startedAt = Date.now();

  const progressEvent = options?.progressEvent || 'crm-enrichment-progress';
  const completeEvent = options?.completeEvent || 'crm-enrichment-complete';
  const userRoom = options?.userId ? `user:${options.userId}` : null;
  const emitToRooms = (event: string, payload: any) => {
    if (!options?.socketEmit) return;
    if (options.socketId) options.socketEmit(options.socketId, event, payload);
    if (userRoom) options.socketEmit(userRoom, event, payload);
  };

  console.log(`[v3] runEnrichment START listId=${input.listId} userId=${input.userId} mode=${input.mode} runId=${runId}`);
  const loadStart = Date.now();
  // Treat empty leadIds as "no filter" so callers can pass an empty array
  // without unexpectedly enriching zero leads.
  const leadIdsFilter = input.leadIds && input.leadIds.length > 0 ? input.leadIds : undefined;
  const leads = await deps.loadLeads({
    listId: input.listId,
    userId: input.userId,
    leadIds: leadIdsFilter,
  });
  console.log(`[v3] loadLeads → ${leads.length} lead(s) in ${Date.now() - loadStart}ms (leadIds filter: ${leadIdsFilter ? leadIdsFilter.length : 'none'})`);

  // ─── PRE: smart field analysis ────────────────────────────────────────────────
  // Separate smart fields (computed/derived) from normal fields (fetchable).
  // Smart fields are excluded from the regular enrichment routing; their
  // dependency canonical fields are injected as synthetic fields so the
  // waterfall populates them, then the POST phase evaluates the smart fields.
  //
  // Limitation: smart field chaining is NOT supported. A smart field can only
  // depend on canonical FIELD_GROUPS data fields (funding_stage, employee_count,
  // etc.) — it cannot depend on another smart field's computed output. See the
  // POST eval loop below and enrichmentConfigService validDeps filter for detail.
  const smartFields = input.config.fields.filter(f => f.smartCondition && f.include);

  // Canonical names already covered by the user's non-smart config fields.
  const existingCanonicals = new Set<string>();
  for (const f of input.config.fields) {
    if (f.smartCondition) continue;
    existingCanonicals.add(f.aliasFor ?? f.name);
  }

  // Deps not yet in the config → inject as synthetic fields (canonical name,
  // empty instruction, fill_if_empty policy, result stays on the lead).
  // fill_if_empty is intentional: if the lead already has the dep value,
  // the waterfall skips it and the fillValueMap fallback reads it from
  // enrichedLead.customFields instead — that path is load-bearing.
  // Injected fills are stripped before writeLeadOutcome (writableFills filter).
  const injectedDepNames = new Set<string>();
  const injectedDeps: EnrichmentFieldConfig[] = [];
  for (const sf of smartFields) {
    for (const dep of sf.smartDependencies ?? []) {
      if (!existingCanonicals.has(dep) && !injectedDepNames.has(dep)) {
        injectedDeps.push({
          name: dep,
          type: 'string',
          instruction: '',
          include: true,
          overwritePolicy: 'fill_if_empty',
        });
        injectedDepNames.add(dep);
      }
    }
  }

  // Working config: smart fields removed, injected deps added.
  // Used for routing + waterfall; writeLeadOutcome still uses input.config
  // so smart field overwrite policies are respected.
  const workingConfig: EnrichmentConfig =
    smartFields.length === 0 && injectedDeps.length === 0
      ? input.config
      : {
          ...input.config,
          fields: [
            ...input.config.fields.filter(f => !f.smartCondition),
            ...injectedDeps,
          ],
        };

  if (injectedDeps.length > 0) {
    console.log(`[v3] injected ${injectedDeps.length} smart-field dep(s): ${injectedDeps.map(d => d.name).join(',')}`);
  }
  // ─────────────────────────────────────────────────────────────────────────────

  const { routing, needsPerson, needsCompany } = routeFields(workingConfig);
  const refreshSet = buildRefreshFieldsSet(input.refreshFields);

  // Build sibling field mapping table once per run (one LLM call for unaliased
  // fields, canonical match is free). Passed to every processLead call. Skipped
  // entirely when there are no leads — no processLead would consume it.
  const siblingMappingTable: SiblingFieldMappingTable = leads.length > 0
    ? await buildSiblingFieldMappingTable(workingConfig.fields)
    : { canonical: new Map(), llm: new Map() };
  const configFieldsByName: Record<string, EnrichmentFieldConfig> = {};
  const fieldAliasMap: Record<string, string> = {};
  for (const f of workingConfig.fields) {
    configFieldsByName[f.name] = f;
    if (f.aliasFor) fieldAliasMap[f.name] = f.aliasFor;
  }

  const includedFieldNames = workingConfig.fields
    .filter(f => f.include)
    .map(f => f.name);

  const tierBreakdown: Record<string, TierCount> = {};
  const previewSamples: NonNullable<RunEnrichmentResult['preview']> = [];
  let processed = 0;
  let identityResolutionFailed = 0;
  let apolloFailed = 0;
  let llmOrParseFailed = 0;
  let updateFailed = 0;

  emitToRooms(progressEvent, {
    runId,
    listId: input.listId,
    message: 'Starting enrichment...',
    progress: 0,
    processedCount: 0,
    failedCount: 0,
    totalToProcess: leads.length,
  });

  // Process up to 20 leads in parallel (matches v2 web-mode setting).
  const CONCURRENCY = 20;
  // Per-lead progress counter so the UI bar moves while a chunk is in flight,
  // not only between chunks. (For small lists with 1 chunk, this is the
  // difference between a frozen 0% banner and visible progress.)
  let completedLeads = 0;
  const emitPerLeadProgress = () => {
    completedLeads += 1;
    emitToRooms(progressEvent, {
      runId,
      listId: input.listId,
      message: `Processed ${completedLeads}/${leads.length} lead${leads.length === 1 ? '' : 's'}`,
      progress: leads.length === 0 ? 100 : Math.round((completedLeads / leads.length) * 100),
      processedCount: completedLeads,
      failedCount: 0,
      totalToProcess: leads.length,
    });
  };

  // Phase 1 keeps the loop simple — slice by chunks to bound concurrency.
  // (A semaphore-based approach is the obvious upgrade if needed.)
  const leadCtx: ProcessLeadContext = {
    input, deps, routing, needsPerson, needsCompany, refreshSet,
    configFieldsByName, siblingMappingTable, smartFields, injectedDepNames,
    smartEvalSemaphore: new Semaphore(SMART_EVAL_CONCURRENCY),
  };
  for (let i = 0; i < leads.length; i += CONCURRENCY) {
    const chunk = leads.slice(i, i + CONCURRENCY);
    const outcomes = await Promise.all(
      chunk.map(lead =>
        processLead(lead, leadCtx).then(outcome => {
          emitPerLeadProgress();
          return { lead, outcome };
        }),
      ),
    );

    // Pass 1 — tally counters and collect the leads that need a DB write.
    // Counting is cheap and order-independent; the writes are the expensive
    // part and are issued concurrently in pass 2.
    const pendingWrites: Array<{ lead: LeadRecord; outcome: PerLeadOutcome }> = [];
    for (const { lead, outcome } of outcomes) {
      // Apollo failures are independent of pass/fail — count them regardless of outcome.
      if (outcome.apolloOrgFailed || outcome.apolloPersonFailed) apolloFailed += 1;

      // Aggregate tier counts only on success — failed leads contribute nothing.
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
        case 'update':
          updateFailed += 1;
          continue;
        case null:
          break;     // success path falls through
      }

      outcome.fills = normalizeFills(outcome.fills, fieldAliasMap);

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
        pendingWrites.push({ lead, outcome });
      }
    }

    // Pass 2 — issue all writes for this chunk concurrently. Each write is an
    // independent per-leadId DynamoDB update, so there is no ordering hazard.
    if (pendingWrites.length > 0) {
      const writeResults = await Promise.all(
        pendingWrites.map(async ({ lead, outcome }) => {
          const wStart = Date.now();
          const writeResult = await writeLeadOutcome(lead, outcome, input, deps, runId);
          console.log(`[v3][lead ${lead.leadId}] write in ${Date.now() - wStart}ms (ok=${writeResult.ok})`);
          return writeResult;
        }),
      );
      for (const writeResult of writeResults) {
        if (writeResult.ok) {
          processed += 1;
        } else {
          updateFailed += 1;
        }
      }
    }

    const completedSoFar = Math.min(i + CONCURRENCY, leads.length);
    const failedSoFar =
      identityResolutionFailed + llmOrParseFailed + updateFailed;
    emitToRooms(progressEvent, {
      runId,
      listId: input.listId,
      message: `Enriching ${completedSoFar}/${leads.length} (${processed} enriched, ${failedSoFar} failed)`,
      progress: leads.length === 0 ? 100 : Math.round((completedSoFar / leads.length) * 100),
      processedCount: processed,
      failedCount: failedSoFar,
      totalToProcess: leads.length,
    });
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
      // v3 treats web-fetch failures as soft degradations — affected fields
      // fall through to 'missing' rather than failing the lead — so there is
      // no hard web-failure count. Kept at 0 for result-shape parity with the
      // v2 path and the customer-portal failure-breakdown UI.
      searchWebFailed: 0,
    },
    tierFillBreakdown: { total, ...tierBreakdown },
    durationMs: Date.now() - startedAt,
  };

  if (input.mode === 'preview') {
    result.preview = previewSamples;
  }

  const totalFailed =
    identityResolutionFailed + llmOrParseFailed + updateFailed;
  console.log(`[v3] runEnrichment DONE runId=${runId} processed=${processed} failed=${totalFailed} durationMs=${result.durationMs}`);
  emitToRooms(completeEvent, {
    runId,
    listId: input.listId,
    processedCount: processed,
    failedCount: totalFailed,
    outputFields: includedFieldNames,
    failureBreakdown: result.failed,
    tierFillBreakdown: result.tierFillBreakdown,
    durationMs: result.durationMs,
  });

  return result;
}
