/**
 * CRM lead auto-enrichment cron (ENG-88)
 *
 * Ray's manual campaign-monitoring routine included going into the CRM and
 * enriching leads with data — clicking "renew" (the enrich-v3 engine, run
 * against a list's saved per-list `enrichmentConfig`) several times by hand.
 * With Ray leaving, this must keep happening without a human clicking it.
 *
 * Scope is intentionally opt-in, per list, default OFF: this cron only ever
 * touches a list whose saved `enrichmentConfig.autoEnrich` is `true`. A list
 * with no saved config, or a saved config that doesn't set `autoEnrich`,
 * is never touched — zero behavior change for every existing customer's CRM
 * data until a human deliberately flips the flag via the already-existing
 * `PUT /lists/:listId/enrichment-config` endpoint. This cron does not decide
 * WHICH lists that should be for (that's a real spend + data-blast-radius
 * call — see the ENG-88 Linear comment); it only builds the mechanism.
 *
 * Idempotent: only leads currently lacking `enrichmentMetadata` are
 * selected, so re-running (whether the next scheduled tick, or an
 * overlapping invocation) never re-enriches — and therefore never
 * double-charges Apollo/LLM usage for — a lead that's already enriched.
 * An in-memory per-list lock additionally prevents two overlapping
 * invocations from racing the same list's still-un-enriched leads.
 *
 * Rate-limit-safe: batches are capped per list per run
 * (MAX_LEADS_PER_LIST_PER_RUN), and the underlying `runEnrichment` engine
 * already enforces the same per-user Apollo daily quota
 * (`apolloQuota.ts`) that the manual "renew" click was always bound by —
 * automating the trigger doesn't change the spend ceiling, only who
 * clicks.
 *
 * Failures are surfaced via the same deduped oncall-alert utility other
 * crons use (`renewalIntegrationHealthCron.ts`), not swallowed.
 */

import type { EnrichmentConfig, RunEnrichmentInput, RunEnrichmentResult, OrchestratorDeps } from '../services/crmEnrichmentServiceV3';
import { runEnrichment as svcRunEnrichment } from '../services/crmEnrichmentServiceV3';
import { buildOrchestratorDeps as buildV3OrchestratorDeps } from '../services/enrichmentV3RealDeps';
import { getEnrichmentConfig as svcGetEnrichmentConfig } from '../services/enrichmentConfigService';
import { buildConfigServiceDeps } from '../services/enrichmentConfigDeps';
import { crmDb } from '../services/db';
import { isCardRevenueField } from '../services/enrichmentGroups';
import { sendAgentModeOncallAlert } from '../utils/agentModeAlerts';

const TAG = '[crmAutoEnrichmentCron]';

/** Upper bound on leads enriched per list per run — keeps a single opted-in
 *  list's backlog from producing an unbounded Apollo/LLM burst in one tick.
 *  A larger backlog just spreads across more ticks. */
export const MAX_LEADS_PER_LIST_PER_RUN = 50;

/** Re-alert on the same list at most once per window. */
export const ALERT_DEDUPE_WINDOW_MS = 6 * 60 * 60 * 1000; // 6 hours

export interface CrmAutoEnrichmentSummary {
  scannedLists: number;
  eligibleLists: number;
  processedLeads: number;
  failedLists: number;
  /** Lists skipped this tick because a prior invocation was still running
   *  against them (overlap guard) — not a failure, just deferred to the
   *  next tick. */
  skippedOverlapping: number;
}

export interface CrmAutoEnrichmentCronDeps {
  /** Lists whose saved config has `enrichmentConfig.autoEnrich === true`.
   *  A lightweight candidate scan — callers must still re-check the full
   *  config via getEnrichmentConfig before enriching (see module docs). */
  getAutoEnrichEnabledLists(): Promise<Array<{ listId: string; userId: string }>>;
  getEnrichmentConfig(input: { listId: string; userId: string }): Promise<{ config: EnrichmentConfig; isDefault: boolean }>;
  getAllLeadsByListId(listId: string): Promise<Array<{ leadId: string; enrichmentMetadata?: Record<string, unknown> }>>;
  runEnrichment(input: RunEnrichmentInput, deps: OrchestratorDeps): Promise<RunEnrichmentResult>;
  buildOrchestratorDeps(userId: string): OrchestratorDeps;
  sendAlert(params: {
    subject: string;
    message: string;
    dedupeKey?: string;
    dedupeWindowMs?: number;
    context?: Record<string, any>;
  }): Promise<boolean>;
}

/**
 * A lead still needs an enrichment run when at least one currently-ENABLED
 * config field has no entry in `enrichmentMetadata` — not merely when the
 * metadata map is empty. Some writers stamp `enrichmentMetadata` for a field
 * that isn't part of the enrichment config at all (e.g.
 * `crmDb.setLeadEmailValidation` writes `enrichmentMetadata.email_validation`
 * without ever running the configured fields), so "any key present" would
 * wrongly mark such a lead permanently done and this cron would never pick
 * it up. (CodeRabbit, PR #2583.)
 */
function isUnenriched(
  lead: {
    enrichmentMetadata?: Record<string, unknown>;
    email?: string | null;
    linkedin?: string | null;
    firstName?: string | null;
    lastName?: string | null;
  },
  config: EnrichmentConfig,
): boolean {
  // Agree with the engine's own precondition, or this cron reselects the same rows forever.
  // resolveLeadIdentity (enrichmentIdentityResolver.ts:293) rejects a lead with no email,
  // no LinkedIn and no full name as 'no_identity_signal', and crmEnrichmentServiceV3.ts
  // `continue`s on that category BEFORE pendingWrites — so no enrichmentMetadata is ever
  // stamped and the selector below picks the identical lead up on the next tick.
  //
  // ENG-2082 made this reachable in volume: a phone-only capture with no name has exactly
  // that shape. At MAX_LEADS_PER_LIST_PER_RUN = 50, fifty such rows permanently consume a
  // list's per-run budget and NO other lead on that list is ever enriched again. Silent,
  // because they count as `skipped` rather than `failed`, so no alert fires.
  const hasEmail = typeof lead.email === 'string' && lead.email.trim() !== '';
  const hasLinkedin = typeof lead.linkedin === 'string' && lead.linkedin.trim() !== '';
  const hasFullName =
    typeof lead.firstName === 'string' && lead.firstName.trim() !== '' &&
    typeof lead.lastName === 'string' && lead.lastName.trim() !== '';
  if (!hasEmail && !hasLinkedin && !hasFullName) return false;

  // Card-revenue fields are never filled by the cron (it doesn't use Enigma,
  // ENG-1388); counting them would reselect the same leads on every tick.
  const enabledFieldNames = config.fields
    .filter((f) => f.include && !isCardRevenueField(f.aliasFor ?? f.name))
    .map((f) => f.name);
  if (enabledFieldNames.length === 0) return false; // nothing configured to enrich
  const meta = lead.enrichmentMetadata;
  return enabledFieldNames.some((name) => !meta || !(name in meta));
}

// Module-level overlap guard: a listId in here has an in-flight run from a
// PRIOR invocation of this cron that hasn't finished yet. Prevents two
// overlapping ticks (e.g. a slow run still going when the next interval
// fires) from both selecting the same still-un-enriched leads and
// double-charging Apollo/LLM usage for them. Mirrors the existing
// in-memory bulk-Apollo lock pattern in routes/crmApollo.ts.
const listsInProgress = new Set<string>();

/**
 * Scan every list opted into auto-enrichment and enrich each one's
 * currently un-enriched leads (bounded per run). Resilient: a failure on
 * one list is alerted and logged, never aborts the rest of the run.
 */
export async function runCrmAutoEnrichmentCron(
  deps: CrmAutoEnrichmentCronDeps,
): Promise<CrmAutoEnrichmentSummary> {
  const summary: CrmAutoEnrichmentSummary = {
    scannedLists: 0,
    eligibleLists: 0,
    processedLeads: 0,
    failedLists: 0,
    skippedOverlapping: 0,
  };

  let candidates: Array<{ listId: string; userId: string }>;
  try {
    candidates = await deps.getAutoEnrichEnabledLists();
  } catch (error) {
    console.error(`${TAG} Failed to scan auto-enrich-enabled lists:`, error);
    return summary;
  }
  summary.scannedLists = candidates.length;

  for (const candidate of candidates) {
    const { listId, userId } = candidate;

    if (listsInProgress.has(listId)) {
      summary.skippedOverlapping++;
      console.log(`${TAG} list ${listId} already has a run in progress from a prior tick — skipping`);
      continue;
    }
    listsInProgress.add(listId);

    try {
      // Re-check the FULL, current config — the candidate scan is a
      // lightweight projection and may be stale by the time we get here
      // (config could have been turned back off, or never actually saved).
      const { config, isDefault } = await deps.getEnrichmentConfig({ listId, userId });
      if (isDefault || config.autoEnrich !== true) {
        continue;
      }

      const leads = await deps.getAllLeadsByListId(listId);
      const unenrichedLeadIds = leads
        .filter((lead) => isUnenriched(lead, config))
        .slice(0, MAX_LEADS_PER_LIST_PER_RUN)
        .map((lead) => lead.leadId);

      if (unenrichedLeadIds.length === 0) {
        continue;
      }

      summary.eligibleLists++;

      const result = await deps.runEnrichment(
        { listId, userId, config, mode: 'enrich', leadIds: unenrichedLeadIds },
        deps.buildOrchestratorDeps(userId),
      );
      summary.processedLeads += result.processed;

      const failedCount = Object.values(result.failed).reduce((a, b) => a + b, 0);
      if (failedCount > 0) {
        summary.failedLists++;
        await sendAlertSafe(deps, {
          subject: `CRM auto-enrichment had ${failedCount} failure(s) on list ${listId}`,
          message:
            `Auto-enrichment run ${result.runId} for list ${listId} (user ${userId}) processed ` +
            `${result.processed} lead(s) with ${failedCount} failure(s): ${JSON.stringify(result.failed)}. ` +
            `Check the list's enrichment config and recent Apollo/LLM quota usage.`,
          dedupeKey: `crm-auto-enrichment:${listId}`,
          dedupeWindowMs: ALERT_DEDUPE_WINDOW_MS,
          context: { listId, userId, runId: result.runId, failed: result.failed },
        });
      }
    } catch (error) {
      summary.failedLists++;
      console.error(`${TAG} list ${listId} auto-enrichment run crashed:`, error);
      await sendAlertSafe(deps, {
        subject: `CRM auto-enrichment crashed for list ${listId}`,
        message: `Auto-enrichment run for list ${listId} (user ${userId}) threw: ${(error as Error)?.message ?? error}`,
        dedupeKey: `crm-auto-enrichment-crash:${listId}`,
        dedupeWindowMs: ALERT_DEDUPE_WINDOW_MS,
        context: { listId, userId },
      });
    } finally {
      listsInProgress.delete(listId);
    }
  }

  console.log(
    `${TAG} Run complete — scannedLists=${summary.scannedLists} eligibleLists=${summary.eligibleLists} ` +
    `processedLeads=${summary.processedLeads} failedLists=${summary.failedLists} skippedOverlapping=${summary.skippedOverlapping}`,
  );
  return summary;
}

/** Never let an alert-send failure crash the run — log and move on. */
async function sendAlertSafe(
  deps: CrmAutoEnrichmentCronDeps,
  params: Parameters<CrmAutoEnrichmentCronDeps['sendAlert']>[0],
): Promise<void> {
  try {
    await deps.sendAlert(params);
  } catch (alertError) {
    console.error(`${TAG} Failed to send alert (dedupeKey=${params.dedupeKey}):`, alertError);
  }
}

/** Real-service deps: production wiring. */
export function buildCrmAutoEnrichmentCronDeps(): CrmAutoEnrichmentCronDeps {
  return {
    getAutoEnrichEnabledLists: () => crmDb.getAutoEnrichEnabledLists(),
    getEnrichmentConfig: async (input) => {
      const { config, isDefault } = await svcGetEnrichmentConfig(input, buildConfigServiceDeps());
      return { config, isDefault };
    },
    getAllLeadsByListId: (listId) => crmDb.getAllLeadsByListId(listId),
    runEnrichment: (input, orchestratorDeps) => svcRunEnrichment(input, orchestratorDeps),
    buildOrchestratorDeps: (userId) => buildV3OrchestratorDeps(userId),
    sendAlert: (params) => sendAgentModeOncallAlert(params),
  };
}

/** Entry point used by server.ts's interval registration. */
export async function runCrmAutoEnrichmentCheck(): Promise<CrmAutoEnrichmentSummary> {
  return runCrmAutoEnrichmentCron(buildCrmAutoEnrichmentCronDeps());
}
