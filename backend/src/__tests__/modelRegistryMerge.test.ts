import {
  AUTO_DERIVED_FIELDS,
  OVERLAY_FIELDS,
  billedPricePerM,
  mergeDiscoveredModel,
  RegistryItem,
} from "../utils/modelRegistryMerge";

const overlay = {
  tier: "premium",
  qualityScore: 0.91,
  qualityScoreSource: "eval:2026-10",
  description: "Customer-facing copy",
  enabled: true,
  adminOnly: false,
  legacy: false,
  family: "claude",
  byokDeploymentId: "azure-dep-1",
  priceOverrideUsd: { inPerM: 2, outPerM: 8 },
};

const existing: RegistryItem = {
  modelId: "openrouter/anthropic/x",
  upstreamId: "anthropic/x",
  inputPricePerM: 3,
  outputPricePerM: 15,
  contextLength: 200000,
  ...overlay,
};

describe("mergeDiscoveredModel (ENG-1777)", () => {
  it("AC1: poll changing auto-derived fields leaves every overlay field unchanged", () => {
    const merged = mergeDiscoveredModel(existing, {
      modelId: existing.modelId,
      inputPricePerM: 5,
      outputPricePerM: 25,
      contextLength: 1000000,
      supportsVision: true,
      // hostile/sloppy upstream payload trying to write overlay keys
      tier: "free",
      enabled: false,
      description: "upstream text",
      priceOverrideUsd: null,
      qualityScore: 0,
    });
    for (const k of OVERLAY_FIELDS) expect(merged[k]).toEqual((overlay as Record<string, unknown>)[k]);
    expect(merged.inputPricePerM).toBe(5);
    expect(merged.contextLength).toBe(1000000);
    expect(merged.supportsVision).toBe(true);
  });

  it("AC2: allow-list is explicit and disjoint from overlay fields", () => {
    expect(AUTO_DERIVED_FIELDS).toEqual([
      "upstreamId",
      "inputPricePerM",
      "outputPricePerM",
      "cacheReadPricePerM",
      "cacheWritePricePerM",
      "contextLength",
      "modalities",
      "supportsVision",
      "supportsTemperature",
      "supportedParams",
    ]);
    const overlap = AUTO_DERIVED_FIELDS.filter((f) => (OVERLAY_FIELDS as readonly string[]).includes(f));
    expect(overlap).toEqual([]);
  });

  it("drops unknown upstream keys and undefined values", () => {
    const merged = mergeDiscoveredModel(existing, {
      modelId: existing.modelId,
      somethingNew: "x",
      inputPricePerM: undefined,
    });
    expect(merged).not.toHaveProperty("somethingNew");
    expect(merged.inputPricePerM).toBe(3);
  });

  it("new discoveries land disabled with no overlay fields", () => {
    const merged = mergeDiscoveredModel(undefined, {
      modelId: "openrouter/new/y",
      inputPricePerM: 1,
      outputPricePerM: 2,
      enabled: true,
      tier: "premium",
    });
    expect(merged).toEqual({ modelId: "openrouter/new/y", inputPricePerM: 1, outputPricePerM: 2, enabled: false });
  });

  it("AC3: priceOverrideUsd is never replaced by the poll-derived price", () => {
    const merged = mergeDiscoveredModel(existing, {
      modelId: existing.modelId,
      inputPricePerM: 99,
      outputPricePerM: 99,
    });
    expect(merged.priceOverrideUsd).toEqual({ inPerM: 2, outPerM: 8 });
    expect(billedPricePerM(merged)).toEqual({ inPerM: 2, outPerM: 8 });
  });

  it("billed price falls back to derived price without an override", () => {
    const { priceOverrideUsd: _drop, ...noOverride } = existing;
    expect(billedPricePerM(noOverride as RegistryItem)).toEqual({ inPerM: 3, outPerM: 15 });
  });
});
