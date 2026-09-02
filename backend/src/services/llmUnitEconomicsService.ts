/**
 * ENG-1139 — internal unit-economics reporting, per billing subject.
 *
 * Extends the ENG-353 admin cost surface rather than standing up a second
 * dashboard (AC7): the spend numbers come from the same `AW-UsageRecords`
 * ledger `getCostAggregation` reads, and this adds the per-account economics
 * around them — tier, usage state, the credit ledger, and a reconciliation
 * against the counter the cap actually enforces on.
 *
 * ## What this deliberately does NOT claim
 *
 * AC3 asks for actual all-in cost against the $7 / $73 / $180 targets, split
 * into LLM, non-LLM vendors, admitted-work overrun and infrastructure. The
 * non-LLM half is not measurable yet: of the vendors ENG-666 covers, only X
 * writes ledger rows today (ENG-694/695/696/698/699 are all Blocked), and v0
 * spend lives in its own `AW-V0Usage` table outside the ledger entirely.
 *
 * So `vendorCostUsd` is reported as MEASURED-ONLY and every row carries
 * `vendorCoverage: 'partial'`. It is not summed into an all-in figure, because a
 * number that silently omits most of its inputs is worse than an absent one —
 * it would read as the overhead envelope being comfortably met. AC3 stays open.
 *
 * The tier targets are likewise NOT hardcoded here. They moved on 2026-09-01
 * (Starter $60 -> $80, Pro $150 -> $200) and Super Premium has never had a row,
 * so thresholds are read live from the same `subscription_types` policy the
 * enforcement path reads. A report that disagrees with the enforcer about where
 * the cap is would be worse than no report.
 */

import { userDb } from './db';
import { usageRecordDb, isVendorEntry, type UsageRecordRow } from './usageRecordDb';
import { getSubscriptionTypeConfig } from './subscriptionService';
import { getLlmUsageCreditAdjustment } from './llmUsageCreditService';

const MICRO = 1_000_000;

/** `YYYY-MM` -> the inclusive day range covering it. */
export function monthBounds(month: string): { start: string; end: string } {
  const m = /^(\d{4})-(\d{2})$/.exec(month);
  if (!m) throw new Error(`month must be YYYY-MM, got ${JSON.stringify(month)}`);
  const year = Number(m[1]);
  const mon = Number(m[2]);
  if (mon < 1 || mon > 12) throw new Error(`month out of range: ${month}`);
  // Day 0 of the following month is the last day of this one; the constructor's
  // month index is 0-based, so `mon` is already "next month".
  const last = new Date(Date.UTC(year, mon, 0)).getUTCDate();
  return { start: `${month}-01`, end: `${month}-${String(last).padStart(2, '0')}` };
}

export interface UnitEconomicsRow {
  billingUserId: string;
  email: string | null;
  tier: string;
  /** The mode the enforcement path would report; `unknown` when no policy exists. */
  usageState: string;

  /** Ledger spend on token-priced rows only. */
  llmCostUsd: number;
  /** Ledger spend on metered per-unit vendor rows. Incomplete — see file header. */
  vendorCostUsd: number;
  vendorCoverage: 'partial';

  /** Credit ledger, scoped to this month (a stale month contributes nothing). */
  migrationOffsetUsd: number;
  purchasedCreditsUsd: number;
  adminGrantedUsd: number;
  purchasedCredits: boolean;

  /** Tier hard threshold, before credits. Null when the tier is unpriced. */
  includedThresholdUsd: number | null;
  /** Threshold + purchased + admin grants — what admission actually compares to. */
  effectiveThresholdUsd: number | null;
  /** LLM spend minus the migration offset — what the cap counts. */
  policyCostUsd: number;
  percentUsed: number | null;

  /** AC2 — reconciliation against the counter, surfaced rather than hidden. */
  counterCostUsd: number | null;
  ledgerVsCounterDeltaUsd: number | null;
  reconciled: boolean;
}

export interface UnitEconomicsFilters {
  tier?: string;
  usageState?: string;
  /** Match on billingUserId or email, case-insensitive substring. */
  account?: string;
  /** Only accounts that bought credits this month. */
  purchasedOnly?: boolean;
  /** Only accounts with spend on this exact model id. */
  model?: string;
}

export interface UnitEconomicsReport {
  month: string;
  start: string;
  end: string;
  rows: UnitEconomicsRow[];
  byTier: Array<{
    tier: string;
    accounts: number;
    llmCostUsd: number;
    purchasedCreditsUsd: number;
    includedThresholdUsd: number | null;
    overThreshold: number;
  }>;
  /** AC5 — aggregate and threshold-based; never one issue per heavy account. */
  alerts: Array<{ kind: string; count: number; detail: string }>;
  /** AC2 — every account whose ledger and counter disagree beyond the tolerance. */
  unreconciled: Array<{ billingUserId: string; email: string | null; deltaUsd: number }>;
  vendorCoverageNote: string;
}

/**
 * A cent. The ledger sums many micro-USD rows while the counter is written as a
 * float, so exact equality would flag rounding as a discrepancy and make AC2's
 * signal useless.
 */
const RECONCILE_TOLERANCE_USD = 0.01;

function round(n: number, dp = 4): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

export async function buildUnitEconomicsReport(
  month: string,
  filters: UnitEconomicsFilters = {},
): Promise<UnitEconomicsReport> {
  const { start, end } = monthBounds(month);
  const rows = await usageRecordDb.scanByDateRange(start, end);

  const perSubject = new Map<string, { llmMicro: number; vendorMicro: number; models: Set<string> }>();
  for (const r of rows as UsageRecordRow[]) {
    const key = r.billingUserId || r.userId;
    if (!key) continue;
    let agg = perSubject.get(key);
    if (!agg) {
      agg = { llmMicro: 0, vendorMicro: 0, models: new Set() };
      perSubject.set(key, agg);
    }
    if (isVendorEntry(r)) agg.vendorMicro += r.costMicroUsd || 0;
    else {
      agg.llmMicro += r.costMicroUsd || 0;
      if (r.model) agg.models.add(r.model);
    }
  }

  const users = await userDb.getAllUsers();
  const byId = new Map<string, any>();
  for (const u of users as any[]) if (u?.userId) byId.set(u.userId, u);

  const tierConfigCache = new Map<string, any>();
  const tierConfig = async (tier: string) => {
    if (!tierConfigCache.has(tier)) tierConfigCache.set(tier, await getSubscriptionTypeConfig(tier));
    return tierConfigCache.get(tier);
  };

  const out: UnitEconomicsRow[] = [];
  for (const [billingUserId, agg] of perSubject) {
    const user = byId.get(billingUserId);
    const tier = user?.subscriptionType || 'Unknown';
    const config = await tierConfig(tier);
    const policy = config?.llmUsagePolicy ?? null;

    const adj = getLlmUsageCreditAdjustment(user?.llmUsageCredits, month);
    const migrationOffsetUsd = adj.migrationOffsetMicroUsd / MICRO;
    const purchasedCreditsUsd = adj.purchasedMicroUsd / MICRO;
    const adminGrantedUsd = adj.adminGrantedMicroUsd / MICRO;

    const llmCostUsd = agg.llmMicro / MICRO;
    const policyCostUsd = Math.max(0, llmCostUsd - migrationOffsetUsd);

    const includedThresholdUsd = policy ? policy.hardCostThresholdMicroUsd / MICRO : null;
    const effectiveThresholdUsd =
      includedThresholdUsd === null
        ? null
        : includedThresholdUsd + purchasedCreditsUsd + adminGrantedUsd;
    const percentUsed =
      effectiveThresholdUsd && effectiveThresholdUsd > 0
        ? round((policyCostUsd / effectiveThresholdUsd) * 100, 2)
        : null;

    // The counter is only comparable when it describes the SAME month; after a
    // lazy reset it holds the current month and says nothing about a past one.
    const counter = user?.tokenUsage;
    const counterCostUsd =
      counter && counter.month === month && typeof counter.totalCost === 'number'
        ? counter.totalCost
        : null;
    const delta = counterCostUsd === null ? null : round(llmCostUsd - counterCostUsd);

    out.push({
      billingUserId,
      email: user?.email ?? null,
      tier,
      usageState: policy ? (policy.enforcementState || 'unknown') : 'unknown',
      llmCostUsd: round(llmCostUsd),
      vendorCostUsd: round(agg.vendorMicro / MICRO),
      vendorCoverage: 'partial',
      migrationOffsetUsd: round(migrationOffsetUsd),
      purchasedCreditsUsd: round(purchasedCreditsUsd),
      adminGrantedUsd: round(adminGrantedUsd),
      purchasedCredits: purchasedCreditsUsd > 0,
      includedThresholdUsd,
      effectiveThresholdUsd: effectiveThresholdUsd === null ? null : round(effectiveThresholdUsd),
      policyCostUsd: round(policyCostUsd),
      percentUsed,
      counterCostUsd: counterCostUsd === null ? null : round(counterCostUsd),
      ledgerVsCounterDeltaUsd: delta,
      reconciled: delta === null ? true : Math.abs(delta) <= RECONCILE_TOLERANCE_USD,
      _models: agg.models,
    } as UnitEconomicsRow & { _models: Set<string> });
  }

  const needle = filters.account?.trim().toLowerCase();
  const filtered = out.filter((r) => {
    const withModels = r as UnitEconomicsRow & { _models: Set<string> };
    if (filters.tier && r.tier !== filters.tier) return false;
    if (filters.usageState && r.usageState !== filters.usageState) return false;
    if (filters.purchasedOnly && !r.purchasedCredits) return false;
    if (filters.model && !withModels._models.has(filters.model)) return false;
    if (needle) {
      const hay = `${r.billingUserId} ${r.email ?? ''}`.toLowerCase();
      if (!hay.includes(needle)) return false;
    }
    return true;
  });
  for (const r of filtered) delete (r as any)._models;
  filtered.sort((a, b) => b.llmCostUsd - a.llmCostUsd);

  const tierMap = new Map<string, UnitEconomicsRow[]>();
  for (const r of filtered) {
    const list = tierMap.get(r.tier) ?? [];
    list.push(r);
    tierMap.set(r.tier, list);
  }
  const byTier = [...tierMap.entries()]
    .map(([tier, list]) => ({
      tier,
      accounts: list.length,
      llmCostUsd: round(list.reduce((s, r) => s + r.llmCostUsd, 0)),
      purchasedCreditsUsd: round(list.reduce((s, r) => s + r.purchasedCreditsUsd, 0)),
      includedThresholdUsd: list[0]?.includedThresholdUsd ?? null,
      overThreshold: list.filter((r) => r.percentUsed !== null && r.percentUsed >= 100).length,
    }))
    .sort((a, b) => b.llmCostUsd - a.llmCostUsd);

  const uncapped = filtered.filter((r) => r.includedThresholdUsd === null);
  const unreconciled = filtered
    .filter((r) => !r.reconciled)
    .map((r) => ({ billingUserId: r.billingUserId, email: r.email, deltaUsd: r.ledgerVsCounterDeltaUsd! }));

  const alerts: UnitEconomicsReport['alerts'] = [];
  const over = filtered.filter((r) => r.percentUsed !== null && r.percentUsed >= 100).length;
  if (over > 0) alerts.push({ kind: 'over_threshold', count: over, detail: `${over} account(s) at or past their effective threshold` });
  if (uncapped.length > 0) {
    alerts.push({
      kind: 'uncapped_tier',
      count: uncapped.length,
      detail: `${uncapped.length} spending account(s) on a tier with no cost policy: ${[...new Set(uncapped.map((r) => r.tier))].join(', ')}`,
    });
  }
  if (unreconciled.length > 0) {
    alerts.push({ kind: 'ledger_counter_drift', count: unreconciled.length, detail: `${unreconciled.length} account(s) where the ledger and the enforced counter disagree by more than $${RECONCILE_TOLERANCE_USD}` });
  }

  return {
    month,
    start,
    end,
    rows: filtered,
    byTier,
    alerts,
    unreconciled,
    vendorCoverageNote:
      'vendorCostUsd counts only metered per-unit vendor rows. Most ENG-666 vendors do not write to this ledger yet and v0 spend lives in AW-V0Usage, so this is not an all-in figure and no overhead envelope is derived from it (ENG-1139 AC3 remains open).',
  };
}
