/**
 * ENG-1816 F1 — recordLlmUsage: one metering entry point, funding decided ABOVE the
 * fire-and-forget funnel, not inside it.
 *
 * `meterWithResolvedBilling` -> `meterUserUsage(Async)` -> `recordUsage` +
 * `incrementUserTokenUsage` is fire-and-forget and fail-open at every layer (errors
 * are caught and logged, never thrown, by design — metering must never break an LLM
 * call). A funding check placed inside that funnel would fail silently. Placing the
 * branch here, before any of it runs, is what makes the branch itself trustworthy.
 */
import { meterWithResolvedBilling } from "../agentMode/deferredBillingMetering";
import type { RecordUsageContext } from "../usageRecorderService";
import { getAttemptUsageJournal, type AttemptUsage } from "./attemptUsageJournal";
import { currentRunFunding, noteRunFundingUnset, type RunFunding } from "./runFunding";

export type RecordLlmUsageInput = RecordUsageContext;

/**
 * `route === 'agentweb'` (and `undefined`, the pre-F1-wiring default): today's path,
 * byte-identical to before this ticket.
 *
 * Any other route: touches NO existing rail — not `recordUsage`, not
 * `incrementUserTokenUsage`, not the spend-event path — because `AW-SpendProjection`'s
 * production writer (PR #3003) folds every settled spend event into that subject's
 * `settledMicroUsd` with no funding dimension. A customer-funded call that reached any
 * existing rail would be folded in and could pause the customer on their own spend the
 * moment ENG-1250's enforcement flag goes global.
 */
export function recordLlmUsage(runFunding: RunFunding | undefined, ctx: RecordLlmUsageInput, where = "recordLlmUsage"): void {
  if (!runFunding) {
    noteRunFundingUnset(where);
    meterWithResolvedBilling(ctx);
    return;
  }

  if (runFunding.route === "agentweb") {
    meterWithResolvedBilling(ctx);
    return;
  }

  void recordToJournal(runFunding, ctx).catch((error) =>
    console.error("[recordLlmUsage] journal write failed (fail-open, no existing rail touched):", error),
  );
}

/**
 * Best-effort AttemptUsage from a plain metering ctx. `runId`/`ordinal` are
 * placeholders — F1 has no real route-attempt sequence to draw them from (that is
 * `runCoordinator`, future work). A3 must replace this mapping once real attempts
 * exist; nothing in F1 exercises this path outside its own negative test, since
 * `resolveRunFunding` never returns a non-agentweb route yet.
 */
async function recordToJournal(runFunding: RunFunding, ctx: RecordLlmUsageInput): Promise<void> {
  const now = new Date().toISOString();
  const attempt: AttemptUsage = {
    runId: ctx.sessionId || `unattributed-${now}`,
    ordinal: 0,
    fundingSource: runFunding.route,
    fundingPrincipalId: runFunding.ownerUserId,
    connectionId: runFunding.connectionId,
    requestedModel: ctx.model,
    requestedBackend: "emma_raw",
    provider: ctx.provider,
    startedAt: now,
    endedAt: now,
    outcome: "succeeded",
    usage: {
      inputTokens: ctx.inputTokens,
      outputTokens: ctx.outputTokens,
      cacheReadTokens: ctx.cacheReadTokens ?? 0,
      cacheWriteTokens: ctx.cacheWriteTokens ?? 0,
    },
    settlementState: "settled",
  };
  await getAttemptUsageJournal().record(attempt);
}

/** Convenience wrapper reading funding from the ambient store. */
export function recordLlmUsageForCurrentRun(ctx: RecordLlmUsageInput, where?: string): void {
  recordLlmUsage(currentRunFunding(), ctx, where);
}
