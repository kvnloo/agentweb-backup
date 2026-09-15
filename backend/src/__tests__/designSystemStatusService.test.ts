/**
 * Design-system build status service tests (ENG-328).
 *
 * Pure state-transition logic — protects the mandatory-onboarding-gate
 * invariant: the acceptance criterion is "onboarding cannot complete without
 * design.md", enforced client-side via hasDesignSystem === (status ===
 * 'ready'). A regression here (e.g. a stuck 'running' that never resolves,
 * or a ready-patch that fires from the wrong state) directly breaks that
 * gate — either stranding users or letting the mandatory step silently
 * no-op.
 */

import {
  buildStartPatch,
  buildReadyPatch,
  buildFailedPatch,
  buildAutoFailPatchIfStuck,
  snapshot,
  DESIGN_SYSTEM_TIMEOUT_MS,
  DESIGN_SYSTEM_HARD_TIMEOUT_MS,
} from "../services/designSystemStatusService";

describe("designSystemStatusService", () => {
  describe("buildStartPatch", () => {
    it("flips to running and clears prior terminal fields", () => {
      const now = new Date("2026-01-01T00:00:00.000Z");
      const patch = buildStartPatch(now);
      expect(patch.designSystem.status).toBe("running");
      expect(patch.designSystem.startedAt).toBe(now.toISOString());
      expect(patch.designSystem.completedAt).toBeUndefined();
      expect(patch.designSystem.error).toBeUndefined();
    });
  });

  describe("buildReadyPatch", () => {
    it("returns null when the current state is not running (ignores stale completions)", () => {
      expect(buildReadyPatch(undefined, "scrape", "task-1")).toBeNull();
      expect(buildReadyPatch({ status: "idle" }, "scrape", "task-1")).toBeNull();
      expect(buildReadyPatch({ status: "ready" }, "scrape", "task-1")).toBeNull();
      expect(buildReadyPatch({ status: "failed" }, "scrape", "task-1")).toBeNull();
    });

    it("completes a running build with the kbTaskId and source", () => {
      const start = new Date("2026-01-01T00:00:00.000Z");
      const end = new Date("2026-01-01T00:00:05.000Z");
      const patch = buildReadyPatch(
        { status: "running", startedAt: start.toISOString() },
        "scrape",
        "task-42",
        end
      );
      expect(patch).not.toBeNull();
      expect(patch!.designSystem.status).toBe("ready");
      expect(patch!.designSystem.source).toBe("scrape");
      expect(patch!.designSystem.kbTaskId).toBe("task-42");
      expect(patch!.designSystem.durationMs).toBe(5000);
      expect(patch!.designSystem.error).toBeUndefined();
    });

    it("records manual_fallback as a distinct source from scrape", () => {
      const patch = buildReadyPatch(
        { status: "running", startedAt: new Date().toISOString() },
        "manual_fallback",
        "task-9"
      );
      expect(patch!.designSystem.source).toBe("manual_fallback");
    });
  });

  describe("buildFailedPatch", () => {
    it("is allowed from any state and preserves the prior kbTaskId", () => {
      const patch = buildFailedPatch({ status: "running", kbTaskId: "task-7" }, "boom");
      expect(patch.designSystem.status).toBe("failed");
      expect(patch.designSystem.error).toBe("boom");
      expect(patch.designSystem.kbTaskId).toBe("task-7");
    });

    it("caps the error message length", () => {
      const patch = buildFailedPatch(undefined, "x".repeat(1000));
      expect(patch.designSystem.error!.length).toBe(512);
    });
  });

  describe("buildAutoFailPatchIfStuck (watchdog)", () => {
    it("returns null when not running", () => {
      expect(buildAutoFailPatchIfStuck({ status: "ready" })).toBeNull();
      expect(buildAutoFailPatchIfStuck(undefined)).toBeNull();
    });

    it("returns null when running but within the hard timeout wall", () => {
      const now = new Date("2026-01-01T00:02:00.000Z");
      const startedAt = new Date(now.getTime() - (DESIGN_SYSTEM_HARD_TIMEOUT_MS - 1000)).toISOString();
      expect(buildAutoFailPatchIfStuck({ status: "running", startedAt }, now)).toBeNull();
    });

    it("force-fails a build stuck past the hard timeout wall", () => {
      const now = new Date("2026-01-01T01:00:00.000Z");
      const startedAt = new Date(now.getTime() - (DESIGN_SYSTEM_HARD_TIMEOUT_MS + 1000)).toISOString();
      const patch = buildAutoFailPatchIfStuck({ status: "running", startedAt }, now);
      expect(patch).not.toBeNull();
      expect(patch!.designSystem.status).toBe("failed");
      expect(patch!.designSystem.error).toMatch(/timed out/i);
    });
  });

  describe("snapshot", () => {
    it("defaults to idle/not-in-flight when designSystem was never set", () => {
      const s = snapshot(undefined);
      expect(s.status).toBe("idle");
      expect(s.inFlight).toBe(false);
      expect(s.timedOut).toBe(false);
    });

    it("reports inFlight while running and timedOut past the UI budget", () => {
      const now = new Date("2026-01-01T02:00:00.000Z");
      const startedAt = new Date(now.getTime() - (DESIGN_SYSTEM_TIMEOUT_MS + 1)).toISOString();
      const s = snapshot({ status: "running", startedAt }, now);
      expect(s.inFlight).toBe(true);
      expect(s.timedOut).toBe(true);
    });

    it("is never timedOut once terminal", () => {
      const now = new Date("2026-01-01T03:00:00.000Z");
      const startedAt = new Date(now.getTime() - (DESIGN_SYSTEM_TIMEOUT_MS + 100_000)).toISOString();
      const s = snapshot({ status: "ready", startedAt }, now);
      expect(s.inFlight).toBe(false);
      expect(s.timedOut).toBe(false);
    });
  });
});
