/**
 * ENG-1213 — API projection over the attribution service.
 *
 * Composes the cost ledger, the attribution/repricing layer, and the runway
 * forecast into the one shape a customer surface can render: what is consuming
 * the allowance, and what switching each driver would be estimated to recover.
 *
 * ## Why days, not dollars
 *
 * A saving in micro-USD is unusable on a customer screen — internal dollar
 * amounts are exactly what ENG-1212 AC4 forbids exposing. The unit that IS
 * meaningful, and the one ENG-1217's "you are estimated to recover X days" needs,
 * is runway. So each candidate switch is converted: work out what the daily burn
 * would have been had the switch already been in effect, re-run the same forecast,
 * and report the difference in days.
 *
 * That conversion reuses `computeUsageRunway` rather than reimplementing the
 * arithmetic, so a customer can never be shown a "days recovered" figure computed
 * on a different basis from the runway sitting next to it.
 *
 * ## The service never switches anything
 *
 * Every recommendation carries `requiresConfirmation: true` and `isEstimate: true`
 * (AC4, AC6). It is a proposal. Nothing here writes a model anywhere.
 */

import { getEffectiveLlmUsagePolicy } from "./llmUsagePolicyResolverService";
import { usageRecordDb } from "./usageRecordDb";
import { agentModeService } from "./agentModeService";
import {
  attributeCosts,
  estimateModelSavings,
  type AttributionRow,
  type CostAttribution,
} from "./llmUsageAttributionService";
import { computeUsageRunway } from "./llmUsageForecastService";

export interface UsageRecommendation {
  fromModel: string;
  toModel: string;
  /** null when the runway itself has no forecast (day one, or negligible burn). */
  estimatedDaysRecovered: number | null;
  /** INTERNAL — stripped before reaching a customer. */
  estimatedSavingsMicroUsd: number;
  isEstimate: true;
  requiresConfirmation: true;
  basis: string;
}

export interface ResolvedUsageDrivers {
  billingUserId: string;
  available: boolean;
  attribution: CostAttribution | null;
  recommendations: UsageRecommendation[];
}

function utcDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function resolveCycle(today: string): { cycleStartDate: string; cycleResetDate: string } {
  const [year, month] = today.split("-").map(Number);
  return {
    cycleStartDate: `${year}-${String(month).padStart(2, "0")}-01`,
    cycleResetDate: utcDay(new Date(Date.UTC(year, month, 1))),
  };
}

export async function resolveUsageDrivers(
  userId: string,
  options: { today?: string } = {},
): Promise<ResolvedUsageDrivers> {
  const today = options.today || utcDay(new Date());
  const usage = await getEffectiveLlmUsagePolicy(userId);

  if (!usage.policy) {
    return { billingUserId: usage.billingUserId, available: false, attribution: null, recommendations: [] };
  }

  const { cycleStartDate, cycleResetDate } = resolveCycle(today);
  const rows = await usageRecordDb.queryByUserDateRange(usage.billingUserId, cycleStartDate, today);

  const ledger: AttributionRow[] = rows.map((r) => ({
    date: r.date,
    model: r.model,
    feature: r.feature,
    inputTokens: r.inputTokens,
    outputTokens: r.outputTokens,
    cacheReadTokens: r.cacheReadTokens,
    cacheWriteTokens: r.cacheWriteTokens,
    costMicroUsd: r.costMicroUsd || 0,
    callCount: r.callCount,
  }));

  const attribution = attributeCosts(ledger);

  const dailyCostMicroUsd = ledger.map((r) => ({ date: r.date, costMicroUsd: r.costMicroUsd }));
  const baseline = computeUsageRunway({
    costUsedMicroUsd: usage.costUsedMicroUsd,
    hardThresholdMicroUsd: usage.policy.hardCostThresholdMicroUsd,
    dailyCostMicroUsd,
    cycleStartDate,
    cycleResetDate,
    today,
  });

  // AC5: only admin-configured, priced, invocable models may be offered. The
  // policy's catalog is the admin-configured list (ENG-1215 renames it to a
  // recommendation catalog); intersecting with the account's supported models
  // enforces "invocable", and estimateModelSavings returns null for anything
  // unpriced, which enforces the rest.
  const supported = new Set(
    typeof agentModeService.getSupportedModels === "function"
      ? await agentModeService.getSupportedModels(false)
      : [],
  );
  const catalog = (usage.policy.optimizedModelIds || []).filter((m) => supported.has(m));

  const recommendations: UsageRecommendation[] = [];
  for (const driver of attribution.byModel) {
    for (const candidate of catalog) {
      const est = estimateModelSavings(ledger, { fromModel: driver.key, toModel: candidate });
      // A switch that saves nothing (or costs more) is noise on a screen whose
      // whole purpose is ranking what to do first.
      if (!est || est.estimatedSavingsMicroUsd <= 0) continue;

      // Re-run the SAME forecast with this driver's spend repriced, so the days
      // figure is computed on an identical basis to the runway beside it.
      const savingByDate = new Map<string, number>();
      for (const r of ledger) {
        if (r.model !== driver.key) continue;
        const share = est.observedCostMicroUsd > 0 ? r.costMicroUsd / est.observedCostMicroUsd : 0;
        savingByDate.set(r.date, (savingByDate.get(r.date) || 0) + est.estimatedSavingsMicroUsd * share);
      }
      const counterfactualDaily = dailyCostMicroUsd.map((d) => ({
        date: d.date,
        costMicroUsd: Math.max(0, d.costMicroUsd - (savingByDate.get(d.date) || 0)),
      }));
      const projected = computeUsageRunway({
        costUsedMicroUsd: usage.costUsedMicroUsd,
        hardThresholdMicroUsd: usage.policy.hardCostThresholdMicroUsd,
        dailyCostMicroUsd: counterfactualDaily,
        cycleStartDate,
        cycleResetDate,
        today,
      });

      const estimatedDaysRecovered =
        baseline.estimatedDaysRemaining === null || projected.estimatedDaysRemaining === null
          ? null
          : Math.max(0, projected.estimatedDaysRemaining - baseline.estimatedDaysRemaining);

      recommendations.push({
        fromModel: driver.key,
        toModel: candidate,
        estimatedDaysRecovered,
        estimatedSavingsMicroUsd: est.estimatedSavingsMicroUsd,
        isEstimate: true,
        requiresConfirmation: true,
        basis: est.basis,
      });
    }
  }

  // Highest impact first. Fall back to raw saving when no forecast exists, so the
  // order stays meaningful on day one of a cycle.
  recommendations.sort(
    (a, b) =>
      (b.estimatedDaysRecovered ?? -1) - (a.estimatedDaysRecovered ?? -1) ||
      b.estimatedSavingsMicroUsd - a.estimatedSavingsMicroUsd,
  );

  return { billingUserId: usage.billingUserId, available: true, attribution, recommendations };
}

export interface CustomerDriver {
  key: string;
  shareOfTotal: number;
  callCount: number;
}

/**
 * Strip everything a customer must not see (ENG-1212 AC4 / ENG-1213 AC4):
 * no micro-USD totals, no raw savings — only shares, counts and day figures.
 */
export function toCustomerDrivers(resolved: ResolvedUsageDrivers) {
  const toShares = (ds: { key: string; shareOfTotal: number; callCount: number }[]): CustomerDriver[] =>
    ds.map((d) => ({ key: d.key, shareOfTotal: d.shareOfTotal, callCount: d.callCount }));

  return {
    available: resolved.available,
    drivers: resolved.attribution
      ? {
          byModel: toShares(resolved.attribution.byModel),
          byFeature: toShares(resolved.attribution.byFeature),
          // Named so a UI can say "we can't break this down" rather than imply zero.
          unavailableGroupings: resolved.attribution.unavailableGroupings,
          hasUnattributed: resolved.attribution.unattributedMicroUsd > 0,
        }
      : null,
    recommendations: resolved.recommendations.map((r) => ({
      fromModel: r.fromModel,
      toModel: r.toModel,
      estimatedDaysRecovered: r.estimatedDaysRecovered,
      isEstimate: r.isEstimate,
      requiresConfirmation: r.requiresConfirmation,
      basis: r.basis,
    })),
  };
}
