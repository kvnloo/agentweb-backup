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
import type { LlmUsageModeDecision, LlmUsagePolicy } from "./llmUsagePolicyService";
import type { PaygOverageStatus } from "./paygOverage";
import { recordUsageTelemetry, USAGE_TELEMETRY_EVENTS } from "./llmUsageTelemetry";
import { readBilledLedgerRows, hasInferredAttribution } from "./llmUsageLedgerReader";

/**
 * How much of the authoritative counter the reconstructed ledger must account for
 * before the forecast is treated as built on complete data. Below this, spend was
 * billed to this subject that the ledger could not find.
 */
const LEDGER_COMPLETENESS_TOLERANCE = 0.95;
import {
  assessForecastAccuracy,
  computeUsageRunway,
  type UsageRunway,
} from "./llmUsageForecastService";
import { utcDay, resolveCycle } from "../utils/usageCycle";

export interface ResolvedUsageRunway {
  billingUserId: string;
  /** false when the tier carries no cost policy — there is nothing to forecast against. */
  available: boolean;
  /** null when `available` is false. Carries internal diagnostics; strip for customers. */
  runway: UsageRunway | null;
}


/**
 * ENG-668: the allowance a runway is forecast against, and whether pay-as-you-go is covering.
 *
 * Shared by `/usage-runway` and the drivers preview (llmUsageDriversResolverService) so the two can never
 * forecast against different pools. For an account admitted on PAYG the pool is the one PAYG measures
 * overage on — the month's high-water pool, not today's possibly smaller one:
 *   - spend at or past that pool: PAYG is covering, so there is no "runs out" (`paygCovering`), whether
 *     or not any of it is billable yet (an opt-in baseline can make the billable part 0);
 *   - spend below it (a downgrade still under this month's high-water pool): the included usage left in
 *     that pool is real, so the forecast runs against it rather than declaring the smaller pool spent.
 */
export function runwayAllowance(usage: {
  policy: LlmUsagePolicy;
  costUsedMicroUsd: number;
  mode: LlmUsageModeDecision;
  overage?: PaygOverageStatus;
}): { hardThresholdMicroUsd: number; paygCovering: boolean } {
  const overage = usage.mode.reason === "payg_overage" ? usage.overage : undefined;
  if (!overage) return { hardThresholdMicroUsd: usage.policy.hardCostThresholdMicroUsd, paygCovering: false };
  return {
    hardThresholdMicroUsd: overage.poolMicroUsd,
    paygCovering: usage.costUsedMicroUsd >= overage.poolMicroUsd,
  };
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

  // A second, independent signal that attribution is incomplete.
  //
  // `costUsedMicroUsd` is the AUTHORITATIVE cycle-to-date counter: it is
  // incremented against the billing root at write time, so it already includes
  // spend by people who have since left the org. The ledger is reconstructed by
  // finding partitions, which cannot reach a departed member's unstamped rows --
  // they have no user record, the org record keeps no member history, and nothing
  // on the row links it to an org.
  //
  // So we cannot recover those rows, but we CAN notice they are gone: a ledger
  // materially below the counter means spend was billed here that the forecast
  // never saw. That matters because the shortfall understates burn, and
  // understating burn LENGTHENS the projected runway -- the direction that
  // reassures a customer shortly before they run out.
  //
  // The `attributionInferred` flag alone does not catch this case: if every row
  // that IS visible carries a payer stamp, nothing is marked inferred even though
  // an entire departed member is missing.
  //
  // Tolerance is deliberate rather than exact. The two are written by different
  // paths at different moments, so small skew is normal and must not permanently
  // pin every account to `low`; only a material gap is treated as evidence.
  const ledgerTotalMicroUsd = rows.reduce((sum, row) => sum + (row.costMicroUsd || 0), 0);
  const ledgerIsIncomplete =
    usage.costUsedMicroUsd > 0 &&
    ledgerTotalMicroUsd < usage.costUsedMicroUsd * LEDGER_COMPLETENESS_TOLERANCE;

  const { hardThresholdMicroUsd, paygCovering } = runwayAllowance({ ...usage, policy: usage.policy });
  // Named rather than inlined so the accuracy backtest below re-runs the
  // forecast over EXACTLY the same inputs — a backtest against a different
  // ledger view would measure the difference between the two views, not the
  // accuracy of the forecast.
  const forecastInput = {
    // Both of these are already credit-adjusted by getEffectiveLlmUsagePolicy —
    // re-applying credits here would double-count them.
    costUsedMicroUsd: usage.costUsedMicroUsd,
    hardThresholdMicroUsd,
    attributionInferred: attributionInferred || ledgerIsIncomplete,
    dailyCostMicroUsd: rows.map((row) => ({
      date: row.date,
      costMicroUsd: row.costMicroUsd || 0,
    })),
    cycleStartDate,
    cycleResetDate,
    today,
    ...(paygCovering ? { paygCovering: true } : {}),
  };
  const runway = computeUsageRunway(forecastInput);

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

  // ENG-1215 AC4: telemetry has to record forecast versus ACTUAL, not only what
  // was shown. Every event above says what we told the customer; none says
  // whether it turned out to be true, so nothing could answer "is the forecast
  // any good" — on a screen whose entire value is asking people to act on it.
  //
  // Recomputed from the same ledger rather than read from a stored snapshot:
  // `computeUsageRunway` is pure, so the earlier forecast is reproducible
  // exactly, and a snapshot could drift from the code that produced it. Null
  // for a cycle too short to hold both a forecast and an outcome — in which
  // case nothing is emitted rather than a zero that would read as a perfect
  // score.
  // No forecast was made while PAYG covers the account, so there is nothing to score.
  const accuracy = runway.paygCovering
    ? null
    : assessForecastAccuracy(forecastInput, runway, { creditsApplied: usage.creditsApplied });
  if (accuracy) {
    await recordUsageTelemetry(usage.billingUserId, USAGE_TELEMETRY_EVENTS.forecastAccuracy, {
      version: runway.version,
      ...accuracy,
    });
  }

  return { billingUserId: usage.billingUserId, available: true, runway };
}
