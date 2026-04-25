/**
 * Ad generation status — Onboarding v2 Phase 4.
 *
 * Thin REST layer over `adGenStatusService`. The onboarding UI calls
 * `POST /api/onboarding/ad-gen/start` when the user transitions from
 * Phase 3 to Phase 4, then polls `GET /api/onboarding/ad-gen/status`
 * while the LLM runs the "B2B lead gen ad" work plan prompts. When the
 * generation settles (successfully or with a client-side timeout), the
 * UI POSTs to `/complete` or `/fail`.
 *
 * The actual ad-creative generation is performed by the work plan
 * pipeline (see phase task body: reuse the production "B2B lead gen ad"
 * work plan via GET /api/admin/work-plans). This route does NOT trigger
 * that generation — it only manages the status state machine and the
 * variant payload persisted back to the User record. Wiring the actual
 * work-plan invocation happens in a follow-up slice once Phase 3 (ICP +
 * value prop selection) is merged.
 *
 * Endpoints
 *   POST /api/onboarding/ad-gen/start     — mark generating
 *   GET  /api/onboarding/ad-gen/status    — read snapshot
 *   POST /api/onboarding/ad-gen/complete  — mark ready, persist variants
 *   POST /api/onboarding/ad-gen/fail      — mark failed (UI-side timeout)
 */

import express from "express";
import { authenticateToken, AuthenticatedRequest } from "../middleware/auth";
import { userDb } from "../services/db";
import {
  adGenFailedPatch,
  adGenReadyPatch,
  adGenSnapshot,
  adGenStartPatch,
  logAdGenCompletionMetric,
  sanitizeAdVariants,
} from "../services/adGenStatusService";

// NOTE: The legacy `onboardingAdGenerator` (single-shot 3-angle LLM call) is
// removed. The `/ad-gen/*` routes still exist for backward compatibility
// with any clients still polling them, but `/start` is now a pure status
// flip — the new per-step pipeline (`/creative-dir/start` →
// `/ad-image/start` → `/ad-copy/start`) drives ad generation.

const router = express.Router();

/**
 * POST /api/onboarding/ad-gen/start
 * Marks the caller's ad generation as in-flight. Idempotent.
 */
router.post("/ad-gen/start", authenticateToken, async (req, res) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.user?.userId;
    if (!userId) {
      return res.status(401).json({ message: "User not authenticated" });
    }
    // Pure status flip — the legacy single-shot LLM generator was removed.
    // Clients should migrate to the per-step pipeline (creative-dir →
    // ad-image → ad-copy). UI flows on the new pipeline call those
    // endpoints directly; this route remains so existing clients still see
    // a coherent state machine and can complete via `/ad-gen/complete`.
    await userDb.updateUser(userId, adGenStartPatch());
    const user = await userDb.getUserById(userId);
    return res.json({ status: adGenSnapshot(user || adGenStartPatch()) });
  } catch (err) {
    console.error("[adGen] start failed", err);
    return res.status(500).json({ message: "Failed to start ad generation" });
  }
});

/**
 * GET /api/onboarding/ad-gen/status
 * Returns the caller's current ad-gen snapshot (including persisted variants
 * on success).
 */
router.get("/ad-gen/status", authenticateToken, async (req, res) => {
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
    return res.json({ status: adGenSnapshot(user) });
  } catch (err) {
    console.error("[adGen] status failed", err);
    return res.status(500).json({ message: "Failed to read ad-gen status" });
  }
});

/**
 * POST /api/onboarding/ad-gen/complete
 * Marks the caller's ad generation as successfully completed and
 * persists the returned variants. Rejects with 409 if the user is not
 * currently `generating` (stale client retry).
 *
 * Body: { variants: AdVariant[] }
 */
router.post("/ad-gen/complete", authenticateToken, async (req, res) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.user?.userId;
    if (!userId) {
      return res.status(401).json({ message: "User not authenticated" });
    }
    const sanitized = sanitizeAdVariants(req.body?.variants);
    if (sanitized.length === 0) {
      return res
        .status(400)
        .json({ message: "variants must be a non-empty array of {id, headline, primaryText, cta}" });
    }
    const user = await userDb.getUserById(userId);
    const patch = adGenReadyPatch(user || {}, sanitized);
    if (!patch) {
      return res
        .status(409)
        .json({ message: "ad generation is not in flight — call /start first" });
    }
    await userDb.updateUser(userId, patch);
    logAdGenCompletionMetric(
      userId,
      "ready",
      patch.adGenDurationMs ?? 0,
      sanitized.length
    );
    const updated = await userDb.getUserById(userId);
    return res.json({ status: adGenSnapshot(updated || patch) });
  } catch (err) {
    console.error("[adGen] complete failed", err);
    return res
      .status(500)
      .json({ message: "Failed to complete ad generation" });
  }
});

/**
 * POST /api/onboarding/ad-gen/fail
 * Marks the caller's ad generation as failed. The UI calls this when
 * the client-side poll exceeds the timeout budget so the retry UX is
 * rendered.
 *
 * Body: { error?: string }
 */
router.post("/ad-gen/fail", authenticateToken, async (req, res) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.user?.userId;
    if (!userId) {
      return res.status(401).json({ message: "User not authenticated" });
    }
    const errorMsg =
      typeof req.body?.error === "string" ? req.body.error : "ad generation timed out";
    const user = await userDb.getUserById(userId);
    const patch = adGenFailedPatch(user || {}, errorMsg);
    await userDb.updateUser(userId, patch);
    logAdGenCompletionMetric(
      userId,
      "failed",
      patch.adGenDurationMs ?? 0,
      0
    );
    const updated = await userDb.getUserById(userId);
    return res.json({ status: adGenSnapshot(updated || patch) });
  } catch (err) {
    console.error("[adGen] fail failed", err);
    return res.status(500).json({ message: "Failed to mark ad generation failed" });
  }
});

export default router;
