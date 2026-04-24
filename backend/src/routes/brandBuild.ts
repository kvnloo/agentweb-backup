/**
 * Brand build status — Onboarding v2 Phase 1.
 *
 * Thin REST layer over `brandBuildStatusService`. The onboarding UI calls
 * `POST /api/onboarding/brand-build/start` when the user submits the brand
 * screen, then polls `GET /api/onboarding/brand-build/status` every few
 * seconds to drive the status pill and the graceful-fallback UX.
 *
 * The actual brand extraction is still performed by the existing chat /
 * agent-mode pipeline. This route does NOT kick off a new LLM call — it
 * only manages the status state machine. The brand write-path hooks
 * (brand.ts and agentModeService.ts) call `markBrandBuildReady` when
 * `brandGuidelines` lands on the User record.
 *
 * Endpoints
 *   POST /api/onboarding/brand-build/start   — mark building
 *   GET  /api/onboarding/brand-build/status  — read snapshot
 *   POST /api/onboarding/brand-build/fail    — mark failed (UI-side timeout)
 */

import express from "express";
import { authenticateToken, AuthenticatedRequest } from "../middleware/auth";
import { userDb } from "../services/db";
import {
  buildFailedPatch,
  buildStartPatch,
  logCompletionMetric,
  snapshot,
} from "../services/brandBuildStatusService";

const router = express.Router();

/**
 * POST /api/onboarding/brand-build/start
 * Marks the caller's brand build as in-flight. Idempotent — repeated calls
 * reset the clock (user retrying from the UI).
 */
router.post("/brand-build/start", authenticateToken, async (req, res) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.user?.userId;
    if (!userId) {
      return res.status(401).json({ message: "User not authenticated" });
    }
    const patch = buildStartPatch();
    await userDb.updateUser(userId, patch);
    const user = await userDb.getUserById(userId);
    return res.json({ status: snapshot(user || patch) });
  } catch (err) {
    console.error("[brandBuild] start failed", err);
    return res.status(500).json({ message: "Failed to start brand build" });
  }
});

/**
 * GET /api/onboarding/brand-build/status
 * Returns the caller's current brand build snapshot.
 */
router.get("/brand-build/status", authenticateToken, async (req, res) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.user?.userId;
    if (!userId) {
      return res.status(401).json({ message: "User not authenticated" });
    }
    const user = await userDb.getUserById(userId);
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }
    return res.json({ status: snapshot(user) });
  } catch (err) {
    console.error("[brandBuild] status failed", err);
    return res.status(500).json({ message: "Failed to read brand build status" });
  }
});

/**
 * POST /api/onboarding/brand-build/fail
 * Marks the caller's brand build as failed. The UI calls this when the
 * client-side poll exceeds the timeout budget so the graceful-fallback
 * manual brand input is rendered. Also called server-side by the brand
 * write-path hooks when the underlying chat session errors.
 *
 * Body: { error?: string }
 */
router.post("/brand-build/fail", authenticateToken, async (req, res) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.user?.userId;
    if (!userId) {
      return res.status(401).json({ message: "User not authenticated" });
    }
    const errorMsg =
      typeof req.body?.error === "string" ? req.body.error : "brand build timed out";
    const user = await userDb.getUserById(userId);
    const patch = buildFailedPatch(user || {}, errorMsg);
    await userDb.updateUser(userId, patch);
    logCompletionMetric(userId, "failed", patch.brandBuildDurationMs ?? 0);
    const updated = await userDb.getUserById(userId);
    return res.json({ status: snapshot(updated || patch) });
  } catch (err) {
    console.error("[brandBuild] fail failed", err);
    return res.status(500).json({ message: "Failed to mark brand build failed" });
  }
});

export default router;
