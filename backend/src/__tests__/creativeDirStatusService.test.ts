import {
  CREATIVE_DIR_TIMEOUT_MS,
  creativeDirFailedPatch,
  creativeDirReadyPatch,
  creativeDirSnapshot,
  creativeDirStartPatch,
  logCreativeDirCompletionMetric,
  sanitizeCreativeDirResult,
  MAX_CONCEPTS,
  MAX_COPY_ANGLES,
} from "../services/creativeDirStatusService";

describe("creativeDirStatusService", () => {
  const now = new Date("2026-04-24T12:00:00.000Z");

  it("startPatch returns running and resets fields", () => {
    const patch = creativeDirStartPatch(now);
    expect(patch.creativeDirStatus).toBe("running");
    expect(patch.creativeDirResult).toBeUndefined();
  });

  it("readyPatch returns null when not running (FAIL #1)", () => {
    const r = { concepts: ["c1"], copy_angles: ["a1"], format_archetypes: ["f1"] };
    expect(creativeDirReadyPatch({ creativeDirStatus: "ready" }, r, now)).toBeNull();
    expect(creativeDirReadyPatch({ creativeDirStatus: "idle" }, r, now)).toBeNull();
    expect(creativeDirReadyPatch({}, r, now)).toBeNull();
  });

  it("readyPatch attaches sanitized result and computes duration", () => {
    const startedAt = new Date("2026-04-24T11:59:30.000Z");
    const patch = creativeDirReadyPatch(
      { creativeDirStatus: "running", creativeDirStartedAt: startedAt.toISOString() },
      {
        concepts: Array.from({ length: 6 }, (_, i) => `c${i}`),
        copy_angles: Array.from({ length: 5 }, (_, i) => `a${i}`),
        format_archetypes: ["f1", "f2"],
      },
      now
    );
    expect(patch).not.toBeNull();
    expect(patch!.creativeDirStatus).toBe("ready");
    expect(patch!.creativeDirDurationMs).toBe(30_000);
    expect(patch!.creativeDirResult!.concepts).toHaveLength(6);
    expect(patch!.creativeDirResult!.copy_angles).toHaveLength(5);
  });

  it("readyPatch coerces negative skew to 0 (FAIL #2)", () => {
    const future = new Date("2026-04-24T12:01:00.000Z");
    const patch = creativeDirReadyPatch(
      { creativeDirStatus: "running", creativeDirStartedAt: future.toISOString() },
      { concepts: [], copy_angles: [], format_archetypes: [] },
      now
    );
    expect(patch!.creativeDirDurationMs).toBe(0);
  });

  it("failedPatch marks failed and caps error", () => {
    const huge = "x".repeat(2000);
    const patch = creativeDirFailedPatch({ creativeDirStatus: "running" }, huge, now);
    expect(patch.creativeDirStatus).toBe("failed");
    expect(patch.creativeDirError!.length).toBe(512);
  });

  it("failedPatch defaults message on empty input", () => {
    const patch = creativeDirFailedPatch({ creativeDirStatus: "running" }, "", now);
    expect(patch.creativeDirError).toBe("creative direction failed");
  });

  it("snapshot flips timedOut once age exceeds budget", () => {
    const tooOld = new Date(now.getTime() - CREATIVE_DIR_TIMEOUT_MS - 1);
    const snap = creativeDirSnapshot(
      { creativeDirStatus: "running", creativeDirStartedAt: tooOld.toISOString() },
      now
    );
    expect(snap.timedOut).toBe(true);
  });

  it("snapshot is not timedOut for non-running state", () => {
    const veryOld = new Date(now.getTime() - 10 * CREATIVE_DIR_TIMEOUT_MS);
    const snap = creativeDirSnapshot(
      { creativeDirStatus: "ready", creativeDirStartedAt: veryOld.toISOString() },
      now
    );
    expect(snap.timedOut).toBe(false);
  });

  it("sanitizeCreativeDirResult drops non-array fields and caps arrays", () => {
    expect(sanitizeCreativeDirResult(null)).toEqual({
      concepts: [],
      copy_angles: [],
      format_archetypes: [],
    });
    const out = sanitizeCreativeDirResult({
      concepts: Array.from({ length: 20 }, (_, i) => `c${i}`),
      copy_angles: Array.from({ length: 20 }, (_, i) => `a${i}`),
      format_archetypes: ["only string", 42, null, "another"],
    });
    expect(out.concepts.length).toBe(MAX_CONCEPTS);
    expect(out.copy_angles.length).toBe(MAX_COPY_ANGLES);
    expect(out.format_archetypes).toEqual(["only string", "another"]);
  });

  it("metric log line is grep-able", () => {
    const captured: unknown[][] = [];
    const spy = jest
      .spyOn(console, "log")
      .mockImplementation((...args) => captured.push(args));
    logCreativeDirCompletionMetric("xyz", "failed", 5_000, 6);
    expect(captured[0][0]).toMatch(
      /^\[metrics\] creative_dir_complete status=failed duration_ms=5000 concepts=6 user=xyz$/
    );
    spy.mockRestore();
  });
});
