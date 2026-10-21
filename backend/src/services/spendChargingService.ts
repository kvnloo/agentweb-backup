/**
 * The single charging API for AgentWeb-paid vendor spend (ENG-1250 §2).
 *
 * §2's rule is that "all paid egress goes through one service; callers may not
 * write the ledger or monthly counter directly". This is that service. It owns
 * the eight-step contract:
 *
 *   1. resolve the billing subject          -> resolveBillingSubject
 *   2. classify the call                    -> classify (agentweb-paid / customer-paid / overhead)
 *   3. resolve measured cost or allocated rate + version
 *   4. reserve                              -> reserveSpend
 *   5. check admission                      -- NOT here, see below
 *   6. execute the vendor call              -> chargeForCall's callback
 *   7. settle the actual spend or void      -> settleSpend / voidSpend
 *   8. persist the idempotent event         -> spendEventDb
 *
 * **Step 5 is deliberately absent.** Admission needs the monthly projection of
 * §3, which is the next slice, and wiring admission at all is what ENG-1250 AC6
 * reserves for Harsha behind shadow-reconciliation evidence. Nothing in this
 * module reads a balance, blocks a call, or can pause an account: it records.
 *
 * Failure policy: this module throws. That is deliberate and is the opposite of
 * `usageRecorderService`, which swallows every error by design so metering can
 * never break a customer's request. The difference is that a swallowed failure
 * on an *observation* rail loses a data point, while a swallowed failure on a
 * *charging* rail loses revenue with no counter of what was lost -- the exact
 * defect ENG-702 was raised for. The dual-write slice is what decides, per call
 * path, whether to run this fail-open during the observe-only phase; that choice
 * belongs at the call site, not buried here.
 */
import {
  SpendEvent,
  SpendEventCostSource,
  SpendEventReferences,
  getSpendEvent,
  recordSpendEvent,
  transitionSpendEvent,
} from "./spendEventDb";
import {
  VendorRateProvider,
  getAllocatedRateWithVersion,
  getRecordingUnit,
} from "../utils/vendorRateCard";

/**
 * ENG-1250's billing boundary, as three outcomes.
 *
 * `customer_paid` covers spend on the customer's own connected account (Meta ad
 * spend, customer-owned SaaS keys); `platform_overhead` covers shared cost with
 * no reviewed allocation policy. Both are recorded as decisions and produce NO
 * ledger row -- charging them would violate AC2.
 */
export type SpendClassification = "agentweb_paid" | "customer_paid" | "platform_overhead";

export interface ChargeSubject {
  /** Who ran the call. */
  actingUserId: string;
  /** Whose balance it debits. Defaults to actingUserId. */
  billingUserId?: string;
  orgId?: string;
}

export interface ChargeRequest {
  /** The idempotency token. Same key twice = one charge, per §1. */
  idempotencyKey: string;
  subject: ChargeSubject;
  provider: string;
  /** What was bought — also the rate-card key when the cost is allocated. */
  operation: string;
  feature?: string;
  quantity: number;
  /** Defaults to `agentweb_paid`. */
  classification?: SpendClassification;
  /**
   * The vendor's own reported cost in USD, when it reports one. Takes
   * precedence over the rate card (§5: "Vendor-reported cost wins").
   */
  measuredCostUsd?: number;
  /** Overrides the card's recording unit. Rarely needed. */
  unit?: string;
  references?: SpendEventReferences;
  vendorReference?: string;
  /** Defaults to now. Pass explicitly when the call and the record can straddle UTC midnight. */
  occurredAt?: string;
}

export class UnpricedSpendError extends Error {
  constructor(provider: string, operation: string) {
    super(
      `No measured cost and no allocated rate for "${provider}" / "${operation}" — ` +
        "price it in vendorRateCard.ts or classify the call as platform_overhead. " +
        "ENG-1250's billing boundary forbids booking it as a silent $0 charge.",
    );
    this.name = "UnpricedSpendError";
  }
}

export class InvalidChargeQuantityError extends Error {
  constructor(provider: string, operation: string, quantity: unknown) {
    super(
      `Invalid quantity ${String(quantity)} for "${provider}" / "${operation}" — ` +
        "must be a finite, non-negative number. Coercing it would book an " +
        "allocated charge of $0 that looks priced but is not.",
    );
    this.name = "InvalidChargeQuantityError";
  }
}

/** A charge that was skipped because it is not AgentWeb's to bill. */
export interface NotChargedResult {
  charged: false;
  classification: Exclude<SpendClassification, "agentweb_paid">;
}

export interface ChargedResult {
  charged: true;
  classification: "agentweb_paid";
  event: SpendEvent;
  /** false when the idempotency key had already been charged. */
  stored: boolean;
}

export type ChargeResult = ChargedResult | NotChargedResult;

/**
 * Step 1. Falls back to the acting user, matching how `recordVendorUsage`
 * already resolves it, so the two rails attribute a call the same way during
 * dual-write — a divergence here would surface as reconciliation drift in §8
 * and be read as a metering bug rather than an attribution difference.
 */
export function resolveBillingSubject(subject: ChargeSubject): {
  billingUserId: string;
  actingUserId: string;
  orgId?: string;
  onBehalfOf?: string;
} {
  const actingUserId = subject.actingUserId || "system";
  const billingUserId = subject.billingUserId || actingUserId;
  return {
    billingUserId,
    actingUserId,
    ...(subject.orgId ? { orgId: subject.orgId } : {}),
    // Only meaningful when the two differ; §1 lists it as optional for exactly
    // that reason, and writing it unconditionally would make every ordinary
    // self-serve call look delegated.
    ...(billingUserId !== actingUserId ? { onBehalfOf: actingUserId } : {}),
  };
}

export interface ResolvedCost {
  costMicroUsd: number;
  costSource: SpendEventCostSource;
  rateCardVersion?: string;
  unit: string;
  /** The validated quantity, so the event records what was actually priced. */
  quantity: number;
}

/**
 * Step 3. Measured beats allocated; an unpriced unit throws.
 *
 * Throwing is the point. ENG-700 established the distinction this preserves:
 * `allocated` means "0 or more real dollars from a known rate", while a missing
 * rate is not a $0 charge, it is an unknown one. §"Billing boundary" is explicit
 * that unpriced paid egress "must never become a silent $0 charge".
 */
export function resolveCost(request: ChargeRequest): ResolvedCost {
  // Reject rather than coerce (CodeRabbit, PR #2788). Clamping a NaN or a
  // negative quantity to 0 produced costMicroUsd 0 with costSource still
  // "allocated" -- a row that looks priced and re-derivable but books nothing,
  // which is precisely the silent $0 charge this file's header forbids, on the
  // revenue path. Zero itself stays legal: buying zero units really does cost
  // zero, and that is a priced answer, not an unknown one.
  if (!Number.isFinite(request.quantity) || request.quantity < 0) {
    throw new InvalidChargeQuantityError(request.provider, request.operation, request.quantity);
  }
  const quantity = request.quantity;

  if (request.measuredCostUsd !== undefined) {
    if (!Number.isFinite(request.measuredCostUsd) || request.measuredCostUsd < 0) {
      throw new Error(`measuredCostUsd must be a non-negative number, got ${request.measuredCostUsd}`);
    }
    return {
      costMicroUsd: Math.round(request.measuredCostUsd * 1e6),
      costSource: "measured",
      unit: request.unit || getRecordingUnit(request.provider as VendorRateProvider, request.operation) || "call",
      quantity,
    };
  }

  // Rate and version come from one snapshot: the event is stamped with the version of the
  // rate that priced it even if an admin override lands between two lookups.
  const priced = getAllocatedRateWithVersion(request.provider as VendorRateProvider, request.operation);
  if (priced === null) throw new UnpricedSpendError(request.provider, request.operation);

  return {
    costMicroUsd: Math.round(quantity * priced.rate * 1e6),
    costSource: "allocated",
    rateCardVersion: priced.version,
    unit: request.unit || getRecordingUnit(request.provider as VendorRateProvider, request.operation) || "call",
    quantity,
  };
}

function buildEvent(request: ChargeRequest, lifecycle: SpendEvent["lifecycle"]): SpendEvent {
  const subject = resolveBillingSubject(request.subject);
  const cost = resolveCost(request);
  const occurredAt = request.occurredAt || new Date().toISOString();

  return {
    billingUserId: subject.billingUserId,
    eventId: request.idempotencyKey,
    occurredAt,
    // Derived from occurredAt rather than from the clock, so the two can never
    // disagree — spendEventDb rejects an event where they do.
    billingMonth: occurredAt.slice(0, 7),
    ...(subject.orgId ? { orgId: subject.orgId } : {}),
    actingUserId: subject.actingUserId,
    ...(subject.onBehalfOf ? { onBehalfOf: subject.onBehalfOf } : {}),
    provider: request.provider,
    operation: request.operation,
    ...(request.feature ? { feature: request.feature } : {}),
    unit: cost.unit,
    // The validated value from resolveCost, not request.quantity raw -- the two
    // were the same number by luck, and only the store's own validator stood
    // between a NaN request and a NaN row.
    quantity: cost.quantity,
    costMicroUsd: cost.costMicroUsd,
    costSource: cost.costSource,
    ...(cost.rateCardVersion ? { rateCardVersion: cost.rateCardVersion } : {}),
    ...(request.references ? { references: request.references } : {}),
    lifecycle,
    ...(request.vendorReference ? { vendorReference: request.vendorReference } : {}),
  };
}

/** Step 2. Anything not explicitly customer-paid or overhead is AgentWeb's. */
export function classify(request: ChargeRequest): SpendClassification {
  return request.classification || "agentweb_paid";
}

/**
 * Steps 4 + 8. Book a reservation for spend about to happen.
 *
 * §4: a fixed-price call reserves the exact allocated rate; a variable-cost call
 * reserves a documented estimate and settles the actual amount.
 */
export async function reserveSpend(request: ChargeRequest): Promise<ChargeResult> {
  const classification = classify(request);
  if (classification !== "agentweb_paid") return { charged: false, classification };

  const { stored, event } = await recordSpendEvent(buildEvent(request, "reserved"));
  return { charged: true, classification, event, stored };
}

/**
 * Steps 7 + 8. Record spend that already happened, with no reservation.
 *
 * For call sites where reserving is not practical because the cost is unknowable
 * until the vendor answers and the call cannot be gated anyway.
 */
export async function recordSettledSpend(request: ChargeRequest): Promise<ChargeResult> {
  const classification = classify(request);
  if (classification !== "agentweb_paid") return { charged: false, classification };

  const { stored, event } = await recordSpendEvent(buildEvent(request, "settled"));
  return { charged: true, classification, event, stored };
}

/** Step 7. Returns false when the reservation was already settled or voided. */
export async function settleSpend(
  billingUserId: string,
  eventId: string,
  actualCostUsd?: number,
): Promise<boolean> {
  const micro =
    actualCostUsd === undefined
      ? undefined
      : Math.round(actualCostUsd * 1e6);
  if (micro === undefined) {
    // Settling at the reserved amount: read it back rather than guessing, so a
    // fixed-price call does not need to restate its own price to settle.
    const existing = await getSpendEvent(billingUserId, eventId);
    if (!existing) return false;
    return transitionSpendEvent(billingUserId, eventId, "settled", existing.costMicroUsd);
  }
  return transitionSpendEvent(billingUserId, eventId, "settled", micro);
}

/** Step 7, the other branch. Releases the reservation; the row stays as evidence. */
export async function voidSpend(billingUserId: string, eventId: string): Promise<boolean> {
  return transitionSpendEvent(billingUserId, eventId, "voided");
}

/**
 * The whole contract around one vendor call: reserve, execute, then settle or
 * void. This is the entry point adapters should use.
 *
 * The vendor call runs even when the idempotency key was already reserved. That
 * is intentional: this service dedupes *charges*, not vendor calls, and a caller
 * retrying its own operation is not something the ledger can or should prevent.
 * The settle is what stays idempotent — a second settle against an already
 * settled event returns false and books nothing.
 *
 * A thrown vendor error voids the reservation and re-throws UNCHANGED, so the
 * caller's own error handling is unaffected by being metered -- including when
 * the void itself fails, which is logged rather than allowed to replace the
 * vendor's error.
 *
 * A failure to SETTLE after a successful vendor call is likewise logged rather
 * than thrown. The money is already spent by then, so throwing would discard
 * the result the caller paid for and invite a duplicate vendor call. The
 * reservation stays `reserved`, which overstates spend rather than losing it
 * and surfaces in the §8 reconciliation as an unsettled row.
 */
export async function chargeForCall<T>(
  request: ChargeRequest,
  call: () => Promise<T>,
  /** Derive the real cost from the vendor's response, for variable-cost calls. */
  settleWith?: (result: T) => number | undefined,
): Promise<T> {
  const reservation = await reserveSpend(request);

  if (!reservation.charged) return call();

  const { billingUserId, eventId } = reservation.event;

  let result: T;
  try {
    result = await call();
  } catch (error) {
    // The vendor error must reach the caller unchanged (CodeRabbit, PR #2788).
    // If voidSpend throws -- a DynamoDB throttle, say -- its error would
    // replace the vendor's, and a caller switching on the vendor error type
    // would see a database error instead. The stuck `reserved` row is the
    // safe failure: it overstates spend rather than losing it, and §8 surfaces
    // it as an unsettled reservation.
    try {
      await voidSpend(billingUserId, eventId);
    } catch (voidError) {
      console.error(
        `[spendCharging] could not void reservation ${eventId} for ${billingUserId} after a vendor failure:`,
        voidError instanceof Error ? voidError.message : voidError,
      );
    }
    throw error;
  }

  try {
    // settleWith is CALLER code reading a vendor response shape, so it can
    // throw as easily as the ledger can (CodeRabbit, PR #2788). Evaluating it
    // outside this block reintroduced the exact failure the catch exists to
    // prevent: vendor paid, result discarded, caller retries and pays again.
    const actualCostUsd = settleWith ? settleWith(result) : undefined;
    if (actualCostUsd === undefined) {
      // Settle at the reserved amount using the figure already in hand, rather
      // than settleSpend's read-back path: a fixed-price call would otherwise
      // pay for a DynamoDB read on every single charge to recover a number this
      // function computed moments earlier. Passing micro-dollars straight
      // through also avoids a needless /1e6 -> *1e6 round trip through float.
      await transitionSpendEvent(billingUserId, eventId, "settled", reservation.event.costMicroUsd);
    } else {
      await settleSpend(billingUserId, eventId, actualCostUsd);
    }
  } catch (settleError) {
    // The vendor call already succeeded and the money is already spent
    // (CodeRabbit, PR #2788). Throwing here would discard `result`, so the
    // caller loses work it has paid for and very likely retries the vendor
    // call -- paying twice. The reservation simply stays `reserved`, which
    // overstates spend rather than losing it and shows up in §8 as an
    // unsettled reservation.
    //
    // This is not a hole in the module's throw policy. That policy exists so a
    // charge is never lost silently; a stuck reservation is neither lost nor
    // silent.
    console.error(
      `[spendCharging] vendor call succeeded but settling ${eventId} for ${billingUserId} failed; ` +
        "reservation left open for reconciliation:",
      settleError instanceof Error ? settleError.message : settleError,
    );
  }
  return result;
}
