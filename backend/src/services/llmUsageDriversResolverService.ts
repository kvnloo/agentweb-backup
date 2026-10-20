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
import { runwayAllowance } from "./llmUsageRunwayResolverService";
import { contentAuthorityOver } from "./orgContentAuthority";
import { modelAccess, systemModelCheck } from "./agentMode/modelAccessInstance";
import {
  readBilledLedgerRows,
  resolvePooledLedgerUserIds,
  hasInferredAttribution,
} from "./llmUsageLedgerReader";
import { scheduleDb } from "./db";
import { agentModeService } from "./agentModeService";
import {
  attributeCosts,
  estimateModelSavings,
  type AttributionRow,
  type CostAttribution,
} from "./llmUsageAttributionService";
import { computeUsageRunway, TRAILING_WINDOW_DAYS } from "./llmUsageForecastService";

/**
 * How much of the authoritative counter the reconstructed ledger must account for
 * before it is treated as complete. Mirrors the runway resolver deliberately: two
 * different numbers would let the same account read as trustworthy on one screen
 * and not the other.
 */
const LEDGER_COMPLETENESS_TOLERANCE = 0.95;

/**
 * ENG-1563 — how large an AA Intelligence Index `qualityScore` gap (0-100
 * scale) must be before a candidate model is called `benchmark_lower`
 * instead of `benchmark_comparable`.
 *
 * The issue did not hand down an exact number, so this is a judgment call,
 * documented rather than left as a magic number buried in `qualityFor`.
 * Reasoning, from the real scores already in `agentModeService`'s registry
 * (`llmModels`, AA Index v4.1.1, snapshot 2026-08-19):
 *
 *   - Same-generation / minor-version deltas cluster small: GPT-5.4 -> 5.5 is
 *     3 points, Gemini 3.5 Flash -> 3.7 Flash is 4 points. These read as "the
 *     same tier of model, slightly refreshed."
 *   - Cross-tier / cross-generation deltas start meaningfully larger: Claude
 *     Opus 5 -> Sonnet 5 is 8 points, Sonnet 4.5 -> 4.6 is 11 points. These
 *     read as genuinely different capability, not noise.
 *
 * 5 sits between those two clusters: it comfortably covers the observed
 * same-tier refreshes (3-4 pts) as "comparable" while still calling an
 * 8+ point cross-tier gap "lower". Given ENG-1200 (a founder account silently
 * defaulted to an inferior model with false confidence), the bias here is
 * deliberately toward the SMALLER threshold — erring toward `benchmark_lower`
 * more readily than toward `benchmark_comparable` — because a false
 * "comparable" is the exact failure mode this system exists to prevent, while
 * an over-cautious "lower" is merely conservative, not misleading.
 *
 * Revisit if the AA Index's own scale or methodology changes materially.
 */
export const BENCHMARK_COMPARABLE_MAX_DELTA = 5;

/**
 * Is this ledger a complete picture of what was billed to the subject?
 *
 * Raised by Greptile on PR #2407: the driver resolver "consumes that incomplete
 * ledger without detecting the discrepancy against the pooled billing counter."
 * The runway resolver already made this check; drivers did not, so recommendations
 * and their day estimates were computed from possibly-missing spend and presented
 * with full confidence.
 *
 * `costUsedMicroUsd` is incremented against the billing root at write time, so it
 * includes spend by members who have since left the org -- whose unstamped rows
 * the partition fan-out can never reach. A ledger materially below it is proof
 * that spend is missing, even when every row we DID find looks correct.
 */
function ledgerIsIncomplete(
  rows: readonly { costMicroUsd?: number }[],
  costUsedMicroUsd: number,
): boolean {
  if (!(costUsedMicroUsd > 0)) return false;
  const total = rows.reduce((sum, r) => sum + (r.costMicroUsd || 0), 0);
  return total < costUsedMicroUsd * LEDGER_COMPLETENESS_TOLERANCE;
}
import { recordUsageTelemetry, USAGE_TELEMETRY_EVENTS } from "./llmUsageTelemetry";
import { utcDay, resolveCycle } from "../utils/usageCycle";
import { taskVerifiedQualityLookup, type TaskVerifiedLookup } from "../loops/eval/taskVerifiedFeed";

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
 * What we know about the cheaper model doing the same job (ENG-1217 AC5,
 * grounded in a real signal by ENG-1563).
 *
 * AC5 forbids representing a cheaper model as equivalent in quality WITHOUT
 * task-specific evaluation evidence. It does not forbid citing a general
 * benchmark signal, as long as it is labeled honestly as exactly that — so
 * `status` carries its own `source`, and the two are never allowed to read as
 * the same kind of claim:
 *
 * - `benchmark_comparable` / `benchmark_lower` (`source: "artificial_analysis"`)
 *   — derived from the AA Intelligence Index `qualityScore` every model
 *   already carries (see `agentModeService.getSupportedModelsWithMetadata`,
 *   the same source powering the picker's meters and the dominance filter).
 *   The copy always names the benchmark and disclaims task-specific
 *   verification (ENG-1200: a confident-looking number nobody can trace to
 *   "was this tested for you" is the exact incident this system exists to
 *   prevent).
 * - `unknown` (`source: "none"`) — the true no-data case: AA has not scored
 *   one or both sides of the pair. This is still the ONLY status this file
 *   is entitled to emit for a pair with no AA data, and it stays that way.
 * - `task_verified` (`source: "task_eval"`) — set by `taskVerifiedQualityLookup`
 *   (loops/eval/taskVerifiedFeed.ts, ENG-2190) from the eval-v2 online sampler's
 *   sampled task-success rate, ONLY for a pair where `evalRegistry.mayGate` is
 *   true for the grader behind it. As of this writing no grader is validated
 *   (ENG-2128 principle 2), so this reads as provably inert: no grader mayGates,
 *   so no eval-v2 data is even read, let alone this status emitted. The full
 *   Okareo-backed harness and canary/promotion rollout (open question
 *   `OQ:okareo`) remains ENG-1564, still Backlog pending its own AC1 decision —
 *   this feed does not attempt that; it reuses AgentWeb's own already-running
 *   production-outcome sampler instead, behind the same registry gate every
 *   other eval-v2 metric already respects.
 *
 * HARD INVARIANT: an AA-derived value and a task-eval-derived value are never
 * blended into one number or one status — each tier renders its own explicit
 * provenance via `source`, always. Do not add a numeric field here that both
 * branches could feed; if that instinct ever comes up, stop and re-read this
 * comment.
 */
export interface RecommendationQuality {
  status: "unknown" | "benchmark_comparable" | "benchmark_lower" | "task_verified";
  source: "none" | "artificial_analysis" | "task_eval";
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
  /**
   * ENG-1438 — whether the schedule RECORD still exists.
   *
   * `title: null` used to mean two different things: a schedule deleted mid-cycle, and one
   * that exists but was never named. The UI could only render one sentence for both, and
   * chose "Untitled scheduled task" — which for a deleted schedule is false, and which sat
   * next to a Confirm button that would 404 on apply.
   *
   * The resolver has always known the difference (the schedule lookup either found a
   * record or did not); it simply threw it away at the boundary. Now it does not.
   */
  scheduleExists: boolean;
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
  /**
   * Whether THIS caller can actually change this schedule's model (ENG-1533).
   *
   * Schedules are pooled across every org member, so this list routinely shows
   * a caller a colleague's work. `llmModelChangeService` correctly refuses a
   * plain member's write on it — which meant the UI offered a Confirm button
   * whose only possible outcome was an error. Answering the authority question
   * here, with the SAME predicate the write path uses, is what lets the UI stop
   * offering an action that cannot succeed.
   *
   * The row itself stays visible either way: the spend is real and was billed
   * to this account, and hiding it would recreate the blind spot ENG-1440
   * closed. What changes is whether an action is offered on it.
   */
  switchable: boolean;
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
  // Union reader: a departed member's spend is still billed here, and omitting it
  // both understates the drivers and inflates every "days recovered" estimate
  // computed against them.
  const rows = await readBilledLedgerRows(usage.billingUserId, cycleStartDate, today);
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
    // ENG-1519: carried through so attribution can tell a per-unit vendor call
    // from a token-priced model call. Without them every vendor row was
    // aggregated as a model.
    provider: r.provider,
    unit: r.unit,
  }));

  const observedByDate = new Map<string, number>();
  for (const r of ledger) {
    observedByDate.set(r.date, (observedByDate.get(r.date) || 0) + r.costMicroUsd);
  }

  // ENG-668: the same allowance /usage-runway forecasts against (the PAYG month pool when admitting).
  const { hardThresholdMicroUsd, paygCovering } = runwayAllowance({ ...usage, policy: usage.policy });
  const forecastInput = {
    costUsedMicroUsd: usage.costUsedMicroUsd,
    hardThresholdMicroUsd,
    ...(paygCovering ? { paygCovering: true } : {}),
    cycleStartDate,
    cycleResetDate,
    today,
    // Every recommendation's confidence is capped by this baseline's, so feeding
    // the signal here propagates it to the whole preview without a second rule.
    attributionInferred:
      hasInferredAttribution(rows) || ledgerIsIncomplete(rows, usage.costUsedMicroUsd),
  };
  const baseline = computeUsageRunway({
    // `forecastInput` already carries `attributionInferred`; repeating it here
    // would be a second place to keep in step for no gain.
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
  options: { today?: string; taskVerifiedLookup?: TaskVerifiedLookup } = {},
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
  // Union read, not a single partition and not the fan-out alone: rows are keyed
  // by the ACTING user, so an org root's own partition omits every member whose
  // spend it pays for -- and the fan-out in turn omits members who have since
  // LEFT. See `llmUsageLedgerReader`.
  const rows = await readBilledLedgerRows(usage.billingUserId, cycleStartDate, today);

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
    // ENG-1519: carried through so attribution can tell a per-unit vendor call
    // from a token-priced model call. Without them every vendor row was
    // aggregated as a model.
    provider: r.provider,
    unit: r.unit,
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
  // ENG-668: the same allowance /usage-runway forecasts against (the PAYG month pool when admitting).
  const allowance = runwayAllowance({ ...usage, policy: usage.policy });
  const baseline = computeUsageRunway({
    costUsedMicroUsd: usage.costUsedMicroUsd,
    hardThresholdMicroUsd: allowance.hardThresholdMicroUsd,
    ...(allowance.paygCovering ? { paygCovering: true } : {}),
    dailyCostMicroUsd,
    cycleStartDate,
    cycleResetDate,
    today,
    // The existing `forecastCap` already holds every recommendation to the
    // baseline's confidence, so the honest signal only has to be supplied once.
    attributionInferred:
      hasInferredAttribution(rows) || ledgerIsIncomplete(rows, usage.costUsedMicroUsd),
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
  // ENG-669: and only what the account's plan includes (switch off => unchanged, nothing read):
  // recommending a model the tier allowlist then refuses would only break the work it targets.
  const catalog = await modelAccess.filterAllowedModels(
    userId,
    (usage.policy.optimizedModelIds || []).filter((m) => supported.has(m)),
    systemModelCheck(null),
  );

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

  // ENG-1563: same source of truth the model picker's meters and the
  // cost/quality dominance filter already read — never a second hand-rolled
  // path to the AA Index data. `true` so the lookup covers the full
  // registry (admin-only + legacy models a historical `fromModel` may be),
  // since this is a metadata READ, not an entitlement decision — entitlement
  // for `toModel` is already enforced above via `catalog`.
  const qualityScoreById = new Map<string, number>(
    (typeof agentModeService.getSupportedModelsWithMetadata === "function"
      ? (await agentModeService.getSupportedModelsWithMetadata(true)) ?? []
      : []
    )
      .filter((m): m is typeof m & { qualityScore: number } => typeof m.qualityScore === "number")
      .map((m) => [m.id, m.qualityScore]),
  );

  /**
   * ENG-1563 — derive one recommendation's `RecommendationQuality` from the AA
   * `qualityScore` delta between `fromModel` and `toModel`.
   *
   * Falls back to `{ status: "unknown", source: "none" }` (AC3) whenever
   * either side is missing from `qualityScoreById` — that is the only honest
   * answer when AA has no benchmark for one or both models. Otherwise
   * resolves to `benchmark_comparable` or `benchmark_lower` (AC1/AC2) per
   * `BENCHMARK_COMPARABLE_MAX_DELTA`. This function itself never returns
   * `task_verified` — its caller tries `taskVerifiedQualityLookup` first
   * (ENG-2190) and only falls back to this AA-benchmark tier when that
   * returns nothing.
   */
  const qualityFor = (fromModel: string, toModel: string): RecommendationQuality => {
    const fromScore = qualityScoreById.get(fromModel);
    const toScore = qualityScoreById.get(toModel);
    if (typeof fromScore !== "number" || typeof toScore !== "number") {
      // AC5's true no-data case: neither this file nor the copy is entitled to
      // make any claim, benchmark or otherwise.
      return {
        status: "unknown",
        source: "none",
        reason:
          "No task-specific evaluation evidence exists for this model on your work, so its output quality is unknown.",
      };
    }
    // Positive => toModel scores lower than fromModel. A tie or a HIGHER
    // toModel score is "comparable" too — there is no third "better" status,
    // and a higher-scoring target was never the case AC5 was worried about.
    const delta = fromScore - toScore;
    if (delta <= BENCHMARK_COMPARABLE_MAX_DELTA) {
      return {
        status: "benchmark_comparable",
        source: "artificial_analysis",
        reason:
          "Generally rated similar on independent benchmarks — not yet tested on your specific work.",
      };
    }
    return {
      status: "benchmark_lower",
      source: "artificial_analysis",
      reason:
        "Generally rated lower on independent benchmarks — not yet tested on your specific work.",
    };
  };

  // ENG-2190 (ENG-1564's reserved slot): a validated eval-v2 rate wins over the AA-benchmark
  // guess below when one is available. Injectable for tests; production resolves through
  // evalRegistry.mayGate, so this reads no eval-v2 data at all while every grader stays
  // unvalidated — the same "inert by construction" contract as the sampler that feeds it.
  const taskVerified = options.taskVerifiedLookup ?? taskVerifiedQualityLookup();

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
        hardThresholdMicroUsd: allowance.hardThresholdMicroUsd,
        ...(allowance.paygCovering ? { paygCovering: true } : {}),
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
        // ENG-2190: task_verified (from real sampled outcomes) fully overrides the AA-benchmark
        // guess for a matching pair, never blends with it (ENG-1564 requirement 4).
        quality: (await taskVerified(driver.key, candidate)) ?? qualityFor(driver.key, candidate),
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
    // ENG-1533: the OWNER travels with the record. `lists` is per pooled user,
    // so ownership is known here and was being flattened away — and without it
    // there is no way to ask whether this caller may act on the row.
    const byId = new Map<
      string,
      { scheduleName?: string; frequency?: string; ownerUserId: string }
    >();
    lists.forEach((list, i) => {
      const ownerUserId = pooledUserIds[i];
      for (const sched of list ?? []) {
        if (sched?.scheduleId) byId.set(sched.scheduleId, { ...sched, ownerUserId });
      }
    });

    // One authority lookup per distinct OWNER, not per row: an org has a
    // handful of members and a cycle can have dozens of schedules, so asking
    // per row would multiply DB reads for an answer that cannot differ within
    // an owner.
    const authorityByOwner = new Map<string, boolean>();
    await Promise.all(
      [...new Set([...byId.values()].map((m) => m.ownerUserId))].map(async (ownerUserId) => {
        const { permitted } = await contentAuthorityOver(userId, ownerUserId);
        authorityByOwner.set(ownerUserId, permitted);
      }),
    );
    // Inheriting schedules run the platform default, so resolving it once is
    // what lets a per-schedule row carry a confirmable recommendation at all.
    // Without it, two thirds of schedules would show spend and no action.
    const platformDefault =
      typeof agentModeService.getDefaultModel === "function"
        ? await agentModeService.getDefaultModel().catch(() => null)
        : null;
    const recByFromModel = new Map(ranked.map((r) => [r.fromModel, r]));

    // ENG-669: a schedule runs under its OWNER's plan (applyModelChange checks exactly that), and an org's report
    // pools schedules whose owners can be on different tiers. So a schedule only carries a recommendation its owner's
    // plan includes. One check per distinct owner x model; switch off => no reads, every recommendation kept.
    const ownerMayRun = new Map<string, boolean>();
    await Promise.all(
      [...byId.values()].flatMap((m) => {
        const pinned = (m as { llmModel?: string }).llmModel || null;
        const rec = (pinned || platformDefault) ? recByFromModel.get((pinned || platformDefault) as string) : undefined;
        if (!rec) return [];
        const key = `${m.ownerUserId}\u0000${rec.toModel}`;
        if (ownerMayRun.has(key)) return [];
        ownerMayRun.set(key, true);
        return [modelAccess.filterAllowedModels(m.ownerUserId, [rec.toModel], systemModelCheck(null))
          .then((kept) => { ownerMayRun.set(key, kept.length > 0); })];
      }),
    );

    scheduleDrivers = attribution.bySchedule.map((d) => {
      const meta = byId.get(d.key);
      // Absent record = deleted mid-cycle. Present but unnamed is a different state and
      // must stay distinguishable — see `scheduleExists` on ScheduleDriver.
      const scheduleExists = meta !== undefined;
      const pinnedModel = (meta as { llmModel?: string } | undefined)?.llmModel || null;
      const effectiveModel = pinnedModel || platformDefault;
      const rankedRec = effectiveModel ? recByFromModel.get(effectiveModel) : undefined;
      const rec = rankedRec && meta && ownerMayRun.get(`${meta.ownerUserId}\u0000${rankedRec.toModel}`) === false ? undefined : rankedRec;
      return {
        scheduleId: d.key,
        pinnedModel,
        effectiveModel,
        recommendedModel: rec?.toModel ?? null,
        estimatedDaysRecovered: rec?.estimatedDaysRecovered ?? null,
        confidence: rec?.confidence ?? null,
        // A schedule deleted mid-cycle still consumed the allowance, so it is reported
        // under its id rather than dropped — dropping it would make the driver list
        // total less than the bill, which is the failure `reconciles` exists to catch.
        //
        // ENG-1439: this comment used to claim the UI says "deleted schedule". It does
        // not, and cannot usefully: `ScheduleSwitchList` is the ONLY consumer of
        // `scheduleDrivers`, and it shows only rows with a switch to offer — so a
        // deleted schedule (which has no actionable switch) is invisible to the
        // customer, as is any other spend without an available action. Measured in
        // production 2026-08-21: 4 deleted schedules held $16.82, 7.3% of all
        // schedule-attributed spend that cycle.
        //
        // The field is real and load-bearing for reconciliation and for
        // `scheduleExists`; it is simply not yet rendered. Stated plainly here rather
        // than described as behaviour that exists.
        title: meta?.scheduleName ?? null,
        scheduleExists,
        // A schedule whose record is gone cannot be switched by anyone, so the
        // authority question does not even arise — `false` here is "no action
        // is possible", which is exactly what the UI needs to know.
        switchable: meta ? (authorityByOwner.get(meta.ownerUserId) ?? false) : false,
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
        // ENG-1436: this event fires on every drivers read, but the panel renders
        // recommendations ONLY when the customer is off track. In 48h of production, 31 of
        // 60 events (52%) went to accounts that could not see them — so the `shown` leg of
        // AC12's funnel overcounted roughly twofold and any decline rate drawn from it was
        // wrong by about half.
        //
        // The event cannot be gated here without the server guessing at a render rule it
        // does not own. Carrying `onTrack` instead makes every row — including the ones
        // already collected — filterable, which is what the analysis actually needs.
        onTrack: baseline.onTrack,
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
          // ENG-1519: per-unit vendor spend IS attributed — to a vendor rather
          // than to a model — and this boundary was dropping it. Removing it
          // from `byModel` without naming it anywhere left the model list
          // covering less than the cycle with no sentence saying why, which
          // trades a wrong row for a silent gap. null when the cycle bought
          // nothing per-unit, so a UI states absence instead of rendering zero.
          byVendor: resolved.attribution.byVendor ? toShares(resolved.attribution.byVendor) : null,
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
      // ENG-1438: crosses the customer boundary. It carries no economics — only whether
      // the named work still exists — and without it the UI cannot tell a deleted task
      // from an unnamed one, which is the whole defect.
      scheduleExists: d.scheduleExists,
      // ENG-1533: crosses the boundary because the UI cannot otherwise tell an
      // actionable row from one whose Confirm button is guaranteed to fail. It
      // carries no economics — only whether THIS caller may act.
      switchable: d.switchable,
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
