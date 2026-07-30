/**
 * usageAnalyticsService — admin-facing read models over the shadow usage table
 * (Ship 1: shadow visibility only; nothing here gates user behavior).
 */

import { usageRecordDb, UsageRecordRow } from "./usageRecordDb";
import { userDb, orgDb, User } from "./db";
import { TWITTER_PROVIDER, isPostReadOperation } from "../utils/twitterPricing";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_RE = /^\d{4}-\d{2}$/;

/** Ledger `model` prefix for X vendor rows, e.g. "twitter:search_tweets". */
const TWITTER_MODEL_PREFIX = `${TWITTER_PROVIDER}:`;

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

// ── Org-aware cost rollup (ENG-200 follow-up) ────────────────────────────────
//
// The admin cost modal used to compare ONE user's gross burn (shadow table,
// keyed on the acting user) against that SAME user's quota counter. But member
// LLM spend is deducted onto the org OWNER (resolveBillingUserId), so:
//   - members showed burn>0 / counted=$0  → false "leak" alarm
//   - owners showed counted >> their own burn → misleading "burn lags" banner
// This rollup fixes the denominator: gross burn is summed across ALL org members
// and reconciled against the OWNER's counter (the only real quota). Per-member
// burn is preserved as a nested breakdown so per-user accounting is not lost.

export interface OrgRollupModelRow {
  model: string;
  costUsd: number;
  callCount: number;
  totalTokens: number;
}

export interface OrgRollupMember {
  userId: string;
  email: string | null;
  orgRole: "owner" | "member" | null;
  /** The user the admin actually clicked (highlighted in the UI). */
  isSelected: boolean;
  burnUsd: number;
  callCount: number;
  totalTokens: number;
  byModel: OrgRollupModelRow[];
}

export interface OrgUsageRollup {
  /** The clicked user. */
  userId: string;
  month: string;
  /** True when the user belongs to a resolvable org (owner + members rolled up). */
  isOrg: boolean;
  ownerUserId: string;
  ownerEmail: string | null;
  /** The OWNER's subscription tier — the org's cost cap is keyed on this, not the member's. */
  ownerSubscriptionType: string | null;
  selectedIsOwner: boolean;
  selectedRole: "owner" | "member" | null;
  /** Total real burn across all members (shadow table). */
  grossBurnUsd: number;
  /** Amount charged to the org quota = the OWNER's monthly counter. */
  countedUsd: number;
  countedSource: "current" | "history" | "none";
  /** Burn not charged to quota: burn-only features + usage predating per-call tracking. */
  unchargedUsd: number;
  /** counted / gross * 100 (0 when gross is 0). Can exceed 100 when the counter runs ahead. */
  coveragePct: number;
  /** Per-member burn, sorted by burn desc. */
  members: OrgRollupMember[];
  /** Org-wide per-model burn, sorted by spend desc. */
  byModel: OrgRollupModelRow[];
}

/** Aggregate a set of shadow rows into totals + a per-model cut (microdollar-exact). */
function aggregateBurn(rows: UsageRecordRow[]): {
  costMicroUsd: number;
  callCount: number;
  totalTokens: number;
  byModel: OrgRollupModelRow[];
} {
  const byModel = new Map<string, { model: string; costMicroUsd: number; callCount: number; totalTokens: number }>();
  let costMicroUsd = 0;
  let callCount = 0;
  let totalTokens = 0;
  for (const r of rows) {
    const cm = r.costMicroUsd || 0;
    costMicroUsd += cm;
    callCount += r.callCount || 0;
    totalTokens += r.totalTokens || 0;
    let bucket = byModel.get(r.model);
    if (!bucket) {
      bucket = { model: r.model, costMicroUsd: 0, callCount: 0, totalTokens: 0 };
      byModel.set(r.model, bucket);
    }
    bucket.costMicroUsd += cm;
    bucket.callCount += r.callCount || 0;
    bucket.totalTokens += r.totalTokens || 0;
  }
  const models: OrgRollupModelRow[] = [...byModel.values()]
    .map((b) => ({
      model: b.model,
      costUsd: b.costMicroUsd / 1_000_000,
      callCount: b.callCount,
      totalTokens: b.totalTokens,
    }))
    .sort((a, b) => b.costUsd - a.costUsd || a.model.localeCompare(b.model));
  return { costMicroUsd, callCount, totalTokens, byModel: models };
}

/** The dollar amount charged to a user's quota counter for a month (current or history). */
function counterForMonth(
  user: User | null,
  month: string
): { costUsd: number; source: "current" | "history" | "none" } {
  if (user?.tokenUsage?.month === month) {
    return { costUsd: user.tokenUsage.totalCost || 0, source: "current" };
  }
  const hist = (user?.tokenUsageHistory || []).find((h) => h.month === month);
  if (hist) return { costUsd: hist.totalCost || 0, source: "history" };
  return { costUsd: 0, source: "none" };
}

export async function getUserOrgUsageRollup(
  userId: string,
  month: string
): Promise<OrgUsageRollup> {
  if (!MONTH_RE.test(month)) {
    throw new Error("month must be YYYY-MM");
  }

  const user = (await userDb.getUserById(userId)) as User | undefined;
  if (!user) throw new Error(`User not found: ${userId}`);

  const start = `${month}-01`;
  // '31' always sorts at/after the real month end; non-existent days have no rows.
  const end = `${month}-31`;

  // Resolve org context. A member's spend is deducted onto the owner, so the
  // owner's counter is the org's "counted". getOrgMembers includes the owner.
  let isOrg = false;
  let ownerUser: User = user;
  let memberUsers: User[] = [user];

  if (user.orgId) {
    const org = await orgDb.getOrgById(user.orgId).catch(() => null);
    if (org) {
      isOrg = true;
      const members = await orgDb.getOrgMembers(user.orgId).catch(() => [] as User[]);
      memberUsers = members.length ? members : [user];
      ownerUser =
        memberUsers.find((m) => m.userId === org.ownerUserId) ??
        (org.ownerUserId === user.userId
          ? user
          : ((await userDb.getUserById(org.ownerUserId).catch(() => null)) as User | null) ??
            user);
    }
  }

  // Burn per member (parallel). A per-member query failure must NOT be swallowed
  // into empty rows: that would silently understate org burn and inflate coverage
  // (Greptile). Let it reject so the whole rollup fails loud — the route returns
  // 500 and the admin sees "failed to load" rather than confidently-wrong numbers.
  const perMember = await Promise.all(
    memberUsers.map(async (m) => {
      const rows = await usageRecordDb.queryByUserDateRange(m.userId, start, end);
      return { user: m, rows, agg: aggregateBurn(rows) };
    })
  );

  // Org-wide aggregate from ALL rows (microdollar-exact — no per-member rounding).
  const orgAgg = aggregateBurn(perMember.flatMap((pm) => pm.rows));
  const grossBurnUsd = orgAgg.costMicroUsd / 1_000_000;

  const counted = counterForMonth(ownerUser, month);
  const unchargedUsd = Math.max(0, grossBurnUsd - counted.costUsd);
  const coveragePct = grossBurnUsd > 0 ? (counted.costUsd / grossBurnUsd) * 100 : 0;

  const members: OrgRollupMember[] = perMember
    .map((pm) => ({
      userId: pm.user.userId,
      email: pm.user.email ?? null,
      orgRole:
        pm.user.orgRole ?? (pm.user.userId === ownerUser.userId ? ("owner" as const) : null),
      isSelected: pm.user.userId === userId,
      burnUsd: pm.agg.costMicroUsd / 1_000_000,
      callCount: pm.agg.callCount,
      totalTokens: pm.agg.totalTokens,
      byModel: pm.agg.byModel,
    }))
    .sort((a, b) => b.burnUsd - a.burnUsd || a.userId.localeCompare(b.userId));

  const selectedIsOwner = user.userId === ownerUser.userId;
  const selectedRole: "owner" | "member" | null =
    user.orgRole ?? (selectedIsOwner ? "owner" : null);

  return {
    userId,
    month,
    isOrg,
    ownerUserId: ownerUser.userId,
    ownerEmail: ownerUser.email ?? null,
    ownerSubscriptionType: ownerUser.subscriptionType ?? null,
    selectedIsOwner,
    selectedRole,
    grossBurnUsd,
    countedUsd: counted.costUsd,
    countedSource: counted.source,
    unchargedUsd,
    coveragePct,
    members,
    byModel: orgAgg.byModel,
  };
}

// ── ENG-664: X (Twitter) allocated totals, for reconciliation against X's own
// measured consumption (twitterService.getXProjectUsage / GET /2/usage/tweets).
//
// "Allocated" = our per-call ledger × the published X rate card. It is an
// upper bound on the billed figure (X dedups a repeat read of the same resource
// within a UTC day; we do not track resource ids), so allocatedPostReadUnits
// reconciles as >= X's measured project_usage. The delta is dedup savings.

export interface XAllocatedOperationRow {
  /** The X tool, e.g. "search_tweets" (the ledger model minus the "twitter:" prefix). */
  operation: string;
  callCount: number;
  quantity: number;
  costUsd: number;
}

export interface XAllocatedTotals {
  start: string;
  end: string;
  costUsd: number;
  callCount: number;
  /** Σ quantity across POST-READ operations — the figure comparable to X project_usage. */
  postReadUnits: number;
  /** Per-operation breakdown, sorted by spend desc. */
  byOperation: XAllocatedOperationRow[];
}

/**
 * Sum every X ledger row (model "twitter:*") across an inclusive date window.
 * Reads the costMicroUsd/quantity already recorded at call time — never
 * re-derives cost.
 */
export async function getXAllocatedTotals(
  start: string,
  end: string
): Promise<XAllocatedTotals> {
  if (!DATE_RE.test(start) || !DATE_RE.test(end)) {
    throw new Error("start and end must be YYYY-MM-DD");
  }
  if (start > end) {
    throw new Error("start must be <= end");
  }

  const items = await usageRecordDb.scanByDateRange(start, end);

  const byOp = new Map<string, XAllocatedOperationRow>();
  let costMicroUsd = 0;
  let callCount = 0;
  let postReadUnits = 0;

  for (const item of items) {
    if (!item.model || !item.model.startsWith(TWITTER_MODEL_PREFIX)) continue;
    const operation = item.model.slice(TWITTER_MODEL_PREFIX.length);
    const cost = item.costMicroUsd || 0;
    const calls = item.callCount || 0;
    const qty = item.quantity || 0;

    costMicroUsd += cost;
    callCount += calls;
    if (isPostReadOperation(operation)) postReadUnits += qty;

    let row = byOp.get(operation);
    if (!row) {
      row = { operation, callCount: 0, quantity: 0, costUsd: 0 };
      byOp.set(operation, row);
    }
    row.callCount += calls;
    row.quantity += qty;
    row.costUsd += cost / 1_000_000;
  }

  const byOperation = [...byOp.values()].sort(
    (a, b) => b.costUsd - a.costUsd || a.operation.localeCompare(b.operation)
  );

  return {
    start,
    end,
    costUsd: costMicroUsd / 1_000_000,
    callCount,
    postReadUnits,
    byOperation,
  };
}

/**
 * The current X billing-cycle window [start, end] (UTC) given the cycle's
 * reset day-of-month. X's GET /2/usage/tweets reports usage for the cycle to
 * date, so allocated totals must be summed over the SAME window to compare.
 * Exported for unit testing the month-boundary logic.
 *
 * @param resetDay  cap_reset_day from X (1–31); falls back to 1 when null.
 * @param now       reference instant (defaults to current time).
 */
export function currentXBillingCycle(
  resetDay: number | null,
  now: Date = new Date()
): { start: string; end: string } {
  const wanted = resetDay && resetDay >= 1 && resetDay <= 31 ? Math.floor(resetDay) : 1;
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const todayDom = now.getUTCDate();

  // The cycle started on `wanted` this month if we're at/past it, else the prior
  // month (which rolls the year back at January). Clamp `wanted` to the target
  // month's real length so a reset day of 29–31 never overflows a short month
  // (e.g. Date.UTC(y, Feb, 31) would spill into March and could push start>end).
  let startY = y;
  let startM = m;
  if (todayDom < wanted) {
    startM = m - 1;
    if (startM < 0) {
      startM = 11;
      startY = y - 1;
    }
  }
  const lastDayOfStartMonth = new Date(Date.UTC(startY, startM + 1, 0)).getUTCDate();
  const startDay = Math.min(wanted, lastDayOfStartMonth);
  const startMs = Date.UTC(startY, startM, startDay);

  const fmt = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  return { start: fmt(startMs), end: now.toISOString().slice(0, 10) };
}
