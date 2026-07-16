/**
 * usageAnalyticsService — admin-facing read models over the shadow usage table
 * (Ship 1: shadow visibility only; nothing here gates user behavior).
 */

import { usageRecordDb, UsageRecordRow } from "./usageRecordDb";
import { userDb } from "./db";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_RE = /^\d{4}-\d{2}$/;

export interface ModelDayUsageRow {
  date: string;
  model: string;
  feature: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  callCount: number;
  costMicroUsd: number;
  costUsd: number;
}

export interface UserUsageByModelDay {
  userId: string;
  start: string;
  end: string;
  rows: ModelDayUsageRow[];
  totals: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    totalTokens: number;
    callCount: number;
    costMicroUsd: number;
    costUsd: number;
  };
}

export interface UsageComparison {
  userId: string;
  month: string;
  /** Totals from the new shadow table (AW-UsageRecords). */
  shadow: { totalTokens: number; costUsd: number; callCount: number };
  /** Totals from the legacy AW-Users.tokenUsage monthly counter. */
  legacy: { totalTokens: number; costUsd: number; source: "current" | "history" | "none" };
  delta: { totalTokens: number; costUsd: number };
}

function toRow(item: UsageRecordRow): ModelDayUsageRow {
  const costMicroUsd = item.costMicroUsd || 0;
  return {
    date: item.date,
    model: item.model,
    feature: item.feature,
    inputTokens: item.inputTokens || 0,
    outputTokens: item.outputTokens || 0,
    cacheReadTokens: item.cacheReadTokens || 0,
    cacheWriteTokens: item.cacheWriteTokens || 0,
    totalTokens: item.totalTokens || 0,
    callCount: item.callCount || 0,
    costMicroUsd,
    costUsd: costMicroUsd / 1_000_000,
  };
}

/**
 * Per-(day, model, feature) usage rows for a user across an inclusive date range.
 */
export async function getUserUsageByModelDay(
  userId: string,
  start: string,
  end: string
): Promise<UserUsageByModelDay> {
  if (!DATE_RE.test(start) || !DATE_RE.test(end)) {
    throw new Error("start and end must be YYYY-MM-DD");
  }
  if (start > end) {
    throw new Error("start must be <= end");
  }

  const items = await usageRecordDb.queryByUserDateRange(userId, start, end);
  const rows = items.map(toRow);
  rows.sort((a, b) =>
    a.date !== b.date ? a.date.localeCompare(b.date) : a.model.localeCompare(b.model)
  );

  const totals = rows.reduce(
    (acc, r) => {
      acc.inputTokens += r.inputTokens;
      acc.outputTokens += r.outputTokens;
      acc.cacheReadTokens += r.cacheReadTokens;
      acc.cacheWriteTokens += r.cacheWriteTokens;
      acc.totalTokens += r.totalTokens;
      acc.callCount += r.callCount;
      acc.costMicroUsd += r.costMicroUsd;
      return acc;
    },
    {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 0,
      callCount: 0,
      costMicroUsd: 0,
      costUsd: 0,
    }
  );
  totals.costUsd = totals.costMicroUsd / 1_000_000;

  return { userId, start, end, rows, totals };
}

/**
 * Compare the shadow table's monthly totals against the legacy
 * AW-Users.tokenUsage monthly counter, for one user and one YYYY-MM month.
 */
export async function getUsageComparison(
  userId: string,
  month: string
): Promise<UsageComparison> {
  if (!MONTH_RE.test(month)) {
    throw new Error("month must be YYYY-MM");
  }

  const items = await usageRecordDb.queryByUserDateRange(userId, `${month}-01`, `${month}-31`);
  const shadow = items.reduce(
    (acc, item) => {
      acc.totalTokens += item.totalTokens || 0;
      acc.costMicroUsd += item.costMicroUsd || 0;
      acc.callCount += item.callCount || 0;
      return acc;
    },
    { totalTokens: 0, costMicroUsd: 0, callCount: 0 }
  );

  // Legacy counter: current month lives on tokenUsage; past months in history.
  let legacy: UsageComparison["legacy"] = { totalTokens: 0, costUsd: 0, source: "none" };
  const user = await userDb.getUserById(userId);
  if (user?.tokenUsage?.month === month) {
    legacy = {
      totalTokens: user.tokenUsage.totalTokens || 0,
      costUsd: user.tokenUsage.totalCost || 0,
      source: "current",
    };
  } else {
    const hist = (user?.tokenUsageHistory || []).find(
      (h: { month: string; totalTokens: number; totalCost: number }) => h.month === month
    );
    if (hist) {
      legacy = {
        totalTokens: hist.totalTokens || 0,
        costUsd: hist.totalCost || 0,
        source: "history",
      };
    }
  }

  const shadowCostUsd = shadow.costMicroUsd / 1_000_000;
  return {
    userId,
    month,
    shadow: { totalTokens: shadow.totalTokens, costUsd: shadowCostUsd, callCount: shadow.callCount },
    legacy,
    delta: {
      totalTokens: shadow.totalTokens - legacy.totalTokens,
      costUsd: shadowCostUsd - legacy.costUsd,
    },
  };
}

// ── ENG-366: cross-user cost aggregation (backend slice of ENG-353) ──────────
//
// Sums the costMicroUsd counters ALREADY priced at record time via
// utils/llmPricing.ts — this module never re-derives cost from token counts
// (ENG-353 behavioral contract, assertion 2: single source of pricing truth).

interface CounterTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  callCount: number;
  costMicroUsd: number;
  costUsd: number;
}

export interface CostByModelRow extends CounterTotals {
  model: string;
}

export interface CostSeriesRow {
  date: string;
  model: string;
  costMicroUsd: number;
  costUsd: number;
  totalTokens: number;
  callCount: number;
}

export interface CostByFeatureRow {
  feature: string;
  costMicroUsd: number;
  costUsd: number;
  totalTokens: number;
  callCount: number;
}

export interface CostTopUser extends CounterTotals {
  userId: string;
  /** Best-effort enrichment from AW-Users; null when the user record is missing or the lookup fails. */
  email: string | null;
  byModel: CostByModelRow[];
}

export interface CostAggregation {
  start: string;
  end: string;
  totals: CounterTotals;
  /** Sorted by spend, highest first. */
  byModel: CostByModelRow[];
  /** Per (date, model) buckets, sorted by date then model — the time series. */
  series: CostSeriesRow[];
  /** Secondary cut over the stored feature dimension, sorted by spend. */
  byFeature: CostByFeatureRow[];
  /** Sorted by spend, highest first, limited to topUsersLimit. */
  topUsers: CostTopUser[];
}

function zeroTotals(): CounterTotals {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
    callCount: 0,
    costMicroUsd: 0,
    costUsd: 0,
  };
}

/** Add one raw row into a counter bucket. Missing counters count as 0 — never NaN. */
function addInto(acc: CounterTotals, item: UsageRecordRow): void {
  acc.inputTokens += item.inputTokens || 0;
  acc.outputTokens += item.outputTokens || 0;
  acc.cacheReadTokens += item.cacheReadTokens || 0;
  acc.cacheWriteTokens += item.cacheWriteTokens || 0;
  acc.totalTokens += item.totalTokens || 0;
  acc.callCount += item.callCount || 0;
  acc.costMicroUsd += item.costMicroUsd || 0;
}

function finalizeUsd(acc: CounterTotals): void {
  acc.costUsd = acc.costMicroUsd / 1_000_000;
}

function bucketByModel(items: UsageRecordRow[]): CostByModelRow[] {
  const byModel = new Map<string, CostByModelRow>();
  for (const item of items) {
    let bucket = byModel.get(item.model);
    if (!bucket) {
      bucket = { model: item.model, ...zeroTotals() };
      byModel.set(item.model, bucket);
    }
    addInto(bucket, item);
  }
  const rows = [...byModel.values()];
  rows.forEach(finalizeUsd);
  rows.sort(
    (a, b) => b.costMicroUsd - a.costMicroUsd || a.model.localeCompare(b.model)
  );
  return rows;
}

/**
 * Aggregate spend across ALL users for an inclusive date window, for the admin
 * cost dashboard (ENG-353). Window filtering happens in the data layer
 * (usageRecordDb.scanByDateRange) so out-of-window records never reach any of
 * the cuts below (contract assertion 3). An empty window yields explicit zeros
 * and empty arrays (contract assertion 4, API half).
 */
export async function getCostAggregation(
  start: string,
  end: string,
  topUsersLimit = 10
): Promise<CostAggregation> {
  if (!DATE_RE.test(start) || !DATE_RE.test(end)) {
    throw new Error("start and end must be YYYY-MM-DD");
  }
  if (start > end) {
    throw new Error("start must be <= end");
  }
  if (!Number.isInteger(topUsersLimit) || topUsersLimit < 1 || topUsersLimit > 100) {
    throw new Error("topUsersLimit must be an integer between 1 and 100");
  }

  const items = await usageRecordDb.scanByDateRange(start, end);

  // Overall totals.
  const totals = zeroTotals();
  items.forEach((item) => addInto(totals, item));
  finalizeUsd(totals);

  // Headline cut: spend by model.
  const byModel = bucketByModel(items);

  // Time series: per (date, model) buckets.
  const seriesBuckets = new Map<string, CostSeriesRow>();
  for (const item of items) {
    const key = `${item.date}#${item.model}`;
    let bucket = seriesBuckets.get(key);
    if (!bucket) {
      bucket = {
        date: item.date,
        model: item.model,
        costMicroUsd: 0,
        costUsd: 0,
        totalTokens: 0,
        callCount: 0,
      };
      seriesBuckets.set(key, bucket);
    }
    bucket.costMicroUsd += item.costMicroUsd || 0;
    bucket.totalTokens += item.totalTokens || 0;
    bucket.callCount += item.callCount || 0;
  }
  const series = [...seriesBuckets.values()];
  series.forEach((s) => {
    s.costUsd = s.costMicroUsd / 1_000_000;
  });
  series.sort(
    (a, b) => a.date.localeCompare(b.date) || a.model.localeCompare(b.model)
  );

  // Secondary cut: spend by feature (session type dimension already on the rows).
  const featureBuckets = new Map<string, CostByFeatureRow>();
  for (const item of items) {
    let bucket = featureBuckets.get(item.feature);
    if (!bucket) {
      bucket = { feature: item.feature, costMicroUsd: 0, costUsd: 0, totalTokens: 0, callCount: 0 };
      featureBuckets.set(item.feature, bucket);
    }
    bucket.costMicroUsd += item.costMicroUsd || 0;
    bucket.totalTokens += item.totalTokens || 0;
    bucket.callCount += item.callCount || 0;
  }
  const byFeature = [...featureBuckets.values()];
  byFeature.forEach((f) => {
    f.costUsd = f.costMicroUsd / 1_000_000;
  });
  byFeature.sort(
    (a, b) => b.costMicroUsd - a.costMicroUsd || a.feature.localeCompare(b.feature)
  );

  // Top users by spend, with per-model breakdown.
  const userItems = new Map<string, UsageRecordRow[]>();
  for (const item of items) {
    const list = userItems.get(item.userId);
    if (list) {
      list.push(item);
    } else {
      userItems.set(item.userId, [item]);
    }
  }
  const rankedUsers = [...userItems.entries()]
    .map(([userId, rows]) => {
      const userTotals = zeroTotals();
      rows.forEach((r) => addInto(userTotals, r));
      finalizeUsd(userTotals);
      return { userId, ...userTotals, byModel: bucketByModel(rows) };
    })
    .sort((a, b) => b.costMicroUsd - a.costMicroUsd || a.userId.localeCompare(b.userId))
    .slice(0, topUsersLimit);

  // Email enrichment is decoration on an admin analytics payload — a per-user
  // lookup failure must not fail the whole aggregation (best-effort sub-step).
  const topUsers: CostTopUser[] = await Promise.all(
    rankedUsers.map(async (u) => {
      const user = await userDb.getUserById(u.userId).catch(() => null);
      return { ...u, email: user?.email ?? null };
    })
  );

  return { start, end, totals, byModel, series, byFeature, topUsers };
}
