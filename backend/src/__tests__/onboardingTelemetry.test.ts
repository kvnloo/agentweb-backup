/**
 * WS2: onboarding reliability telemetry. Image-generation and brand-scrape
 * lifecycle events flow into the same loops framework (Dev-AW-LoopEvents,
 * onboarding loop) as the rest of the system, so failures cluster + surface
 * on the loop health endpoint with a semantic errorClass.
 *
 * Mocks fireLoopEvent so we assert the emitted (loopId, event) shape without
 * touching DynamoDB.
 */

jest.mock("../services/loopEventsEmitter", () => ({
  fireLoopEvent: jest.fn().mockResolvedValue(undefined),
}));

import {
  ONBOARDING_TELEMETRY_EVENTS,
  recordOnboardingEvent,
  recordOnboardingFailure,
} from "../services/onboardingTelemetry";
const { fireLoopEvent } = require("../services/loopEventsEmitter");
const { ONBOARDING_LOOP_ID } = require("../loops/instances/onboarding/manifest");

beforeEach(() => jest.clearAllMocks());

describe("recordOnboardingEvent", () => {
  it("fires a NormalizedEvent on the onboarding loop with subjectId + dimensions", async () => {
    await recordOnboardingEvent("user-1", ONBOARDING_TELEMETRY_EVENTS.imageGenStarted, {
      variantCount: 3,
    });
    expect(fireLoopEvent).toHaveBeenCalledTimes(1);
    const [loopId, event] = fireLoopEvent.mock.calls[0];
    expect(loopId).toBe(ONBOARDING_LOOP_ID);
    expect(event.subjectId).toBe("user-1");
    expect(event.eventType).toBe("image_generation_started");
    expect(event.ts instanceof Date).toBe(true);
    expect(event.dimensions).toMatchObject({ variantCount: 3 });
  });

  it("never throws even if the emitter rejects (best-effort telemetry)", async () => {
    fireLoopEvent.mockRejectedValueOnce(new Error("ddb down"));
    await expect(
      recordOnboardingEvent("user-1", ONBOARDING_TELEMETRY_EVENTS.imageGenCompleted),
    ).resolves.toBeUndefined();
  });
});

describe("recordOnboardingFailure", () => {
  it("injects a semantic errorClass + truncated errorMessage", async () => {
    await recordOnboardingFailure(
      "user-1",
      ONBOARDING_TELEMETRY_EVENTS.imageGenFailed,
      new Error("Request timed out after 180000ms"),
      { variantCount: 3 },
    );
    const [, event] = fireLoopEvent.mock.calls[0];
    expect(event.eventType).toBe("image_generation_failed");
    expect(event.dimensions.errorClass).toBe("timeout");
    expect(event.dimensions.errorMessage).toContain("timed out");
    expect(event.dimensions.variantCount).toBe(3);
  });

  it("classifies auth failures distinctly", async () => {
    await recordOnboardingFailure(
      "user-1",
      ONBOARDING_TELEMETRY_EVENTS.brandScrapeFailed,
      new Error("401 Unauthorized: invalid api key"),
    );
    const [, event] = fireLoopEvent.mock.calls[0];
    expect(event.dimensions.errorClass).toBe("auth");
  });

  it("handles non-Error throwables", async () => {
    await recordOnboardingFailure("user-1", ONBOARDING_TELEMETRY_EVENTS.brandScrapeFailed, "boom");
    const [, event] = fireLoopEvent.mock.calls[0];
    expect(typeof event.dimensions.errorClass).toBe("string");
    expect(event.dimensions.errorMessage).toBe("boom");
  });
});
