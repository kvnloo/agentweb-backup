// Mock services/db BEFORE importing the SUT so the lazy `require` inside
// markOnboardingCompletedIfTerminal hits this stub.
jest.mock("../../services/db", () => ({
  userDb: {
    getUserById: jest.fn(),
    updateUser: jest.fn(),
  },
}));

import {
  deriveOnboardingStage,
  isOnboardingStage,
  ALL_ONBOARDING_STAGES,
  ALLOWED_ONBOARDING_EVENTS,
  markOnboardingCompletedIfTerminal,
  OnboardingEvent,
} from "../onboardingStage";

const { userDb } = require("../../services/db");

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

  it("rejects made-up event names — allowlist is strict", () => {
    expect(ALLOWED_ONBOARDING_EVENTS.has("totally_made_up")).toBe(false);
    expect(ALLOWED_ONBOARDING_EVENTS.has("")).toBe(false);
  });
});

describe("markOnboardingCompletedIfTerminal", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  const ALL_READY = {
    brandBuildStatus: "ready",
    icpStatus: "ready",
    competitorStatus: "ready",
    creativeDirStatus: "ready",
    adImageStatus: "ready",
    adCopyStatus: "ready",
  };

  it("happy path: all 6 steps ready, stage advances to onboarding_completed", async () => {
    userDb.getUserById.mockResolvedValue({
      userId: "u1",
      ...ALL_READY,
      onboardingStage: "brand_submitted",
      onboardingEvents: [
        { event: "goal_selected", ts: "2026-04-28T11:00:00Z" },
        { event: "brand_submitted", ts: "2026-04-28T11:01:00Z" },
      ],
    });
    await markOnboardingCompletedIfTerminal("u1");
    expect(userDb.updateUser).toHaveBeenCalledTimes(1);
    const [calledUserId, patch] = userDb.updateUser.mock.calls[0];
    expect(calledUserId).toBe("u1");
    expect(patch.onboardingStage).toBe("onboarding_completed");
    expect(patch.onboardingEvents.length).toBe(3);
    expect(patch.onboardingEvents[2].event).toBe("onboarding_completed");
    // The synthetic event has the right shape — event name, ISO ts, source tag.
    const synthetic = patch.onboardingEvents[2];
    expect(typeof synthetic.ts).toBe("string");
    expect(Number.isFinite(Date.parse(synthetic.ts))).toBe(true);
    expect(synthetic.data?.source).toBe("backend:auto_terminal_backfill");
  });

  it("no-op when all 6 steps ready but stage is already onboarding_completed", async () => {
    userDb.getUserById.mockResolvedValue({
      userId: "u1",
      ...ALL_READY,
      onboardingStage: "onboarding_completed",
      onboardingEvents: [{ event: "onboarding_completed", ts: "2026-04-28T11:00:00Z" }],
    });
    await markOnboardingCompletedIfTerminal("u1");
    expect(userDb.updateUser).not.toHaveBeenCalled();
  });

  it("no-op when stage is `active` (past onboarding_completed)", async () => {
    userDb.getUserById.mockResolvedValue({
      userId: "u1",
      ...ALL_READY,
      onboardingStage: "active",
      onboardingEvents: [],
    });
    await markOnboardingCompletedIfTerminal("u1");
    expect(userDb.updateUser).not.toHaveBeenCalled();
  });

  it("no-op when stage is `stale`", async () => {
    userDb.getUserById.mockResolvedValue({
      userId: "u1",
      ...ALL_READY,
      onboardingStage: "stale",
      onboardingEvents: [],
    });
    await markOnboardingCompletedIfTerminal("u1");
    expect(userDb.updateUser).not.toHaveBeenCalled();
  });

  it("no-op when one step status is not ready", async () => {
    userDb.getUserById.mockResolvedValue({
      userId: "u1",
      ...ALL_READY,
      adCopyStatus: "running",
      onboardingStage: "brand_submitted",
      onboardingEvents: [],
    });
    await markOnboardingCompletedIfTerminal("u1");
    expect(userDb.updateUser).not.toHaveBeenCalled();
  });

  it("no-op when a step status is missing", async () => {
    const partial = { ...ALL_READY };
    delete (partial as any).adImageStatus;
    userDb.getUserById.mockResolvedValue({
      userId: "u1",
      ...partial,
      onboardingStage: "brand_submitted",
      onboardingEvents: [],
    });
    await markOnboardingCompletedIfTerminal("u1");
    expect(userDb.updateUser).not.toHaveBeenCalled();
  });

  it("no throw when user not found", async () => {
    userDb.getUserById.mockResolvedValue(undefined);
    await expect(markOnboardingCompletedIfTerminal("u1")).resolves.toBeUndefined();
    expect(userDb.updateUser).not.toHaveBeenCalled();
  });

  it("no throw when getUserById rejects", async () => {
    userDb.getUserById.mockRejectedValue(new Error("ddb timeout"));
    await expect(markOnboardingCompletedIfTerminal("u1")).resolves.toBeUndefined();
    expect(userDb.updateUser).not.toHaveBeenCalled();
  });

  it("no-op for empty/invalid userId", async () => {
    await markOnboardingCompletedIfTerminal("");
    await markOnboardingCompletedIfTerminal(undefined as any);
    await markOnboardingCompletedIfTerminal(null as any);
    expect(userDb.getUserById).not.toHaveBeenCalled();
    expect(userDb.updateUser).not.toHaveBeenCalled();
  });

  it("handles missing onboardingEvents (treats as empty array)", async () => {
    userDb.getUserById.mockResolvedValue({
      userId: "u1",
      ...ALL_READY,
      onboardingStage: "brand_submitted",
      // no onboardingEvents field
    });
    await markOnboardingCompletedIfTerminal("u1");
    expect(userDb.updateUser).toHaveBeenCalledTimes(1);
    const patch = userDb.updateUser.mock.calls[0][1];
    expect(patch.onboardingStage).toBe("onboarding_completed");
    expect(patch.onboardingEvents.length).toBe(1);
    expect(patch.onboardingEvents[0].event).toBe("onboarding_completed");
  });

  it("caps the event log at 50 entries (FIFO drop)", async () => {
    const events: OnboardingEvent[] = Array.from({ length: 60 }, (_, i) => ({
      event: "goal_selected",
      ts: new Date(2026, 0, 1, i).toISOString(),
    }));
    userDb.getUserById.mockResolvedValue({
      userId: "u1",
      ...ALL_READY,
      onboardingStage: "brand_submitted",
      onboardingEvents: events,
    });
    await markOnboardingCompletedIfTerminal("u1");
    const patch = userDb.updateUser.mock.calls[0][1];
    expect(patch.onboardingEvents.length).toBe(50);
    // Last entry is the synthetic one we just appended.
    expect(patch.onboardingEvents[49].event).toBe("onboarding_completed");
  });

  it("swallows updateUser errors silently (best-effort backfill)", async () => {
    userDb.getUserById.mockResolvedValue({
      userId: "u1",
      ...ALL_READY,
      onboardingStage: "brand_submitted",
      onboardingEvents: [],
    });
    userDb.updateUser.mockRejectedValue(new Error("ddb write failed"));
    await expect(markOnboardingCompletedIfTerminal("u1")).resolves.toBeUndefined();
  });
});
