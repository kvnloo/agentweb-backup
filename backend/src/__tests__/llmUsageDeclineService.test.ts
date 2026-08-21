/**
 * ENG-1210 AC12 — the `declined` third of "recommendation shown/accepted/declined".
 *
 * `shown` (runway_recommendation_shown) and `accepted` (runway_change_applied) have been
 * emitted since the drivers resolver landed. `declined` has never had an event, because
 * until now a decline had no observable moment: the runway panel offers "Preview this
 * change" and a "Keep <model> — ..." SPAN. Nothing to click means nothing to record.
 *
 * So the shape of this service follows what is actually observable rather than what would
 * be convenient. It records a decline the customer PERFORMED, carries a `reason` naming
 * which gesture it was, and refuses to invent one. A customer who was shown a
 * recommendation and simply never engaged produces no event here — that inference needs a
 * queryable store to join `shown` against `applied` over time, which
 * `llmUsageTelemetry.ts` already documents as deferred and data-plane-gated.
 *
 * Tests first (CLAUDE.md Rule 2): the failure paths, then the happy path.
 */

import {
  recordRecommendationDeclined,
  DECLINE_REASONS,
} from "../services/llmUsageDeclineService";
import {
  USAGE_TELEMETRY_EVENTS,
  __setUsageTelemetrySinkForTests,
} from "../services/llmUsageTelemetry";

jest.mock("../services/llmUsagePolicyResolverService", () => ({
  getEffectiveLlmUsagePolicy: jest.fn(),
}));
const { getEffectiveLlmUsagePolicy } = jest.requireMock(
  "../services/llmUsagePolicyResolverService",
);

type Emitted = { event: string; dimensions: Record<string, unknown> };
let emitted: Emitted[] = [];

beforeEach(() => {
  emitted = [];
  __setUsageTelemetrySinkForTests((event, dimensions) => {
    emitted.push({ event, dimensions });
  });
  getEffectiveLlmUsagePolicy.mockResolvedValue({ billingUserId: "root-1", policy: {} });
});

afterEach(() => {
  __setUsageTelemetrySinkForTests(null);
  jest.clearAllMocks();
});

describe("recordRecommendationDeclined — refusals", () => {
  it("FAIL: rejects a selection whose models are not both strings", async () => {
    await expect(
      recordRecommendationDeclined("u1", {
        reason: DECLINE_REASONS.removedFromPreview,
        selections: [{ fromModel: "a", toModel: 5 as unknown as string }],
      }),
    ).rejects.toThrow(/fromModel.*toModel|must be/i);
    expect(emitted).toHaveLength(0);
  });

  it("FAIL: rejects an unknown reason rather than recording an uninterpretable one", async () => {
    // A free-text reason would make the funnel unqueryable the moment a caller
    // invented a synonym, and "declined" is only useful if every row means the
    // same thing.
    await expect(
      recordRecommendationDeclined("u1", {
        reason: "user_seemed_unhappy" as never,
        selections: [{ fromModel: "a", toModel: "b" }],
      }),
    ).rejects.toThrow(/reason/i);
    expect(emitted).toHaveLength(0);
  });

  it("FAIL: rejects an empty selection list — a decline of nothing is not a decline", async () => {
    await expect(
      recordRecommendationDeclined("u1", {
        reason: DECLINE_REASONS.previewCleared,
        selections: [],
      }),
    ).rejects.toThrow(/at least one/i);
    expect(emitted).toHaveLength(0);
  });

  it("FAIL: emits nothing when the account has no usage policy", async () => {
    // No ceiling means no runway, so there was no recommendation to decline. Recording
    // one would put rows in the funnel that never had a `shown` counterpart.
    getEffectiveLlmUsagePolicy.mockResolvedValue({ billingUserId: "root-1", policy: null });
    const result = await recordRecommendationDeclined("u1", {
      reason: DECLINE_REASONS.previewCleared,
      selections: [{ fromModel: "a", toModel: "b" }],
    });
    expect(result.recorded).toBe(0);
    expect(emitted).toHaveLength(0);
  });
});

describe("recordRecommendationDeclined — recording", () => {
  it("SUCCESS: emits one declined event per selection, keyed to the billing user", async () => {
    const result = await recordRecommendationDeclined("member-9", {
      reason: DECLINE_REASONS.previewCleared,
      selections: [
        { fromModel: "anthropic.claude-opus-5", toModel: "gemini-3.7-flash" },
        { fromModel: "gpt-5.4", toModel: "gemini-3.7-flash" },
      ],
    });

    expect(result.recorded).toBe(2);
    expect(emitted).toHaveLength(2);
    expect(emitted.every((e) => e.event === USAGE_TELEMETRY_EVENTS.recommendationDeclined)).toBe(
      true,
    );
    // Billing user, not the acting member — the funnel is per paying account, the
    // same key `shown` and `applied` already use.
    expect(emitted[0].dimensions.billingUserId).toBe("root-1");
    expect(emitted[0].dimensions).toMatchObject({
      fromModel: "anthropic.claude-opus-5",
      toModel: "gemini-3.7-flash",
      reason: DECLINE_REASONS.previewCleared,
    });
  });

  it("carries the estimate the customer was SHOWN, never a recomputed one", async () => {
    await recordRecommendationDeclined("u1", {
      reason: DECLINE_REASONS.removedFromPreview,
      selections: [
        { fromModel: "a", toModel: "b", estimatedDaysRecovered: 4, confidence: "low" },
      ],
    });
    expect(emitted[0].dimensions).toMatchObject({
      estimatedDaysRecoveredAtDecision: 4,
      confidenceAtDecision: "low",
    });
  });

  it("never ships internal economics, even when a caller spreads a whole recommendation", async () => {
    await recordRecommendationDeclined("u1", {
      reason: DECLINE_REASONS.previewCleared,
      selections: [
        {
          fromModel: "a",
          toModel: "b",
          // A caller passing the raw recommendation object is the mistake the
          // redactor exists for.
          estimatedSavingsMicroUsd: 12_345_678,
        } as never,
      ],
    });
    const serialised = JSON.stringify(emitted);
    expect(serialised).not.toMatch(/MicroUsd/);
    expect(serialised).not.toMatch(/12345678/);
  });

  it("bounds the number of selections so one request cannot emit unboundedly", async () => {
    const many = Array.from({ length: 50 }, (_, i) => ({ fromModel: `m${i}`, toModel: "b" }));
    const result = await recordRecommendationDeclined("u1", {
      reason: DECLINE_REASONS.previewCleared,
      selections: many,
    });
    expect(result.recorded).toBe(20);
    expect(emitted).toHaveLength(20);
  });

  it("a telemetry failure never propagates to the caller", async () => {
    __setUsageTelemetrySinkForTests(() => {
      throw new Error("sink exploded");
    });
    await expect(
      recordRecommendationDeclined("u1", {
        reason: DECLINE_REASONS.previewCleared,
        selections: [{ fromModel: "a", toModel: "b" }],
      }),
    ).resolves.toMatchObject({ recorded: 1 });
  });
});
