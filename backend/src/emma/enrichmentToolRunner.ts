// Emma enrichment runner: builds + processes a V3 config, runs the V3
// engine, and maps the result to an Emma-friendly summary. Also provides
// lead-set helpers (preview sampling, execute cap resolution).

import { processEnrichmentConfig } from '../services/enrichmentConfigService';
import { buildConfigProcessingDeps } from '../services/enrichmentConfigDeps';
import { runEnrichment, type RunEnrichmentResult } from '../services/crmEnrichmentServiceV3';
import { buildOrchestratorDeps } from '../services/enrichmentV3RealDeps';
import type { SocketEmitFn } from '../services/crmEnrichmentService';
import { buildRawEnrichmentConfig, type EmmaEnrichmentOutputField } from './enrichmentToolConfig';

/** Emma-facing summary of a V3 enrichment run. */
export interface EmmaEnrichmentSummary {
  runId: string;
  mode: 'preview' | 'enrich';
  processedCount: number;
  failedCount: number;
  failureBreakdown: RunEnrichmentResult['failed'];
  durationMs: number;
  warnings: string[];
  samples?: Array<{ leadId: string; enrichedFields: Record<string, string> }>;
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
  const rawConfig = buildRawEnrichmentConfig(params.outputFields, params.userId);
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
    },
    deps,
    { userId: params.userId, socketId: params.socketId, socketEmit: params.socketEmit },
  );

  const failedCount = Object.values(result.failed).reduce((a, b) => a + b, 0);

  // Observability: engine-tagged line so we can confirm Emma traffic is on V3.
  console.log(
    `[emma-enrich] engine=v3 runId=${result.runId} listId=${params.listId} ` +
    `userId=${params.userId} mode=${params.mode} leads=${result.processed} ` +
    `fields=${params.outputFields.length} failed=${failedCount} durationMs=${result.durationMs}`,
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
    summary.samples = result.preview.map(p => ({
      leadId: p.leadId,
      enrichedFields: p.extractedFields,
    }));
  }
  return summary;
}

/** Select 2 representative sample leads for a preview run. Prefers leads
 *  with identity data (email or linkedin) so the preview shows useful
 *  results. Throws when the list has no leads to sample. */
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
  const hasIdentity = (l: any) =>
    (typeof l.email === 'string' && l.email.trim()) ||
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
