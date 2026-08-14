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
import { readPooledLedgerRows } from "./llmUsageLedgerReader";
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
  const rows = await readPooledLedgerRows(usage.billingUserId, cycleStartDate, today);

  const runway = computeUsageRunway({
    // Both of these are already credit-adjusted by getEffectiveLlmUsagePolicy —
    // re-applying credits here would double-count them.
    costUsedMicroUsd: usage.costUsedMicroUsd,
    hardThresholdMicroUsd: usage.policy.hardCostThresholdMicroUsd,
    dailyCostMicroUsd: rows.map((row) => ({
      date: row.date,
      costMicroUsd: row.costMicroUsd || 0,
    })),
    cycleStartDate,
    cycleResetDate,
    today,
  });

  return { billingUserId: usage.billingUserId, available: true, runway };
}
