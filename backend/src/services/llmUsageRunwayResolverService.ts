/**
 * ENG-1212 — API projection over the pure runway calculator.
 *
 * Composes the authoritative usage state with the cost ledger and hands both to
 * `computeUsageRunway`. Deliberately thin: all judgement lives in the pure
 * calculator, all I/O lives here. This mirrors the existing split between
 * `llmUsagePolicyService` (pure) and `llmUsagePolicyResolverService` (impure).
 *
 * ## Billing subject, not caller
 *
 * The ledger is read for the resolved BILLING SUBJECT. An org member pools onto
 * the billing root (`inheritsOrgBilling`), so reading their own userId would
 * show a sliver of the account's spend and forecast a runway several times too
 * long — the ENG-1200 investigation showed one root covering four humans.
 *
 * Resolving that subject is necessary but NOT sufficient, and the first cut of
 * this file got it wrong: ledger rows are partitioned by the ACTING user, so the
 * root's partition holds only the root's own calls. Reading it while
 * `costUsedMicroUsd` is already pooled reproduces the very error described above.
 * `readPooledLedgerRows` closes that gap by reading every partition that bills
 * here; see `llmUsageLedgerReader` for why the predicate must be the same one
 * `resolveBillingUserId` uses.
 *
 * ## Cycle boundaries
 *
 * The included allowance resets monthly at 00:00 UTC on the 1st, which is what
 * `tokenUsage.month` / `resetDate` already encode and what the ledger's
 * `YYYY-MM-DD` sort key aligns to. Paid plans moving to the Stripe
 * billing-period boundary is ENG-1135's contract, not this issue's; when that
 * lands, only `resolveCycle` below changes.
 */

import { getEffectiveLlmUsagePolicy } from "./llmUsagePolicyResolverService";
import { recordUsageTelemetry, USAGE_TELEMETRY_EVENTS } from "./llmUsageTelemetry";
import { readBilledLedgerRows, hasInferredAttribution } from "./llmUsageLedgerReader";
import {
  computeUsageRunway,
  type UsageRunway,
} from "./llmUsageForecastService";

export interface ResolvedUsageRunway {
  billingUserId: string;
  /** false when the tier carries no cost policy — there is nothing to forecast against. */
  available: boolean;
  /** null when `available` is false. Carries internal diagnostics; strip for customers. */
  runway: UsageRunway | null;
}

/** UTC calendar day, `YYYY-MM-DD`. */
function utcDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function resolveCycle(today: string): { cycleStartDate: string; cycleResetDate: string } {
  const [year, month] = today.split("-").map(Number);
  const cycleStartDate = `${year}-${String(month).padStart(2, "0")}-01`;
  // Month 12 rolls to January of the next year; Date.UTC handles the overflow.
  const resetMs = Date.UTC(year, month, 1);
  return { cycleStartDate, cycleResetDate: utcDay(new Date(resetMs)) };
}

export async function resolveUsageRunway(
  userId: string,
  options: { today?: string } = {},
): Promise<ResolvedUsageRunway> {
  const today = options.today || utcDay(new Date());
  const usage = await getEffectiveLlmUsagePolicy(userId);

  // No configured policy (Managed, Partner, Demo, unmapped tiers) means no
  // ceiling exists. Withhold rather than forecast against an invented one —
  // the same discipline the calculator applies to thin history.
  if (!usage.policy) {
    return { billingUserId: usage.billingUserId, available: false, runway: null };
  }

  const { cycleStartDate, cycleResetDate } = resolveCycle(today);

  // Query to `today` inclusive: the calculator discards the in-progress day
  // itself, but fetching it keeps this boundary in one place rather than two.
  //
  // Read through the POOLED reader, not `queryByUserDateRange` directly. The
  // billing subject is resolved above, but ledger rows are partitioned by the
  // ACTING user, so a root's own partition is only its own calls — while
  // `costUsedMicroUsd` is already pooled. Mixing the two divides the account's
  // consumption by one person's burn and overstates the runway.
  // The UNION reader (ENG-1251), not the partition fan-out alone. The fan-out can
  // only ask about people who are members NOW, so a member who leaves mid-cycle
  // takes their spend out of the burn rate while `costUsedMicroUsd` still counts
  // it. That understates burn, and understating burn LENGTHENS the runway -- the
  // customer is told they are fine and then runs out mid-cycle, which is the
  // surprise this whole feature exists to prevent.
  const rows = await readBilledLedgerRows(usage.billingUserId, cycleStartDate, today);

  // Tell the forecast when its inputs are only approximately ours, so it reports
  // `low` confidence rather than a precise-looking date built on inference.
  const attributionInferred = hasInferredAttribution(rows);

  const runway = computeUsageRunway({
    // Both of these are already credit-adjusted by getEffectiveLlmUsagePolicy —
    // re-applying credits here would double-count them.
    costUsedMicroUsd: usage.costUsedMicroUsd,
    hardThresholdMicroUsd: usage.policy.hardCostThresholdMicroUsd,
    attributionInferred,
    dailyCostMicroUsd: rows.map((row) => ({
      date: row.date,
      costMicroUsd: row.costMicroUsd || 0,
    })),
    cycleStartDate,
    cycleResetDate,
    today,
  });

  // ENG-1212 AC6: record the forecast's inputs and output version so any figure
  // a customer was shown can be reproduced later. Awaited but non-throwing —
  // `recordUsageTelemetry` swallows its own failures, so a telemetry problem can
  // never turn a working forecast into a 500.
  //
  // Deliberately NOT spread from `runway`: `diagnostics` carries the raw burn
  // rates and remaining allowance in micro-USD. The redactor would strip them,
  // but naming the safe fields means the guard is a backstop rather than the
  // only thing standing between internal economics and a log line.
  await recordUsageTelemetry(usage.billingUserId, USAGE_TELEMETRY_EVENTS.forecastComputed, {
    version: runway.version,
    confidence: runway.confidence,
    onTrack: runway.onTrack,
    percentUsed: runway.percentUsed,
    estimatedDaysRemaining: runway.estimatedDaysRemaining,
    estimatedExhaustionDate: runway.estimatedExhaustionDate,
    completeDaysElapsed: runway.completeDaysElapsed,
    daysUntilReset: runway.daysUntilReset,
    resetDate: runway.resetDate,
    ledgerRowCount: rows.length,
  });

  return { billingUserId: usage.billingUserId, available: true, runway };
}
