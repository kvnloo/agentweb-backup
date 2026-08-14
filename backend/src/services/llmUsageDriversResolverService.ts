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
import { readPooledLedgerRows } from "./llmUsageLedgerReader";
import { agentModeService } from "./agentModeService";
import {
  attributeCosts,
  estimateModelSavings,
  type AttributionRow,
  type CostAttribution,
} from "./llmUsageAttributionService";
import { computeUsageRunway } from "./llmUsageForecastService";

/** A different target for the SAME driver — an alternative, never an extra win. */
export interface UsageRecommendationAlternative {
  toModel: string;
  estimatedDaysRecovered: number | null;
  /** INTERNAL — stripped before reaching a customer. */
  estimatedSavingsMicroUsd: number;
}

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
  /**
   * The other eligible targets for this same driver, ranked. Kept so a picker can
   * offer the choice, but deliberately NOT top-level entries: see the grouping
   * note in `resolveUsageDrivers`.
   */
  alternatives: UsageRecommendationAlternative[];
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
  // Pooled read, not a single partition: rows are keyed by the ACTING user, so an
  // org root's own partition omits every member whose spend it pays for. See
  // `llmUsageLedgerReader`.
  const rows = await readPooledLedgerRows(usage.billingUserId, cycleStartDate, today);

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

  // Collapse to one total per DATE up front. computeUsageRunway sums duplicates
  // itself, so the baseline is correct either way — but the counterfactual below
  // must subtract a day's saving exactly once, which is only well-defined against
  // a per-date total.
  const observedByDate = new Map<string, number>();
  for (const r of ledger) {
    observedByDate.set(r.date, (observedByDate.get(r.date) || 0) + r.costMicroUsd);
  }
  const dailyCostMicroUsd = [...observedByDate.entries()].map(([date, costMicroUsd]) => ({ date, costMicroUsd }));
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
      //
      // Each date is repriced from ITS OWN token mix rather than by taking a
      // share of the cycle-wide saving. Savings are not proportional to cost:
      // model rates scale differently for input-family and output tokens (Opus
      // 5:25 vs Flash Lite 0.25:1.5), so a day of mostly output saves a
      // different fraction than a day of mostly input at identical cost.
      //
      // That matters because the forecast independently evaluates a
      // trailing-seven window, so misallocating savings across dates lands them
      // in or out of that window and moves the result — measured at 17 days of
      // error on a realistic 10-day ledger, on a number the customer is asked to
      // act on.
      const rowsByDate = new Map<string, AttributionRow[]>();
      for (const r of ledger) {
        const list = rowsByDate.get(r.date);
        if (list) list.push(r); else rowsByDate.set(r.date, [r]);
      }
      const counterfactualDaily = [...observedByDate.entries()].map(([date, cost]) => {
        const dayEst = estimateModelSavings(rowsByDate.get(date) || [], {
          fromModel: driver.key,
          toModel: candidate,
        });
        // No spend for this driver on this date leaves the day untouched.
        const saving = dayEst ? dayEst.estimatedSavingsMicroUsd : 0;
        return { date, costMicroUsd: Math.max(0, cost - saving) };
      });
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
        alternatives: [],
      });
    }
  }

  // Highest impact first. Fall back to raw saving when no forecast exists, so the
  // order stays meaningful on day one of a cycle.
  const byImpact = (a: { estimatedDaysRecovered: number | null; estimatedSavingsMicroUsd: number },
                    b: { estimatedDaysRecovered: number | null; estimatedSavingsMicroUsd: number }) =>
    (b.estimatedDaysRecovered ?? -1) - (a.estimatedDaysRecovered ?? -1) ||
    b.estimatedSavingsMicroUsd - a.estimatedSavingsMicroUsd;

  recommendations.sort(byImpact);

  // ENG-1210: collapse to ONE non-overlapping opportunity per driver.
  //
  // Opus->Sonnet and Opus->Haiku are not two savings a customer can bank; they
  // are two ways to spend the same driver once. Listed side by side they read as
  // additive, and each one's "days recovered" is computed against the SAME
  // baseline — so accepting either makes the other's figure obsolete rather than
  // incremental. Ranked opportunities have to be independently actionable or the
  // ranking is a lie about what the customer gets.
  //
  // Different drivers do NOT overlap: `estimateModelSavings` filters rows by
  // `fromModel`, so two drivers reprice disjoint spend and their savings compose.
  // Only the same-driver alternatives collapse.
  const best = new Map<string, UsageRecommendation>();
  for (const rec of recommendations) {
    const held = best.get(rec.fromModel);
    // The list is already impact-sorted, so the first per driver is the best.
    if (!held) {
      best.set(rec.fromModel, rec);
      continue;
    }
    held.alternatives.push({
      toModel: rec.toModel,
      estimatedDaysRecovered: rec.estimatedDaysRecovered,
      estimatedSavingsMicroUsd: rec.estimatedSavingsMicroUsd,
    });
  }

  return {
    billingUserId: usage.billingUserId,
    available: true,
    attribution,
    recommendations: [...best.values()].sort(byImpact),
  };
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
          // null until the metering tag has produced at least one row this cycle.
          bySource: resolved.attribution.bySource ? toShares(resolved.attribution.bySource) : null,
          // Named so a UI can say "we can't break this down" rather than imply zero.
          unavailableGroupings: resolved.attribution.unavailableGroupings,
          hasUnattributed: resolved.attribution.unattributedMicroUsd > 0,
          // Lets the UI caveat a partial split instead of presenting it as whole.
          hasUntaggedSourceSpend: resolved.attribution.sourceUnattributedMicroUsd > 0,
        }
      : null,
    recommendations: resolved.recommendations.map((r) => ({
      fromModel: r.fromModel,
      toModel: r.toModel,
      estimatedDaysRecovered: r.estimatedDaysRecovered,
      isEstimate: r.isEstimate,
      requiresConfirmation: r.requiresConfirmation,
      basis: r.basis,
      // Alternatives cross the boundary so ENG-1214's picker can offer the
      // choice, but carry days only — never the internal saving.
      alternatives: r.alternatives.map((a) => ({
        toModel: a.toModel,
        estimatedDaysRecovered: a.estimatedDaysRecovered,
      })),
    })),
  };
}
