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
 * v0 returns no per-call price — only `.id` is read from the response — so every
 * entry is `costSource: "allocated"` with no dollar figure, per AC6. When a rate
 * card lands, only this file changes. `v0BillingService`'s account-level balance
 * is a periodic drift check, never a per-call cost.
 */

import { recordVendorUsage } from "./usageRecorderService";

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
    void recordVendorUsage({
      userId: ctx.userId,
      billingUserId: ctx.billingUserId,
      ...(ctx.onBehalfOf ? { onBehalfOf: ctx.onBehalfOf } : {}),
      provider: "v0",
      operation: ctx.operation,
      feature: "landing_page",
      unit: "generation",
      quantity: 1,
      // AC6 — allocated for as long as v0 returns no per-call price.
      costSource: "allocated",
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
