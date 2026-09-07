/**
 * The monthly spend projection of ENG-1250 §3 — derived, not stored.
 *
 * §3 calls for an atomic `billingUserId + month` projection. Persisting one is a
 * second data-plane gate, so this slice builds the *derivation* first: a pure
 * function over immutable spend events that produces the §3 shape and proves
 * §3's invariant, with no new table and no writes. Persisting it for
 * admission-speed reads is the follow-up, and arrives with measurements behind
 * it rather than a design sketch.
 *
 * Nothing here reads live data, writes anything, or decides admission. Every
 * input is passed in.
 *
 * ## Two things this module deliberately does NOT invent
 *
 * **The policy boundary.** ENG-1250 §3/§4 say the mode is
 * `full_choice | optimized | paused`. That text was written on 2026-08-15;
 * ENG-1211 then shipped on 2026-09-04 and removed the optimization boundary
 * outright — `evaluateLlmUsageMode` can no longer return `optimized`, and
 * `optimizationCostThresholdMicroUsd` is an alert level that "can never again
 * change, block, or rewrite a model". Deriving three modes here would quietly
 * reintroduce a gate the team deliberately deleted, so this delegates to
 * `evaluateLlmUsageMode` instead of reimplementing the comparison. One
 * boundary, one definition, no way for the two rails to disagree about it.
 *
 * **The spend basis.** The live gate counts LLM cost only; this rail counts
 * every AgentWeb-paid vendor. So for the same account the new basis is >= the
 * old one and can reach the same threshold sooner. That difference is not a
 * bug to paper over — quantifying it is exactly what the §8 shadow
 * reconciliation is for, and AC6 forbids moving enforcement until it has been
 * measured. `policyMode` here is therefore a SHADOW computation. Nothing reads
 * it.
 */
import { SpendEvent } from "./spendEventDb";
import { LlmUsageMode, LlmUsagePolicy, evaluateLlmUsageMode } from "./llmUsagePolicyService";

/**
 * The allowance side of the ledger (§3). Passed in rather than fetched: these
 * live in subscription policy and the credit ledger, and wiring them is a later
 * slice. Keeping them parameters is also what makes the invariant testable.
 *
 * Per §3, "credits and migration adjustments change available allowance; they
 * never erase or rewrite spend" — so none of these ever touch `settledMicroUsd`.
 */
export interface AllowanceInputs {
  /** The tier's included monthly allowance. */
  includedAllowanceMicroUsd: number;
  purchasedCreditsMicroUsd?: number;
  /** Admin grants (positive) and reversals (negative). */
  adminAdjustmentMicroUsd?: number;
  migrationAdjustmentMicroUsd?: number;
}

export interface MonthlyProjection {
  billingUserId: string;
  billingMonth: string;

  /** Settled spend. The figure §3's invariant must reproduce. */
  settledMicroUsd: number;
  /** In-flight reservations. Admission input, not spend. */
  reservedMicroUsd: number;

  includedAllowanceMicroUsd: number;
  purchasedCreditsMicroUsd: number;
  adminAdjustmentMicroUsd: number;
  migrationAdjustmentMicroUsd: number;
  /** Everything the subject may spend this month, after adjustments. */
  usableAllowanceMicroUsd: number;
  /** usable - settled - reserved. Floors at 0; overspend is read from `overspentMicroUsd`. */
  remainingMicroUsd: number;
  /** How far past the allowance the subject already is, 0 when within it. */
  overspentMicroUsd: number;

  /**
   * SHADOW ONLY — see the module header. Nothing consumes this.
   *
   * Basis is settled spend, matching the live gate's, so the one intended
   * divergence (all-vendor vs LLM-only) stays the only one §8 has to measure.
   */
  policyMode: LlmUsageMode;
  /**
   * Why `policyMode` fell back to `full_choice`, when a malformed stored policy
   * made it uncomputable. Absent on the normal path. Present means the mode is
   * a default, not a measurement — a §8 comparison must not treat it as one.
   */
  policyModeError?: string;

  settledEventCount: number;
  reservedEventCount: number;
  voidedEventCount: number;
  /** Events dropped for belonging to another subject or month. Should be 0. */
  excludedEventCount: number;
}

const sum = (events: readonly SpendEvent[]) => events.reduce((t, e) => t + e.costMicroUsd, 0);

/**
 * The shadow mode, computed so it can never take the projection down with it.
 *
 * `evaluateLlmUsageMode` throws `InvalidLlmUsagePolicyError` when an enforcing
 * policy fails validation. Letting that escape would mean one malformed stored
 * policy aborts `projectMonth` entirely and the caller loses `settledMicroUsd`,
 * the reservations and the allowance figures too -- an outage path fed by
 * config data, for the sake of a field nothing reads (CodeRabbit, PR #2791).
 * The failure is reported rather than swallowed, so a bad policy is visible
 * without being fatal.
 *
 * Basis is SETTLED spend only, deliberately. This module declares exactly one
 * intended divergence from the live gate -- all-vendor spend instead of
 * LLM-only -- and that is the number §8 has to measure. Including reservations
 * here would add a second, undocumented divergence, and the reconciliation
 * could no longer attribute a difference to either one. §4's admission basis
 * IS settled + reserved, and both are exposed as separate fields for whoever
 * builds it.
 */
function shadowPolicyMode(
  settledMicroUsd: number,
  policy: LlmUsagePolicy | null | undefined,
): { policyMode: LlmUsageMode; policyModeError?: string } {
  try {
    return { policyMode: evaluateLlmUsageMode({ costUsedMicroUsd: settledMicroUsd, policy }).usageMode };
  } catch (error) {
    return {
      policyMode: "full_choice",
      policyModeError: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Build the projection for one billing subject and month.
 *
 * Events are filtered to the subject and month rather than trusted, and the
 * number dropped is reported. A caller that hands over a neighbouring month's
 * events would otherwise get a plausible-looking total that no reconciliation
 * could ever match, and the §8 check would read it as vendor drift.
 */
export function projectMonth(
  billingUserId: string,
  billingMonth: string,
  events: readonly SpendEvent[],
  allowance: AllowanceInputs,
  policy?: LlmUsagePolicy | null,
): MonthlyProjection {
  const mine = events.filter((e) => e.billingUserId === billingUserId && e.billingMonth === billingMonth);

  const settled = mine.filter((e) => e.lifecycle === "settled");
  const reserved = mine.filter((e) => e.lifecycle === "reserved");
  const voided = mine.filter((e) => e.lifecycle === "voided");

  const settledMicroUsd = sum(settled);
  const reservedMicroUsd = sum(reserved);

  const purchasedCreditsMicroUsd = allowance.purchasedCreditsMicroUsd ?? 0;
  const adminAdjustmentMicroUsd = allowance.adminAdjustmentMicroUsd ?? 0;
  const migrationAdjustmentMicroUsd = allowance.migrationAdjustmentMicroUsd ?? 0;

  // Adjustments can legitimately be negative (a reversal), but they must not be
  // able to drive the allowance below zero and turn into phantom spend.
  const usableAllowanceMicroUsd = Math.max(
    0,
    allowance.includedAllowanceMicroUsd +
      purchasedCreditsMicroUsd +
      adminAdjustmentMicroUsd +
      migrationAdjustmentMicroUsd,
  );

  const committed = settledMicroUsd + reservedMicroUsd;
  const remainingMicroUsd = Math.max(0, usableAllowanceMicroUsd - committed);
  const overspentMicroUsd = Math.max(0, committed - usableAllowanceMicroUsd);

  return {
    billingUserId,
    billingMonth,
    settledMicroUsd,
    reservedMicroUsd,
    includedAllowanceMicroUsd: allowance.includedAllowanceMicroUsd,
    purchasedCreditsMicroUsd,
    adminAdjustmentMicroUsd,
    migrationAdjustmentMicroUsd,
    usableAllowanceMicroUsd,
    remainingMicroUsd,
    overspentMicroUsd,
    ...shadowPolicyMode(settledMicroUsd, policy),
    settledEventCount: settled.length,
    reservedEventCount: reserved.length,
    voidedEventCount: voided.length,
    excludedEventCount: events.length - mine.length,
  };
}

/**
 * §3's invariant: "summing immutable settled events must reproduce the monthly
 * spend projection within one micro-dollar".
 *
 * One micro-dollar, not zero, because the spec names that tolerance — but note
 * that with integer micro-dollars throughout, a real discrepancy is the only
 * way to consume it. A non-zero drift here means events were lost, double
 * counted, or written to the wrong month; it is never rounding.
 */
export const PROJECTION_TOLERANCE_MICRO_USD = 1;

export interface ProjectionReconciliation {
  ok: boolean;
  driftMicroUsd: number;
  eventSumMicroUsd: number;
  projectionMicroUsd: number;
}

export function reconcileProjection(
  events: readonly SpendEvent[],
  projection: MonthlyProjection,
): ProjectionReconciliation {
  const eventSumMicroUsd = sum(
    events.filter(
      (e) =>
        e.billingUserId === projection.billingUserId &&
        e.billingMonth === projection.billingMonth &&
        e.lifecycle === "settled",
    ),
  );
  const driftMicroUsd = eventSumMicroUsd - projection.settledMicroUsd;

  return {
    ok: Math.abs(driftMicroUsd) <= PROJECTION_TOLERANCE_MICRO_USD,
    driftMicroUsd,
    eventSumMicroUsd,
    projectionMicroUsd: projection.settledMicroUsd,
  };
}
