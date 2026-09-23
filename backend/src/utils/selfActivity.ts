/**
 * ENG-1271 (forward-only slice, per ENG-1501 decision option 1).
 *
 * Distinguishes "the customer is using the product" from "AgentWeb staff are
 * operating it through a delegated admin session". The only persisted
 * customer-only signal is `AW-Users.lastActiveAt`, which chatbotService writes
 * exclusively for non-delegated chat sessions. Token usage is recorded for
 * both kinds of session, so tokens this month with no recent self-activity is
 * the Haven/Every shape: heavy usage, customer absent.
 *
 * Deliberately NOT a historical or mixed-ratio rate: token records carry no
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
  tokenUsage?: { month?: string; totalTokens?: number } | null;
}

const currentMonth = (now: Date): string => now.toISOString().slice(0, 7);

export function deriveSelfActivity(
  user: SelfActivityInput,
  now: Date = new Date(),
): SelfActivitySignal {
  const parsed = user.lastActiveAt ? new Date(user.lastActiveAt) : null;
  const valid = parsed !== null && !Number.isNaN(parsed.getTime());
  const selfActiveRecently =
    valid &&
    now.getTime() - (parsed as Date).getTime() <=
      SELF_ACTIVITY_WINDOW_DAYS * 24 * 60 * 60 * 1000;

  const usage = user.tokenUsage;
  const hasUsageThisMonth =
    !!usage &&
    usage.month === currentMonth(now) &&
    typeof usage.totalTokens === "number" &&
    usage.totalTokens > 0;

  return {
    selfActiveRecently,
    lastSelfActiveAt: valid ? (parsed as Date).toISOString() : null,
    staffOperatedSuspect: hasUsageThisMonth && !selfActiveRecently,
  };
}
