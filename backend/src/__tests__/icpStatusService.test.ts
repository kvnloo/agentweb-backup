import {
  ICP_TIMEOUT_MS,
  ICPPersona,
  icpFailedPatch,
  icpReadyPatch,
  icpSnapshot,
  icpStartPatch,
  logICPCompletionMetric,
  sanitizeICPPersonas,
  MAX_ICP_PERSONAS,
} from "../services/icpStatusService";

const persona = (i: number): ICPPersona => ({
  name: `Persona ${i}`,
  pain: `pain ${i}`,
  desire: `desire ${i}`,
  objection: `objection ${i}`,
  meta_targeting_brief: `brief ${i}`,
});

describe("icpStatusService", () => {
  const now = new Date("2026-04-24T12:00:00.000Z");

  describe("icpStartPatch", () => {
    it("returns running status and resets completion fields", () => {
      const patch = icpStartPatch(now);
      expect(patch.icpStatus).toBe("running");
      expect(patch.icpStartedAt).toBe("2026-04-24T12:00:00.000Z");
      expect(patch.icpCompletedAt).toBeUndefined();
      expect(patch.icpDurationMs).toBeUndefined();
      expect(patch.icpError).toBeUndefined();
      expect(patch.icpResult).toBeUndefined();
    });
  });

  describe("icpReadyPatch", () => {
    it("returns null when user is not currently running (FAIL #1)", () => {
      // Cannot complete when no run is in flight.
      expect(icpReadyPatch({ icpStatus: "ready" }, [persona(1)], now)).toBeNull();
      expect(icpReadyPatch({ icpStatus: "failed" }, [persona(1)], now)).toBeNull();
      expect(icpReadyPatch({ icpStatus: "idle" }, [persona(1)], now)).toBeNull();
      expect(icpReadyPatch({}, [persona(1)], now)).toBeNull();
    });

    it("computes duration from startedAt to now and attaches personas", () => {
      const startedAt = new Date("2026-04-24T11:59:30.000Z"); // 30s ago
      const personas = [persona(1), persona(2), persona(3), persona(4), persona(5)];
      const patch = icpReadyPatch(
        { icpStatus: "running", icpStartedAt: startedAt.toISOString() },
        personas,
        now
      );
      expect(patch).not.toBeNull();
      expect(patch!.icpStatus).toBe("ready");
      expect(patch!.icpCompletedAt).toBe("2026-04-24T12:00:00.000Z");
      expect(patch!.icpDurationMs).toBe(30_000);
      expect(patch!.icpError).toBeUndefined();
      expect(patch!.icpResult).toHaveLength(5);
      expect(patch!.icpResult![0].name).toBe("Persona 1");
    });

    it("coerces negative clock skew to 0 ms (FAIL #2)", () => {
      const future = new Date("2026-04-24T12:01:00.000Z");
      const patch = icpReadyPatch(
        { icpStatus: "running", icpStartedAt: future.toISOString() },
        [persona(1)],
        now
      );
      expect(patch!.icpDurationMs).toBe(0);
    });

    it("defaults duration to 0 when startedAt is missing or invalid (FAIL #3)", () => {
      const patch = icpReadyPatch(
        { icpStatus: "running", icpStartedAt: "not-a-date" },
        [persona(1)],
        now
      );
      expect(patch!.icpDurationMs).toBe(0);
    });
  });

  describe("icpFailedPatch", () => {
    it("marks status failed and records error with duration", () => {
      const startedAt = new Date("2026-04-24T11:58:00.000Z"); // 120s ago
      const patch = icpFailedPatch(
        { icpStatus: "running", icpStartedAt: startedAt.toISOString() },
        "llm rate limit",
        now
      );
      expect(patch.icpStatus).toBe("failed");
      expect(patch.icpError).toBe("llm rate limit");
      expect(patch.icpDurationMs).toBe(120_000);
      expect(patch.icpCompletedAt).toBe("2026-04-24T12:00:00.000Z");
    });

    it("falls back to default message on empty input and caps error at 512 chars", () => {
      const huge = "x".repeat(2000);
      const patch1 = icpFailedPatch({ icpStatus: "running" }, "", now);
      expect(patch1.icpError).toBe("icp generation failed");

      const patch2 = icpFailedPatch({ icpStatus: "running" }, huge, now);
      expect(patch2.icpError!.length).toBe(512);
    });

    it("allows failing from any state", () => {
      expect(icpFailedPatch({ icpStatus: "ready" }, "stale", now).icpStatus).toBe(
        "failed"
      );
      expect(icpFailedPatch({}, "never started", now).icpStatus).toBe("failed");
    });
  });

  describe("icpSnapshot", () => {
    it("marks inFlight and not timedOut for a fresh running state", () => {
      const snap = icpSnapshot(
        { icpStatus: "running", icpStartedAt: "2026-04-24T11:59:55.000Z" },
        now
      );
      expect(snap.inFlight).toBe(true);
      expect(snap.timedOut).toBe(false);
    });

    it("flips timedOut=true once age exceeds ICP_TIMEOUT_MS", () => {
      const tooOld = new Date(now.getTime() - ICP_TIMEOUT_MS - 1);
      const snap = icpSnapshot(
        { icpStatus: "running", icpStartedAt: tooOld.toISOString() },
        now
      );
      expect(snap.inFlight).toBe(true);
      expect(snap.timedOut).toBe(true);
    });

    it("is not timedOut for non-running statuses regardless of age", () => {
      const veryOld = new Date(now.getTime() - 10 * ICP_TIMEOUT_MS);
      const snap = icpSnapshot(
        {
          icpStatus: "ready",
          icpStartedAt: veryOld.toISOString(),
          icpCompletedAt: veryOld.toISOString(),
        },
        now
      );
      expect(snap.inFlight).toBe(false);
      expect(snap.timedOut).toBe(false);
    });
  });

  describe("sanitizeICPPersonas", () => {
    it("rejects non-array inputs", () => {
      expect(sanitizeICPPersonas(null as any)).toEqual([]);
      expect(sanitizeICPPersonas(undefined as any)).toEqual([]);
      expect(sanitizeICPPersonas("nope" as any)).toEqual([]);
      expect(sanitizeICPPersonas({ not: "array" } as any)).toEqual([]);
    });

    it("drops malformed entries missing required fields", () => {
      const raw = [
        persona(1),
        { name: "missing fields" },
        null,
        { pain: "no name" },
      ];
      const out = sanitizeICPPersonas(raw as any);
      expect(out).toHaveLength(1);
      expect(out[0].name).toBe("Persona 1");
    });

    it("caps the array at MAX_ICP_PERSONAS entries", () => {
      const many = Array.from({ length: 10 }, (_, i) => persona(i));
      const out = sanitizeICPPersonas(many);
      expect(out.length).toBe(MAX_ICP_PERSONAS);
      expect(MAX_ICP_PERSONAS).toBe(5);
    });

    it("truncates overlong string fields to bounded lengths", () => {
      const huge = "x".repeat(5000);
      const out = sanitizeICPPersonas([
        {
          name: huge,
          pain: huge,
          desire: huge,
          objection: huge,
          meta_targeting_brief: huge,
        },
      ]);
      expect(out[0].name.length).toBeLessThanOrEqual(200);
      expect(out[0].pain.length).toBeLessThanOrEqual(1000);
      expect(out[0].desire.length).toBeLessThanOrEqual(1000);
      expect(out[0].objection.length).toBeLessThanOrEqual(1000);
      expect(out[0].meta_targeting_brief.length).toBeLessThanOrEqual(2000);
    });
  });

  describe("logICPCompletionMetric", () => {
    let spy: jest.SpyInstance;
    let captured: unknown[][];
    beforeEach(() => {
      captured = [];
      spy = jest
        .spyOn(console, "log")
        .mockImplementation((...args: unknown[]) => {
          captured.push(args);
        });
    });
    afterEach(() => {
      spy.mockRestore();
    });

    it("emits a grep-able structured log line", () => {
      logICPCompletionMetric("abcdefghi-long-user-id", "ready", 58_000, 5);
      expect(captured.length).toBe(1);
      const line = captured[0][0] as string;
      expect(line).toMatch(
        /^\[metrics\] icp_complete status=ready duration_ms=58000 personas=5 user=abcdefgh$/
      );
    });

    it("truncates user id and handles missing ids", () => {
      logICPCompletionMetric("", "failed", 1000, 0);
      const line = captured[0][0] as string;
      expect(line).toContain("user=anon");
      expect(line).toContain("status=failed");
      expect(line).toContain("personas=0");
    });
  });
});
