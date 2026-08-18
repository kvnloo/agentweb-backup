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
import { readPooledLedgerRows, resolvePooledLedgerUserIds } from "./llmUsageLedgerReader";
import { scheduleDb } from "./db";
import { agentModeService } from "./agentModeService";
import {
  attributeCosts,
  estimateModelSavings,
  type AttributionRow,
  type CostAttribution,
} from "./llmUsageAttributionService";
import { computeUsageRunway, TRAILING_WINDOW_DAYS } from "./llmUsageForecastService";
import { recordUsageTelemetry, USAGE_TELEMETRY_EVENTS } from "./llmUsageTelemetry";

/** A different target for the SAME driver — an alternative, never an extra win. */
export interface UsageRecommendationAlternative {
  toModel: string;
  estimatedDaysRecovered: number | null;
  /** INTERNAL — stripped before reaching a customer. */
  estimatedSavingsMicroUsd: number;
}

/**
 * How much to trust one recommendation's day figure (ENG-1217 AC6).
 *
 * Four levels because the AC names four. `insufficient_data` is not "a bit
 * unsure" — it means no forecast could be produced at all, so there is no number
 * to qualify.
 */
export type RecommendationConfidence = "insufficient_data" | "low" | "medium" | "high";

/**
 * What we know about the cheaper model doing the same job (ENG-1217 AC5).
 *
 * `status` is a closed set with one member today, and that is the point. AC5
 * forbids representing a cheaper model as equivalent in quality without
 * task-specific evaluation evidence, and no eval harness exists yet (open
 * question `OQ:okareo`). Modelling it as a field rather than omitting it forces
 * the UI to render "quality: unknown" instead of silently implying parity, and
 * gives the eventual harness a slot to fill rather than a schema change.
 */
export interface RecommendationQuality {
  status: "unknown";
  reason: string;
}

export interface UsageRecommendation {
  fromModel: string;
  toModel: string;
  /** null when the runway itself has no forecast (day one, or negligible burn). */
  estimatedDaysRecovered: number | null;
  /** INTERNAL — stripped before reaching a customer. */
  estimatedSavingsMicroUsd: number;
  /** This driver's share of the cycle's cost, so the estimate can be weighed (AC4). */
  shareOfTotal: number;
  /** Complete cycle days the estimate was computed over (AC6's "window"). */
  completeDaysObserved: number;
  confidence: RecommendationConfidence;
  quality: RecommendationQuality;
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

/**
 * One named schedule's share of the allowance (ENG-1217 AC4/AC8).
 *
 * `title`/`frequency` are null when the schedule can no longer be resolved — a
 * deleted schedule still consumed the allowance, so its spend is reported under
 * its id rather than dropped. Dropping it would make the driver list quietly
 * total less than the bill, which is the failure `reconciles` exists to catch.
 */
export interface ScheduleDriver {
  scheduleId: string;
  title: string | null;
  frequency: string | null;
  shareOfTotal: number;
  callCount: number;
  /**
   * The model this schedule actually runs on.
   *
   * `pinnedModel` is what the schedule stores; NULL means it stores nothing and
   * inherits the platform default, which is the common case — 66 of 91 active
   * production schedules carry no `llmModel`. `effectiveModel` resolves that
   * inheritance so a recommendation can be matched to the schedule, and so the
   * UI can say what would actually change.
   *
   * The distinction survives to the boundary because switching an INHERITING
   * schedule pins a model where none was set, and undoing that must restore
   * inheritance rather than write back today's default.
   */
  pinnedModel: string | null;
  effectiveModel: string | null;
  /** The switch offered for THIS schedule, if its model has one. */
  recommendedModel: string | null;
  estimatedDaysRecovered: number | null;
  confidence: RecommendationConfidence | null;
  /** INTERNAL — stripped before reaching a customer. */
  costMicroUsd: number;
}

export interface ResolvedUsageDrivers {
  billingUserId: string;
  available: boolean;
  attribution: CostAttribution | null;
  recommendations: UsageRecommendation[];
  /** Empty until the metering tag has named at least one schedule this cycle. */
  scheduleDrivers: ScheduleDriver[];
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

/**
 * Reprice a ledger per DATE under a set of switches, returning the daily totals
 * the forecast should see.
 *
 * Per-date rather than a share of the cycle-wide saving: model rates scale
 * differently for input-family and output tokens, so a day of mostly output
 * saves a different fraction than a day of mostly input at identical cost, and
 * the forecast independently evaluates a trailing-seven window — misallocating
 * savings across dates moves them in or out of that window and changes the
 * answer.
 *
 * Multiple switches compose safely because `estimateModelSavings` filters rows
 * by `fromModel`: two selections with different sources reprice disjoint rows.
 * Two selections with the SAME source would not, which is why callers must
 * de-duplicate before calling.
 */
function counterfactualDaily(
  ledger: AttributionRow[],
  observedByDate: Map<string, number>,
  selections: readonly RunwayPreviewSelection[],
): { date: string; costMicroUsd: number }[] {
  const rowsByDate = new Map<string, AttributionRow[]>();
  for (const r of ledger) {
    const list = rowsByDate.get(r.date);
    if (list) list.push(r); else rowsByDate.set(r.date, [r]);
  }
  return [...observedByDate.entries()].map(([date, cost]) => {
    const dayRows = rowsByDate.get(date) || [];
    let saving = 0;
    for (const sel of selections) {
      const dayEst = estimateModelSavings(dayRows, sel);
      // No spend for that driver on this date leaves the day untouched.
      if (dayEst) saving += dayEst.estimatedSavingsMicroUsd;
    }
    return { date, costMicroUsd: Math.max(0, cost - saving) };
  });
}

export interface RunwayPreviewSelection {
  fromModel: string;
  toModel: string;
}

export interface RejectedSelection extends RunwayPreviewSelection {
  /** `duplicate_from_model` | `not_estimable` */
  reason: string;
}

/**
 * The combined effect of a set of proposed switches, in DAYS, persisting nothing.
 *
 * ENG-1217 AC2 needs the projected exhaustion date to move as a customer
 * previews, and AC6 needs several previews inspected as one combined,
 * non-duplicated impact. This cannot be done by summing the per-recommendation
 * figures from `/usage-drivers`: each of those is measured against the SAME
 * baseline, and `computeUsageRunway` takes the LARGER of the cycle-to-date and
 * trailing-seven burn rates, so the forecast is non-linear and two gains do not
 * add. The combined case is therefore re-forecast from a counterfactual ledger
 * with every accepted selection applied at once.
 *
 * Nothing is written. `persisted: false` is part of the contract, not a comment.
 */
export interface RunwayPreview {
  billingUserId: string;
  available: boolean;
  baselineDaysRemaining: number | null;
  projectedDaysRemaining: number | null;
  estimatedDaysRecovered: number | null;
  projectedExhaustionDate: string | null;
  applied: RunwayPreviewSelection[];
  rejected: RejectedSelection[];
  isEstimate: true;
  persisted: false;
}

export async function previewUsageRunway(
  userId: string,
  selections: readonly RunwayPreviewSelection[],
  options: { today?: string } = {},
): Promise<RunwayPreview> {
  const today = options.today || utcDay(new Date());
  const usage = await getEffectiveLlmUsagePolicy(userId);

  const empty = (billingUserId: string): RunwayPreview => ({
    billingUserId,
    available: false,
    baselineDaysRemaining: null,
    projectedDaysRemaining: null,
    estimatedDaysRecovered: null,
    projectedExhaustionDate: null,
    applied: [],
    rejected: [],
    isEstimate: true,
    persisted: false,
  });

  if (!usage.policy) return empty(usage.billingUserId);

  const { cycleStartDate, cycleResetDate } = resolveCycle(today);
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

  const observedByDate = new Map<string, number>();
  for (const r of ledger) {
    observedByDate.set(r.date, (observedByDate.get(r.date) || 0) + r.costMicroUsd);
  }

  const forecastInput = {
    costUsedMicroUsd: usage.costUsedMicroUsd,
    hardThresholdMicroUsd: usage.policy.hardCostThresholdMicroUsd,
    cycleStartDate,
    cycleResetDate,
    today,
  };
  const baseline = computeUsageRunway({
    ...forecastInput,
    dailyCostMicroUsd: [...observedByDate.entries()].map(([date, costMicroUsd]) => ({ date, costMicroUsd })),
  });

  // A driver can only be switched once. Applying two selections for the same
  // source would reprice the same rows twice and claim a saving the customer
  // cannot actually get — the double-count AC6 exists to prevent.
  const applied: RunwayPreviewSelection[] = [];
  const rejected: RejectedSelection[] = [];
  const seenFrom = new Set<string>();
  for (const sel of selections) {
    if (seenFrom.has(sel.fromModel)) {
      rejected.push({ ...sel, reason: "duplicate_from_model" });
      continue;
    }
    // Unpriced or absent from the ledger: refuse it visibly rather than drop it,
    // so the UI can say why a preview did nothing instead of appearing broken.
    if (!estimateModelSavings(ledger, sel)) {
      rejected.push({ ...sel, reason: "not_estimable" });
      continue;
    }
    seenFrom.add(sel.fromModel);
    applied.push({ fromModel: sel.fromModel, toModel: sel.toModel });
  }

  const projected = applied.length
    ? computeUsageRunway({
        ...forecastInput,
        dailyCostMicroUsd: counterfactualDaily(ledger, observedByDate, applied),
      })
    : baseline;

  const estimatedDaysRecovered =
    baseline.estimatedDaysRemaining === null || projected.estimatedDaysRemaining === null
      ? null
      : Math.max(0, projected.estimatedDaysRemaining - baseline.estimatedDaysRemaining);

  // ENG-1217 AC2 / ENG-1210 AC12: a preview is the closest signal we have today
  // to intent — the customer inspected a combined change without committing to
  // it. Recording shown-vs-previewed is measurable now; accepted/declined needs
  // the apply-and-audit path, which does not exist yet.
  await recordUsageTelemetry(usage.billingUserId, USAGE_TELEMETRY_EVENTS.previewComputed, {
    appliedCount: applied.length,
    rejectedCount: rejected.length,
    rejectionReasons: rejected.map((r) => r.reason),
    baselineDaysRemaining: baseline.estimatedDaysRemaining,
    projectedDaysRemaining: projected.estimatedDaysRemaining,
    estimatedDaysRecovered,
    confidence: projected.confidence,
  });

  return {
    billingUserId: usage.billingUserId,
    available: true,
    baselineDaysRemaining: baseline.estimatedDaysRemaining,
    projectedDaysRemaining: projected.estimatedDaysRemaining,
    estimatedDaysRecovered,
    projectedExhaustionDate: projected.estimatedExhaustionDate,
    applied,
    rejected,
    isEstimate: true,
    persisted: false,
  };
}

export async function resolveUsageDrivers(
  userId: string,
  options: { today?: string } = {},
): Promise<ResolvedUsageDrivers> {
  const today = options.today || utcDay(new Date());
  const usage = await getEffectiveLlmUsagePolicy(userId);

  if (!usage.policy) {
    return {
      billingUserId: usage.billingUserId,
      available: false,
      attribution: null,
      recommendations: [],
      scheduleDrivers: [],
    };
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

  /**
   * The recommendation's confidence, capped by the forecast's own (AC6).
   *
   * The days figure IS `computeUsageRunway` re-run over repriced history, so
   * claiming more certainty about the difference than about either endpoint
   * would be incoherent. The cap makes that structural rather than a convention
   * someone has to remember.
   *
   * With today's thresholds the cap never actually binds — the forecast drops to
   * `low` below three complete days, and the rule below cannot reach `medium`
   * until three either. It is kept because the two rules live in different files
   * and are free to drift; the day one of them moves, this stays coherent
   * instead of quietly emitting a confident recommendation about an unconfident
   * forecast.
   *
   * Below the cap it reads two things the customer would ask about anyway: how
   * many complete days we watched, and how many calls that driver actually made.
   * A week of steady traffic is a different claim from two days and five calls,
   * and both can produce the same arithmetic.
   */
  const forecastCap: RecommendationConfidence =
    baseline.confidence === "insufficient_data"
      ? "insufficient_data"
      : baseline.confidence === "low"
        ? "low"
        : "high";
  const RANK: Record<RecommendationConfidence, number> = {
    insufficient_data: 0,
    low: 1,
    medium: 2,
    high: 3,
  };
  const confidenceFor = (callCount: number): RecommendationConfidence => {
    const own: RecommendationConfidence =
      baseline.completeDaysElapsed >= TRAILING_WINDOW_DAYS && callCount >= 20
        ? "high"
        : baseline.completeDaysElapsed >= 3 && callCount >= 5
          ? "medium"
          : "low";
    return RANK[own] <= RANK[forecastCap] ? own : forecastCap;
  };

  /**
   * AC5. One value, deliberately: we have no task-specific evaluation evidence
   * for any of these targets, so `unknown` is the only claim we are entitled to
   * make. The wording avoids "similar"/"equivalent" for the same reason.
   */
  const UNKNOWN_QUALITY: RecommendationQuality = {
    status: "unknown",
    reason:
      "No task-specific evaluation evidence exists for this model on your work, so its output quality is unknown.",
  };

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
      // Same helper the combined preview uses, so a single-switch figure and the
      // combined one can never be computed on different bases.
      const projected = computeUsageRunway({
        costUsedMicroUsd: usage.costUsedMicroUsd,
        hardThresholdMicroUsd: usage.policy.hardCostThresholdMicroUsd,
        dailyCostMicroUsd: counterfactualDaily(ledger, observedByDate, [
          { fromModel: driver.key, toModel: candidate },
        ]),
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
        shareOfTotal: driver.shareOfTotal,
        completeDaysObserved: baseline.completeDaysElapsed,
        confidence:
          estimatedDaysRecovered === null ? "insufficient_data" : confidenceFor(driver.callCount),
        quality: UNKNOWN_QUALITY,
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

  // ENG-1217 AC4/AC8: an opportunity has to name the work and its recurrence, so
  // the ledger's scheduleId is joined to the schedule record here — the resolver
  // is the layer with DB access, keeping `attributeCosts` pure over the ledger.
  //
  // Schedules are read for every POOLED member, not just the root: an org
  // member's schedule is billed to the root, so naming it means reading that
  // member's schedules too. Same reasoning as the pooled ledger read itself.
  // Ranked BEFORE the schedule join, because each schedule row needs to look up
  // the recommendation for the model it runs on.
  const ranked = [...best.values()].sort(byImpact);

  let scheduleDrivers: ScheduleDriver[] = [];
  if (attribution.bySchedule?.length) {
    const pooledUserIds = await resolvePooledLedgerUserIds(usage.billingUserId);
    const lists = await Promise.all(
      pooledUserIds.map((id) => scheduleDb.getSchedulesByUserId(id)),
    );
    // `scheduleName` is the field a schedule actually stores its name in. This
    // map was typed with `title`, which no schedule record has, so `meta?.title`
    // was always undefined and every driver rendered as "Untitled scheduled task"
    // — defeating AC6, whose whole point is that the customer can see WHICH named
    // task is spending their allowance. The optional property is why nothing
    // caught it: reading an absent optional field is not a type error.
    const byId = new Map<string, { scheduleName?: string; frequency?: string }>();
    for (const sched of lists.flat()) {
      if (sched?.scheduleId) byId.set(sched.scheduleId, sched);
    }
    // Inheriting schedules run the platform default, so resolving it once is
    // what lets a per-schedule row carry a confirmable recommendation at all.
    // Without it, two thirds of schedules would show spend and no action.
    const platformDefault =
      typeof agentModeService.getDefaultModel === "function"
        ? await agentModeService.getDefaultModel().catch(() => null)
        : null;
    const recByFromModel = new Map(ranked.map((r) => [r.fromModel, r]));

    scheduleDrivers = attribution.bySchedule.map((d) => {
      const meta = byId.get(d.key);
      const pinnedModel = (meta as { llmModel?: string } | undefined)?.llmModel || null;
      const effectiveModel = pinnedModel || platformDefault;
      const rec = effectiveModel ? recByFromModel.get(effectiveModel) : undefined;
      return {
        scheduleId: d.key,
        pinnedModel,
        effectiveModel,
        recommendedModel: rec?.toModel ?? null,
        estimatedDaysRecovered: rec?.estimatedDaysRecovered ?? null,
        confidence: rec?.confidence ?? null,
        // A schedule deleted mid-cycle still consumed the allowance. Report it
        // under its id with a null title so the UI can say "deleted schedule",
        // rather than dropping spend the customer was charged for.
        title: meta?.scheduleName ?? null,
        frequency: meta?.frequency ?? null,
        shareOfTotal: d.shareOfTotal,
        callCount: d.callCount,
        costMicroUsd: d.costMicroUsd,
      };
    });
  }

  // ENG-1210 AC12: record which recommendation each customer was actually shown,
  // with the model before/after and the driver it was attributed to. Emitted per
  // recommendation rather than as one summary row so a later analysis can join
  // an individual suggestion to whatever the customer did next.
  //
  // `estimatedSavingsMicroUsd` is deliberately absent. The redactor would remove
  // it anyway; not sending it keeps that guard a backstop rather than the only
  // thing between internal economics and a log line.
  //
  // Awaited together, and each call swallows its own failure, so telemetry can
  // never fail the request that produced the recommendations.
  await Promise.all(
    ranked.map((rec) =>
      recordUsageTelemetry(usage.billingUserId, USAGE_TELEMETRY_EVENTS.recommendationShown, {
        fromModel: rec.fromModel,
        toModel: rec.toModel,
        estimatedDaysRecovered: rec.estimatedDaysRecovered,
        confidence: rec.confidence,
        qualityStatus: rec.quality.status,
        shareOfTotal: rec.shareOfTotal,
        completeDaysObserved: rec.completeDaysObserved,
        alternativeCount: rec.alternatives.length,
      }),
    ),
  );

  return {
    billingUserId: usage.billingUserId,
    available: true,
    attribution,
    recommendations: ranked,
    scheduleDrivers,
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
    // Named work with its recurrence, and no micro-USD (ENG-1212 AC4). The
    // model fields cross so a row can offer a confirmable switch that names the
    // exact schedule (AC8) — the recommendation list alone is per-MODEL and has
    // no scope to apply to.
    scheduleDrivers: resolved.scheduleDrivers.map((d) => ({
      scheduleId: d.scheduleId,
      title: d.title,
      frequency: d.frequency,
      shareOfTotal: d.shareOfTotal,
      callCount: d.callCount,
      pinnedModel: d.pinnedModel,
      effectiveModel: d.effectiveModel,
      recommendedModel: d.recommendedModel,
      estimatedDaysRecovered: d.estimatedDaysRecovered,
      confidence: d.confidence,
    })),
    recommendations: resolved.recommendations.map((r) => ({
      fromModel: r.fromModel,
      toModel: r.toModel,
      estimatedDaysRecovered: r.estimatedDaysRecovered,
      // The qualifiers travel WITH the number they qualify. Sending the days
      // figure alone would leave a UI free to render it as a promise, which is
      // exactly what ENG-1217 AC4/AC5/AC6 exist to prevent.
      shareOfTotal: r.shareOfTotal,
      completeDaysObserved: r.completeDaysObserved,
      confidence: r.confidence,
      quality: r.quality,
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
