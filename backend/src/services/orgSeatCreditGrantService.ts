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
 * `getUserTokenUsage` in tokenUsageService.ts).
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
 *
 * DECIDED SCOPE LIMIT, not an oversight (2026-10-01 review): mid-month seat
 * increases are not back-filled. See the doc comment on
 * `grantMonthlySeatCreditForOrg` below for why, and for how that limit is kept
 * visible in logs.
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
 * `grantMonthlySeatCreditForOrg` is the only caller, so eligibility is
 * decided in exactly one place. An earlier version had the sweep re-derive
 * eligibility from the raw (unfloored) value before also calling into this
 * per-org function, which floored it independently — an org with e.g.
 * `purchasedExtraSeats: 0.5` was tallied as eligible by the sweep but then
 * came back neither granted, idempotent, nor failed, a silent gap in the
 * summary. `grantMonthlySeatCreditsForAllOrgs` now reads eligibility off this
 * function's own `attempted` result instead of recomputing it.
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
 *
 * DECIDED SCOPE LIMIT, not an oversight (2026-10-01 review): the grant id is
 * `seat-credit:{orgId}:{month}` — scoped to org+month, not to the seat count
 * at grant time. If an org raises `purchasedExtraSeats` mid-month (buys more
 * seats after this month's grant already landed), the additional credit is
 * NOT back-filled for the remainder of the current month — it first shows up
 * once this sweep runs again under next month's grant id, at the new total.
 * This was considered and deliberately NOT "fixed" with an immediate
 * mid-cycle top-up: doing that correctly needs either a delta-tracking ledger
 * (real risk of a worse double-credit bug if rushed) or folding seat credit
 * into the live policy-threshold resolution in llmUsagePolicyResolverService.ts
 * instead of a ledgered grant (a larger change touching every usage check in
 * the system, not just seat billing). Both are real options for a follow-up
 * iteration; shipping the simpler, well-tested monthly-grant model now with
 * this limitation disclosed beats rushing either under deadline pressure.
 * This function logs when it skips an org this way (below) so the gap stays
 * visible in logs rather than silently indistinguishable from a routine
 * idempotent replay.
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

  if (!result.granted) {
    // Idempotent replay — normal on every subsequent daily sweep run this
    // month. Logged at this (not error) level purely so the "mid-month
    // seat increase isn't back-filled" scope limit documented above stays
    // traceable: if `seats`/`amountMicroUsd` here is higher than whatever
    // was actually granted under this exact grantId earlier this month,
    // that gap is this decided limitation, not a failure — cross-reference
    // against AW-Users' llmUsageCredits ledger for this billingUserId/grantId
    // if a customer ever reports a shortfall.
    console.log(
      `[orgSeatCreditGrantService] ${grantId} already granted this month; current seat count (${seats}) would compute ${amountMicroUsd} microUSD — if this differs from the original grant, seats increased mid-month and the difference lands next cycle (decided scope limit, see this function's doc comment).`
    );
  }

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
    try {
      const result = await grantMonthlySeatCreditForOrg(org, now);
      if (!result.attempted) continue;
      summary.eligible++;
      if (result.granted) {
        summary.granted++;
        summary.totalGrantedMicroUsd += result.amountMicroUsd;
      } else {
        summary.idempotent++;
      }
    } catch (error: any) {
      // grantMonthlySeatCreditForOrg only throws past its own eligibility
      // check (see normalizePurchasedSeats), so a thrown error here always
      // means this org was eligible — count it as such alongside the failure.
      summary.eligible++;
      summary.failed++;
      summary.errors.push({ orgId: org.orgId, error: error?.message || String(error) });
      console.error(`[orgSeatCreditGrantService] Failed to grant seat credit for org ${org.orgId}:`, error);
    }
  }

  return summary;
}
