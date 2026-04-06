/**
 * Revenue metric calculations — pure utility functions.
 * All formulas live here, not in components.
 */

export interface SubscriptionRecord {
  userId: string;
  email: string;
  stripeCustomerId: string;
  subscriptionStatus: string;
  subscriptionType: string;
  monthlyAmount: number; // in cents
  currentPeriodStart: string;
  currentPeriodEnd: string;
  createdAt: string;
  canceledAt?: string;
}

export interface RevenueSnapshot {
  date: string; // YYYY-MM
  mrr: number;
  newMrr: number;
  expansionMrr: number;
  contractionMrr: number;
  churnedMrr: number;
  netNewMrr: number;
  activeSubscriptions: number;
  newSubscriptions: number;
  churnedSubscriptions: number;
  customerChurnRate: number;
  revenueChurnRate: number;
}

export interface RevenueMetrics {
  currentMrr: number;
  previousMrr: number;
  mrrChange: number;
  mrrChangePercent: number;
  arr: number;
  nrr: number; // Net Revenue Retention as percentage
  grossChurnRate: number;
  netChurnRate: number;
  arpu: number;
  activeCount: number;
  payingCount: number;
  trialCount: number;
  pastDueCount: number;
  churnedCount: number;
  ltv: number;
}

export interface CohortRow {
  cohortMonth: string; // YYYY-MM
  startingCount: number;
  startingMrr: number;
  retention: number[]; // percentage retained at month 0, 1, 2, ...
  mrrRetention: number[]; // MRR retained at month 0, 1, 2, ...
}

// --- Core calculations ---

/**
 * MRR = sum of all active subscription monthly amounts
 */
export function calculateMrr(subscriptions: SubscriptionRecord[]): number {
  return subscriptions
    .filter((s) => s.subscriptionStatus === "active" || s.subscriptionStatus === "trialing")
    .reduce((sum, s) => sum + s.monthlyAmount, 0);
}

/**
 * ARR = MRR × 12
 */
export function calculateArr(mrr: number): number {
  return mrr * 12;
}

/**
 * NRR = (Starting MRR + Expansion - Contraction - Churn) / Starting MRR × 100
 * >100% means existing customers are worth more over time (good)
 * <100% means you're shrinking from existing base (bad)
 */
export function calculateNrr(
  startingMrr: number,
  expansionMrr: number,
  contractionMrr: number,
  churnedMrr: number,
): number {
  if (startingMrr === 0) return 0;
  return ((startingMrr + expansionMrr - contractionMrr - churnedMrr) / startingMrr) * 100;
}

/**
 * ARPU = MRR / number of paying customers
 */
export function calculateArpu(mrr: number, payingCount: number): number {
  if (payingCount === 0) return 0;
  return mrr / payingCount;
}

/**
 * Gross churn rate = churned customers / starting customers × 100
 */
export function calculateGrossChurnRate(churnedCount: number, startingCount: number): number {
  if (startingCount === 0) return 0;
  return (churnedCount / startingCount) * 100;
}

/**
 * Net churn rate = (churned MRR - expansion MRR) / starting MRR × 100
 * Negative = net expansion (good)
 */
export function calculateNetChurnRate(
  churnedMrr: number,
  expansionMrr: number,
  startingMrr: number,
): number {
  if (startingMrr === 0) return 0;
  return ((churnedMrr - expansionMrr) / startingMrr) * 100;
}

/**
 * Customer LTV = ARPU / monthly churn rate
 * Rough estimate. Returns 0 if churn rate is 0 (infinite LTV).
 */
export function calculateLtv(arpu: number, monthlyChurnRate: number): number {
  if (monthlyChurnRate <= 0) return 0;
  return arpu / (monthlyChurnRate / 100);
}

// --- Aggregation helpers ---

/**
 * Compute full RevenueMetrics from current + previous period data.
 */
export function computeRevenueMetrics(
  currentSubs: SubscriptionRecord[],
  previousSubs: SubscriptionRecord[],
  churnedThisMonth: SubscriptionRecord[],
  newThisMonth: SubscriptionRecord[],
  expansionMrr: number,
  contractionMrr: number,
): RevenueMetrics {
  const currentMrr = calculateMrr(currentSubs);
  const previousMrr = calculateMrr(previousSubs);
  const mrrChange = currentMrr - previousMrr;
  const mrrChangePercent = previousMrr > 0 ? (mrrChange / previousMrr) * 100 : 0;

  const payingCount = currentSubs.filter(
    (s) => s.subscriptionStatus === "active" && s.monthlyAmount > 0,
  ).length;
  const trialCount = currentSubs.filter((s) => s.subscriptionStatus === "trialing").length;
  const pastDueCount = currentSubs.filter((s) => s.subscriptionStatus === "past_due").length;
  const activeCount = payingCount + trialCount;

  const churnedMrr = churnedThisMonth.reduce((sum, s) => sum + s.monthlyAmount, 0);
  const arpu = calculateArpu(currentMrr, payingCount);
  const grossChurnRate = calculateGrossChurnRate(
    churnedThisMonth.length,
    previousSubs.filter((s) => s.subscriptionStatus === "active").length,
  );
  const netChurnRate = calculateNetChurnRate(churnedMrr, expansionMrr, previousMrr);
  const nrr = calculateNrr(previousMrr, expansionMrr, contractionMrr, churnedMrr);
  const ltv = calculateLtv(arpu, grossChurnRate);

  return {
    currentMrr,
    previousMrr,
    mrrChange,
    mrrChangePercent,
    arr: calculateArr(currentMrr),
    nrr,
    grossChurnRate,
    netChurnRate,
    arpu,
    activeCount,
    payingCount,
    trialCount,
    pastDueCount,
    churnedCount: churnedThisMonth.length,
    ltv,
  };
}

// --- Formatting helpers ---

/**
 * Format cents to dollars string: 12345 → "$123.45"
 */
export function formatCents(cents: number): string {
  const dollars = cents / 100;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(dollars);
}

/**
 * Format cents to dollars with decimals: 12345 → "$123.45"
 */
export function formatCentsExact(cents: number): string {
  const dollars = cents / 100;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(dollars);
}

/**
 * Format percentage: 112.5 → "112.5%"
 */
export function formatPercent(value: number, decimals = 1): string {
  return `${value.toFixed(decimals)}%`;
}

/**
 * Change indicator: positive → "+$123", negative → "-$123"
 */
export function formatChange(cents: number): string {
  const prefix = cents >= 0 ? "+" : "";
  return `${prefix}${formatCents(cents)}`;
}

/**
 * Determine health color for a metric.
 */
export function getMetricColor(
  metric: "nrr" | "churn" | "mrrChange",
  value: number,
): "success" | "warning" | "error" {
  switch (metric) {
    case "nrr":
      if (value >= 100) return "success";
      if (value >= 90) return "warning";
      return "error";
    case "churn":
      if (value <= 3) return "success";
      if (value <= 7) return "warning";
      return "error";
    case "mrrChange":
      if (value > 0) return "success";
      if (value === 0) return "warning";
      return "error";
  }
}
