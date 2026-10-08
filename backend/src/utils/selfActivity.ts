/**
 * ENG-1271 (forward-only slice, per ENG-1501 decision option 1).
 *
 * Distinguishes "the customer is using the product" from "AgentWeb staff are
 * operating it through a delegated admin session". The only persisted
 * customer-only signal is `AW-Users.lastActiveAt`, which chatbotService writes
 * exclusively for non-delegated chat sessions. Spend is recorded for both kinds
 * of session, so spend this month with no recent self-activity is the
 * Haven/Every shape: heavy usage, customer absent.
 *
 * "Spend this month" comes from the spend ledger (the account's settled spend in
 * AW-SpendProjection), supplied by the caller. It used to be read off the legacy
 * `AW-Users.tokenUsage` counter, which ENG-1250 AC7 retires. It is slightly broader
 * than the old token check: vendor spend counts too, which is the better evidence of
 * an account being operated while its owner is absent.
 *
 * Deliberately NOT a historical or mixed-ratio rate: usage records carry no
 * session lineage, and adding one is a data-plane change (ENG-1501).
 */

/** Matches the `stale` window in utils/onboardingStage.ts. */
export const SELF_ACTIVITY_WINDOW_DAYS = 30;

export interface SelfActivitySignal {
  /** Customer's own (non-delegated) session was active inside the window. */
  selfActiveRecently: boolean;
  /** Last non-delegated activity, or null if never recorded / unparseable. */
  lastSelfActiveAt: string | null;
  /** Usage this month but no recent customer self-activity. */
  staffOperatedSuspect: boolean;
}

interface SelfActivityInput {
  lastActiveAt?: string | null;
}

export function deriveSelfActivity(
  user: SelfActivityInput,
  /** Whether the account has settled spend recorded this month (see the module doc). */
  hasUsageThisMonth: boolean,
  now: Date = new Date(),
): SelfActivitySignal {
  const parsed = user.lastActiveAt ? new Date(user.lastActiveAt) : null;
  const valid = parsed !== null && !Number.isNaN(parsed.getTime());
  const ageMs = valid ? now.getTime() - (parsed as Date).getTime() : -1;
  // A future timestamp (clock skew / bad write) is not evidence of activity.
  const selfActiveRecently =
    valid && ageMs >= 0 && ageMs <= SELF_ACTIVITY_WINDOW_DAYS * 24 * 60 * 60 * 1000;

  return {
    selfActiveRecently,
    lastSelfActiveAt: valid ? (parsed as Date).toISOString() : null,
    staffOperatedSuspect: hasUsageThisMonth && !selfActiveRecently,
  };
}
