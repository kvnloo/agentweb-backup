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
 * ## All-in cost targets (AC3 comparison)
 *
 * Decided 2026-11-16 (the ticket's $7/$73/$180 table is stale; ENG-1688):
 * target = the tier's LIVE hard LLM threshold + a fixed overhead envelope for
 * everything that is not LLM spend (non-LLM vendors, infrastructure, support).
 * The threshold half is read from the policy at report time, never hardcoded;
 * only the envelope lives in this file (TIER_OVERHEAD_ENVELOPE_USD). Each row
 * and each tier aggregate carries `targetAllInUsd`, `varianceUsd`
 * (actual - target) and `overTarget`; the admin CSV export includes them too.
 * Credits are deliberately NOT added to the target: it is the tier's included
 * economics, so a purchased top-up shows as variance rather than moving the goal.
 *
 * Thresholds are read live; envelopes are fixed constants. The caps moved on
 * 2026-09-01 (Starter $60 -> $80, Pro $150 -> $200) and Super Premium has never
 * had a row, so thresholds come from the same `subscription_types` policy the
 * enforcement path reads. A report that disagrees with the enforcer about where
 * the cap is would be worse than no report.
 */

import { userDb } from './db';
import { usageRecordDb, isVendorEntry, type UsageRecordRow } from './usageRecordDb';
import { getSubscriptionTypeConfig } from './subscriptionService';
import { getLlmUsageCreditAdjustment } from './llmUsageCreditService';

const MICRO = 1_000_000;

/**
 * Fixed non-LLM overhead allowance added to a tier's live hard LLM threshold to
 * form its all-in cost target (2026-11-16 decision, project owner's delegate).
 * Rationale: the threshold already caps LLM spend, so the envelope budgets what
 * the threshold cannot see: metered vendors, shared infrastructure and support.
 * It scales with plan size. Change an envelope here only with a new owner
 * decision. Resolved targets follow the live caps, e.g. Free $5 -> $7.
 */
export const TIER_OVERHEAD_ENVELOPE_USD: Readonly<Record<string, number>> = {
  Free: 2,
  Starter: 13,
  Pro: 30,
  'Super Premium': 30,
};

/**
 * Tiers with no `subscription_types` policy row of their own borrow another
 * tier's live policy for the TARGET only. Super Premium is internal-only and has
 * never had a row; enforcement does not alias it (it reports uncapped), so this
 * does not change thresholds, usage state or the uncapped alert. An own policy
 * row, if one is ever added, wins over the alias.
 */
const TARGET_POLICY_FALLBACK_TIER: Readonly<Record<string, string>> = {
  'Super Premium': 'Pro',
};

/** Human-readable list of the envelopes, built from the constant so the note cannot drift. */
const envelopeSummary = (): string =>
  Object.entries(TIER_OVERHEAD_ENVELOPE_USD)
    .map(([tier, usd]) => `${tier} $${usd}`)
    .join(', ');

/** Built from TARGET_POLICY_FALLBACK_TIER so the note cannot drift from the alias map. */
const targetPolicyNote = (): string =>
  Object.entries(TARGET_POLICY_FALLBACK_TIER)
    .map(([tier, from]) => `${tier} borrows ${from}'s policy`)
    .join('; ');

interface TargetFields {
  targetAllInUsd: number | null;
  varianceUsd: number | null;
  overTarget: boolean;
}

/**
 * Pure target arithmetic. `hardCostThresholdMicroUsd` is the tier's resolved live
 * policy threshold (own row, else the fallback tier's); null/undefined means no
 * policy. A tier with no envelope or no policy has no target, and `overTarget`
 * is then false: callers must surface "no target" separately (tier_no_target).
 */
export function computeTargetFields(
  tier: string,
  hardCostThresholdMicroUsd: number | null | undefined,
  allInCostUsd: number,
): TargetFields {
  const envelope = TIER_OVERHEAD_ENVELOPE_USD[tier];
  if (envelope === undefined || hardCostThresholdMicroUsd == null) {
    return { targetAllInUsd: null, varianceUsd: null, overTarget: false };
  }
  const target = round(hardCostThresholdMicroUsd / MICRO + envelope);
  const variance = round(allInCostUsd - target);
  return { targetAllInUsd: target, varianceUsd: variance, overTarget: variance > 0 };
}

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

  /** Live hard LLM threshold + the tier's overhead envelope. Null when the tier has no policy or no envelope. */
  targetAllInUsd: number | null;
  /** allInCostUsd - targetAllInUsd; positive means over target. Null when there is no target. */
  varianceUsd: number | null;
  overTarget: boolean;
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
    /** Sum of the accounts' targets, comparable with this tier's aggregate allInCostUsd. Null if no account has one. */
    targetAllInUsd: number | null;
    varianceUsd: number | null;
    overTarget: boolean;
    /** Accounts whose own actual exceeds their own target. */
    overTargetAccounts: number;
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
    const fallbackTier = TARGET_POLICY_FALLBACK_TIER[tier];
    const targetPolicy =
      policy ?? (fallbackTier ? (await tierConfig(fallbackTier))?.llmUsagePolicy : null);

    const adj = getLlmUsageCreditAdjustment(user?.llmUsageCredits, month);
    const migrationOffsetUsd = adj.migrationOffsetMicroUsd / MICRO;
    const purchasedCreditsUsd = adj.purchasedMicroUsd / MICRO;
    const adminGrantedUsd = adj.adminGrantedMicroUsd / MICRO;

    const llmCostUsd = agg.llmMicro / MICRO;
    const allInCostUsd = round(llmCostUsd + agg.vendorMicro / MICRO);
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
      allInCostUsd,
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
      ...computeTargetFields(tier, targetPolicy?.hardCostThresholdMicroUsd, allInCostUsd),
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
    .map(([tier, list]) => {
      const targets = list.flatMap((r) => (r.targetAllInUsd === null ? [] : [r.targetAllInUsd]));
      const target = targets.length ? round(targets.reduce((sum, t) => sum + t, 0)) : null;
      // Compare like with like: only accounts that have a target contribute actual.
      const targetedActual = list.reduce((sum, r) => sum + (r.targetAllInUsd === null ? 0 : r.allInCostUsd), 0);
      const variance = target === null ? null : round(targetedActual - target);
      return {
        tier,
        accounts: list.length,
        llmCostUsd: round(list.reduce((s, r) => s + r.llmCostUsd, 0)),
        vendorCostUsd: round(list.reduce((s, r) => s + r.vendorCostUsd, 0)),
        allInCostUsd: round(list.reduce((s, r) => s + r.allInCostUsd, 0)),
        purchasedCreditsUsd: round(list.reduce((s, r) => s + r.purchasedCreditsUsd, 0)),
        includedThresholdUsd: list[0]?.includedThresholdUsd ?? null,
        overThreshold: list.filter((r) => r.percentUsed !== null && r.percentUsed >= 100).length,
        targetAllInUsd: target,
        varianceUsd: variance,
        overTarget: variance !== null && variance > 0,
        overTargetAccounts: list.filter((r) => r.overTarget).length,
      };
    })
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
  // AC5: aggregate counts only. Tiers over target, and a count of accounts over
  // theirs; never one alert (or Linear issue) per heavy user.
  const tiersOver = byTier.filter((t) => t.overTarget);
  if (tiersOver.length > 0) {
    alerts.push({
      kind: 'tier_over_target',
      count: tiersOver.length,
      detail: `${tiersOver.length} tier(s) with aggregate all-in cost over target: ${tiersOver.map((t) => t.tier).join(', ')}`,
    });
  }
  const accountsOver = filtered.filter((r) => r.overTarget).length;
  if (accountsOver > 0) {
    alerts.push({ kind: 'account_over_target', count: accountsOver, detail: `${accountsOver} account(s) with all-in cost over their tier target` });
  }
  // A null target is "unknown", never "on target": surface it, still aggregate-only.
  const noTarget = filtered.filter((r) => r.targetAllInUsd === null);
  if (noTarget.length > 0) {
    const tiers = [...new Set(noTarget.map((r) => r.tier))];
    alerts.push({
      kind: 'tier_no_target',
      count: tiers.length,
      detail: `${tiers.length} tier(s) with ${noTarget.length} spending account(s) have no all-in target (no policy or no envelope), so they are not compared: ${tiers.join(', ')}`,
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
      "vendorCostUsd is complete: every paid vendor (v0, X, You.com, Google CSE, Apollo, enrich.so, Remotion, ElevenLabs, 2captcha, Placid) writes to AW-UsageRecords. allInCostUsd = LLM + vendor is therefore actual all-in cost. Per-account infrastructure is $0 (shared overhead is not per-account attributable). " +
      `targetAllInUsd = the tier's live hard LLM threshold + a fixed overhead envelope (${envelopeSummary()}; ${targetPolicyNote()}); varianceUsd = allInCostUsd - targetAllInUsd. A tier with no target is flagged by the tier_no_target alert, not treated as on target. Internal only.`,
  };
}

const CSV_COLUMNS: Array<[string, (r: UnitEconomicsRow) => unknown]> = [
  ['billingUserId', (r) => r.billingUserId],
  ['email', (r) => r.email],
  ['tier', (r) => r.tier],
  ['llmCostUsd', (r) => r.llmCostUsd],
  ['nonLlmVendorCostUsd', (r) => r.vendorCostUsd],
  ['admittedWorkOverrunUsd', (r) => r.admittedWorkOverrunUsd],
  ['infrastructureUsd', (r) => r.infrastructureUsd],
  ['actualAllInUsd', (r) => r.allInCostUsd],
  ['targetAllInUsd', (r) => r.targetAllInUsd],
  ['varianceUsd', (r) => r.varianceUsd],
  ['overTarget', (r) => r.overTarget],
];

/** AC3 monthly export: one row per account, parts separated, actual vs target. Admin-only. */
export function buildUnitEconomicsCsv(report: UnitEconomicsReport): string {
  const esc = (v: unknown) => {
    let text = v === null || v === undefined ? '' : String(v);
    // Neutralise spreadsheet formula injection from user-controlled emails.
    if (typeof v === 'string' && /^[=+\-@\t\r\n]/.test(text)) text = `'${text}`;
    return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const lines = [CSV_COLUMNS.map(([h]) => h).join(',')];
  for (const r of report.rows) lines.push(CSV_COLUMNS.map(([, f]) => esc(f(r))).join(','));
  return lines.join('\n') + '\n';
}
