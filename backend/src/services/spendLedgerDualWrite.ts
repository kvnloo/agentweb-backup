/**
 * Observe-only dual-write from the vendor usage rail into the spend ledger
 * (ENG-1250 §9 step 2: "dual-write old and new rails in observe-only mode").
 *
 * Mirrors at `recordVendorUsage` rather than at each adapter. That function is
 * already the single choke point every metered vendor path funnels through --
 * You.com, Google CSE, Apollo, enrich.so, Remotion, v0, X -- so one seam covers
 * all of them and any vendor added later, instead of seven edits that a new
 * adapter can silently miss. Adapters calling the charging API directly is the
 * end state (§2); this is the shadow phase that earns the right to get there.
 *
 * NOTHING READS THESE ROWS. No enforcement, no admission, no balance. AC6 keeps
 * that transition with Harsha, gated on the reconciliation this data produces.
 *
 * ## Fail-open, deliberately
 *
 * `spendChargingService` throws by design, because a charging rail that
 * swallows failures loses revenue silently. This shim is the opposite and
 * should be: it is a *shadow* of an observation rail, so a failure here must
 * never break the metering it mirrors, let alone the customer request behind
 * it. That is the per-call-path decision the charging service documents as
 * belonging at the call site -- and here, the call site is observe-only.
 *
 * ## Why retries are not deduplicated yet
 *
 * §1 wants an idempotency key supplied at the vendor call site. Those tokens do
 * not exist yet -- adding them is ENG-702 -- so an absent one falls back to a
 * generated id, and a retried vendor call writes two shadow rows.
 *
 * That is the right behaviour for this phase rather than a gap. The existing
 * rail is ALSO non-idempotent (ENG-702: "no write on any rail is idempotent"),
 * so a retry double-counts on both sides and the two totals still reconcile. A
 * shadow rail that deduplicated while the live rail did not would diverge from
 * it by design, and every retry would surface as unexplained drift in the §8
 * comparison. Call sites can start passing real tokens incrementally via
 * `idempotencyKey`, and each one that does becomes correct independently.
 */
import { randomUUID } from "crypto";
import { SpendEvent, recordSpendEvent } from "./spendEventDb";
import { VENDOR_RATE_CARD_VERSION, VendorRateProvider, getAllocatedRate } from "../utils/vendorRateCard";
import { LLM_PRICE_BOOK_PROVENANCE } from "../utils/llmPricing";

/**
 * Kill switch. Defaults ON, unlike the repo's usual opt-in flags.
 *
 * The point of this slice is to accumulate the shadow evidence AC6 requires,
 * and a flag defaulting off means discovering in a week that no evidence
 * exists. The blast radius that justifies the inversion: a fire-and-forget
 * write to a new, empty, PAY_PER_REQUEST table that nothing reads, at the
 * measured rate of a few hundred rows a day. Set SPEND_LEDGER_DUAL_WRITE=false
 * to stop it without a deploy.
 */
export function isDualWriteEnabled(): boolean {
  return process.env.SPEND_LEDGER_DUAL_WRITE !== "false";
}

/** What `recordVendorUsage` knows at the moment it meters a call. */
export interface VendorUsageMirrorInput {
  userId?: string;
  billingUserId?: string;
  onBehalfOf?: string;
  sessionId?: string;
  provider: string;
  operation: string;
  feature?: string;
  unit: string;
  quantity: number;
  costSource: "measured" | "allocated" | "unpriced";
  costUsd?: number;
  /** A real idempotency token when the call site has one. See the header. */
  idempotencyKey?: string;
}

export type MirrorResult =
  | { status: "written"; event: SpendEvent }
  | { status: "duplicate"; event: SpendEvent }
  | { status: "skipped"; reason: "disabled" | "unpriced" }
  | { status: "failed"; reason: string };

/**
 * Where an allocated amount actually came from.
 *
 * Not every allocated cost is priced by `vendorRateCard`: X/Twitter is
 * deliberately excluded from it (ENG-703 scope note) and prices four read
 * categories from `twitterPricing.ts` instead. Stamping the card's version on
 * an X event would claim a provenance the amount does not have, so a cost the
 * card cannot reproduce is labelled by its caller instead. Either way §5's
 * requirement holds: the event records which rate produced it.
 */
export function resolveRateProvenance(provider: string, operation: string): string {
  return getAllocatedRate(provider as VendorRateProvider, operation) !== null
    ? VENDOR_RATE_CARD_VERSION
    : `caller:${provider}`;
}

/**
 * Build the shadow event, or explain why there is none.
 *
 * `unpriced` is skipped rather than written as $0. ENG-1250's billing boundary
 * forbids an unpriced unit becoming a silent $0 charge, and the ledger's own
 * CostSource has no `unpriced` member for exactly that reason -- so a $0 row
 * here would be the very thing the boundary exists to prevent, and would dilute
 * the §8 reconciliation with spend that never happened.
 */
export function buildShadowEvent(
  input: VendorUsageMirrorInput,
  occurredAt: string,
): { event: SpendEvent } | { skip: "unpriced" } {
  if (input.costSource === "unpriced") return { skip: "unpriced" };

  const actingUserId = input.userId || "system";
  const billingUserId = input.billingUserId || actingUserId;

  return {
    event: {
      billingUserId,
      eventId: input.idempotencyKey || `gen:${randomUUID()}`,
      occurredAt,
      billingMonth: occurredAt.slice(0, 7),
      actingUserId,
      ...(input.onBehalfOf ? { onBehalfOf: input.onBehalfOf } : {}),
      provider: input.provider,
      operation: input.operation,
      ...(input.feature ? { feature: input.feature } : {}),
      unit: input.unit,
      quantity: input.quantity,
      // The SAME arithmetic recordVendorUsage uses for its own row. If these two
      // ever diverge, every reconciliation in §8 reports drift that is really
      // just two roundings of one number.
      costMicroUsd: Math.max(0, Math.round((input.costUsd || 0) * 1e6)),
      costSource: input.costSource,
      ...(input.costSource === "allocated"
        ? { rateCardVersion: resolveRateProvenance(input.provider, input.operation) }
        : {}),
      ...(input.sessionId ? { references: { sessionId: input.sessionId } } : {}),
      lifecycle: "settled",
    },
  };
}

/**
 * Mirror one metered vendor call into the spend ledger. Never throws.
 *
 * Settled directly rather than reserved-then-settled: by the time
 * recordVendorUsage runs, the vendor call has already happened and been paid
 * for. A reservation would be recording an intention that is already history.
 */
export async function mirrorVendorUsage(
  input: VendorUsageMirrorInput,
  occurredAt: string = new Date().toISOString(),
): Promise<MirrorResult> {
  try {
    if (!isDualWriteEnabled()) return { status: "skipped", reason: "disabled" };

    const built = buildShadowEvent(input, occurredAt);
    if ("skip" in built) return { status: "skipped", reason: built.skip };

    const { stored, event } = await recordSpendEvent(built.event);
    return stored ? { status: "written", event } : { status: "duplicate", event };
  } catch (error) {
    // Everything is inside the try, including buildShadowEvent and the flag
    // read. This function is invoked fire-and-forget from a hot metering path,
    // so a rejection escaping it becomes an unhandled promise rejection and
    // takes the process down -- a shadow ledger killing the API it observes.
    // Returning a status instead of rejecting is the contract callers rely on.
    return { status: "failed", reason: error instanceof Error ? error.message : String(error) };
  }
}

// ── LLM spend (ENG-1934, ENG-1250 §6) ────────────────────────────────────────
//
// The vendor mirror above left the ledger holding vendor spend only, while
// LLM calls — most of what AgentWeb pays for — reached AW-UsageRecords and
// stopped. These helpers let both LLM write paths (`recordUsage` and the
// agent-engine `/internal/usage` batch) put the same call on the ledger, in
// the same transaction as its aggregate row.
//
// Observe-only, like the vendor rail: nothing enforces on these events. The
// live cap still counts `AW-Users.tokenUsage.totalCost`.

/**
 * Kill switch for LLM events. Separate from `SPEND_LEDGER_DUAL_WRITE` so the
 * two rails can be stopped independently: LLM calls are several times the
 * vendor write rate, and pausing them must not also blind the vendor ledger.
 *
 * Defaults ON for the same reason the vendor switch does — the point is to
 * accumulate a full billing cycle of evidence before any cap is sized, and a
 * default-off flag discovers weeks later that none exists. Blast radius: a
 * fire-and-forget write into a PAY_PER_REQUEST table nothing enforces on. Set
 * SPEND_LEDGER_LLM_DUAL_WRITE=false to restore today's aggregate-only writes.
 */
export function isLlmDualWriteEnabled(): boolean {
  return process.env.SPEND_LEDGER_LLM_DUAL_WRITE !== "false";
}

/**
 * The day LLM events began reaching the ledger in production.
 *
 * Two readers need it. The §8 fidelity check must not count days before it as
 * "not mirrored"; and the admin ledger must say that a month which started
 * before it holds only part of that month's LLM spend. Day granularity is
 * deliberate — the aggregate rail it is reconciled against is daily.
 */
export const LLM_SPEND_LEDGER_STARTED_ON = "2026-09-14";

/** How much of a billing month's LLM spend the ledger can hold. */
export interface LlmLedgerCoverage {
  /** Whether the kill switch currently lets LLM events through. */
  recording: boolean;
  startedOn: string;
  /**
   * `none`: the month ended before LLM events existed — the ledger holds its
   * vendor spend only. `partial`: the month began before them. `full`: every
   * day of the month is after the start.
   */
  month: "none" | "partial" | "full";
}

/**
 * Coverage for one `YYYY-MM`, for readers that compare the ledger total with an
 * allowance that also covers LLM spend. Without it that comparison silently
 * understates how much of the allowance a pre-coverage month used (ENG-1874).
 */
export function describeLlmLedgerCoverage(billingMonth: string): LlmLedgerCoverage {
  const startMonth = LLM_SPEND_LEDGER_STARTED_ON.slice(0, 7);
  return {
    recording: isLlmDualWriteEnabled(),
    startedOn: LLM_SPEND_LEDGER_STARTED_ON,
    month:
      billingMonth < startMonth
        ? "none"
        : billingMonth === startMonth && !LLM_SPEND_LEDGER_STARTED_ON.endsWith("-01")
        ? "partial"
        : "full",
  };
}

/**
 * Units for LLM events. Namespaced so no vendor rate-card unit can ever collide
 * with them — `isLlmSpendEvent` is how every reader tells the two rails apart.
 */
export const LLM_TOKEN_UNIT = "llm_token";
export const LLM_GENERATION_UNIT = "llm_generation";

export function isLlmSpendEvent(event: Pick<SpendEvent, "unit">): boolean {
  return event.unit === LLM_TOKEN_UNIT || event.unit === LLM_GENERATION_UNIT;
}

/** What an LLM write path knows once it has priced a call. */
export interface LlmSpendEventInput {
  /** Already defaulted to "system" by the caller when unattributed. */
  actingUserId: string;
  billingUserId: string;
  onBehalfOf?: string;
  sessionId?: string;
  taskId?: string;
  provider: string;
  model: string;
  feature: string;
  /** input + output + cache read + cache write. */
  totalTokens: number;
  /** True for image/video models billed per generation rather than per token. */
  perGeneration: boolean;
  costMicroUsd: number;
  costSource: "allocated" | "unpriced";
  /**
   * Where the dollar figure came from, stamped as the event's rateCardVersion.
   * `LLM_PRICE_BOOK_PROVENANCE` when this backend priced it; `caller:<who>` when
   * the amount arrived from outside the book (an OpenRouter-reported cost, the
   * agent engine). §5 requires one on every allocated event.
   */
  rateProvenance: string;
  /**
   * A per-call identity the caller already has (a provider response id, the
   * engine's charge-event id). When absent a fresh id is minted — build the
   * event ONCE, before any retry, so a retried write reuses it.
   */
  callId?: string;
}

/**
 * Build the spend event for one priced LLM call, or say why there is none.
 *
 * An unpriced model is skipped rather than written as $0, for exactly the
 * reason `buildShadowEvent` skips an unpriced vendor unit: the ledger's billing
 * boundary forbids a missing rate becoming a silent $0 charge.
 */
export function buildLlmSpendEvent(
  input: LlmSpendEventInput,
  occurredAt: string,
): { event: SpendEvent } | { skip: "unpriced" } {
  if (input.costSource === "unpriced") return { skip: "unpriced" };

  const references = {
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    ...(input.taskId ? { taskId: input.taskId } : {}),
  };

  return {
    event: {
      billingUserId: input.billingUserId,
      // Prefixed so an LLM call id can never collide with a vendor idempotency
      // key sharing this billing subject's partition.
      eventId: input.callId ? `llm:${input.callId}` : `gen:${randomUUID()}`,
      occurredAt,
      billingMonth: occurredAt.slice(0, 7),
      actingUserId: input.actingUserId,
      ...(input.onBehalfOf ? { onBehalfOf: input.onBehalfOf } : {}),
      provider: input.provider || "unknown",
      operation: input.model || "unknown",
      ...(input.feature ? { feature: input.feature } : {}),
      unit: input.perGeneration ? LLM_GENERATION_UNIT : LLM_TOKEN_UNIT,
      quantity: input.perGeneration ? 1 : Math.max(0, Math.round(input.totalTokens)),
      costMicroUsd: Math.max(0, Math.round(input.costMicroUsd)),
      costSource: "allocated",
      rateCardVersion: input.rateProvenance,
      ...(Object.keys(references).length ? { references } : {}),
      lifecycle: "settled",
    },
  };
}
