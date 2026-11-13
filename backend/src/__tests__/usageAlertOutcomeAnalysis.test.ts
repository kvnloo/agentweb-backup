import { analyzeUsageAlertOutcomes, parseTelemetryLine } from "../services/usageAlertOutcomeAnalysis";
import { USAGE_TELEMETRY_VERSION } from "../services/llmUsageTelemetry";

const line = (event: string, billingUserId: string, ts: string, extra: Record<string, unknown> = {}) =>
  `2026-11-01 web: [usageTelemetry] ${JSON.stringify({ event, ...extra, billingUserId, telemetryVersion: USAGE_TELEMETRY_VERSION, ts })}`;

describe("usageAlertOutcomeAnalysis (ENG-2947)", () => {
  it("AC1: counts non-telemetry, malformed and unknown-version lines without throwing", () => {
    const r = analyzeUsageAlertOutcomes([
      "random EB noise",
      "",
      "[usageTelemetry] {not json",
      `[usageTelemetry] ${JSON.stringify({ event: "runway_alert_shown", billingUserId: "u", telemetryVersion: "old-v0", ts: "2026-11-01T00:00:00Z" })}`,
      line("runway_alert_shown", "u1", "2026-11-01T00:00:00Z"),
    ]);
    expect(r.skipped).toEqual({ nonTelemetry: 2, malformed: 1, unknownVersion: 1 });
    expect(r.eventsParsed).toBe(1);
    expect(parseTelemetryLine("[usageTelemetry] []")).toEqual({ ok: false, reason: "malformed" });
  });

  it("AC2+AC3: per-subject off-track time, alert, strongest outcome, 7-day switches", () => {
    const r = analyzeUsageAlertOutcomes([
      line("runway_forecast_computed", "a", "2026-11-01T00:00:00Z", { onTrack: true }),
      line("runway_forecast_computed", "a", "2026-11-02T00:00:00Z", { onTrack: false }),
      line("runway_alert_shown", "a", "2026-11-02T01:00:00Z"),
      line("runway_alert_see_options", "a", "2026-11-02T01:01:00Z"),
      line("runway_alert_upgrade", "a", "2026-11-02T01:02:00Z"),
      line("runway_change_applied", "a", "2026-11-05T00:00:00Z"),
      line("runway_change_applied", "a", "2026-11-12T00:00:00Z"),
      line("runway_alert_shown", "b", "2026-11-03T00:00:00Z"),
      line("runway_alert_shown", "b", "2026-11-04T00:00:00Z"),
      line("runway_alert_dismissed", "b", "2026-11-04T00:01:00Z"),
      line("runway_alert_shown", "c", "2026-11-03T00:00:00Z"),
      line("runway_forecast_computed", "d", "2026-11-03T00:00:00Z", { onTrack: true }),
    ]);
    const by = Object.fromEntries(r.subjects.map((s) => [s.billingUserId, s]));
    expect(by.a).toEqual({
      billingUserId: "a",
      firstOffTrackAt: "2026-11-02T00:00:00.000Z",
      alertShown: true,
      firstAlertAt: "2026-11-02T01:00:00.000Z",
      outcome: "upgrade",
      modelSwitchesWithin7d: 1,
    });
    expect(by.b.outcome).toBe("dismissed");
    expect(by.c.outcome).toBe("none");
    expect(by.d).toMatchObject({ alertShown: false, firstOffTrackAt: null, outcome: "none" });
    expect(r.aggregates.subjectsWithAlert).toBe(3);
    expect(r.aggregates.alertShownCount).toBe(4);
    expect(r.aggregates.ctaConversionRates.upgrade).toBeCloseTo(1 / 3);
    expect(r.aggregates.ctaConversionRates.dismissed).toBeCloseTo(1 / 3);
    expect(r.aggregates.ctaConversionRates.book_call).toBe(0);
    expect(r.aggregates.modelSwitchesWithin7dAfterFirstAlert).toBe(1);
    expect(r.aggregates.subjectsSwitchedWithin7d).toBe(1);
  });

  it("AC4: money dimensions on input never reach the output", () => {
    const r = analyzeUsageAlertOutcomes([
      line("runway_alert_shown", "a", "2026-11-02T01:00:00Z", { costMicroUsd: 4_000_000, priceUsd: 9 }),
    ]);
    expect(JSON.stringify(r)).not.toMatch(/microusd|usd|cost|price/i);
  });

  it("zero alerts yields zero rates, not NaN", () => {
    const r = analyzeUsageAlertOutcomes([]);
    expect(r.aggregates.ctaConversionRates.upgrade).toBe(0);
  });
});
