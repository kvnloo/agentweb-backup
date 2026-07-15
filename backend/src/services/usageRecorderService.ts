/**
 * usageRecorderService — fire-and-forget shadow usage recorder (Ship 1).
 *
 * Acceptance criterion: usage analytics must NEVER break (or slow) chat.
 *  - recordUsage() returns a promise that ALWAYS resolves — every error path is
 *    swallowed (logged at most once per minute on repeated failure).
 *  - Callers do not await it in hot paths; firing it is a single microtask.
 *  - Missing userId is recorded under userId "system" so platform overhead is
 *    visible, never dropped.
 *  - Unknown models record with cost 0 (llmPricing emits a deduped warn);
 *    tokens are still counted.
 */

import { getModelPrice } from "../utils/llmPricing";
import { usageRecordDb } from "./usageRecordDb";
// tokenUsageService is lazy-required inside meterUserUsage (not statically imported):
// it pulls in db.ts -> config/aws.ts, and usageRecorderService is imported very widely
// (via llmClients). A static import would drag that whole graph into every consumer's
// module-load, breaking suites that mock aws-sdk without a `config` (e.g. blog.test.ts)
// and matching the existing lazy-load pattern in llmClients.ts.

export interface RecordUsageContext {
  userId?: string;
  billingUserId?: string;
  onBehalfOf?: string;
  model: string;
  provider: string;
  feature: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  sessionId?: string;
  taskId?: string;
  /**
   * Explicit USD cost for calls that are NOT token-priced (image/video are billed
   * per generation, so getModelPrice returns null and token-derived cost is 0).
   * When set, it is recorded verbatim instead of computing cost from tokens.
   */
  costUsdOverride?: number;
}

/** Log at most one recorder failure per minute to avoid log spam on outages. */
const ERROR_LOG_INTERVAL_MS = 60_000;
let lastErrorLogAt = 0;

/**
 * Compute cost in INTEGER microdollars for a call.
 * USD-per-1M-token prices mean: microUsd = tokens * pricePerM (since 1e6/1e6 cancels).
 * Returns 0 (never throws) when the model has no price entry.
 */
export function computeCostMicroUsd(
  model: string,
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens: number = 0,
  cacheWriteTokens: number = 0
): number {
  const price = getModelPrice(model);
  if (!price) return 0;
  const cacheReadPerM = price.cacheReadPerM ?? price.inPerM * 0.1;
  const cacheWritePerM = price.cacheWritePerM ?? price.inPerM * 1.25;
  return Math.round(
    inputTokens * price.inPerM +
      outputTokens * price.outPerM +
      cacheReadTokens * cacheReadPerM +
      cacheWriteTokens * cacheWritePerM
  );
}

/**
 * Record one LLM call into the shadow usage table.
 *
 * Fire-and-forget: call it WITHOUT await in hot paths. The returned promise
 * always resolves — a recording failure can never fail or slow an LLM response.
 */
export async function recordUsage(ctx: RecordUsageContext): Promise<void> {
  try {
    const userId = ctx.userId || "system";
    const billingUserId = ctx.billingUserId || userId;
    const date = new Date().toISOString().slice(0, 10);
    const inputTokens = Math.max(0, Math.round(ctx.inputTokens || 0));
    const outputTokens = Math.max(0, Math.round(ctx.outputTokens || 0));
    const cacheReadTokens = Math.max(0, Math.round(ctx.cacheReadTokens || 0));
    const cacheWriteTokens = Math.max(0, Math.round(ctx.cacheWriteTokens || 0));

    const costMicroUsd =
      ctx.costUsdOverride != null
        ? Math.max(0, Math.round(ctx.costUsdOverride * 1e6))
        : computeCostMicroUsd(
            ctx.model,
            inputTokens,
            outputTokens,
            cacheReadTokens,
            cacheWriteTokens
          );

    await usageRecordDb.incrementUsage({
      userId,
      date,
      model: ctx.model || "unknown",
      feature: ctx.feature || "unknown",
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      costMicroUsd,
      billingUserId,
      ...(ctx.onBehalfOf ? { onBehalfOf: ctx.onBehalfOf } : {}),
    });
  } catch (error) {
    const now = Date.now();
    if (now - lastErrorLogAt >= ERROR_LOG_INTERVAL_MS) {
      lastErrorLogAt = now;
      console.error(
        "[usageRecorder] Failed to record usage (further failures suppressed for 60s):",
        error instanceof Error ? error.message : error
      );
    }
  }
}

/**
 * Meter one LLM call BOTH ways for a direct-provider call site that spends a real
 * user's tokens but bypasses callLLM (crm enrichment, growth-genius, workflow-gen,
 * report-revision, invite-note shortening, …):
 *   1. recordUsage()          — the shadow analytics table.
 *   2. incrementUserTokenUsage — the enforced per-user monthly cap.
 *
 * Fire-and-forget + fail-open on both — metering must never fail or slow an LLM
 * response. The cap charge is skipped when no user is attributable (a bare
 * recordUsage under "system" still captures the platform overhead).
 *
 * Note: tokens feed the always-on token cap; cost feeds the cap in dollars but
 * only blocks when ENFORCE_COST_CAP is enabled (observe-only by default).
 */
export function meterUserUsage(ctx: RecordUsageContext): void {
  // Shadow analytics — records under "system" when userId is absent.
  void recordUsage(ctx);

  // Enforced per-user cap — only when a real user is attributable.
  if (!ctx.userId) return;

  const inputTokens = Math.max(0, Math.round(ctx.inputTokens || 0));
  const outputTokens = Math.max(0, Math.round(ctx.outputTokens || 0));
  const cacheReadTokens = Math.max(0, Math.round(ctx.cacheReadTokens || 0));
  const cacheWriteTokens = Math.max(0, Math.round(ctx.cacheWriteTokens || 0));
  const totalTokens = inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens;
  // Honor an explicit dollar cost for calls that are NOT token-priced (image is
  // billed per generation, video per clip). Without this, image/video would deduct
  // $0 from the cap even though they're the largest costs — mirrors recordUsage.
  const costUsd =
    ctx.costUsdOverride != null
      ? Math.max(0, ctx.costUsdOverride)
      : computeCostMicroUsd(ctx.model, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens) /
        1e6;

  if (totalTokens <= 0 && costUsd <= 0) return;

  // Lazy-required (see import-site note) to keep this module's static load graph light.
  const { incrementUserTokenUsage } = require("./tokenUsageService") as typeof import("./tokenUsageService");
  void incrementUserTokenUsage(ctx.userId, totalTokens, costUsd).catch((err: unknown) =>
    console.error(
      "[usageRecorder] meterUserUsage: failed to charge per-user cap:",
      err instanceof Error ? err.message : err
    )
  );
}

/** Test hook: reset the error-log throttle. */
export function __resetErrorLogThrottleForTests(): void {
  lastErrorLogAt = 0;
}
