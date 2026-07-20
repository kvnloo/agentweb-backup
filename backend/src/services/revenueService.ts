/**
 * Revenue metrics service — calculates MRR, NRR, ARPU, churn, cohorts
 * from Stripe subscriptions + PaymentHistory DynamoDB table.
 *
 * All monetary values are in cents.
 */
import Stripe from 'stripe';
import { createStripeClient } from './stripeClientFactory';
import dotenv from 'dotenv';
import { userDb } from './db';
import { paymentHistoryDb, PaymentHistoryRecord } from './paymentHistoryDb';

dotenv.config();

// Emails excluded from ALL revenue metrics (e.g. barter/debt-payoff arrangements).
// These users get free service but are NOT customers for MRR/churn/cohort purposes.
const EXCLUDED_EMAILS: Set<string> = new Set([
  'childrenstorywithai@gmail.com', // StorywithAI — free service to pay off debt
]);

let _stripe: Stripe | null = null;

function getStripe(): Stripe {
  if (!_stripe) {
    const key = process.env.STRIPE_SECRET_KEY;
    if (!key) throw new Error('Missing STRIPE_SECRET_KEY');
    _stripe = createStripeClient(key);
  }
  return _stripe;
}

// ─── Types ──────────────────────────────────────────────────────────────

export interface RevenueMetrics {
  currentMrr: number;
  previousMrr: number;
  mrrChange: number;
  mrrChangePercent: number;
  arr: number;
  nrr: number;
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
  customerChurnRate: number; // % of customers lost this month
  revenueChurnRate: number; // % of MRR lost this month
}

export interface CohortRow {
  cohortMonth: string;
  startingCount: number;
  startingMrr: number;
  retention: number[];
  mrrRetention: number[];
}

// ─── Core: fetch all Stripe subscriptions ───────────────────────────────

async function fetchAllSubscriptions(): Promise<Stripe.Subscription[]> {
  const stripe = getStripe();
  const subs: Stripe.Subscription[] = [];
  let hasMore = true;
  let startingAfter: string | undefined;

  while (hasMore) {
    const params: Stripe.SubscriptionListParams = {
      limit: 100,
      status: 'all',
      expand: ['data.items.data.price', 'data.customer', 'data.discounts'],
    };
    if (startingAfter) params.starting_after = startingAfter;

    const page = await stripe.subscriptions.list(params);
    subs.push(...page.data);
    hasMore = page.has_more;
    if (page.data.length > 0) {
      startingAfter = page.data[page.data.length - 1].id;
    }
  }

  // Filter out excluded emails (barter/debt arrangements, not real customers)
  return subs.filter(s => {
    const customer = s.customer as Stripe.Customer;
    if (customer?.email && EXCLUDED_EMAILS.has(customer.email.toLowerCase())) return false;
    return true;
  });
}

/**
 * Get the monthly amount for a subscription in cents.
 * Converts yearly prices to monthly equivalent.
 * Accounts for active coupons/discounts — a 100% off coupon = $0 effective MRR.
 */
function getMonthlyAmount(sub: Stripe.Subscription): number {
  const item = sub.items.data[0];
  if (!item?.price) return 0;

  let amount = item.price.unit_amount || 0;
  const interval = item.price.recurring?.interval;

  if (interval === 'year') amount = Math.round(amount / 12);

  // Apply active discounts if present (Stripe API uses discounts array)
  const discounts = sub.discounts;
  if (discounts && discounts.length > 0) {
    for (const discount of discounts) {
      const coupon = typeof discount === 'object' && 'coupon' in discount ? discount.coupon : null;
      if (!coupon || typeof coupon === 'string') continue;
      if (coupon.percent_off) {
        amount = Math.round(amount * (1 - coupon.percent_off / 100));
      } else if (coupon.amount_off) {
        const monthlyDiscount = interval === 'year'
          ? Math.round(coupon.amount_off / 12)
          : coupon.amount_off;
        amount = Math.max(0, amount - monthlyDiscount);
      }
    }
  }

  return amount;
}

function toYearMonth(ts: number): string {
  const d = new Date(ts * 1000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function monthDiff(a: string, b: string): number {
  const [ay, am] = a.split('-').map(Number);
  const [by, bm] = b.split('-').map(Number);
  return (by - ay) * 12 + (bm - am);
}

// ─── Current metrics ────────────────────────────────────────────────────

export async function computeCurrentMetrics(): Promise<RevenueMetrics> {
  const subs = await fetchAllSubscriptions();
  const now = new Date();
  const thisMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

  const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const lastMonthStr = `${lastMonth.getFullYear()}-${String(lastMonth.getMonth() + 1).padStart(2, '0')}`;

  const active = subs.filter(s => s.status === 'active' || s.status === 'trialing');
  const paying = active.filter(s => s.status === 'active' && getMonthlyAmount(s) > 0);
  const trials = active.filter(s => s.status === 'trialing');
  const pastDue = subs.filter(s => s.status === 'past_due');

  const currentMrr = paying.reduce((sum, s) => sum + getMonthlyAmount(s), 0);

  // Churned this month: canceled subs whose canceled_at falls in this month
  const churnedThisMonth = subs.filter(s => {
    if (s.status !== 'canceled' || !s.canceled_at) return false;
    return toYearMonth(s.canceled_at) === thisMonth;
  });
  const churnedMrr = churnedThisMonth.reduce((sum, s) => sum + getMonthlyAmount(s), 0);

  // New this month: created this month and still active
  const newThisMonth = paying.filter(s => toYearMonth(s.created) === thisMonth);
  const newMrr = newThisMonth.reduce((sum, s) => sum + getMonthlyAmount(s), 0);

  // Estimate previous MRR from current + churn - new
  // (Accurate calculation would need historical Stripe data or invoice history)
  const previousMrr = currentMrr - newMrr + churnedMrr;

  // Expansion/contraction: detect from PaymentHistory subscription_updated events
  // For MVP, estimate as MRR change minus new/churn
  const expansionMrr = Math.max(0, currentMrr - previousMrr - newMrr + churnedMrr);
  const contractionMrr = Math.max(0, previousMrr - currentMrr + newMrr - churnedMrr);

  const mrrChange = currentMrr - previousMrr;
  const mrrChangePercent = previousMrr > 0 ? (mrrChange / previousMrr) * 100 : 0;

  const arpu = paying.length > 0 ? currentMrr / paying.length : 0;
  const previousPayingCount = paying.length - newThisMonth.length + churnedThisMonth.length;
  const grossChurnRate = previousPayingCount > 0
    ? (churnedThisMonth.length / previousPayingCount) * 100
    : 0;
  const netChurnRate = previousMrr > 0
    ? ((churnedMrr - expansionMrr) / previousMrr) * 100
    : 0;
  const nrr = previousMrr > 0
    ? ((previousMrr + expansionMrr - contractionMrr - churnedMrr) / previousMrr) * 100
    : 100;
  const ltv = grossChurnRate > 0 ? arpu / (grossChurnRate / 100) : 0;

  return {
    currentMrr,
    previousMrr,
    mrrChange,
    mrrChangePercent,
    arr: currentMrr * 12,
    nrr,
    grossChurnRate,
    netChurnRate,
    arpu,
    activeCount: active.length,
    payingCount: paying.length,
    trialCount: trials.length,
    pastDueCount: pastDue.length,
    churnedCount: churnedThisMonth.length,
    ltv,
  };
}

// ─── Historical snapshots ───────────────────────────────────────────────

export async function computeMonthlySnapshots(months: number = 24): Promise<RevenueSnapshot[]> {
  const subs = await fetchAllSubscriptions();
  const now = new Date();
  const snapshots: RevenueSnapshot[] = [];

  for (let i = months - 1; i >= 0; i--) {
    const targetDate = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const monthStr = `${targetDate.getFullYear()}-${String(targetDate.getMonth() + 1).padStart(2, '0')}`;
    const monthEnd = new Date(targetDate.getFullYear(), targetDate.getMonth() + 1, 0);
    const monthEndTs = Math.floor(monthEnd.getTime() / 1000);
    const monthStartTs = Math.floor(targetDate.getTime() / 1000);

    // Previous month for churn rate denominator
    const prevMonthDate = new Date(targetDate.getFullYear(), targetDate.getMonth() - 1, 1);
    const prevMonthEnd = new Date(targetDate.getFullYear(), targetDate.getMonth(), 0);
    const prevMonthEndTs = Math.floor(prevMonthEnd.getTime() / 1000);
    const prevMonthStartTs = Math.floor(prevMonthDate.getTime() / 1000);

    // Active at end of this month: created before month end, not canceled before month end
    const activeAtEnd = subs.filter(s => {
      const created = s.created;
      if (created > monthEndTs) return false;
      if (s.status === 'canceled' && s.canceled_at && s.canceled_at < monthStartTs) return false;
      if (s.status === 'canceled' && s.canceled_at && s.canceled_at <= monthEndTs) return false;
      return getMonthlyAmount(s) > 0 || s.status === 'trialing';
    });

    // Active at end of previous month (starting base for churn calc)
    const activeAtPrevEnd = subs.filter(s => {
      const created = s.created;
      if (created > prevMonthEndTs) return false;
      if (s.status === 'canceled' && s.canceled_at && s.canceled_at < prevMonthStartTs) return false;
      if (s.status === 'canceled' && s.canceled_at && s.canceled_at <= prevMonthEndTs) return false;
      return getMonthlyAmount(s) > 0;
    });

    const payingAtEnd = activeAtEnd.filter(s => getMonthlyAmount(s) > 0);
    const mrr = payingAtEnd.reduce((sum, s) => sum + getMonthlyAmount(s), 0);
    const prevMrr = activeAtPrevEnd.reduce((sum, s) => sum + getMonthlyAmount(s), 0);

    // New this month
    const newSubs = payingAtEnd.filter(s => toYearMonth(s.created) === monthStr);
    const newMrr = newSubs.reduce((sum, s) => sum + getMonthlyAmount(s), 0);

    // Churned this month
    const churned = subs.filter(s => {
      if (!s.canceled_at) return false;
      return toYearMonth(s.canceled_at) === monthStr && getMonthlyAmount(s) > 0;
    });
    const churnedMrr = churned.reduce((sum, s) => sum + getMonthlyAmount(s), 0);

    // Churn rates
    const customerChurnRate = activeAtPrevEnd.length > 0
      ? (churned.length / activeAtPrevEnd.length) * 100
      : 0;
    const revenueChurnRate = prevMrr > 0
      ? (churnedMrr / prevMrr) * 100
      : 0;

    snapshots.push({
      date: monthStr,
      mrr,
      newMrr,
      expansionMrr: 0,
      contractionMrr: 0,
      churnedMrr,
      netNewMrr: newMrr - churnedMrr,
      activeSubscriptions: activeAtEnd.length,
      newSubscriptions: newSubs.length,
      churnedSubscriptions: churned.length,
      customerChurnRate,
      revenueChurnRate,
    });
  }

  return snapshots;
}

// ─── Cohort retention ───────────────────────────────────────────────────

export async function computeCohorts(months: number = 24): Promise<CohortRow[]> {
  const subs = await fetchAllSubscriptions();
  const now = new Date();
  const cohorts: CohortRow[] = [];

  for (let i = months - 1; i >= 0; i--) {
    const cohortDate = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const cohortMonth = `${cohortDate.getFullYear()}-${String(cohortDate.getMonth() + 1).padStart(2, '0')}`;

    // Cohort = subs created in this month
    const cohortSubs = subs.filter(s => toYearMonth(s.created) === cohortMonth && getMonthlyAmount(s) > 0);
    if (cohortSubs.length === 0) continue;

    const startingCount = cohortSubs.length;
    const startingMrr = cohortSubs.reduce((sum, s) => sum + getMonthlyAmount(s), 0);

    // Track retention for each subsequent month
    const retention: number[] = [];
    const mrrRetention: number[] = [];

    for (let m = 0; m <= i; m++) {
      const checkDate = new Date(cohortDate.getFullYear(), cohortDate.getMonth() + m + 1, 0);
      const checkTs = Math.floor(checkDate.getTime() / 1000);

      const retained = cohortSubs.filter(s => {
        if (s.status === 'canceled' && s.canceled_at && s.canceled_at <= checkTs) return false;
        return true;
      });

      retention.push(startingCount > 0 ? (retained.length / startingCount) * 100 : 0);
      const retainedMrr = retained.reduce((sum, s) => sum + getMonthlyAmount(s), 0);
      mrrRetention.push(startingMrr > 0 ? (retainedMrr / startingMrr) * 100 : 0);
    }

    cohorts.push({ cohortMonth, startingCount, startingMrr, retention, mrrRetention });
  }

  return cohorts;
}

// ─── Main endpoint handler ──────────────────────────────────────────────

export async function getRevenueMetrics(monthsBack: number = 24) {
  const [metrics, snapshots, cohorts] = await Promise.all([
    computeCurrentMetrics(),
    computeMonthlySnapshots(monthsBack),
    computeCohorts(monthsBack),
  ]);

  return { metrics, snapshots, cohorts };
}
