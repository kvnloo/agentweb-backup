/**
 * ENG-694 — vendor metering for v0 landing-page generation.
 *
 * v0 runs on a single account-wide key, so per-user attribution is ours to
 * produce; `userId` is already in scope at every billable site, so this is
 * plumbing rather than auth work.
 *
 * ## Why the wrapper sits INSIDE the retry callback
 *
 * Every billable site has the shape
 * `guardedV0X({ ..., send: () => withRetry(() => v0.chats.Y(...)) })`.
 * Metering at the guard would record once per logical request; the contract asks
 * for what the VENDOR was asked to do, so a retry that actually reached v0 has
 * to appear. Wrapping the innermost callback is the only layer where each
 * attempt is individually observable.
 *
 * ## Why it records on some failures
 *
 * A request that reached v0 can be billed even when our side then errors — the
 * 300s-timeout case that ENG-287 was about. So an error carrying an HTTP status
 * (v0 answered) is recorded; a transport error with no status (we never got
 * there) is not. Recording everything would invent spend; recording only
 * successes would miss exactly the case that motivated the row.
 *
 * ## Cost
 *
 * v0's RESPONSE carries no price — only `.id` is read from it. That is exactly
 * what an allocated rate is for, and one already exists: `vendorRateCard.ts`
 * prices `v0.landing_page_generation` at $2.00/generation (ENG-703, approved
 * 2026-08-16), and that module states no adapter may embed its own dollar
 * literal for a vendor it covers.
 *
 * AC6 asks for the cost to be reported as ALLOCATED, which per ENG-700 means
 * "0 or more real dollars from a known rate" — as opposed to "unpriced", which
 * means 0 because the rate is missing. An earlier revision of this file recorded
 * `allocated` with NO figure, which collapses those two into the worst reading:
 * confirmed-free spend from a known rate. The rate is read from the card here.
 *
 * If the card ever loses the entry, this degrades to `unpriced` rather than
 * booking a silent $0 — ENG-700's signal — instead of throwing, because metering
 * must never fail a render the vendor has already been paid for.
 *
 * `v0BillingService`'s account-level balance stays a periodic drift check, never
 * a per-call cost.
 */

import { recordVendorUsage } from "./usageRecorderService";
import { getAllocatedRate } from "../utils/vendorRateCard";

/** The card key for a v0 landing-page generation (ENG-703). */
const V0_RATE_KEY = "landing_page_generation";

export type V0Operation =
  | "chat_create"
  | "correction_message"
  | "iterate_message";

export interface V0MeterContext {
  /** The member who triggered the call. */
  userId?: string;
  /** The account the spend is billed to — the page owner when they differ (AC5). */
  billingUserId?: string;
  /** Set when the acting member is not the accountable owner (AC5). */
  onBehalfOf?: string;
  operation: V0Operation;
  /**
   * ENG-702 AC1: the charge's identity. Supplied by v0UsageGuard, which already
   * owns the canonical notion of "the same generation", so the guard and the
   * ledger can never disagree about what one call is.
   *
   * The unit is ONE CHARGE PER RESERVATION, not per attempt. `meteredV0`
   * returns a thunk that `withRetry` re-invokes, so every retry inside one
   * reservation used to book another charge -- the exact defect ENG-702 names:
   * "the v0 retry loop books duplicates under one reservation". Sharing the
   * key across those attempts collapses them into one charge, while a
   * guard-permitted retry after a failure mints a NEW reservation and is
   * charged in full, because it really did call v0 again.
   */
  idempotencyKey?: string;
}

/** True when the error carries evidence that v0 answered, so the call was billable. */
export function reachedVendor(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const e = error as Record<string, any>;
  const status =
    e.status ?? e.statusCode ?? e.response?.status ?? e.response?.statusCode;
  return typeof status === "number" && status > 0;
}

export function recordV0Call(ctx: V0MeterContext): void {
  // Fire-and-forget AND fail-open. `void` alone only swallows a rejected promise;
  // a recorder that throws synchronously would still propagate into the caller and
  // fail a generation the vendor has already been paid for. The try/catch is what
  // makes "metering never breaks generation" true rather than intended.
  try {
    // Read, never embed. A rate change must stay a one-line edit in the card.
    const rate = getAllocatedRate("v0", V0_RATE_KEY);
    void recordVendorUsage({
      userId: ctx.userId,
      billingUserId: ctx.billingUserId,
      ...(ctx.onBehalfOf ? { onBehalfOf: ctx.onBehalfOf } : {}),
      provider: "v0",
      operation: ctx.operation,
      feature: "landing_page",
      unit: "generation",
      quantity: 1,
      ...(ctx.idempotencyKey ? { idempotencyKey: ctx.idempotencyKey } : {}),
      ...(rate === null
        ? // The card lost the entry: make it loud rather than book a silent $0.
          { costSource: "unpriced" as const }
        : { costSource: "allocated" as const, costUsd: rate }),
    });
  } catch {
    // Deliberately silent: usageRecorderService already throttles its own failure
    // logging, and a second log here would double it on a ledger outage.
  }
}

/**
 * Wrap the innermost v0 call so every attempt that reached the vendor is
 * recorded exactly once.
 *
 * Returns a thunk of the same shape `withRetry` already expects, so a call site
 * changes from `() => v0.chats.x(a)` to `meteredV0(ctx, () => v0.chats.x(a))`
 * and nothing about the retry or guard semantics moves.
 */
export function meteredV0<T>(ctx: V0MeterContext, call: () => Promise<T>): () => Promise<T> {
  return async () => {
    try {
      const result = await call();
      recordV0Call(ctx);
      return result;
    } catch (error) {
      if (reachedVendor(error)) recordV0Call(ctx);
      throw error;
    }
  };
}
