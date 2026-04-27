import {
  AD_GEN_TIMEOUT_MS,
  adGenFailedPatch,
  adGenReadyPatch,
  adGenStartPatch,
  logAdGenCompletionMetric,
  adGenSnapshot,
  sanitizeAdVariants,
  MAX_AD_VARIANTS,
} from "../services/adGenStatusService";

describe("adGenStatusService", () => {
  const now = new Date("2026-04-24T12:00:00.000Z");

  describe("adGenStartPatch", () => {
    it("returns generating status and resets completion fields", () => {
      const patch = adGenStartPatch(now);
      expect(patch.adGenStatus).toBe("generating");
      expect(patch.adGenStartedAt).toBe("2026-04-24T12:00:00.000Z");
      expect(patch.adGenCompletedAt).toBeUndefined();
      expect(patch.adGenDurationMs).toBeUndefined();
      expect(patch.adGenError).toBeUndefined();
      expect(patch.adGenVariants).toBeUndefined();
    });
  });

  describe("adGenReadyPatch", () => {
    it("returns null when user is not currently generating", () => {
      // FAIL case #1: cannot complete when no generation is in flight.
      expect(
        adGenReadyPatch({ adGenStatus: "ready" }, [{ id: "v1", headline: "h", primaryText: "p", cta: "Learn more" }], now)
      ).toBeNull();
      expect(
        adGenReadyPatch({ adGenStatus: "failed" }, [{ id: "v1", headline: "h", primaryText: "p", cta: "Learn more" }], now)
      ).toBeNull();
      expect(
        adGenReadyPatch({}, [{ id: "v1", headline: "h", primaryText: "p", cta: "Learn more" }], now)
      ).toBeNull();
    });

    it("computes a positive duration from startedAt to now and attaches variants", () => {
      const startedAt = new Date("2026-04-24T11:59:15.000Z"); // 45s before now
      const variants = [
        { id: "v1", headline: "Hit your Q4 number", primaryText: "Stop guessing.", cta: "Learn more" },
        { id: "v2", headline: "Pipeline for founders", primaryText: "Built for you.", cta: "Sign up" },
        { id: "v3", headline: "10 leads a week", primaryText: "No ops needed.", cta: "Get started" },
      ];
      const patch = adGenReadyPatch(
        {
          adGenStatus: "generating",
          adGenStartedAt: startedAt.toISOString(),
        },
        variants,
        now
      );
      expect(patch).not.toBeNull();
      expect(patch!.adGenStatus).toBe("ready");
      expect(patch!.adGenCompletedAt).toBe("2026-04-24T12:00:00.000Z");
      expect(patch!.adGenDurationMs).toBe(45_000);
      expect(patch!.adGenError).toBeUndefined();
      expect(patch!.adGenVariants).toHaveLength(3);
      expect(patch!.adGenVariants![0].id).toBe("v1");
    });

    it("coerces negative clock skew to 0 ms", () => {
      // FAIL case #2: clock moves backward between start and complete.
      const future = new Date("2026-04-24T12:01:00.000Z");
      const patch = adGenReadyPatch(
        {
          adGenStatus: "generating",
          adGenStartedAt: future.toISOString(),
        },
        [{ id: "v1", headline: "h", primaryText: "p", cta: "c" }],
        now
      );
      expect(patch!.adGenDurationMs).toBe(0);
    });

    it("defaults duration to 0 when startedAt is missing or invalid", () => {
      // FAIL case #3: race — `generating` set without startedAt.
      const patch = adGenReadyPatch(
        { adGenStatus: "generating", adGenStartedAt: "not-a-date" },
        [{ id: "v1", headline: "h", primaryText: "p", cta: "c" }],
        now
      );
      expect(patch!.adGenDurationMs).toBe(0);
    });
  });

  describe("adGenFailedPatch", () => {
    it("marks status failed and records error with duration", () => {
      const startedAt = new Date("2026-04-24T11:58:00.000Z"); // 120s ago
      const patch = adGenFailedPatch(
        {
          adGenStatus: "generating",
          adGenStartedAt: startedAt.toISOString(),
        },
        "llm rate limit",
        now
      );
      expect(patch.adGenStatus).toBe("failed");
      expect(patch.adGenError).toBe("llm rate limit");
      expect(patch.adGenDurationMs).toBe(120_000);
      expect(patch.adGenCompletedAt).toBe("2026-04-24T12:00:00.000Z");
    });

    it("falls back to default message on empty input and caps error at 512 chars", () => {
      const huge = "x".repeat(2000);
      const patch1 = adGenFailedPatch({ adGenStatus: "generating" }, "", now);
      expect(patch1.adGenError).toBe("ad generation failed");

      const patch2 = adGenFailedPatch({ adGenStatus: "generating" }, huge, now);
      expect(patch2.adGenError!.length).toBe(512);
    });

    it("allows failing from any state (not just generating)", () => {
      expect(
        adGenFailedPatch({ adGenStatus: "ready" }, "stale", now).adGenStatus
      ).toBe("failed");
      expect(adGenFailedPatch({}, "never started", now).adGenStatus).toBe(
        "failed"
      );
    });
  });

  describe("adGenSnapshot", () => {
    it("marks inFlight and not timedOut for a fresh generating state", () => {
      const snap = adGenSnapshot(
        {
          adGenStatus: "generating",
          adGenStartedAt: "2026-04-24T11:59:55.000Z", // 5s ago
        },
        now
      );
      expect(snap.inFlight).toBe(true);
      expect(snap.timedOut).toBe(false);
    });

    it("flips timedOut=true once age exceeds AD_GEN_TIMEOUT_MS", () => {
      const tooOld = new Date(now.getTime() - AD_GEN_TIMEOUT_MS - 1);
      const snap = adGenSnapshot(
        {
          adGenStatus: "generating",
          adGenStartedAt: tooOld.toISOString(),
        },
        now
      );
      expect(snap.inFlight).toBe(true);
      expect(snap.timedOut).toBe(true);
    });

    it("is not timedOut for non-generating statuses regardless of age", () => {
      const veryOld = new Date(now.getTime() - 10 * AD_GEN_TIMEOUT_MS);
      const snap = adGenSnapshot(
        {
          adGenStatus: "ready",
          adGenStartedAt: veryOld.toISOString(),
          adGenCompletedAt: veryOld.toISOString(),
        },
        now
      );
      expect(snap.inFlight).toBe(false);
      expect(snap.timedOut).toBe(false);
    });
  });

  describe("sanitizeAdVariants", () => {
    it("rejects non-array inputs and returns an empty array", () => {
      expect(sanitizeAdVariants(null as any)).toEqual([]);
      expect(sanitizeAdVariants(undefined as any)).toEqual([]);
      expect(sanitizeAdVariants("nope" as any)).toEqual([]);
      expect(sanitizeAdVariants({ not: "an array" } as any)).toEqual([]);
    });

    it("drops malformed entries missing required fields", () => {
      const raw = [
        { id: "v1", headline: "H", primaryText: "P", cta: "C" },
        { id: "v2" }, // missing body
        null,
        { headline: "no-id", primaryText: "P", cta: "C" }, // missing id
      ];
      const out = sanitizeAdVariants(raw as any);
      expect(out).toHaveLength(1);
      expect(out[0].id).toBe("v1");
    });

    it("caps the array at MAX_AD_VARIANTS entries", () => {
      const many = Array.from({ length: 10 }, (_, i) => ({
        id: `v${i}`,
        headline: `H${i}`,
        primaryText: `P${i}`,
        cta: "Learn more",
      }));
      const out = sanitizeAdVariants(many);
      expect(out.length).toBe(MAX_AD_VARIANTS);
      expect(MAX_AD_VARIANTS).toBe(3);
    });

    it("truncates overlong string fields to bounded lengths", () => {
      // Keeps the DynamoDB item size bounded — same pattern as brandBuildError.
      const huge = "x".repeat(5000);
      const out = sanitizeAdVariants([
        {
          id: huge,
          headline: huge,
          primaryText: huge,
          cta: huge,
          imageUrl: huge,
        },
      ]);
      expect(out[0].id.length).toBeLessThanOrEqual(64);
      expect(out[0].headline.length).toBeLessThanOrEqual(200);
      expect(out[0].primaryText.length).toBeLessThanOrEqual(1000);
      expect(out[0].cta.length).toBeLessThanOrEqual(40);
      expect(out[0].imageUrl!.length).toBeLessThanOrEqual(1024);
    });

    it("preserves optional imageUrl when present", () => {
      const out = sanitizeAdVariants([
        {
          id: "v1",
          headline: "H",
          primaryText: "P",
          cta: "C",
          imageUrl: "https://example.com/img.png",
        },
      ]);
      expect(out[0].imageUrl).toBe("https://example.com/img.png");
    });
  });

  describe("logAdGenCompletionMetric", () => {
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
      logAdGenCompletionMetric("abcdefghi-long-user-id", "ready", 58_000, 3);
      expect(captured.length).toBe(1);
      const line = captured[0][0] as string;
      expect(line).toMatch(
        /^\[metrics\] ad_gen_complete status=ready duration_ms=58000 variants=3 user=abcdefgh$/
      );
    });

    it("truncates the user id in the log and handles missing ids", () => {
      logAdGenCompletionMetric("", "failed", 1000, 0);
      const line = captured[0][0] as string;
      expect(line).toContain("user=anon");
      expect(line).toContain("status=failed");
      expect(line).toContain("variants=0");
    });
  });
});
