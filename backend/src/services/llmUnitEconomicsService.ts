/**
 * ENG-1139 — internal unit-economics reporting, per billing subject.
 *
 * Extends the ENG-353 admin cost surface rather than standing up a second
 * dashboard (AC7): the spend numbers come from the same `AW-UsageRecords`
 * ledger `getCostAggregation` reads, and this adds the per-account economics
 * around them — tier, usage state and the credit ledger.
 *
 * (AC2 originally also reconciled the ledger against the legacy `AW-Users.tokenUsage`
 * counter. ENG-1250 AC7 retires that counter and the cap now enforces on the ledger
 * itself, so there is nothing left to reconcile against; the counter fields and the
 * `ledger_counter_drift` alert were removed.)
 *
 * ## All-in cost (AC3)
 *
 * As of 2026-09-14 every paid vendor writes to this ledger: v0, X, You.com,
 * Google CSE, Apollo, enrich.so, Remotion, ElevenLabs, 2captcha and Placid all
 * route through `recordVendorUsage` into `AW-UsageRecords`, and the coverage
 * guard now holds zero allowlisted vendors. So `vendorCostUsd` is COMPLETE, not
 * a sample, and `allInCostUsd = llmCostUsd + vendorCostUsd` is honest to
 * compute: the reason it was withheld (a figure silently omitting most of its
 * inputs) no longer applies.
 *
 * The all-in figure is separated into its AC3 parts: LLM, non-LLM vendor,
 * admitted-work overrun (LLM spend past the effective cap, admitted before the
 * boundary and allowed to finish), and infrastructure. Per-account
 * infrastructure is deliberately $0: the billing boundary excludes shared
 * platform overhead from per-account attribution without a reviewed allocation
 * policy, so allocating it here would be an invention, not a measurement.
 *
 * What AC3 still needs from a human: the COGS targets ($7 / $73 / $180 in the
 * ticket) to compare actual all-in against. Those numbers are stale (the hard
 * caps moved to $80/$200 on 2026-09-01 and Super Premium never had a row), and
 * setting the authoritative targets is a business decision (ENG-1688). This
 * report computes and separates actual all-in cost; the target comparison is
 * layered on once those numbers exist.
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
  /** Ledger spend on metered per-unit vendor rows. Complete — every paid vendor writes here. */
  vendorCostUsd: number;
  vendorCoverage: 'complete';
  /** llmCostUsd + vendorCostUsd — the actual all-in cost (AC3). */
  allInCostUsd: number;
  /** LLM spend past the effective cap (admitted-work overrun); $0 when within cap or uncapped. */
  admittedWorkOverrunUsd: number;
  /** Shared platform overhead — not per-account attributable, so always $0 here (AC3, honestly). */
  infrastructureUsd: number;

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
    vendorCostUsd: number;
    allInCostUsd: number;
    purchasedCreditsUsd: number;
    includedThresholdUsd: number | null;
    overThreshold: number;
  }>;
  /** AC5 — aggregate and threshold-based; never one issue per heavy account. */
  alerts: Array<{ kind: string; count: number; detail: string }>;
  vendorCoverageNote: string;
}

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

    out.push({
      billingUserId,
      email: user?.email ?? null,
      tier,
      usageState: policy ? (policy.enforcementState || 'unknown') : 'unknown',
      llmCostUsd: round(llmCostUsd),
      vendorCostUsd: round(agg.vendorMicro / MICRO),
      vendorCoverage: 'complete',
      allInCostUsd: round(llmCostUsd + agg.vendorMicro / MICRO),
      // Overrun is measured against the EFFECTIVE cap (threshold + credits +
      // grants); an uncapped tier cannot overrun, so a null threshold => $0.
      admittedWorkOverrunUsd:
        effectiveThresholdUsd === null ? 0 : round(Math.max(0, policyCostUsd - effectiveThresholdUsd)),
      infrastructureUsd: 0,
      migrationOffsetUsd: round(migrationOffsetUsd),
      purchasedCreditsUsd: round(purchasedCreditsUsd),
      adminGrantedUsd: round(adminGrantedUsd),
      purchasedCredits: purchasedCreditsUsd > 0,
      includedThresholdUsd,
      effectiveThresholdUsd: effectiveThresholdUsd === null ? null : round(effectiveThresholdUsd),
      policyCostUsd: round(policyCostUsd),
      percentUsed,
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
      vendorCostUsd: round(list.reduce((s, r) => s + r.vendorCostUsd, 0)),
      allInCostUsd: round(list.reduce((s, r) => s + r.allInCostUsd, 0)),
      purchasedCreditsUsd: round(list.reduce((s, r) => s + r.purchasedCreditsUsd, 0)),
      includedThresholdUsd: list[0]?.includedThresholdUsd ?? null,
      overThreshold: list.filter((r) => r.percentUsed !== null && r.percentUsed >= 100).length,
    }))
    .sort((a, b) => b.llmCostUsd - a.llmCostUsd);

  const uncapped = filtered.filter((r) => r.includedThresholdUsd === null);

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
  return {
    month,
    start,
    end,
    rows: filtered,
    byTier,
    alerts,
    vendorCoverageNote:
      'vendorCostUsd is complete: every paid vendor (v0, X, You.com, Google CSE, Apollo, enrich.so, Remotion, ElevenLabs, 2captcha, Placid) writes to AW-UsageRecords. allInCostUsd = LLM + vendor is therefore actual all-in cost. Per-account infrastructure is $0 (shared overhead is not per-account attributable). The remaining AC3 item is the COGS target comparison, which needs the authoritative $7/$73/$180 numbers (ENG-1688).',
  };
}
