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
 * scheduled-vs-interactive split, and that is **not answerable from this table**:
 * `meterUserUsage` receives a `sessionId` but the row aggregates it away, and
 * `agentModeService` stamps `feature: 'agent_task'` for both scheduled and
 * interactive agent runs — a bucket holding ~95% of all recorded spend.
 *
 * AC2 permits "an explicit unattributed remainder", so that split is reported as
 * *unavailable* rather than silently returned as zero. Reporting "0% scheduled"
 * would be a false statement about a customer's own usage. Making it answerable
 * is a metering write-path change (emit `agent_task:scheduled`), deliberately
 * kept out of this read-only layer.
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

export interface CostAttribution {
  totalCostMicroUsd: number;
  byModel: CostDriver[];
  byFeature: CostDriver[];
  /** null — the ledger cannot separate scheduled from interactive. See module docs. */
  bySource: null;
  /** Named groupings this data set cannot support, so callers state it rather than imply zero. */
  unavailableGroupings: string[];
  /** Cost that could not be attributed (missing model/feature). Never silently dropped. */
  unattributedMicroUsd: number;
  reconciles: boolean;
}

/** Group key for a `feature`: the segment before any `:` qualifier. */
function normaliseFeature(feature: string): string {
  return (feature || "").split(":")[0].trim();
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
  let total = 0;
  let unattributed = 0;

  for (const row of rows) {
    const cost = Math.max(0, row.costMicroUsd || 0);
    const calls = row.callCount || 0;
    total += cost;

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

  return {
    totalCostMicroUsd: total,
    byModel: toDrivers(byModel, total),
    byFeature: toDrivers(byFeature, total),
    bySource: null,
    unavailableGroupings: ["scheduled_vs_interactive"],
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
