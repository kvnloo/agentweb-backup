import {
  deriveOnboardingStage,
  isOnboardingStage,
  ALL_ONBOARDING_STAGES,
  ALLOWED_ONBOARDING_EVENTS,
  OnboardingEvent,
} from "../onboardingStage";

describe("deriveOnboardingStage", () => {
  const now = new Date("2026-04-18T12:00:00.000Z");

  it("returns signed_up_no_start for an empty event log", () => {
    expect(deriveOnboardingStage([], { now })).toBe("signed_up_no_start");
  });

  it("returns signed_up_no_start when events is undefined", () => {
    expect(deriveOnboardingStage(undefined, { now })).toBe(
      "signed_up_no_start",
    );
  });

  it("returns goal_selected when only a goal has been chosen", () => {
    const events: OnboardingEvent[] = [
      { event: "goal_selected", ts: "2026-04-18T11:00:00Z", data: { goal: "paid_ads" } },
    ];
    expect(deriveOnboardingStage(events, { now })).toBe("goal_selected");
  });

  it("returns brand_skipped when brand was explicitly skipped", () => {
    const events: OnboardingEvent[] = [
      { event: "goal_selected", ts: "2026-04-18T11:00:00Z" },
      { event: "brand_skipped", ts: "2026-04-18T11:01:00Z" },
    ];
    expect(deriveOnboardingStage(events, { now })).toBe("brand_skipped");
  });

  it("returns brand_submitted when brand was filled in (overrides a prior skip)", () => {
    const events: OnboardingEvent[] = [
      { event: "goal_selected", ts: "2026-04-18T11:00:00Z" },
      { event: "brand_skipped", ts: "2026-04-18T11:01:00Z" },
      { event: "brand_submitted", ts: "2026-04-18T11:02:00Z", data: { companyName: "Acme" } },
    ];
    expect(deriveOnboardingStage(events, { now })).toBe("brand_submitted");
  });

  it("returns data_connected once a data source is connected", () => {
    const events: OnboardingEvent[] = [
      { event: "goal_selected", ts: "2026-04-18T11:00:00Z" },
      { event: "brand_submitted", ts: "2026-04-18T11:01:00Z" },
      { event: "data_connected", ts: "2026-04-18T11:02:00Z", data: { source: "fathom" } },
    ];
    expect(deriveOnboardingStage(events, { now })).toBe("data_connected");
  });

  it("returns channel_connected once a channel is hooked up", () => {
    const events: OnboardingEvent[] = [
      { event: "goal_selected", ts: "2026-04-18T11:00:00Z" },
      { event: "brand_submitted", ts: "2026-04-18T11:01:00Z" },
      { event: "data_connected", ts: "2026-04-18T11:02:00Z" },
      { event: "channel_connected", ts: "2026-04-18T11:03:00Z" },
    ];
    expect(deriveOnboardingStage(events, { now })).toBe("channel_connected");
  });

  it("returns onboarding_completed when flow is finished and no activity known", () => {
    const events: OnboardingEvent[] = [
      { event: "goal_selected", ts: "2026-04-18T11:00:00Z" },
      { event: "onboarding_completed", ts: "2026-04-18T11:05:00Z" },
    ];
    expect(deriveOnboardingStage(events, { now })).toBe("onboarding_completed");
  });

  it("returns active when flow is finished and user was recently active", () => {
    const events: OnboardingEvent[] = [
      { event: "onboarding_completed", ts: "2026-04-10T00:00:00Z" },
    ];
    expect(
      deriveOnboardingStage(events, {
        now,
        lastActiveAt: "2026-04-18T11:00:00Z",
      }),
    ).toBe("active");
  });

  it("returns stale when flow is finished but no activity in 30+ days", () => {
    const events: OnboardingEvent[] = [
      { event: "onboarding_completed", ts: "2026-02-01T00:00:00Z" },
    ];
    expect(
      deriveOnboardingStage(events, {
        now,
        // 2026-04-18 minus 45 days
        lastActiveAt: "2026-03-04T00:00:00Z",
      }),
    ).toBe("stale");
  });

  it("prefers onboarding_completed over a prior goal_selected even when events are in reverse order", () => {
    const events: OnboardingEvent[] = [
      { event: "onboarding_completed", ts: "2026-04-18T11:05:00Z" },
      { event: "goal_selected", ts: "2026-04-18T11:00:00Z" },
    ];
    expect(deriveOnboardingStage(events, { now })).toBe("onboarding_completed");
  });

  it("treats an unknown standalone event like 'onboarding_skipped' as signed_up_no_start", () => {
    const events: OnboardingEvent[] = [
      { event: "onboarding_skipped", ts: "2026-04-18T11:00:00Z" },
    ];
    expect(deriveOnboardingStage(events, { now })).toBe("signed_up_no_start");
  });

  it("ignores a malformed lastActiveAt gracefully", () => {
    const events: OnboardingEvent[] = [
      { event: "onboarding_completed", ts: "2026-04-18T11:05:00Z" },
    ];
    expect(
      deriveOnboardingStage(events, { now, lastActiveAt: "not-a-date" }),
    ).toBe("onboarding_completed");
  });
});

describe("isOnboardingStage", () => {
  it("accepts every canonical stage", () => {
    for (const s of ALL_ONBOARDING_STAGES) {
      expect(isOnboardingStage(s)).toBe(true);
    }
  });

  it("rejects unknown strings", () => {
    expect(isOnboardingStage("totally_not_a_stage")).toBe(false);
    expect(isOnboardingStage("")).toBe(false);
  });

  it("rejects non-string inputs", () => {
    expect(isOnboardingStage(undefined)).toBe(false);
    expect(isOnboardingStage(null)).toBe(false);
    expect(isOnboardingStage(42)).toBe(false);
    expect(isOnboardingStage({})).toBe(false);
  });
});

describe("ALLOWED_ONBOARDING_EVENTS", () => {
  it("includes every event name emitted by OnboardingV2.tsx (Phase 1 + Phase 2)", () => {
    // If this list changes, the frontend must change too (see OnboardingV2.tsx).
    const expected = [
      // Phase 1 — PR #568
      "goal_selected",
      "brand_submitted",
      "brand_skipped",
      "data_connected",
      "data_skipped",
      "channel_connected",
      "onboarding_completed",
      "onboarding_skipped",
      // Phase 2 — Onboarding v2 analytics
      "channel_selected",
      "channels_skipped",
      "icp_selected",
      "value_prop_edited",
      "ads_generated",
      "ads_regenerated",
      "welcome_offer_shown",
      "welcome_offer_outcome",
      "brand_build_status",
      "onboarding_abandoned",
      "deviation",
    ];
    for (const name of expected) {
      expect(ALLOWED_ONBOARDING_EVENTS.has(name)).toBe(true);
    }
  });

  it("allows the manual brand-fallback event so the recovery modal's telemetry is not dropped", () => {
    // The graceful brand-build failure modal (ManualBrandFallback) emits
    // this when a user supplies a manual brand description. Without it the
    // POST /onboarding/events call 400s and we lose the signal for how often
    // brand-build failures push users onto the manual path.
    expect(ALLOWED_ONBOARDING_EVENTS.has("brand_fallback_manual")).toBe(true);
  });

  it("rejects made-up event names — allowlist is strict", () => {
    expect(ALLOWED_ONBOARDING_EVENTS.has("totally_made_up")).toBe(false);
    expect(ALLOWED_ONBOARDING_EVENTS.has("")).toBe(false);
  });
});
