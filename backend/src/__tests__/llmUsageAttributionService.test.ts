/**
 * ENG-1213 — cost driver attribution and opt-in model savings.
 *
 * Pure aggregation + repricing over the existing ledger. It never changes a
 * model; it returns what is consuming the allowance and what switching would be
 * estimated to save, for a human to confirm.
 *
 * Scope note carried from the ticket: AC1 asks for a scheduled-vs-interactive
 * split as well. `AW-UsageRecords` cannot answer that — `meterUserUsage` receives
 * a sessionId but the row is keyed `date#model#feature` and aggregates it away,
 * and `agentModeService.ts` stamps `feature: 'agent_task'` for both. That bucket
 * is ~95% of all spend. AC2 explicitly permits "an explicit unattributed
 * remainder", so the split is reported as unavailable rather than guessed.
 */

import {
  attributeCosts,
  estimateModelSavings,
  type AttributionRow,
} from "../services/llmUsageAttributionService";

const USD = 1_000_000;

const row = (over: Partial<AttributionRow> = {}): AttributionRow => ({
  date: "2026-08-01",
  model: "anthropic.claude-opus-5",
  feature: "agent_task",
  inputTokens: 1_000,
  outputTokens: 1_000,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costMicroUsd: 10 * USD,
  callCount: 1,
  ...over,
});

describe("attributeCosts — grouping (ENG-1213 AC1)", () => {
  it("groups by actual model, largest first", () => {
    const result = attributeCosts([
      row({ model: "anthropic.claude-opus-5", costMicroUsd: 30 * USD }),
      row({ model: "gemini-3.5-flash", costMicroUsd: 50 * USD }),
      row({ model: "anthropic.claude-opus-5", costMicroUsd: 5 * USD }),
    ]);
    // Distinct totals on purpose: equal totals would fall through to the
    // alphabetical tiebreak and this would stop testing "largest first".
    expect(result.byModel.map((d) => d.key)).toEqual(["gemini-3.5-flash", "anthropic.claude-opus-5"]);
    expect(result.byModel[0].costMicroUsd).toBe(50 * USD);
    expect(result.byModel[1].costMicroUsd).toBe(35 * USD);
  });

  it("orders equal-cost drivers deterministically by key", () => {
    const result = attributeCosts([
      row({ model: "zeta", costMicroUsd: 10 * USD }),
      row({ model: "alpha", costMicroUsd: 10 * USD }),
    ]);
    expect(result.byModel.map((d) => d.key)).toEqual(["alpha", "zeta"]);
  });

  it("normalises dynamic feature suffixes so drivers do not fragment", () => {
    // Production carries `x-account:1340767380`, `content_gen:streaming-no-usage`
    // and similar. Grouped raw, one social account per row becomes its own
    // "driver" and the list is noise.
    const result = attributeCosts([
      row({ feature: "x-account:1340767380", costMicroUsd: 10 * USD }),
      row({ feature: "x-account:4854497199", costMicroUsd: 20 * USD }),
      row({ feature: "content_gen:streaming-no-usage", costMicroUsd: 5 * USD }),
      row({ feature: "content_gen", costMicroUsd: 5 * USD }),
    ]);
    const keys = result.byFeature.map((d) => d.key);
    expect(keys).toContain("x-account");
    expect(keys).toContain("content_gen");
    expect(result.byFeature.find((d) => d.key === "x-account")!.costMicroUsd).toBe(30 * USD);
    expect(result.byFeature.find((d) => d.key === "content_gen")!.costMicroUsd).toBe(10 * USD);
  });

  it("reconciles every group exactly to the total (AC2)", () => {
    const rows = [
      row({ model: "a", feature: "agent_task", costMicroUsd: 7 * USD }),
      row({ model: "b", feature: "enrichment", costMicroUsd: 11 * USD }),
      row({ model: "a", feature: "chat", costMicroUsd: 3 * USD }),
    ];
    const result = attributeCosts(rows);
    expect(result.totalCostMicroUsd).toBe(21 * USD);
    expect(result.byModel.reduce((s, d) => s + d.costMicroUsd, 0)).toBe(21 * USD);
    expect(result.byFeature.reduce((s, d) => s + d.costMicroUsd, 0)).toBe(21 * USD);
    expect(result.unattributedMicroUsd).toBe(0);
    expect(result.reconciles).toBe(true);
  });

  it("routes rows with a missing model or feature to an explicit unattributed bucket", () => {
    const result = attributeCosts([
      row({ costMicroUsd: 10 * USD }),
      row({ model: "", feature: "", costMicroUsd: 4 * USD }),
    ]);
    expect(result.totalCostMicroUsd).toBe(14 * USD);
    expect(result.unattributedMicroUsd).toBe(4 * USD);
    // Still reconciles — the remainder is named, not lost.
    expect(result.byModel.reduce((s, d) => s + d.costMicroUsd, 0) + result.unattributedMicroUsd)
      .toBe(14 * USD);
  });

  it("reports the scheduled-vs-interactive split as unavailable, not as zero", () => {
    const result = attributeCosts([row()]);
    // Reporting 0% scheduled would be a lie; the ledger simply cannot say.
    expect(result.bySource).toBeNull();
    expect(result.unavailableGroupings).toContain("scheduled_vs_interactive");
  });

  it("carries call counts and shares alongside cost", () => {
    const result = attributeCosts([
      row({ model: "a", costMicroUsd: 75 * USD, callCount: 3 }),
      row({ model: "b", costMicroUsd: 25 * USD, callCount: 1 }),
    ]);
    expect(result.byModel[0].shareOfTotal).toBeCloseTo(0.75, 5);
    expect(result.byModel[0].callCount).toBe(3);
  });

  it("returns an empty, reconciling result for no rows", () => {
    const result = attributeCosts([]);
    expect(result.totalCostMicroUsd).toBe(0);
    expect(result.byModel).toEqual([]);
    expect(result.reconciles).toBe(true);
  });
});

describe("estimateModelSavings — counterfactual repricing (ENG-1213 AC3)", () => {
  const opusRows = [
    row({
      model: "anthropic.claude-opus-5",
      inputTokens: 1_000_000,
      outputTokens: 100_000,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costMicroUsd: 7_500_000,
    }),
  ];

  it("reprices the SAME observed token mix at the target model's rates", () => {
    // opus-5 $5/$25 per 1M; haiku-4.5 $1/$5. 1M in + 100k out:
    //   opus  = $5.00 + $2.50 = $7.50
    //   haiku = $1.00 + $0.50 = $1.50
    const est = estimateModelSavings(opusRows, {
      fromModel: "anthropic.claude-opus-5",
      toModel: "anthropic.claude-haiku-4-5-20251001-v1:0",
    });
    expect(est).not.toBeNull();
    expect(est!.observedCostMicroUsd).toBe(7_500_000);
    expect(est!.estimatedCostMicroUsd).toBe(1_500_000);
    expect(est!.estimatedSavingsMicroUsd).toBe(6_000_000);
  });

  it("prices cache reads and writes rather than ignoring them", () => {
    // Cache creation dominated the real ENG-1200 session (1.76M write tokens),
    // so a repricing that skipped cache tokens would understate everything.
    const withCache = estimateModelSavings(
      [row({
        model: "anthropic.claude-opus-5",
        inputTokens: 0, outputTokens: 0,
        cacheReadTokens: 1_000_000, cacheWriteTokens: 1_000_000,
        costMicroUsd: 6_750_000,
      })],
      { fromModel: "anthropic.claude-opus-5", toModel: "anthropic.claude-haiku-4-5-20251001-v1:0" },
    );
    expect(withCache!.estimatedCostMicroUsd).toBeGreaterThan(0);
    expect(withCache!.estimatedSavingsMicroUsd).toBeGreaterThan(0);
  });

  it("labels the result an estimate and promises no equivalence (AC4)", () => {
    const est = estimateModelSavings(opusRows, {
      fromModel: "anthropic.claude-opus-5",
      toModel: "anthropic.claude-haiku-4-5-20251001-v1:0",
    });
    expect(est!.isEstimate).toBe(true);
    expect(est!.basis).toMatch(/observed token mix/i);
  });

  it("withholds an estimate when either model has no price entry (AC7)", () => {
    expect(estimateModelSavings(opusRows, {
      fromModel: "anthropic.claude-opus-5",
      toModel: "some-unpriced-model",
    })).toBeNull();
    expect(estimateModelSavings(
      [row({ model: "some-unpriced-model" })],
      { fromModel: "some-unpriced-model", toModel: "anthropic.claude-haiku-4-5-20251001-v1:0" },
    )).toBeNull();
  });

  it("ignores rows belonging to other models", () => {
    const est = estimateModelSavings(
      [...opusRows, row({ model: "gemini-3.5-flash", costMicroUsd: 999 * USD })],
      { fromModel: "anthropic.claude-opus-5", toModel: "anthropic.claude-haiku-4-5-20251001-v1:0" },
    );
    expect(est!.observedCostMicroUsd).toBe(7_500_000);
  });

  it("returns null when the source model has no spend to reprice", () => {
    expect(estimateModelSavings([row({ model: "gemini-3.5-flash" })], {
      fromModel: "anthropic.claude-opus-5",
      toModel: "anthropic.claude-haiku-4-5-20251001-v1:0",
    })).toBeNull();
  });

  it("ignores rows recorded at zero cost, which consumed none of the allowance", () => {
    // `computeCostMicroUsd` returns 0 for a model with no price entry but still
    // writes the token counts, so a model priced MID-CYCLE carries token-bearing
    // $0 rows for the rest of that cycle. Repricing those tokens invents a cost
    // for the target on one side of a comparison whose other side is literally
    // zero — which understates the saving, and on a model whose rows are mostly
    // mismetered flips it negative and suppresses the recommendation outright.
    const est = estimateModelSavings(
      [
        row({ inputTokens: 1_000_000, outputTokens: 0, costMicroUsd: 5 * USD }),
        // Identical usage, recorded before the price entry landed.
        row({ inputTokens: 1_000_000, outputTokens: 0, costMicroUsd: 0 }),
      ],
      { fromModel: "anthropic.claude-opus-5", toModel: "anthropic.claude-haiku-4-5-20251001-v1:0" },
    );
    // Only the priced row is repriced: 1M input at haiku's $1/1M.
    expect(est!.observedCostMicroUsd).toBe(5 * USD);
    expect(est!.estimatedCostMicroUsd).toBe(1 * USD);
    expect(est!.estimatedSavingsMicroUsd).toBe(4 * USD);
  });

  it("withholds an estimate when every row for the model was recorded at zero cost", () => {
    // Nothing was charged, so there is no saving to claim — and no basis for
    // asserting the target would have been dearer either.
    expect(estimateModelSavings(
      [row({ inputTokens: 1_000_000, outputTokens: 0, costMicroUsd: 0 })],
      { fromModel: "anthropic.claude-opus-5", toModel: "anthropic.claude-haiku-4-5-20251001-v1:0" },
    )).toBeNull();
  });

  it("never proposes switching a model to itself", () => {
    expect(estimateModelSavings(opusRows, {
      fromModel: "anthropic.claude-opus-5",
      toModel: "anthropic.claude-opus-5",
    })).toBeNull();
  });

  it("reports a negative saving honestly rather than hiding an upgrade", () => {
    const est = estimateModelSavings(
      [row({
        model: "anthropic.claude-haiku-4-5-20251001-v1:0",
        inputTokens: 1_000_000, outputTokens: 0,
        cacheReadTokens: 0, cacheWriteTokens: 0,
        costMicroUsd: 1_000_000,
      })],
      { fromModel: "anthropic.claude-haiku-4-5-20251001-v1:0", toModel: "anthropic.claude-opus-5" },
    );
    expect(est!.estimatedSavingsMicroUsd).toBeLessThan(0);
  });
});
