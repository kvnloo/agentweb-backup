/**
 * WS1c: image-prompt quality analyzer.
 *
 * Reads the per-archetype image like/skip signals captured by WS1b and ranks
 * archetypes whose like-rate is below threshold (with enough sample) as
 * underperformers — the recommendation a taste person acts on by editing the
 * managed prompt (WS1a). This closes the human-in-the-loop self-improvement
 * cycle: signal → surfaced → edit → re-measure.
 *
 * Pure logic with injected signal + template fetchers — no DynamoDB.
 */

import { analyzeImagePromptQuality } from "../services/imagePromptQualityService";

const summaryFor = (byArch: Record<string, { like: number; skip: number }>) => ({
  promptVersion: "x",
  totals: { like: 0, skip: 0, continue_set: 0, regenerate_set: 0 },
  byArchetype: Object.fromEntries(
    Object.entries(byArch).map(([k, v]) => [
      k,
      { like: v.like, skip: v.skip, continue_set: 0, regenerate_set: 0 },
    ]),
  ),
  sampleSize: 0,
});

const deps = (byArch: Record<string, { like: number; skip: number }>, overrides = {}) => ({
  listTemplates: async () => [
    { templateId: "archetype-A", version: "v1-seed" },
    { templateId: "archetype-B", version: "v2-2026-06-14" },
    { templateId: "archetype-C", version: "v1-seed" },
  ],
  getSummary: async () => summaryFor(byArch),
  builderVersion: "vBUILD",
  ...overrides,
});

describe("analyzeImagePromptQuality", () => {
  it("flags archetypes below the like-rate threshold with enough sample", async () => {
    const report = await analyzeImagePromptQuality(
      deps({
        A: { like: 2, skip: 18 }, // 10% like, n=20 → underperforming
        B: { like: 18, skip: 2 }, // 90% like, n=20 → ok
        C: { like: 5, skip: 5 }, // 50% like, n=10 → below minSample(20) → insufficient
      }),
    );
    const byId = Object.fromEntries(report.archetypes.map((a) => [a.archetype, a]));
    expect(byId.A.status).toBe("underperforming");
    expect(byId.B.status).toBe("ok");
    expect(byId.C.status).toBe("insufficient_data");
    expect(report.underperformers.map((u) => u.archetype)).toEqual(["A"]);
  });

  it("ranks underperformers worst like-rate first", async () => {
    const report = await analyzeImagePromptQuality(
      deps({
        A: { like: 6, skip: 14 }, // 30%
        B: { like: 2, skip: 18 }, // 10% — worst
        C: { like: 8, skip: 12 }, // 40%
      }),
    );
    expect(report.underperformers.map((u) => u.archetype)).toEqual(["B", "A", "C"]);
  });

  it("carries the full prompt version (builder/template) for each archetype", async () => {
    const report = await analyzeImagePromptQuality(deps({ A: { like: 1, skip: 1 } }));
    const a = report.archetypes.find((x) => x.archetype === "A")!;
    expect(a.version).toBe("vBUILD/v1-seed");
  });

  it("respects custom threshold + minSample", async () => {
    const report = await analyzeImagePromptQuality(
      deps({ A: { like: 6, skip: 4 } }, { likeRateThreshold: 0.8, minSample: 5 }),
    );
    // 60% like, n=10: below the 0.8 threshold and above minSample(5) → underperforming
    expect(report.archetypes.find((a) => a.archetype === "A")!.status).toBe(
      "underperforming",
    );
  });

  it("treats zero-signal archetypes as insufficient_data, not 0%", async () => {
    const report = await analyzeImagePromptQuality(deps({}));
    for (const a of report.archetypes) {
      expect(a.status).toBe("insufficient_data");
      expect(a.likeRate).toBeNull();
    }
    expect(report.underperformers).toEqual([]);
  });

  it("includes a human-readable recommendation on each underperformer", async () => {
    const report = await analyzeImagePromptQuality(deps({ A: { like: 1, skip: 19 } }));
    const a = report.underperformers[0];
    expect(typeof a.recommendation).toBe("string");
    expect(a.recommendation.length).toBeGreaterThan(0);
  });
});
