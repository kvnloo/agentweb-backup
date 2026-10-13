/**
 * ENG-1816 F1 / ENG-2106 A3 — recordLlmUsage: one metering entry point, funding decided
 * ABOVE the fire-and-forget funnel, not inside it.
 *
 * `meterWithResolvedBilling` -> `meterUserUsage(Async)` -> `recordUsage` +
 * `incrementUserTokenUsage` is fire-and-forget and fail-open at every layer (errors
 * are caught and logged, never thrown, by design — metering must never break an LLM
 * call). A funding check placed inside that funnel would fail silently. Placing the
 * branch here, before any of it runs, is what makes the branch itself trustworthy.
 */
import { randomUUID } from "crypto";
import { meterWithResolvedBilling } from "../agentMode/deferredBillingMetering";
import { computeCostMicroUsd, type RecordUsageContext } from "../usageRecorderService";
import { getModelPrice, LLM_PRICE_BOOK_PROVENANCE } from "../../utils/llmPricing";
import { getAttemptUsageJournal, type AttemptUsage } from "./attemptUsageJournal";
import { noteRunFundingUnset, type RunFunding } from "./runFunding";

export type RecordLlmUsageInput = RecordUsageContext;

/**
 * `route === 'agentweb'` (and `undefined`, the pre-F1-wiring default): today's path,
 * byte-identical to before this ticket. The one field A3 added to the context
 * (`upstreamCostUsd`) is removed first, so no AgentWeb rail ever sees it.
 *
 * Any other route: touches NO existing rail — not `recordUsage`, not
 * `incrementUserTokenUsage`, not the spend-event path — because `AW-SpendProjection`'s
 * production writer (PR #3003) folds every settled spend event into that subject's
 * `settledMicroUsd` with no funding dimension. A customer-funded call that reached any
 * existing rail would be folded in and could pause the customer on their own spend the
 * moment ENG-1250's enforcement flag goes global. It writes one immutable row to the
 * attempt journal instead, and a failure there is logged, never thrown.
 */
export function recordLlmUsage(runFunding: RunFunding | undefined, ctx: RecordLlmUsageInput, where = "recordLlmUsage"): void {
  if (!runFunding) {
    noteRunFundingUnset(where);
    meterWithResolvedBilling(withoutJournalOnlyFields(ctx));
    return;
  }

  if (runFunding.route === "agentweb") {
    meterWithResolvedBilling(withoutJournalOnlyFields(ctx));
    return;
  }

  let attempt: AttemptUsage;
  try {
    attempt = buildAttempt(runFunding, ctx);
  } catch (error) {
    console.error(`[recordLlmUsage] could not build the attempt record (${where}, fail-open, no existing rail touched):`, errorCode(error));
    return;
  }
  void getAttemptUsageJournal()
    .record(attempt)
    .catch((error) =>
      // The error carries an attempt id and a code only; never log the object, which
      // could hold request details.
      console.error(
        `[recordLlmUsage] journal write failed (${where}, fail-open, no existing rail touched): attempt ${attempt.attemptId} run ${attempt.runId} ${errorCode(error)}`,
      ),
    );
}

function errorCode(error: unknown): string {
  return (error as { code?: string })?.code || (error as Error)?.name || "error";
}

/** Same object back when there is nothing to remove, which is every call but a BYOK one. */
function withoutJournalOnlyFields(ctx: RecordLlmUsageInput): RecordLlmUsageInput {
  if (!("upstreamCostUsd" in ctx)) return ctx;
  const { upstreamCostUsd: _journalOnly, ...rest } = ctx;
  return rest;
}

/**
 * One AttemptUsage from a metering context. The call has already finished when usage is
 * reported, and the context carries no clock, so start and end are both "now"; a row is
 * only ever written for a call that returned usage, hence `succeeded`.
 *
 * Costs follow the journal's rule that unknown is never zero:
 *  - L (list-equivalent) comes from the price book and is ABSENT for an unpriced model
 *    (`computeCostMicroUsd` returns 0 there, which would record "unknown" as "zero");
 *  - C (what the customer's provider charged) is present only when the caller passed
 *    `upstreamCostUsd`, i.e. the response was flagged BYOK and reported a cost.
 */
function buildAttempt(runFunding: RunFunding, ctx: RecordLlmUsageInput): AttemptUsage {
  const now = new Date().toISOString();
  const attemptId = typeof ctx.eventId === "string" && ctx.eventId ? ctx.eventId : randomUUID();
  const cacheReadTokens = ctx.cacheReadTokens ?? 0;
  const cacheWriteTokens = ctx.cacheWriteTokens ?? 0;
  const priced = getModelPrice(ctx.model) !== null;
  const upstream = ctx.upstreamCostUsd;
  const hasCustomerCost = typeof upstream === "number" && Number.isFinite(upstream) && upstream > 0;

  return {
    attemptId,
    runId: ctx.sessionId || ctx.taskId || `unattributed-${attemptId}`,
    userId: ctx.userId || runFunding.ownerUserId,
    billingUserId: ctx.billingUserId || runFunding.billingUserId,
    fundingSource: runFunding.route,
    fundingPrincipalId: runFunding.fundingPrincipalId || runFunding.ownerUserId,
    connectionId: runFunding.connectionId,
    requestedModel: ctx.model,
    actualModel: ctx.model,
    requestedBackend: "emma_raw",
    provider: runFunding.provider || ctx.provider,
    startedAt: now,
    endedAt: now,
    outcome: "succeeded",
    usage: {
      inputTokens: ctx.inputTokens,
      outputTokens: ctx.outputTokens,
      cacheReadTokens,
      cacheWriteTokens,
    },
    ...(priced
      ? {
          listEquivalentMicroUsd: computeCostMicroUsd(
            ctx.model,
            ctx.inputTokens,
            ctx.outputTokens,
            cacheReadTokens,
            cacheWriteTokens,
            ctx.cacheWriteByTtl,
          ),
          priceVersion: LLM_PRICE_BOOK_PROVENANCE,
        }
      : {}),
    ...(hasCustomerCost
      ? { customerEstimateMicroUsd: Math.round((upstream as number) * 1_000_000), costProvenance: "openrouter:upstream_inference_cost" }
      : {}),
    settlementState: "settled",
  };
}
