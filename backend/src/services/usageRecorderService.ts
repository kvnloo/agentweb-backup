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

import { getModelPrice, cacheWriteCost, CacheWriteByTtl } from "../utils/llmPricing";
import { usageRecordDb, CostSource } from "./usageRecordDb";
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
  /** ENG-893: cache-write tokens split by the TTL Bedrock applied, when reported. */
  cacheWriteByTtl?: CacheWriteByTtl;
  sessionId?: string;
  taskId?: string;
  /**
   * ENG-1251: stable identity for THIS charge, used to dedupe a retried usage
   * report against the per-user monthly cap (see llmChargeAuditDb.recordLlmChargeEvent).
   * Omit only when the caller genuinely has no natural per-call id — a retry
   * will then be double-charged, since a fresh one is minted each time.
   */
  eventId?: string;
  /**
   * Explicit USD cost for calls that are NOT token-priced (image/video are billed
   * per generation, so getModelPrice returns null and token-derived cost is 0).
   * When set, it is recorded verbatim instead of computing cost from tokens.
   */
  costUsdOverride?: number;
  /**
   * ENG-1251 Greptile P1: YYYY-MM-DD override. A caller that ALSO writes a
   * paired charge event for the same logical usage (internalUsage.ts is the
   * only one today) must compute this ledger row's date from the exact same
   * instant as that charge event's occurredAt -- two independent `new
   * Date()` calls a few awaits apart can straddle a UTC-midnight boundary,
   * landing the ledger row on one date and the charge event on the next.
   * The itemization reconciliation keys on (date, model, feature), so a
   * one-day mismatch breaks the key match: the charge event can no longer
   * cover its own aggregate row, and both show up (double count). Omit for
   * every other caller -- defaults to `new Date()` at call time, unchanged.
   */
  date?: string;
}

/**
 * A spend entry for a vendor billed per unit rather than per token (v0 renders,
 * You.com queries, ElevenLabs characters, …).
 *
 * Note what is NOT here: any rate table. This entry point records the dollar
 * figure its caller hands it and states, via `costSource`, where that figure came
 * from. Choosing the allocated rate is a pricing decision owned by ENG-703.
 */
export interface RecordVendorUsageContext {
  userId?: string;
  billingUserId?: string;
  onBehalfOf?: string;
  sessionId?: string;
  /** Vendor id: "v0", "you.com", "remotion", "elevenlabs", … */
  provider: string;
  /** What was bought from that vendor: "generate", "search", "render", … */
  operation: string;
  feature: string;
  /** The thing being counted: "render", "query", "character", … */
  unit: string;
  quantity: number;
  costSource: CostSource;
  /** Dollar cost of this call. Omitted means 0 — ENG-700 makes an unpriced unit loud. */
  costUsd?: number;
}

/** Log at most one recorder failure per minute to avoid log spam on outages. */
const ERROR_LOG_INTERVAL_MS = 60_000;
let lastErrorLogAt = 0;

/** Swallow-and-throttle: metering must never fail or slow the caller's operation. */
function logRecorderFailure(error: unknown): void {
  const now = Date.now();
  if (now - lastErrorLogAt >= ERROR_LOG_INTERVAL_MS) {
    lastErrorLogAt = now;
    console.error(
      "[usageRecorder] Failed to record usage (further failures suppressed for 60s):",
      error instanceof Error ? error.message : error
    );
  }
}

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
  cacheWriteTokens: number = 0,
  /** ENG-893: per-TTL cache-write split from Bedrock's `usage.cacheDetails`. */
  cacheWriteByTtl?: CacheWriteByTtl
): number {
  const price = getModelPrice(model);
  if (!price) return 0;
  const cacheReadPerM = price.cacheReadPerM ?? price.inPerM * 0.1;
  return Math.round(
    inputTokens * price.inPerM +
      outputTokens * price.outPerM +
      cacheReadTokens * cacheReadPerM +
      cacheWriteCost(price, cacheWriteTokens, cacheWriteByTtl)
  );
}

/**
 * ENG-700: true when `model` has no entry in the price book. Used to mark a
 * usage row's costSource as "unpriced" (0 dollars because the rate is
 * missing) rather than "allocated" (0 or more real dollars from a known
 * rate) — the two must stay distinguishable so an unpriced model never reads
 * as confirmed-free spend.
 */
function isUnpriced(model: string): boolean {
  return getModelPrice(model) === null;
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
    const date = ctx.date || new Date().toISOString().slice(0, 10);
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
            cacheWriteTokens,
            ctx.cacheWriteByTtl
          );

    // ENG-700: an override or a known price is real allocated spend (possibly
    // $0 for a genuinely free call). No override AND no price entry means the
    // 0 in costMicroUsd is a missing rate, not a fact about the call — tag it
    // "unpriced" so it never reads as confirmed-free spend. Token counts are
    // written either way (see inputTokens/outputTokens below), unaffected by
    // costSource.
    const costSource =
      ctx.costUsdOverride != null || !isUnpriced(ctx.model) ? "allocated" : "unpriced";

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
      costSource,
      ...(ctx.onBehalfOf ? { onBehalfOf: ctx.onBehalfOf } : {}),
      ...(ctx.provider ? { provider: ctx.provider } : {}),
      ...(ctx.sessionId ? { sessionId: ctx.sessionId } : {}),
    });
  } catch (error) {
    logRecorderFailure(error);
  }
}

/**
 * Record one per-unit vendor call into the SAME ledger `recordUsage` writes to.
 *
 * Fire-and-forget with identical guarantees: the returned promise always
 * resolves, and a recording failure can never fail or slow the caller.
 *
 * The row's model slot is namespaced `{provider}:{operation}`. The sort key
 * format stays `{date}#{model}#{feature}` (changing it is out of scope and would
 * be a real key change) — namespacing the model component is what guarantees two
 * different vendors can never aggregate into one row and overwrite each other's
 * `provider`. For token-priced LLM rows that ambiguity is ENG-700's job.
 */
export async function recordVendorUsage(ctx: RecordVendorUsageContext): Promise<void> {
  try {
    const userId = ctx.userId || "system";
    const billingUserId = ctx.billingUserId || userId;
    const date = new Date().toISOString().slice(0, 10);

    await usageRecordDb.incrementUsage({
      userId,
      date,
      model: `${ctx.provider}:${ctx.operation}`,
      feature: ctx.feature || "unknown",
      // Token counters are meaningless here; the adapter omits them entirely
      // because `unit` is set, so these three are never written.
      inputTokens: 0,
      outputTokens: 0,
      costMicroUsd: Math.max(0, Math.round((ctx.costUsd || 0) * 1e6)),
      billingUserId,
      provider: ctx.provider,
      unit: ctx.unit,
      quantity: ctx.quantity,
      costSource: ctx.costSource,
      ...(ctx.onBehalfOf ? { onBehalfOf: ctx.onBehalfOf } : {}),
      ...(ctx.sessionId ? { sessionId: ctx.sessionId } : {}),
    });
  } catch (error) {
    logRecorderFailure(error);
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
      : computeCostMicroUsd(
          ctx.model,
          inputTokens,
          outputTokens,
          cacheReadTokens,
          cacheWriteTokens,
          ctx.cacheWriteByTtl
        ) / 1e6;

  if (totalTokens <= 0 && costUsd <= 0) return;

  // Lazy-required (see import-site note) to keep this module's static load graph light.
  const { incrementUserTokenUsage } = require("./tokenUsageService") as typeof import("./tokenUsageService");
  void incrementUserTokenUsage(ctx.userId, totalTokens, costUsd, {
    eventId: ctx.eventId,
    model: ctx.model,
    provider: ctx.provider,
    feature: ctx.feature,
    sessionId: ctx.sessionId,
  }).catch((err: unknown) =>
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
