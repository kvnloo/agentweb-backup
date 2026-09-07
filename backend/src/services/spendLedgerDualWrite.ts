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
