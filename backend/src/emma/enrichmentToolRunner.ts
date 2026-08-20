// Emma enrichment runner: builds + processes a V3 config, runs the V3
// engine, and maps the result to an Emma-friendly summary. Also provides
// lead-set helpers (preview sampling, execute cap resolution).

import { processEnrichmentConfig } from '../services/enrichmentConfigService';
import { buildConfigProcessingDeps } from '../services/enrichmentConfigDeps';
import { runEnrichment, type RunEnrichmentResult } from '../services/crmEnrichmentServiceV3';
import { buildOrchestratorDeps } from '../services/enrichmentV3RealDeps';
import { CrmEnrichmentService, type SocketEmitFn } from '../services/crmEnrichmentService';
import { buildRawEnrichmentConfig, type EmmaEnrichmentOutputField } from './enrichmentToolConfig';
import { normalizeOutputFields, type FieldRemap } from './enrichmentFieldNormalizer';
import { fieldVerificationStatus, fieldProvenanceBadge } from '../utils/enrichedFieldValue';

/**
 * Build the list-level disambiguation context string from a lead list record.
 * Combines the list name and description (e.g. "YC Poker Night — YC alumni")
 * so identity resolution can disambiguate a name-only lead via shared
 * affiliation. Returns undefined when neither is present. Bounded to a short
 * string so it stays a useful search-keyword suffix rather than a paragraph.
 */
export function buildListContext(list: any): string | undefined {
  const name = typeof list?.name === 'string' ? list.name.trim() : '';
  const description = typeof list?.description === 'string' ? list.description.trim() : '';
  const combined = [name, description].filter(Boolean).join(' — ').trim();
  if (!combined) return undefined;
  return combined.length > 200 ? combined.slice(0, 200) : combined;
}

/** Emma-facing summary of a V3 enrichment run. */
export interface EmmaEnrichmentSummary {
  runId: string;
  mode: 'preview' | 'enrich';
  processedCount: number;
  failedCount: number;
  failureBreakdown: RunEnrichmentResult['failed'];
  durationMs: number;
  warnings: string[];
  samples?: Array<{
    leadId: string;
    enrichedFields: Record<string, string>;
    /** Fields whose value is low-confidence / unverified (web-sourced or
     *  critic-flagged) and should be caveated rather than stated as fact.
     *  Empty array means every populated field is high-confidence/verified. */
    unverifiedFields: string[];
    /** Per-field provenance for the unverified fields, so Emma can name WHY a
     *  value is unverified (ENG-122): 'ai-knowledge' = asserted from the model's
     *  own training memory (no source); 'web-unverified' = from a web source the
     *  fact-check couldn't confirm. Omitted when no field carries a badge. */
    unverifiedProvenance?: Record<string, 'web-unverified' | 'ai-knowledge'>;
  }>;
  /** Field renames applied before building the config (synonym/alias normalization). */
  fieldRemaps?: FieldRemap[];
}

export interface RunEmmaEnrichmentParams {
  listId: string;
  userId: string;
  outputFields: EmmaEnrichmentOutputField[];
  mode: 'preview' | 'enrich';
  leadIds?: string[];
  socketId?: string;
  socketEmit?: SocketEmitFn;
}

/**
 * Process an Emma enrichment request through the V3 engine. Builds the raw
 * config, processes it (alias resolution + smart-field classification +
 * validation — may throw ConfigValidationError), runs V3, and maps the
 * result. Logs one engine-tagged line per run for observability.
 */
export async function runEmmaEnrichment(
  params: RunEmmaEnrichmentParams,
): Promise<EmmaEnrichmentSummary> {
  // Access check (ENG-1049): this was previously missing entirely — not even a
  // same-org check — so any authenticated user who could get a list_id in front
  // of Emma could trigger enrichment writes on it. 'preview' doesn't persist, so
  // it's gated by the read-level guard (still honours crm.enabled); 'enrich'
  // writes field values, so it requires owner/org-owner/crm.editor.
  const { crmDb } = await import('../services/db');
  let accessList: any;
  try {
    accessList = await crmDb.getLeadListById(params.listId);
  } catch (err) {
    // Fail closed — unlike the field-normalization lookup below, an access-check
    // failure must never silently allow the write to proceed.
    throw new Error('Failed to verify list access');
  }
  if (!accessList) {
    throw new Error('Lead list not found');
  }
  const { canAccessCrmList, canDestructiveCrmList, CRM_EDITOR_REQUIRED_MESSAGE } = await import('../services/crmAccessControl');
  const hasAccess = params.mode === 'preview'
    ? await canAccessCrmList(params.userId, accessList)
    : await canDestructiveCrmList(params.userId, accessList);
  if (!hasAccess) {
    throw new Error(CRM_EDITOR_REQUIRED_MESSAGE);
  }

  // Normalize field names: map synonyms onto existing standard/custom columns to
  // avoid creating duplicates. Fail soft — if the list lookup throws, proceed
  // with the original output_fields unchanged (enrichment must never be blocked).
  let effectiveOutputFields = params.outputFields;
  let remaps: FieldRemap[] = [];
  let listContext: string | undefined;
  try {
    const existingFieldNames: string[] = Array.isArray(accessList?.fieldNames) ? accessList.fieldNames : [];
    const normalized = normalizeOutputFields(params.outputFields, existingFieldNames);
    effectiveOutputFields = normalized.fields;
    remaps = normalized.remaps;
    listContext = buildListContext(accessList);
  } catch (err) {
    console.warn(
      `[emma-enrich] Failed to fetch list fieldNames for normalization (listId=${params.listId}); ` +
      `proceeding with original output_fields. Error: ${err}`,
    );
  }

  const rawConfig = buildRawEnrichmentConfig(effectiveOutputFields, params.userId);
  const { config, warnings } = await processEnrichmentConfig(
    { listId: params.listId, userId: params.userId, config: rawConfig },
    buildConfigProcessingDeps(),
  );

  const deps = buildOrchestratorDeps(params.userId);
  const result = await runEnrichment(
    {
      listId: params.listId,
      userId: params.userId,
      config,
      mode: params.mode,
      leadIds: params.leadIds,
      listContext,
    },
    deps,
    { userId: params.userId, socketId: params.socketId, socketEmit: params.socketEmit },
  );

  const failedCount = Object.values(result.failed).reduce((a, b) => a + b, 0);

  // Observability: engine-tagged line so we can confirm Emma traffic is on V3.
  console.log(
    `[emma-enrich] engine=v3 runId=${result.runId} listId=${params.listId} ` +
    `userId=${params.userId} mode=${params.mode} leads=${result.processed} ` +
    `fields=${effectiveOutputFields.length} failed=${failedCount} durationMs=${result.durationMs}`,
  );

  const summary: EmmaEnrichmentSummary = {
    runId: result.runId,
    mode: params.mode,
    processedCount: result.processed,
    failedCount,
    failureBreakdown: result.failed,
    durationMs: result.durationMs,
    warnings,
  };
  if (params.mode === 'preview' && Array.isArray(result.preview)) {
    summary.samples = result.preview.map(p => {
      const meta = p.meta ?? {};
      // Flag each populated field that is low-confidence / unverified so Emma
      // can caveat it (the Slashy funding_stage bug) instead of asserting it.
      const unverifiedFields = Object.keys(p.extractedFields).filter(
        field => fieldVerificationStatus(meta[field]) === 'unverified',
      );
      // Name WHY each unverified field is unverified so Emma can caveat it
      // specifically — AI-knowledge (model memory) vs an unconfirmed web source.
      const unverifiedProvenance: Record<string, 'web-unverified' | 'ai-knowledge'> = {};
      for (const field of unverifiedFields) {
        const badge = fieldProvenanceBadge(meta[field]);
        if (badge) unverifiedProvenance[field] = badge;
      }
      return {
        leadId: p.leadId,
        enrichedFields: p.extractedFields,
        unverifiedFields,
        ...(Object.keys(unverifiedProvenance).length > 0 ? { unverifiedProvenance } : {}),
      };
    });
  }
  if (remaps.length > 0) {
    summary.fieldRemaps = remaps;
  }
  return summary;
}

/** Select 2 representative sample leads for a preview run. Prefers leads
 *  with identity data (email or linkedin) so the preview shows useful
 *  results. A placeholder/test address (queue-verify@example.com) is not
 *  identity data — such a row can never be enriched (ENG-968), and sampling
 *  two of them makes an otherwise-enrichable list look unenrichable. Falls
 *  back to the raw pool when no better leads exist. Throws when the list has
 *  no leads to sample. */
export async function pickPreviewLeadIds(
  listId: string,
  explicitLeadIds: string[] | undefined,
): Promise<string[]> {
  const { crmDb } = await import('../services/db');
  const result = await crmDb.getLeadsByListId(listId);
  const items: any[] = Array.isArray(result?.items) ? result.items : [];
  const pool = explicitLeadIds && explicitLeadIds.length > 0
    ? items.filter(l => explicitLeadIds.includes(l.leadId))
    : items;
  if (pool.length === 0) {
    throw new Error('This list has no leads to preview enrichment on.');
  }
  const hasRealEmail = (l: any) => {
    const email = typeof l.email === 'string' ? l.email.trim() : '';
    if (!email) return false;
    return !CrmEnrichmentService.isPlaceholderDomain(email.split('@')[1] || '');
  };
  const hasIdentity = (l: any) =>
    hasRealEmail(l) ||
    (typeof l.linkedin === 'string' && l.linkedin.trim());
  const withIdentity = pool.filter(hasIdentity);
  const chosen = (withIdentity.length >= 2 ? withIdentity : pool).slice(0, 2);
  return chosen.map(l => l.leadId);
}

/** Resolve the lead set + count for an execute run. With explicit lead_ids,
 *  the count is their length. Otherwise the whole list is counted (and
 *  leadIds stays undefined so V3 queries the full list). */
export async function resolveExecuteLeadIds(
  listId: string,
  explicitLeadIds: string[] | undefined,
): Promise<{ leadIds: string[] | undefined; count: number }> {
  if (explicitLeadIds && explicitLeadIds.length > 0) {
    return { leadIds: explicitLeadIds, count: explicitLeadIds.length };
  }
  const { crmDb } = await import('../services/db');
  const result = await crmDb.getLeadsByListId(listId);
  const items: any[] = Array.isArray(result?.items) ? result.items : [];
  return { leadIds: undefined, count: items.length };
}
