import {
  COMPETITOR_TIMEOUT_MS,
  CompetitorPerICP,
  competitorFailedPatch,
  competitorReadyPatch,
  competitorSnapshot,
  competitorStartPatch,
  logCompetitorCompletionMetric,
  sanitizeCompetitorResult,
  MAX_COMPETITOR_ICPS,
} from "../services/competitorStatusService";

const perICP = (i: number): CompetitorPerICP => ({
  icp_id: `icp-${i}`,
  competitor_names: [`comp-${i}-a`, `comp-${i}-b`],
  offer_angles: [`angle-${i}-1`, `angle-${i}-2`],
  meta_targeting_brief: `brief-${i}`,
});

describe("competitorStatusService", () => {
  const now = new Date("2026-04-24T12:00:00.000Z");

  describe("competitorStartPatch", () => {
    it("returns running and resets fields", () => {
      const patch = competitorStartPatch(now);
      expect(patch.competitorStatus).toBe("running");
      expect(patch.competitorStartedAt).toBe("2026-04-24T12:00:00.000Z");
      expect(patch.competitorResult).toBeUndefined();
      expect(patch.competitorError).toBeUndefined();
    });
  });

  describe("competitorReadyPatch", () => {
    it("returns null when not running (FAIL #1)", () => {
      const result = { per_icp: [perICP(1)] };
      expect(competitorReadyPatch({ competitorStatus: "ready" }, result, now)).toBeNull();
      expect(competitorReadyPatch({ competitorStatus: "failed" }, result, now)).toBeNull();
      expect(competitorReadyPatch({ competitorStatus: "idle" }, result, now)).toBeNull();
      expect(competitorReadyPatch({}, result, now)).toBeNull();
    });

    it("computes duration and attaches sanitized result", () => {
      const startedAt = new Date("2026-04-24T11:59:00.000Z"); // 60s ago
      const patch = competitorReadyPatch(
        { competitorStatus: "running", competitorStartedAt: startedAt.toISOString() },
        { per_icp: [perICP(1), perICP(2)] },
        now
      );
      expect(patch).not.toBeNull();
      expect(patch!.competitorStatus).toBe("ready");
      expect(patch!.competitorDurationMs).toBe(60_000);
      expect(patch!.competitorResult!.per_icp).toHaveLength(2);
      expect(patch!.competitorResult!.per_icp[0].icp_id).toBe("icp-1");
    });

    it("coerces negative skew to 0 (FAIL #2)", () => {
      const future = new Date("2026-04-24T12:01:00.000Z");
      const patch = competitorReadyPatch(
        { competitorStatus: "running", competitorStartedAt: future.toISOString() },
        { per_icp: [perICP(1)] },
        now
      );
      expect(patch!.competitorDurationMs).toBe(0);
    });
  });

  describe("competitorFailedPatch", () => {
    it("marks failed with error", () => {
      const startedAt = new Date("2026-04-24T11:58:00.000Z");
      const patch = competitorFailedPatch(
        { competitorStatus: "running", competitorStartedAt: startedAt.toISOString() },
        "search api down",
        now
      );
      expect(patch.competitorStatus).toBe("failed");
      expect(patch.competitorError).toBe("search api down");
      expect(patch.competitorDurationMs).toBe(120_000);
    });

    it("falls back to default + caps error", () => {
      const huge = "x".repeat(2000);
      expect(competitorFailedPatch({ competitorStatus: "running" }, "", now).competitorError).toBe(
        "competitor research failed"
      );
      expect(
        competitorFailedPatch({ competitorStatus: "running" }, huge, now).competitorError!.length
      ).toBe(512);
    });
  });

  describe("competitorSnapshot", () => {
    it("inFlight + not timedOut for fresh", () => {
      const snap = competitorSnapshot(
        { competitorStatus: "running", competitorStartedAt: "2026-04-24T11:59:55.000Z" },
        now
      );
      expect(snap.inFlight).toBe(true);
      expect(snap.timedOut).toBe(false);
    });

    it("timedOut once age exceeds budget", () => {
      const tooOld = new Date(now.getTime() - COMPETITOR_TIMEOUT_MS - 1);
      const snap = competitorSnapshot(
        { competitorStatus: "running", competitorStartedAt: tooOld.toISOString() },
        now
      );
      expect(snap.timedOut).toBe(true);
    });
  });

  describe("sanitizeCompetitorResult", () => {
    it("returns empty per_icp for non-objects / non-array per_icp", () => {
      expect(sanitizeCompetitorResult(null).per_icp).toEqual([]);
      expect(sanitizeCompetitorResult("nope").per_icp).toEqual([]);
      expect(sanitizeCompetitorResult({ per_icp: "not array" }).per_icp).toEqual([]);
    });

    it("drops malformed entries and caps array", () => {
      const raw = {
        per_icp: [
          perICP(1),
          { competitor_names: ["x"] }, // missing icp_id
          null,
          ...Array.from({ length: 10 }, (_, i) => perICP(i + 2)),
        ],
      };
      const out = sanitizeCompetitorResult(raw);
      expect(out.per_icp.length).toBe(MAX_COMPETITOR_ICPS);
      expect(out.per_icp[0].icp_id).toBe("icp-1");
    });

    it("truncates strings and caps inner arrays", () => {
      const huge = "x".repeat(5000);
      const out = sanitizeCompetitorResult({
        per_icp: [
          {
            icp_id: huge,
            competitor_names: Array.from({ length: 50 }, () => huge),
            offer_angles: Array.from({ length: 50 }, () => huge),
            meta_targeting_brief: huge,
          },
        ],
      });
      expect(out.per_icp[0].icp_id.length).toBeLessThanOrEqual(64);
      expect(out.per_icp[0].competitor_names.length).toBeLessThanOrEqual(10);
      expect(out.per_icp[0].offer_angles.length).toBeLessThanOrEqual(10);
      expect(out.per_icp[0].meta_targeting_brief.length).toBeLessThanOrEqual(2000);
      expect(out.per_icp[0].competitor_names[0].length).toBeLessThanOrEqual(200);
    });
  });

  describe("logCompetitorCompletionMetric", () => {
    it("emits structured log line", () => {
      const captured: unknown[][] = [];
      const spy = jest
        .spyOn(console, "log")
        .mockImplementation((...args) => captured.push(args));
      logCompetitorCompletionMetric("user-id-12345", "ready", 90_000, 3);
      const line = captured[0][0] as string;
      expect(line).toMatch(
        /^\[metrics\] competitor_complete status=ready duration_ms=90000 icps=3 user=user-id-$/
      );
      spy.mockRestore();
    });
  });
});
