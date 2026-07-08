import {
  BRAND_BUILD_TIMEOUT_MS,
  BRAND_BUILD_HARD_TIMEOUT_MS,
  buildAutoFailPatchIfStuck,
  buildFailedPatch,
  buildReadyPatch,
  buildStartPatch,
  logCompletionMetric,
  snapshot,
} from "../services/brandBuildStatusService";

describe("brandBuildStatusService", () => {
  const now = new Date("2026-04-24T12:00:00.000Z");

  describe("buildStartPatch", () => {
    it("returns building status and resets completion fields", () => {
      const patch = buildStartPatch(now);
      expect(patch.brandBuildStatus).toBe("building");
      expect(patch.brandBuildStartedAt).toBe("2026-04-24T12:00:00.000Z");
      expect(patch.brandBuildCompletedAt).toBeUndefined();
      expect(patch.brandBuildDurationMs).toBeUndefined();
      expect(patch.brandBuildError).toBeUndefined();
    });
  });

  describe("buildReadyPatch", () => {
    it("returns null when the user is not currently building", () => {
      // FAIL case #1: attempting to complete when no build is in flight.
      expect(buildReadyPatch({ brandBuildStatus: "ready" }, now)).toBeNull();
      expect(buildReadyPatch({ brandBuildStatus: "failed" }, now)).toBeNull();
      expect(buildReadyPatch({}, now)).toBeNull();
    });

    it("computes a positive duration from startedAt to now", () => {
      const startedAt = new Date("2026-04-24T11:59:30.000Z"); // 30s before now
      const patch = buildReadyPatch(
        {
          brandBuildStatus: "building",
          brandBuildStartedAt: startedAt.toISOString(),
        },
        now
      );
      expect(patch).not.toBeNull();
      expect(patch!.brandBuildStatus).toBe("ready");
      expect(patch!.brandBuildCompletedAt).toBe("2026-04-24T12:00:00.000Z");
      expect(patch!.brandBuildDurationMs).toBe(30_000);
      expect(patch!.brandBuildError).toBeUndefined();
    });

    it("coerces negative clock skew to 0 ms (never reports negative duration)", () => {
      // FAIL case #2: system clock moves backward between start and complete.
      const future = new Date("2026-04-24T12:01:00.000Z");
      const patch = buildReadyPatch(
        {
          brandBuildStatus: "building",
          brandBuildStartedAt: future.toISOString(),
        },
        now
      );
      expect(patch!.brandBuildDurationMs).toBe(0);
    });

    it("defaults duration to 0 when startedAt is missing or invalid", () => {
      // FAIL case #3: race condition where `building` was set without a startedAt.
      const patch = buildReadyPatch(
        { brandBuildStatus: "building", brandBuildStartedAt: "not-a-date" },
        now
      );
      expect(patch!.brandBuildDurationMs).toBe(0);
    });
  });

  describe("buildFailedPatch", () => {
    it("marks status failed and records the error with duration", () => {
      const startedAt = new Date("2026-04-24T11:58:30.000Z"); // 90s ago
      const patch = buildFailedPatch(
        {
          brandBuildStatus: "building",
          brandBuildStartedAt: startedAt.toISOString(),
        },
        "llm timeout",
        now
      );
      expect(patch.brandBuildStatus).toBe("failed");
      expect(patch.brandBuildError).toBe("llm timeout");
      expect(patch.brandBuildDurationMs).toBe(90_000);
      expect(patch.brandBuildCompletedAt).toBe("2026-04-24T12:00:00.000Z");
    });

    it("falls back to a default message on empty input and caps error at 512 chars", () => {
      // FAIL case: pathological inputs should not blow up the DynamoDB item
      // size or surface an empty error string to the UI.
      const huge = "x".repeat(2000);
      const patch1 = buildFailedPatch({ brandBuildStatus: "building" }, "", now);
      expect(patch1.brandBuildError).toBe("brand build failed");

      const patch2 = buildFailedPatch({ brandBuildStatus: "building" }, huge, now);
      expect(patch2.brandBuildError!.length).toBe(512);
    });

    it("allows failing from any state (not just building)", () => {
      // A watchdog that detects a stuck job must be able to flip ready→failed
      // without needing the exact prior state.
      expect(
        buildFailedPatch({ brandBuildStatus: "ready" }, "stale", now)
          .brandBuildStatus
      ).toBe("failed");
      expect(buildFailedPatch({}, "never started", now).brandBuildStatus).toBe(
        "failed"
      );
    });
  });

  describe("snapshot", () => {
    it("marks inFlight and not timedOut for a fresh building state", () => {
      const snap = snapshot(
        {
          brandBuildStatus: "building",
          brandBuildStartedAt: "2026-04-24T11:59:55.000Z", // 5s ago
        },
        now
      );
      expect(snap.inFlight).toBe(true);
      expect(snap.timedOut).toBe(false);
    });

    it("flips timedOut=true once age exceeds BRAND_BUILD_TIMEOUT_MS", () => {
      const tooOld = new Date(now.getTime() - BRAND_BUILD_TIMEOUT_MS - 1);
      const snap = snapshot(
        {
          brandBuildStatus: "building",
          brandBuildStartedAt: tooOld.toISOString(),
        },
        now
      );
      expect(snap.inFlight).toBe(true);
      expect(snap.timedOut).toBe(true);
    });

    it("is not timedOut for non-building statuses regardless of age", () => {
      // FAIL case: previously-ready builds that happen to be old must not be
      // classified as timed out — that would make the UI re-show the warning.
      const veryOld = new Date(now.getTime() - 10 * BRAND_BUILD_TIMEOUT_MS);
      const snap = snapshot(
        {
          brandBuildStatus: "ready",
          brandBuildStartedAt: veryOld.toISOString(),
          brandBuildCompletedAt: veryOld.toISOString(),
        },
        now
      );
      expect(snap.inFlight).toBe(false);
      expect(snap.timedOut).toBe(false);
    });
  });

  describe("timeout budgets", () => {
    it("aligns the status/UI budget with the 300s server session wall (was a stale 90s)", () => {
      // The server-side Emma brand-build session budget
      // (onboardingBrandBuildService.BRAND_BUILD_TIMEOUT_MS) is 300s. The
      // status-service budget used to derive `timedOut` MUST NOT be shorter,
      // or a legitimately-in-flight build (p95 ≈ 5m) is reported as timed out
      // while the server is still working.
      expect(BRAND_BUILD_TIMEOUT_MS).toBe(300_000);
    });

    it("sets the hard watchdog wall above the server budget so the server's own failure wins the race", () => {
      expect(BRAND_BUILD_HARD_TIMEOUT_MS).toBeGreaterThan(BRAND_BUILD_TIMEOUT_MS);
    });
  });

  describe("buildAutoFailPatchIfStuck", () => {
    it("returns null for a build that is within the hard timeout budget", () => {
      // FAIL case: a fresh in-flight build must never be auto-failed.
      const startedAt = new Date(now.getTime() - 10_000); // 10s ago
      expect(
        buildAutoFailPatchIfStuck(
          {
            brandBuildStatus: "building",
            brandBuildStartedAt: startedAt.toISOString(),
          },
          now
        )
      ).toBeNull();
    });

    it("returns null for non-building statuses regardless of age", () => {
      // A ready/failed build is already terminal — the watchdog must ignore it.
      const veryOld = new Date(now.getTime() - 100 * BRAND_BUILD_HARD_TIMEOUT_MS);
      expect(
        buildAutoFailPatchIfStuck(
          { brandBuildStatus: "ready", brandBuildStartedAt: veryOld.toISOString() },
          now
        )
      ).toBeNull();
      expect(
        buildAutoFailPatchIfStuck(
          { brandBuildStatus: "failed", brandBuildStartedAt: veryOld.toISOString() },
          now
        )
      ).toBeNull();
      expect(buildAutoFailPatchIfStuck({}, now)).toBeNull();
    });

    it("returns null when a building record has no valid startedAt (cannot age it)", () => {
      expect(
        buildAutoFailPatchIfStuck(
          { brandBuildStatus: "building", brandBuildStartedAt: "not-a-date" },
          now
        )
      ).toBeNull();
    });

    it("auto-fails a build stuck in 'building' past the hard timeout so the UI shows a retry, not a silent spinner", () => {
      // SUCCESS case + the 70-day stuck-user case (brand_submitted): a build
      // whose background job was lost stays 'building' forever. The watchdog
      // must convert it to a terminal 'failed' with a user-visible message.
      const stuck = new Date(now.getTime() - BRAND_BUILD_HARD_TIMEOUT_MS - 1);
      const patch = buildAutoFailPatchIfStuck(
        {
          brandBuildStatus: "building",
          brandBuildStartedAt: stuck.toISOString(),
        },
        now
      );
      expect(patch).not.toBeNull();
      expect(patch!.brandBuildStatus).toBe("failed");
      expect(patch!.brandBuildError).toMatch(/timed out/i);
      expect(patch!.brandBuildCompletedAt).toBe("2026-04-24T12:00:00.000Z");
    });

    it("auto-fails a 70-day stuck build (matches the stuck brand_submitted users)", () => {
      const seventyDaysAgo = new Date(now.getTime() - 70 * 24 * 60 * 60 * 1000);
      const patch = buildAutoFailPatchIfStuck(
        {
          brandBuildStatus: "building",
          brandBuildStartedAt: seventyDaysAgo.toISOString(),
        },
        now
      );
      expect(patch).not.toBeNull();
      expect(patch!.brandBuildStatus).toBe("failed");
    });
  });

  describe("logCompletionMetric", () => {
    let spy: jest.SpyInstance;
    let captured: unknown[][];
    beforeEach(() => {
      captured = [];
      spy = jest.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
        captured.push(args);
      });
    });
    afterEach(() => {
      spy.mockRestore();
    });

    it("emits a grep-able structured log line", () => {
      logCompletionMetric("abcdefghi-long-user-id", "ready", 42_000);
      expect(captured.length).toBe(1);
      const line = captured[0][0] as string;
      expect(line).toMatch(
        /^\[metrics\] brand_build_complete status=ready duration_ms=42000 user=abcdefgh$/
      );
    });

    it("truncates the user id in the log and handles missing ids", () => {
      logCompletionMetric("", "failed", 1000);
      const line = captured[0][0] as string;
      expect(line).toContain("user=anon");
      expect(line).toContain("status=failed");
    });
  });
});
