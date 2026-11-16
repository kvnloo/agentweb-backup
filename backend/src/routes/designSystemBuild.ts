/**
 * Design-system build status — ENG-328 mandatory onboarding step.
 *
 * Thin REST layer over `designSystemStatusService`, structurally identical
 * to `brandBuild.ts`. The onboarding UI calls
 * `POST /api/onboarding/design-system/start` when it lands on the
 * buildingDesignSystem screen, then polls
 * `GET /api/onboarding/design-system/status` to drive the status pill.
 *
 * Endpoints
 *   POST /api/onboarding/design-system/start   — mark running, fire the scrape
 *   GET  /api/onboarding/design-system/status  — read snapshot (+ watchdog)
 */

import express from "express";
import { authenticateToken, AuthenticatedRequest } from "../middleware/auth";
import { userDb } from "../services/db";
import { readUserForOwnership } from "../utils/readUserForOwnership";
import {
  buildAutoFailPatchIfStuck,
  buildFailedPatch,
  buildStartPatch,
  snapshot,
} from "../services/designSystemStatusService";
import { triggerDesignSystemBuildForUser } from "../services/onboardingDesignSystemService";

const router = express.Router();

/**
 * Guards the idle/failed -> running transition with a DynamoDB
 * ConditionExpression (CodeRabbit/Greptile finding, ENG-328) — the plain
 * read-then-write below it replaced let two concurrent /start requests both
 * observe a non-in-flight status and both win, launching two scrapes and
 * creating two Knowledge Base tasks. userDb.updateUser already supports
 * conditional writes for exactly this class of race (see
 * userDb.updateUser.condition.test.ts, ENG-792's ad-image axis); this uses
 * the same primitive to make the claim atomic instead of adding new
 * machinery. Distinct alias names avoid colliding with the update's own
 * `#designSystem` placeholder (see userDb.updateUser's name-merging).
 */
const START_CLAIM_CONDITION = {
  expression:
    "attribute_not_exists(#dsGuard) OR (#dsGuard.#dsGuardStatus <> :dsGuardRunning AND #dsGuard.#dsGuardStatus <> :dsGuardReady)",
  names: { "#dsGuard": "designSystem", "#dsGuardStatus": "status" },
  values: { ":dsGuardRunning": "running", ":dsGuardReady": "ready" },
};

/**
 * POST /api/onboarding/design-system/start
 *
 * (1) Flips designSystem.status to "running". (2) Fires the scrape in the
 * background. Returns the running snapshot immediately so the UI can poll
 * /status. Idempotent — a second call while already running/ready is a no-op
 * (mirrors brand-build's prefetch-then-canonical-call double-trigger).
 */
router.post("/design-system/start", authenticateToken, async (req, res) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.user?.userId;
    if (!userId) {
      return res.status(401).json({ message: "User not authenticated" });
    }

    const existing = await readUserForOwnership(userId);
    const existingStatus = (existing as any)?.designSystem?.status;
    const alreadyInFlight = existingStatus === "running" || existingStatus === "ready";
    if (alreadyInFlight) {
      return res.json({ status: snapshot((existing as any)?.designSystem) });
    }

    const patch = buildStartPatch((existing as any)?.designSystem);
    try {
      await userDb.updateUser(userId, patch as any, { condition: START_CLAIM_CONDITION });
    } catch (err: any) {
      if (err?.code === "ConditionalCheckFailedException") {
        // Lost the race — another concurrent /start already claimed it.
        const current = await readUserForOwnership(userId);
        return res.json({ status: snapshot((current as any)?.designSystem) });
      }
      throw err;
    }

    // Fire-and-forget background work; route returns immediately so the UI
    // can poll /status without holding an HTTP connection open.
    void triggerDesignSystemBuildForUser(userId).catch((e) => {
      console.error("[designSystemBuild] background trigger crashed", e);
    });

    // The snapshot of the claim just written, not a read-back: the index can
    // still show the previous (failed) state, which would tell the UI to stop.
    return res.json({ status: snapshot(patch.designSystem) });
  } catch (err) {
    console.error("[designSystemBuild] start failed", err);
    return res.status(500).json({ message: "Failed to start design system build" });
  }
});

/**
 * GET /api/onboarding/design-system/status
 * Returns the caller's current design-system build snapshot.
 */
router.get("/design-system/status", authenticateToken, async (req, res) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.user?.userId;
    if (!userId) {
      return res.status(401).json({ message: "User not authenticated" });
    }
    const user = await readUserForOwnership(userId);
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    // Watchdog: a build orphaned by a lost fire-and-forget job stays
    // `running` forever, leaving the UI on an infinite spinner. Force-fail
    // any build past the hard wall on read (mirrors brandBuild.ts's watchdog,
    // minus its strongly-consistent-reread race guard — this scrape is
    // deterministic and single-shot with no equivalent GSI-lag risk to guard
    // against: nothing else concurrently flips this field to 'ready').
    const autoFail = buildAutoFailPatchIfStuck((user as any).designSystem);
    if (autoFail) {
      await userDb.updateUser(userId, autoFail as any);
      const refreshed = await readUserForOwnership(userId);
      return res.json({ status: snapshot((refreshed as any)?.designSystem ?? autoFail.designSystem) });
    }

    return res.json({ status: snapshot((user as any).designSystem) });
  } catch (err) {
    console.error("[designSystemBuild] status failed", err);
    return res.status(500).json({ message: "Failed to read design system build status" });
  }
});

/**
 * POST /api/onboarding/design-system/fail
 * Marks the caller's design-system build as failed. Called by the UI when
 * the client-side poll exceeds its timeout budget.
 *
 * Body: { error?: string }
 */
router.post("/design-system/fail", authenticateToken, async (req, res) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.user?.userId;
    if (!userId) {
      return res.status(401).json({ message: "User not authenticated" });
    }
    const errorMsg = typeof req.body?.error === "string" ? req.body.error : "design system build timed out";
    const user = await readUserForOwnership(userId);
    const patch = buildFailedPatch((user as any)?.designSystem, errorMsg);
    await userDb.updateUser(userId, patch as any);
    const updated = await readUserForOwnership(userId);
    return res.json({ status: snapshot((updated as any)?.designSystem ?? patch.designSystem) });
  } catch (err) {
    console.error("[designSystemBuild] fail failed", err);
    return res.status(500).json({ message: "Failed to mark design system build failed" });
  }
});

export default router;
