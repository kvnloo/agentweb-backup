/**
 * The enforcer's own admission state, shaped for the admin spend ledger
 * (ENG-1886).
 *
 * The admin screen used to have no way to show whether an account is actually
 * paused. The spend ledger's `pause` came from `explainPause`, a SHADOW
 * computation over the ledger that nothing enforces on (and that ENG-1874
 * withheld). This module does not compute anything: it re-labels the exact
 * `TokenUsageStatus` that `checkTokenUsage` returns — the value that admits or
 * refuses a user's work — so the screen and the gate cannot disagree about
 * "paused". A second definition is what ENG-1135 consolidated away.
 *
 * What it deliberately carries alongside the decision: the counter the enforcer
 * measured (`AW-Users.tokenUsage`), which ENG-1247 found can differ from what an
 * account really spent. The screen must show what the enforcer DECIDED, and
 * say that it is not the ledger total.
 */
import type { TokenUsageStatus } from "./tokenUsageService";

export type EnforcementState =
  | {
      available: true;
      /** YYYY-MM the enforcer evaluated — always the current month. */
      month: string;
      /** The admission decision itself. false means the account is paused now. */
      paused: boolean;
      /** `usageMode` as the enforcer returned it, when a versioned policy set one. */
      usageMode: string | null;
      /** Which counter gates admission: dollars (LLM cost) or token count. */
      gatedBy: "cost" | "tokens" | "none";
      /** The counter and threshold the decision was made against, in the gating unit. */
      used: number;
      limit: number | null;
      percentUsed: number;
      /** First day of the month after `month` (UTC), when the counter resets. */
      resetsOn: string;
      usagePolicyVersion: string | null;
    }
  | { available: false; reason: "not-current-month"; currentMonth: string }
  | { available: false; reason: "unreadable"; message: string };

/** `2026-09` → `2026-10-01`. */
export function firstDayOfNextMonth(month: string): string {
  const [y, m] = month.split("-").map(Number);
  const next = m === 12 ? { y: y + 1, m: 1 } : { y, m: m + 1 };
  return `${next.y}-${String(next.m).padStart(2, "0")}-01`;
}

/**
 * Describe the enforcer's decision for the month an admin is looking at.
 *
 * The enforcer only knows the CURRENT month (its counter resets), so a past
 * month is reported as unavailable rather than inferring a historical pause
 * from spend — which would be exactly the shadow claim this replaces.
 */
export function describeEnforcement(status: TokenUsageStatus, requestedMonth: string): EnforcementState {
  if (requestedMonth !== status.month) {
    return { available: false, reason: "not-current-month", currentMonth: status.month };
  }

  const gatedByCost = status.costEnforced;
  const tokenLimit = status.effectiveAllowance;
  const gatedBy: "cost" | "tokens" | "none" = gatedByCost ? "cost" : tokenLimit === null ? "none" : "tokens";

  return {
    available: true,
    month: status.month,
    paused: !status.allowed,
    usageMode: status.usageMode ?? null,
    gatedBy,
    used: gatedByCost ? status.costUsed : status.used,
    limit: gatedByCost ? status.costAllowance : tokenLimit,
    percentUsed: gatedByCost ? status.costPercentUsed : status.percentUsed,
    resetsOn: firstDayOfNextMonth(status.month),
    usagePolicyVersion: status.usagePolicyVersion ?? null,
  };
}
