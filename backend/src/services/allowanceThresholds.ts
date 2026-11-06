/**
 * ENG-2821 (child of ENG-2812): pure monthly allowance threshold-crossing evaluator.
 *
 * DARK — not wired into any live path. Persistence of fired thresholds, notification
 * channels, and customer copy belong to the parent issue. This module only decides which
 * thresholds are newly crossed for the given billing month.
 */

export interface FiredThreshold {
  billingMonth: string;
  threshold: number;
}

export interface AllowanceThresholdInput {
  usedUsd: number;
  allowanceUsd?: number;
  billingMonth: string;
  alreadyFired: FiredThreshold[];
  thresholds?: number[];
}

export const DEFAULT_ALLOWANCE_THRESHOLDS = [0.75, 0.9];

export function evaluateAllowanceThresholds(input: AllowanceThresholdInput): number[] {
  const { usedUsd, allowanceUsd, billingMonth, alreadyFired, thresholds = DEFAULT_ALLOWANCE_THRESHOLDS } = input;
  if (allowanceUsd === undefined || !Number.isFinite(allowanceUsd) || allowanceUsd <= 0) return [];
  if (!Number.isFinite(usedUsd)) return [];

  const ratio = usedUsd / allowanceUsd;
  const firedThisMonth = new Set(
    alreadyFired.filter((f) => f.billingMonth === billingMonth).map((f) => f.threshold),
  );

  return Array.from(new Set(thresholds))
    .filter((t) => Number.isFinite(t) && t > 0)
    .sort((a, b) => a - b)
    .filter((t) => ratio >= t && !firedThisMonth.has(t));
}
