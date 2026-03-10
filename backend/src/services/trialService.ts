/**
 * Trial service — manages free trial lifecycle.
 *
 * Default: 3-day trial on signup.
 * Extended: 14-day trial after booking an onboarding call.
 */

export const DEFAULT_TRIAL_DAYS = 3;
export const EXTENDED_TRIAL_DAYS = 14;

export interface TrialStatus {
  /** User is currently in an active trial */
  isInTrial: boolean;
  /** Trial existed and has expired */
  isExpired: boolean;
  /** Days remaining (0 if expired or no trial) */
  daysRemaining: number;
  /** ISO date when trial ends (undefined if no trial) */
  trialEnd?: string;
}

/**
 * Check if a trial has expired based on the trial_end date.
 * Returns false if trial_end is not set (no trial = no restriction).
 */
export function isTrialExpired(trialEnd: string | undefined): boolean {
  if (!trialEnd) return false;
  return new Date(trialEnd).getTime() < Date.now();
}

/**
 * Get the full trial status for a user.
 */
export function getTrialStatus(
  trialStart: string | undefined,
  trialEnd: string | undefined
): TrialStatus {
  // No trial dates set — user has no trial (e.g., paying subscriber or legacy user)
  if (!trialStart || !trialEnd) {
    return { isInTrial: false, isExpired: false, daysRemaining: 0 };
  }

  const now = Date.now();
  const endMs = new Date(trialEnd).getTime();

  if (endMs < now) {
    // Trial has expired
    return {
      isInTrial: false,
      isExpired: true,
      daysRemaining: 0,
      trialEnd,
    };
  }

  // Trial is active
  const msRemaining = endMs - now;
  const daysRemaining = Math.ceil(msRemaining / (24 * 60 * 60 * 1000));

  return {
    isInTrial: true,
    isExpired: false,
    daysRemaining,
    trialEnd,
  };
}

/**
 * Calculate trial end date from a start date and duration in days.
 */
export function calculateTrialEnd(
  startDate: Date,
  durationDays: number
): Date {
  return new Date(startDate.getTime() + durationDays * 24 * 60 * 60 * 1000);
}
