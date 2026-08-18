/**
 * ENG-1213 — cost driver attribution and opt-in model savings.
 *
 * A read-only aggregation and repricing layer over the existing ledger. It
 * answers "what is consuming the allowance" and "what would switching be
 * estimated to save", and it **never changes a model** — the output is a
 * proposal for a human to confirm (AC6).
 *
 * ## What the ledger can and cannot attribute
 *
 * `AW-UsageRecords` is keyed `userId` / `date#model#feature`, so grouping by
 * **model** and by **feature** is exact. AC1 also asks for a
 * scheduled-vs-interactive split, which the table originally could not answer:
 * `meterUserUsage` receives a `sessionId` but the row aggregates it away, and
 * `agentModeService` stamped `feature: 'agent_task'` for both scheduled and
 * interactive agent runs — a bucket holding ~95% of all recorded spend.
 *
 * Per Harsha's 2026-08-14 direction, that is now fixed **forward** rather than
 * reconstructed: `meteringFeature` stamps provenance at write time, and this
 * layer reports the split for rows that carry it alongside an explicit remainder
 * for rows that predate it (AC2 permits exactly that remainder). History is never
 * back-filled by inference — a guess about which past rows were scheduled would
 * be indistinguishable, to the customer, from a measurement.
 *
 * So `bySource` is null only while NO row is tagged, and becomes available the
 * moment one is. Reporting "0% scheduled" for an untagged ledger would be a false
 * statement about a customer's own usage; reporting a partial split plus a named
 * remainder is a true one.
 *
 * ## Feature normalisation
 *
 * `feature` is not a closed enum in practice — production carries
 * `x-account:1340767380`, `content_gen:streaming-no-usage`, `onboarding:cron`.
 * Grouped raw, every social account becomes its own "top driver" and the list
 * degenerates into noise, so the segment before `:` is the grouping key.
 */

import { getModelPrice, cacheWriteCost } from "../utils/llmPricing";

export interface AttributionRow {
  date: string;
  model: string;
  feature: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  costMicroUsd: number;
  callCount?: number;
}

export interface CostDriver {
  key: string;
  costMicroUsd: number;
  /** 0..1 of the attributed + unattributed total. */
  shareOfTotal: number;
  callCount: number;
}

export type UsageSource = "scheduled" | "interactive";

/**
 * The only qualifiers that denote provenance. Everything else after a `:` is an
 * ordinary feature qualifier — `x-account:1340767380` is a social account id, and
 * reading any qualifier as a source would invent a source named after an account.
 */
const SOURCE_TAGS: readonly string[] = ["scheduled", "interactive"];

export interface CostAttribution {
  totalCostMicroUsd: number;
  byModel: CostDriver[];
  byFeature: CostDriver[];
  /**
   * Scheduled vs interactive, for rows written since the metering tag shipped.
   * null while NO row carries the tag — an untagged ledger genuinely cannot say,
   * and reporting "0% scheduled" would be a false statement about real usage.
   */
  bySource: CostDriver[] | null;
  /**
   * Spend per individual schedule, keyed by scheduleId, for rows that name one.
   * null while no row does. ENG-1217 AC8 requires naming the exact schedule, and
   * a resolver joins these ids to schedule titles — this layer stays read-only
   * over the ledger and never invents a name it cannot key.
   */
  bySchedule: CostDriver[] | null;
  /** Cost whose provenance predates the tag. Stated, never folded into a source. */
  sourceUnattributedMicroUsd: number;
  /** Named groupings this data set cannot support, so callers state it rather than imply zero. */
  unavailableGroupings: string[];
  /** Cost that could not be attributed (missing model/feature). Never silently dropped. */
  unattributedMicroUsd: number;
  reconciles: boolean;
}

/** Group key for a `feature`: the segment before any `:` qualifier. */
export function normaliseFeature(feature: string): string {
  return (feature || "").split(":")[0].trim();
}

/** The provenance a `feature` carries, or null for rows written before the tag. */
function sourceOf(feature: string): UsageSource | null {
  const qualifier = (feature || "").split(":")[1]?.trim();
  return qualifier && SOURCE_TAGS.includes(qualifier) ? (qualifier as UsageSource) : null;
}

/** The schedule a `feature` names, or null when the row is not schedule-tagged. */
function scheduleOf(feature: string): string | null {
  // Only meaningful under the `scheduled` source — a third segment on anything
  // else is not a schedule id.
  if (sourceOf(feature) !== "scheduled") return null;
  return (feature || "").split(":")[2]?.trim() || null;
}

/**
 * Stamp scheduled-vs-interactive provenance onto a `feature` at metering time.
 *
 * ENG-1210 AC6 needs spend attributed to actionable sources, and the ledger is
 * keyed `date#model#feature` — a sessionId reaches the recorder but is aggregated
 * away, so provenance has to live in a dimension the key keeps. Harsha's
 * 2026-08-14 direction was to tag going forward rather than reconstruct history,
 * so this writes the tag and the read layer reports an honest remainder for rows
 * that predate it.
 *
 * It rides the existing `:` qualifier convention, which is what makes it safe to
 * turn on mid-cycle: `normaliseFeature` already collapses `agent_task:scheduled`
 * to `agent_task`, so every existing feature grouping is unmoved and only the new
 * `bySource` grouping reads the qualifier.
 *
 * An unknown sessionType is left UNTAGGED rather than assumed interactive.
 * Defaulting would manufacture exactly the false precision AC5 forbids — and it
 * would do so in the direction that flatters us, by making unexplained spend look
 * like something the customer chose to run.
 */
export function meteringFeature(
  base: string,
  sessionType?: string | null,
  scheduleId?: string | null,
): string {
  const feature = (base || "").trim();
  // A feature that already carries a qualifier keeps it: either it is already
  // tagged, or it is a dimension like `x-account:<id>` that must not be rewritten.
  if (!feature || feature.includes(":")) return feature;
  const type = (sessionType || "").trim();
  if (!type) return feature;
  if (type !== "scheduled") {
    // Interactive work has no schedule. Accepting an id here would invent one.
    return `${feature}:interactive`;
  }

  // ENG-1217 AC8 names the exact schedule, which needs a THIRD segment. Existing
  // readers are unaffected by construction: `normaliseFeature` takes [0] and
  // `sourceOf` takes [1].
  //
  // `#` separates sort-key components and `:` separates qualifiers, so an id
  // carrying either would silently re-shape the key. Such an id is refused
  // rather than written — the run stays correctly attributed as scheduled, it
  // just goes unnamed, which is the honest-remainder outcome rather than a
  // corrupted key. The same applies when the pageIdentifier could not be parsed.
  const id = (scheduleId || "").trim();
  if (!id || id.includes(":") || id.includes("#")) return `${feature}:scheduled`;
  return `${feature}:scheduled:${id}`;
}

function toDrivers(totals: Map<string, { cost: number; calls: number }>, grandTotal: number): CostDriver[] {
  return [...totals.entries()]
    .map(([key, v]) => ({
      key,
      costMicroUsd: v.cost,
      shareOfTotal: grandTotal > 0 ? v.cost / grandTotal : 0,
      callCount: v.calls,
    }))
    // Highest impact first (AC1 "show the highest-cost drivers first"); key as a
    // tiebreak so equal-cost drivers order deterministically.
    .sort((a, b) => b.costMicroUsd - a.costMicroUsd || a.key.localeCompare(b.key));
}

export function attributeCosts(rows: AttributionRow[]): CostAttribution {
  const byModel = new Map<string, { cost: number; calls: number }>();
  const byFeature = new Map<string, { cost: number; calls: number }>();
  const bySource = new Map<string, { cost: number; calls: number }>();
  const bySchedule = new Map<string, { cost: number; calls: number }>();
  let total = 0;
  let unattributed = 0;
  let sourceUnattributed = 0;

  for (const row of rows) {
    const cost = Math.max(0, row.costMicroUsd || 0);
    const calls = row.callCount || 0;
    total += cost;

    // Provenance is independent of whether the row can be attributed by
    // model/feature, so it is read before the placement check below.
    const source = sourceOf(row.feature);
    if (source) {
      const s = bySource.get(source) || { cost: 0, calls: 0 };
      bySource.set(source, { cost: s.cost + cost, calls: s.calls + calls });
    } else {
      sourceUnattributed += cost;
    }

    const schedule = scheduleOf(row.feature);
    if (schedule) {
      const sc = bySchedule.get(schedule) || { cost: 0, calls: 0 };
      bySchedule.set(schedule, { cost: sc.cost + cost, calls: sc.calls + calls });
    }

    const model = (row.model || "").trim();
    const feature = normaliseFeature(row.feature);

    // A row missing either dimension cannot be placed. It is added to an explicit
    // remainder so the parts still sum to the whole (AC2) — the failure mode to
    // avoid is a driver list that quietly totals less than the bill.
    if (!model || !feature) {
      unattributed += cost;
      continue;
    }

    const m = byModel.get(model) || { cost: 0, calls: 0 };
    byModel.set(model, { cost: m.cost + cost, calls: m.calls + calls });
    const f = byFeature.get(feature) || { cost: 0, calls: 0 };
    byFeature.set(feature, { cost: f.cost + cost, calls: f.calls + calls });
  }

  const attributed = [...byModel.values()].reduce((s, v) => s + v.cost, 0);

  // Available the moment ANY row carries the tag. A cycle that straddles the
  // cutover reports the split it can prove plus the remainder it cannot, rather
  // than suppressing a real answer until the whole cycle is tagged.
  const sourceAvailable = bySource.size > 0;
  const scheduleAvailable = bySchedule.size > 0;

  // Named separately: a cycle can know scheduled-vs-interactive while still not
  // naming any individual schedule (a run whose pageIdentifier would not parse
  // is tagged `scheduled` with no id), so one grouping can be available while
  // the other is not.
  const unavailable: string[] = [];
  if (!sourceAvailable) unavailable.push("scheduled_vs_interactive");
  if (!scheduleAvailable) unavailable.push("per_schedule");

  return {
    totalCostMicroUsd: total,
    byModel: toDrivers(byModel, total),
    byFeature: toDrivers(byFeature, total),
    bySource: sourceAvailable ? toDrivers(bySource, total) : null,
    bySchedule: scheduleAvailable ? toDrivers(bySchedule, total) : null,
    sourceUnattributedMicroUsd: sourceUnattributed,
    unavailableGroupings: unavailable,
    unattributedMicroUsd: unattributed,
    reconciles: attributed + unattributed === total,
  };
}

export interface ModelSavingsEstimate {
  fromModel: string;
  toModel: string;
  observedCostMicroUsd: number;
  estimatedCostMicroUsd: number;
  /** Positive = saving. Negative when the target is dearer; reported, not hidden. */
  estimatedSavingsMicroUsd: number;
  isEstimate: true;
  basis: string;
}

/**
 * Reprice the SAME observed token mix at another model's published rates.
 *
 * This is deliberately a counterfactual on tokens, not a prediction: a different
 * model will not consume the same tokens for the same work. ENG-1200 measured
 * that directly — Flash Lite burned 19.5x the prompt tokens of Opus on an
 * identical task and still failed it. So the result is labelled an estimate and
 * promises no quality or volume equivalence (AC4), and callers must present it
 * that way.
 *
 * Returns null rather than guessing when either model is unpriced (AC7) or when
 * there is nothing to reprice.
 */
export function estimateModelSavings(
  rows: AttributionRow[],
  input: { fromModel: string; toModel: string },
): ModelSavingsEstimate | null {
  const { fromModel, toModel } = input;
  if (!fromModel || !toModel || fromModel === toModel) return null;

  const fromPrice = getModelPrice(fromModel);
  const toPrice = getModelPrice(toModel);
  // An unpriced model cannot be compared. Silence beats a confident wrong number
  // on a screen that asks someone to change how their account runs.
  if (!fromPrice || !toPrice) return null;

  // Rows recorded at zero cost are excluded, not repriced. `computeCostMicroUsd`
  // returns 0 for a model with no price entry but still writes the token counts,
  // so a model that gains its price MID-CYCLE carries token-bearing $0 rows for
  // the rest of that cycle (the registry entry and the pricing entry are separate
  // steps in the add-a-model runbook). Repricing those tokens would invent a cost
  // for the target on one side of a comparison whose other side is literally
  // zero, so the "saving" would measure a metering gap rather than a price
  // difference — understating it, or on a mostly-mismetered model flipping it
  // negative and suppressing a genuinely good recommendation.
  //
  // A row that consumed none of the allowance can neither save nor add any.
  const source = rows.filter(
    (r) => (r.model || "").trim() === fromModel && (r.costMicroUsd || 0) > 0,
  );
  if (source.length === 0) return null;

  let observed = 0;
  let input_ = 0;
  let output = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  // Every surviving row costs something, so `observed` is necessarily > 0 — the
  // "nothing to reprice" case is already handled by the empty-source check above.
  for (const r of source) {
    observed += r.costMicroUsd;
    input_ += r.inputTokens || 0;
    output += r.outputTokens || 0;
    cacheRead += r.cacheReadTokens || 0;
    cacheWrite += r.cacheWriteTokens || 0;
  }

  // `tokens * ratePerMillion` already yields MICRO-USD: a rate is USD per 1e6
  // tokens, so the 1e6 in the rate's denominator and the 1e6 in a micro-dollar
  // cancel. This is the same convention `cacheWriteCost` returns in, so its
  // result is used as-is — scaling it again overstates cache cost a
  // million-fold.
  const microUsd = (tokens: number, ratePerMillion: number) => tokens * ratePerMillion;
  const estimated =
    microUsd(input_, toPrice.inPerM) +
    microUsd(output, toPrice.outPerM) +
    microUsd(cacheRead, toPrice.cacheReadPerM ?? toPrice.inPerM * 0.1) +
    // Cache creation dominated the real ENG-1200 Opus session (1.76M write
    // tokens, ~73% of that bill), so omitting it would understate every estimate.
    cacheWriteCost(toPrice, cacheWrite);

  const estimatedCostMicroUsd = Math.round(estimated);

  return {
    fromModel,
    toModel,
    observedCostMicroUsd: observed,
    estimatedCostMicroUsd,
    estimatedSavingsMicroUsd: observed - estimatedCostMicroUsd,
    isEstimate: true,
    basis: "Repriced the observed token mix at current published rates; token volume and quality may differ on another model.",
  };
}
