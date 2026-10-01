/**
 * Seat-based billing (ENG-2247) — monthly LLM usage credit grant.
 *
 * Product decision: $50/month per purchased extra seat, of which $30 becomes
 * additional shared LLM usage credit for the org, granted on the same
 * monthly cadence as the org's existing usage/cost counters reset.
 *
 * "The same cadence" turned out to have no single hook to extend. Per-user
 * token/cost counters (`tokenUsageService.ts`) are NOT reset by any scheduled
 * job — they reset lazily, in place, the moment a read or increment notices
 * the stored `month` no longer matches `getCurrentUsageMonth()` (see
 * `getUserTokenUsage` / `incrementUserTokenUsage` in tokenUsageService.ts).
 * There is no central "month rolled over" event to subscribe to, and nothing
 * to extend directly: a hypothetical edit at the lazy-reset call sites would
 * only fire for a user who happens to incur usage that month, which is
 * exactly backwards for a credit that must land whether or not the org used
 * anything yet.
 *
 * So this ships as a sibling scheduled sweep (`cron/orgSeatCreditGrantCron.ts`,
 * registered daily in server.ts) running at the identical monthly granularity:
 * `getCurrentUsageMonth()` is the same calendar-month key the usage ledger
 * itself resets on, and the grant id is scoped to it
 * (`seat-credit:{orgId}:{month}`), so the sweep is a no-op for an org it has
 * already credited this month no matter how many times a day it runs or how
 * many times the process restarts (see dailySchedule.ts for why this backend
 * can't rely on a naive 24h setInterval to mean "once a day").
 *
 * Idempotency is NOT reimplemented here — it is entirely delegated to
 * `grantMonthlyLlmUsageCredit`'s own grantId ledger + ConditionalCheckFailedException
 * retry loop (llmUsageCreditService.ts). This module's only job is to decide,
 * once per org per sweep, what to call that function with.
 */

import { orgDb, type Organization } from './db';
import { getCurrentUsageMonth, grantMonthlyLlmUsageCredit } from './llmUsageCreditService';

/** $30 of the $50/seat/month price becomes shared LLM usage credit (ENG-2247 product decision). */
export const SEAT_CREDIT_MICRO_USD_PER_SEAT = 30_000_000;

export interface OrgSeatCreditGrantResult {
  orgId: string;
  /** False when the org has no (or non-positive) purchasedExtraSeats — nothing was attempted. */
  attempted: boolean;
  /** True only when this call actually appended a new grant; false for a skip or an idempotent replay. */
  granted: boolean;
  amountMicroUsd: number;
}

export interface OrgSeatCreditGrantSummary {
  scanned: number;
  /** Orgs with purchasedExtraSeats > 0 — grantMonthlyLlmUsageCredit was called for each. */
  eligible: number;
  granted: number;
  /** Already credited this usage month — grantId collision handled by grantMonthlyLlmUsageCredit. */
  idempotent: number;
  failed: number;
  totalGrantedMicroUsd: number;
  errors: Array<{ orgId: string; error: string }>;
}

/** Deterministic, human-traceable grant id: one grant per org per usage month. */
export function seatCreditGrantId(orgId: string, usageMonth: string): string {
  return `seat-credit:${orgId}:${usageMonth}`;
}

/**
 * Normalize a raw `purchasedExtraSeats` value to a non-negative integer seat
 * count. Non-numeric/non-finite values and values that floor to <= 0 (absent,
 * zero, negative, or fractional like 0.5) all collapse to 0 — "no seats
 * purchased" — rather than throwing, since this reads untyped DynamoDB data.
 *
 * Used both by the sweep's own eligibility pre-check and by
 * `grantMonthlySeatCreditForOrg`'s skip check, so the two can never disagree:
 * previously the sweep counted an org as "eligible" using the raw (unfloored)
 * value while the per-org function skipped it using the floored value, so an
 * org with e.g. `purchasedExtraSeats: 0.5` was tallied as eligible but ended
 * up neither granted, idempotent, nor failed — a silent gap in the summary,
 * and a wasted call into the credit-grant path for an org that was always
 * going to no-op.
 */
export function normalizePurchasedSeats(rawSeats: unknown): number {
  const seats = typeof rawSeats === 'number' && Number.isFinite(rawSeats) ? Math.floor(rawSeats) : 0;
  return seats > 0 ? seats : 0;
}

/**
 * Grant (or no-op replay) this month's seat credit for a single org.
 * Skips orgs with no purchased extra seats without calling the credit
 * function at all — a zero/absent seat count must never produce a call,
 * wasted or otherwise.
 */
export async function grantMonthlySeatCreditForOrg(
  org: Pick<Organization, 'orgId' | 'ownerUserId' | 'purchasedExtraSeats'>,
  now: Date = new Date(),
): Promise<OrgSeatCreditGrantResult> {
  const seats = normalizePurchasedSeats(org.purchasedExtraSeats);
  if (seats <= 0) {
    return { orgId: org.orgId, attempted: false, granted: false, amountMicroUsd: 0 };
  }

  const usageMonth = getCurrentUsageMonth(now);
  const amountMicroUsd = SEAT_CREDIT_MICRO_USD_PER_SEAT * seats;
  const grantId = seatCreditGrantId(org.orgId, usageMonth);

  const result = await grantMonthlyLlmUsageCredit({
    billingUserId: org.ownerUserId,
    grantId,
    source: 'purchase',
    amountMicroUsd,
    now,
    reason: `Seat-based billing: ${seats} purchased extra seat(s) for ${usageMonth}`,
  });

  return { orgId: org.orgId, attempted: true, granted: result.granted, amountMicroUsd };
}

/**
 * Sweep every organization and grant (or idempotently skip) this month's
 * seat-based LLM usage credit. One org's failure is logged and does not
 * abort the sweep for the rest — mirrors the per-item isolation in
 * `approvalExpirySweepCron.ts`.
 */
export async function grantMonthlySeatCreditsForAllOrgs(
  now: Date = new Date(),
): Promise<OrgSeatCreditGrantSummary> {
  const summary: OrgSeatCreditGrantSummary = {
    scanned: 0,
    eligible: 0,
    granted: 0,
    idempotent: 0,
    failed: 0,
    totalGrantedMicroUsd: 0,
    errors: [],
  };

  const orgs = await orgDb.listAll();
  for (const org of orgs) {
    summary.scanned++;
    if (normalizePurchasedSeats(org.purchasedExtraSeats) <= 0) continue;
    summary.eligible++;
    try {
      const result = await grantMonthlySeatCreditForOrg(org, now);
      if (result.granted) {
        summary.granted++;
        summary.totalGrantedMicroUsd += result.amountMicroUsd;
      } else if (result.attempted) {
        summary.idempotent++;
      }
    } catch (error: any) {
      summary.failed++;
      summary.errors.push({ orgId: org.orgId, error: error?.message || String(error) });
      console.error(`[orgSeatCreditGrantService] Failed to grant seat credit for org ${org.orgId}:`, error);
    }
  }

  return summary;
}
