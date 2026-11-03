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
import { cronJobRegistry } from "../../utils/cronJobRegistry";
import { meterWithResolvedBilling } from "../agentMode/deferredBillingMetering";
import { computeCostMicroUsd, type RecordUsageContext } from "../usageRecorderService";
import { getModelPrice, LLM_PRICE_BOOK_PROVENANCE } from "../../utils/llmPricing";
import { getAttemptUsageJournal, type AttemptUsage } from "./attemptUsageJournal";
import { noteRunFundingUnset, type RunFunding } from "./runFunding";

export type RecordLlmUsageInput = RecordUsageContext;

/**
 * What the customer's own provider account was charged for one call, in USD, from an
 * OpenRouter response's usage block: present only when the response says it was served
 * on the caller's own key (`is_byok === true`) AND reports a positive upstream cost.
 * Otherwise `{}`, never zero: on a non-BYOK response the cost is AgentWeb's own, and
 * reading it as the customer's would book AgentWeb's money against their provider.
 */
export function customerUpstreamCost(usage: {
  is_byok?: boolean;
  cost_details?: { upstream_inference_cost?: unknown } | null;
}): { upstreamCostUsd?: number } {
  const cost = usage?.cost_details?.upstream_inference_cost;
  return usage?.is_byok === true && typeof cost === 'number' && Number.isFinite(cost) && cost > 0
    ? { upstreamCostUsd: cost }
    : {};
}

/** Whether the response reports that OpenRouter executed a server tool (web search...) for this call. */
function reportsServerToolUse(usage: { server_tool_use_details?: unknown }): boolean {
  const details = usage?.server_tool_use_details;
  if (!details || typeof details !== 'object') return false;
  return Object.values(details as Record<string, unknown>).some(v => typeof v === 'number' && Number.isFinite(v) && v > 0);
}

const SHAPE_WARNING_INTERVAL_MS = 60_000;
let lastShapeWarningAt = 0;

/**
 * AgentWeb's own total cost of one OpenRouter call served on a BYOK key, in USD (ENG-2720).
 *
 * A BYOK response carries two separate bills: `cost_details.upstream_inference_cost` is what
 * the model provider charged the key (tokens, and native tool fees), and `usage.cost` is
 * OpenRouter's own charge on top of it (server-tool fees such as web search on the Exa,
 * Firecrawl and Parallel engines, plus any BYOK platform fee). Both are AgentWeb expenses.
 * Reading only the upstream figure left the web-search fee out of the ledger entirely: on a
 * real Luna enrichment run the fee was ~$1.1 against ~$0.2 of recorded tokens.
 *
 * Observed on real responses: a plain BYOK call reports `usage.cost` 0; a search call reports the fee
 * ($0.007 Exa, $0.005 Parallel) with `server_tool_use_details.web_search_requests` and an upstream bill of
 * ~$0.0005 to $0.0007, so the fee is often several times the token bill. That is why the router charge is
 * NEVER dropped or capped by its size: a rule such as "ignore a charge at least as large as the upstream bill"
 * would discard the real search fee on every default (Luna) search call the moment a response lacked the
 * tool-use field, which is the under-booking this change exists to remove.
 *
 * Tripwire only: a router charge at least as large as the whole upstream bill with NO reported server-tool
 * use is not a shape seen in real traffic. It could be a platform fee, or a response in which `usage.cost`
 * already contains the upstream bill. Both bills are still booked (an over-count is bounded by the token bill,
 * an under-count by the whole fee), and a warning naming the response's keys is logged at most once a minute
 * so a change in OpenRouter's reporting shows up in the logs instead of silently skewing the ledger.
 *
 * `undefined` when neither bill is reported, so the caller falls back to the price book exactly as
 * before. An unusable OpenRouter charge counts as 0, never as a drop; a fee with no upstream bill is
 * booked on top of `tokenCostFallbackUsd` (the book's token cost) instead of being lost.
 * Callers use this for AgentWeb-paid calls only; customer-funded routes are stripped of the
 * override downstream and read `customerUpstreamCost` instead.
 */
export function openRouterByokCostUsd(
  usage: {
    cost?: unknown;
    cost_details?: { upstream_inference_cost?: unknown } | null;
    server_tool_use_details?: unknown;
  },
  /** Token cost from the price book, used only when the response reports no upstream cost but does charge a fee. */
  tokenCostFallbackUsd?: number,
): number | undefined {
  const routerCharge = typeof usage?.cost === 'number' && Number.isFinite(usage.cost) && usage.cost > 0 ? usage.cost : 0;
  const upstream = usage?.cost_details?.upstream_inference_cost;
  if (typeof upstream === 'number' && Number.isFinite(upstream) && upstream > 0) {
    if (routerCharge > 0 && routerCharge >= upstream && !reportsServerToolUse(usage)) {
      const now = Date.now();
      if (now - lastShapeWarningAt >= SHAPE_WARNING_INTERVAL_MS) {
        lastShapeWarningAt = now;
        console.warn(
          '[openRouterByokCostUsd] BYOK router charge is at least the whole upstream bill and no server tool use is reported; booking both. OpenRouter usage shape change?',
          { usageKeys: Object.keys(usage ?? {}), costDetailKeys: Object.keys(usage?.cost_details ?? {}) },
        );
      }
    }
    return upstream + routerCharge;
  }
  // No usable upstream bill. With no fee either, stay undefined so the caller prices tokens from the book exactly
  // as before. With a fee (a search ran), book it on top of the book's token cost rather than dropping it.
  if (routerCharge > 0) {
    const tokens = typeof tokenCostFallbackUsd === 'number' && Number.isFinite(tokenCostFallbackUsd) && tokenCostFallbackUsd > 0
      ? tokenCostFallbackUsd
      : 0;
    return tokens + routerCharge;
  }
  return undefined;
}

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
  // Tracked, like the deferred metering rail, so a graceful shutdown drains the write
  // instead of dropping a row that has no other record. Still never awaited here.
  const write = getAttemptUsageJournal()
    .record(attempt)
    .catch((error) =>
      // The error carries an attempt id and a code only; never log the object, which
      // could hold request details.
      console.error(
        `[recordLlmUsage] journal write failed (${where}, fail-open, no existing rail touched): attempt ${attempt.attemptId} run ${attempt.runId} ${errorCode(error)}`,
      ),
    );
  void cronJobRegistry.track("attemptUsageJournal", write);
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
      ? { // At least 1: a real charge below half a micro-dollar must not round to 0, which
          // would read as "the customer paid nothing".
          customerEstimateMicroUsd: Math.max(1, Math.round((upstream as number) * 1_000_000)), costProvenance: "openrouter:upstream_inference_cost" }
      : {}),
    settlementState: "settled",
  };
}
