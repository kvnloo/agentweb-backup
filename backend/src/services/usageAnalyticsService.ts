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
