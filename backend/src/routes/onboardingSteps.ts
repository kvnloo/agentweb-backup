/**
 * Per-step onboarding status routes — Onboarding Epic Phase 2.
 *
 * Thin REST layer over the five per-axis state-machine services. Each
 * axis (icp / competitor / creative-dir / ad-image / ad-copy) gets its
 * own `start` / `status` / `complete` / `fail` quartet, mirroring the
 * `/api/onboarding/brand-build/*` and `/api/onboarding/ad-gen/*`
 * patterns.
 *
 * The actual generation work (LLM calls, image generation, web research)
 * is performed by other services. These routes only manage the status
 * state machine and the result payload persisted back to the User
 * record. Wiring the actual generation invocations happens in follow-up
 * slices once the per-screen UI work lands.
 *
 * Endpoints (5 axes × 4 verbs = 20 endpoints):
 *   POST /api/onboarding/{axis}/start     — mark running, reset clock
 *   GET  /api/onboarding/{axis}/status    — read snapshot
 *   POST /api/onboarding/{axis}/complete  — mark ready, persist result
 *   POST /api/onboarding/{axis}/fail      — mark failed
 *
 * Where {axis} ∈ icp | competitor | creative-dir | ad-image | ad-copy.
 */

import express, { Request, Response } from "express";
import { authenticateToken, AuthenticatedRequest } from "../middleware/auth";
import { userDb } from "../services/db";
import {
  icpStartPatch,
  icpReadyPatch,
  icpFailedPatch,
  icpSnapshot,
  logICPCompletionMetric,
  sanitizeICPPersonas,
} from "../services/icpStatusService";
import { startIcpDiscoveryForUser } from "../services/onboardingIcpService";
import {
  competitorStartPatch,
  competitorReadyPatch,
  competitorFailedPatch,
  competitorSnapshot,
  logCompetitorCompletionMetric,
  sanitizeCompetitorResult,
} from "../services/competitorStatusService";
import { startCompetitorStrategyForUser } from "../services/onboardingCompetitorService";
import {
  creativeDirStartPatch,
  creativeDirReadyPatch,
  creativeDirFailedPatch,
  creativeDirSnapshot,
  logCreativeDirCompletionMetric,
  sanitizeCreativeDirResult,
} from "../services/creativeDirStatusService";
import { startCreativeDirForUser } from "../services/onboardingCreativeDirService";
import {
  adImageStartPatch,
  adImageReadyPatch,
  adImageFailedPatch,
  adImageSnapshot,
  logAdImageCompletionMetric,
  sanitizeAdImageResult,
} from "../services/adImageStatusService";
import {
  adCopyStartPatch,
  adCopyReadyPatch,
  adCopyFailedPatch,
  adCopySnapshot,
  logAdCopyCompletionMetric,
  sanitizeAdCopyResult,
} from "../services/adCopyStatusService";
import { startAdCopyForUser } from "../services/onboardingAdCopyService";

const router = express.Router();

/** Pull the authenticated user id, or return 401. */
function requireUserId(req: Request, res: Response): string | null {
  const authReq = req as AuthenticatedRequest;
  const userId = authReq.user?.userId;
  if (!userId) {
    res.status(401).json({ message: "User not authenticated" });
    return null;
  }
  return userId;
}

// ───────────────────────────────────── ICP ─────────────────────────────────────

router.post("/icp/start", authenticateToken, async (req, res) => {
  try {
    const userId = requireUserId(req, res);
    if (!userId) return;
    // startIcpDiscoveryForUser applies icpStartPatch synchronously and
    // launches the background LLM call (fire-and-forget). The route returns
    // the running snapshot immediately so the UI can poll /icp/status.
    await startIcpDiscoveryForUser(userId);
    const user = await userDb.getUserById(userId);
    const fallback = icpStartPatch();
    return res.json({ status: icpSnapshot(user || fallback) });
  } catch (err) {
    console.error("[icp] start failed", err);
    return res.status(500).json({ message: "Failed to start icp" });
  }
});

router.get("/icp/status", authenticateToken, async (req, res) => {
  try {
    const userId = requireUserId(req, res);
    if (!userId) return;
    const user = await userDb.getUserById(userId);
    if (!user) return res.status(404).json({ message: "User not found" });
    return res.json({ status: icpSnapshot(user) });
  } catch (err) {
    console.error("[icp] status failed", err);
    return res.status(500).json({ message: "Failed to read icp status" });
  }
});

router.post("/icp/complete", authenticateToken, async (req, res) => {
  try {
    const userId = requireUserId(req, res);
    if (!userId) return;
    const personas = sanitizeICPPersonas(req.body?.personas);
    if (personas.length === 0) {
      return res.status(400).json({
        message:
          "personas must be a non-empty array of {name, pain, desire, objection, meta_targeting_brief}",
      });
    }
    const user = await userDb.getUserById(userId);
    const patch = icpReadyPatch(user || {}, personas);
    if (!patch) {
      return res
        .status(409)
        .json({ message: "icp is not in flight — call /start first" });
    }
    await userDb.updateUser(userId, patch);
    logICPCompletionMetric(userId, "ready", patch.icpDurationMs ?? 0, personas.length);
    const updated = await userDb.getUserById(userId);
    return res.json({ status: icpSnapshot(updated || patch) });
  } catch (err) {
    console.error("[icp] complete failed", err);
    return res.status(500).json({ message: "Failed to complete icp" });
  }
});

router.post("/icp/fail", authenticateToken, async (req, res) => {
  try {
    const userId = requireUserId(req, res);
    if (!userId) return;
    const errorMsg =
      typeof req.body?.error === "string" ? req.body.error : "icp generation timed out";
    const user = await userDb.getUserById(userId);
    const patch = icpFailedPatch(user || {}, errorMsg);
    await userDb.updateUser(userId, patch);
    logICPCompletionMetric(userId, "failed", patch.icpDurationMs ?? 0, 0);
    const updated = await userDb.getUserById(userId);
    return res.json({ status: icpSnapshot(updated || patch) });
  } catch (err) {
    console.error("[icp] fail failed", err);
    return res.status(500).json({ message: "Failed to mark icp failed" });
  }
});

// ───────────────────────────────── Competitor ─────────────────────────────────

router.post("/competitor/start", authenticateToken, async (req, res) => {
  try {
    const userId = requireUserId(req, res);
    if (!userId) return;
    // startCompetitorStrategyForUser applies competitorStartPatch synchronously
    // and launches the background per-ICP LLM loop (fire-and-forget). The
    // route returns the running snapshot immediately so the UI can poll
    // /competitor/status.
    await startCompetitorStrategyForUser(userId);
    const user = await userDb.getUserById(userId);
    const fallback = competitorStartPatch();
    return res.json({ status: competitorSnapshot(user || fallback) });
  } catch (err) {
    console.error("[competitor] start failed", err);
    return res.status(500).json({ message: "Failed to start competitor" });
  }
});

router.get("/competitor/status", authenticateToken, async (req, res) => {
  try {
    const userId = requireUserId(req, res);
    if (!userId) return;
    const user = await userDb.getUserById(userId);
    if (!user) return res.status(404).json({ message: "User not found" });
    return res.json({ status: competitorSnapshot(user) });
  } catch (err) {
    console.error("[competitor] status failed", err);
    return res.status(500).json({ message: "Failed to read competitor status" });
  }
});

router.post("/competitor/complete", authenticateToken, async (req, res) => {
  try {
    const userId = requireUserId(req, res);
    if (!userId) return;
    const result = sanitizeCompetitorResult(req.body?.result);
    if (result.per_icp.length === 0) {
      return res.status(400).json({
        message:
          "result.per_icp must be a non-empty array of {icp_id, competitor_names, offer_angles, meta_targeting_brief}",
      });
    }
    const user = await userDb.getUserById(userId);
    const patch = competitorReadyPatch(user || {}, result);
    if (!patch) {
      return res
        .status(409)
        .json({ message: "competitor is not in flight — call /start first" });
    }
    await userDb.updateUser(userId, patch);
    logCompetitorCompletionMetric(
      userId,
      "ready",
      patch.competitorDurationMs ?? 0,
      result.per_icp.length
    );
    const updated = await userDb.getUserById(userId);
    return res.json({ status: competitorSnapshot(updated || patch) });
  } catch (err) {
    console.error("[competitor] complete failed", err);
    return res.status(500).json({ message: "Failed to complete competitor" });
  }
});

router.post("/competitor/fail", authenticateToken, async (req, res) => {
  try {
    const userId = requireUserId(req, res);
    if (!userId) return;
    const errorMsg =
      typeof req.body?.error === "string" ? req.body.error : "competitor research timed out";
    const user = await userDb.getUserById(userId);
    const patch = competitorFailedPatch(user || {}, errorMsg);
    await userDb.updateUser(userId, patch);
    logCompetitorCompletionMetric(userId, "failed", patch.competitorDurationMs ?? 0, 0);
    const updated = await userDb.getUserById(userId);
    return res.json({ status: competitorSnapshot(updated || patch) });
  } catch (err) {
    console.error("[competitor] fail failed", err);
    return res.status(500).json({ message: "Failed to mark competitor failed" });
  }
});

// ─────────────────────────────── Creative direction ───────────────────────────

router.post("/creative-dir/start", authenticateToken, async (req, res) => {
  try {
    const userId = requireUserId(req, res);
    if (!userId) return;
    // startCreativeDirForUser applies creativeDirStartPatch synchronously and
    // launches the background LLM call (fire-and-forget). The route returns
    // the running snapshot immediately so the UI can poll /creative-dir/status.
    await startCreativeDirForUser(userId);
    const user = await userDb.getUserById(userId);
    const fallback = creativeDirStartPatch();
    return res.json({ status: creativeDirSnapshot(user || fallback) });
  } catch (err) {
    console.error("[creative-dir] start failed", err);
    return res.status(500).json({ message: "Failed to start creative direction" });
  }
});

router.get("/creative-dir/status", authenticateToken, async (req, res) => {
  try {
    const userId = requireUserId(req, res);
    if (!userId) return;
    const user = await userDb.getUserById(userId);
    if (!user) return res.status(404).json({ message: "User not found" });
    return res.json({ status: creativeDirSnapshot(user) });
  } catch (err) {
    console.error("[creative-dir] status failed", err);
    return res.status(500).json({ message: "Failed to read creative direction status" });
  }
});

router.post("/creative-dir/complete", authenticateToken, async (req, res) => {
  try {
    const userId = requireUserId(req, res);
    if (!userId) return;
    const result = sanitizeCreativeDirResult(req.body?.result);
    if (result.concepts.length === 0 && result.copy_angles.length === 0) {
      return res.status(400).json({
        message:
          "result must include at least concepts or copy_angles (got empty arrays)",
      });
    }
    const user = await userDb.getUserById(userId);
    const patch = creativeDirReadyPatch(user || {}, result);
    if (!patch) {
      return res
        .status(409)
        .json({ message: "creative direction is not in flight — call /start first" });
    }
    await userDb.updateUser(userId, patch);
    logCreativeDirCompletionMetric(
      userId,
      "ready",
      patch.creativeDirDurationMs ?? 0,
      result.concepts.length
    );
    const updated = await userDb.getUserById(userId);
    return res.json({ status: creativeDirSnapshot(updated || patch) });
  } catch (err) {
    console.error("[creative-dir] complete failed", err);
    return res.status(500).json({ message: "Failed to complete creative direction" });
  }
});

router.post("/creative-dir/fail", authenticateToken, async (req, res) => {
  try {
    const userId = requireUserId(req, res);
    if (!userId) return;
    const errorMsg =
      typeof req.body?.error === "string"
        ? req.body.error
        : "creative direction timed out";
    const user = await userDb.getUserById(userId);
    const patch = creativeDirFailedPatch(user || {}, errorMsg);
    await userDb.updateUser(userId, patch);
    logCreativeDirCompletionMetric(
      userId,
      "failed",
      patch.creativeDirDurationMs ?? 0,
      0
    );
    const updated = await userDb.getUserById(userId);
    return res.json({ status: creativeDirSnapshot(updated || patch) });
  } catch (err) {
    console.error("[creative-dir] fail failed", err);
    return res
      .status(500)
      .json({ message: "Failed to mark creative direction failed" });
  }
});

// ───────────────────────────────── Ad image ──────────────────────────────────

router.post("/ad-image/start", authenticateToken, async (req, res) => {
  try {
    const userId = requireUserId(req, res);
    if (!userId) return;
    const patch = adImageStartPatch();
    await userDb.updateUser(userId, patch);
    const user = await userDb.getUserById(userId);
    return res.json({ status: adImageSnapshot(user || patch) });
  } catch (err) {
    console.error("[ad-image] start failed", err);
    return res.status(500).json({ message: "Failed to start ad image" });
  }
});

router.get("/ad-image/status", authenticateToken, async (req, res) => {
  try {
    const userId = requireUserId(req, res);
    if (!userId) return;
    const user = await userDb.getUserById(userId);
    if (!user) return res.status(404).json({ message: "User not found" });
    return res.json({ status: adImageSnapshot(user) });
  } catch (err) {
    console.error("[ad-image] status failed", err);
    return res.status(500).json({ message: "Failed to read ad image status" });
  }
});

router.post("/ad-image/complete", authenticateToken, async (req, res) => {
  try {
    const userId = requireUserId(req, res);
    if (!userId) return;
    const result = sanitizeAdImageResult(req.body?.result);
    if (result.variants.length === 0) {
      return res.status(400).json({
        message:
          "result.variants must be a non-empty array of {id, imageUrl, prompt}",
      });
    }
    const user = await userDb.getUserById(userId);
    const patch = adImageReadyPatch(user || {}, result);
    if (!patch) {
      return res
        .status(409)
        .json({ message: "ad image is not in flight — call /start first" });
    }
    await userDb.updateUser(userId, patch);
    logAdImageCompletionMetric(
      userId,
      "ready",
      patch.adImageDurationMs ?? 0,
      result.variants.length
    );
    const updated = await userDb.getUserById(userId);
    return res.json({ status: adImageSnapshot(updated || patch) });
  } catch (err) {
    console.error("[ad-image] complete failed", err);
    return res.status(500).json({ message: "Failed to complete ad image" });
  }
});

router.post("/ad-image/fail", authenticateToken, async (req, res) => {
  try {
    const userId = requireUserId(req, res);
    if (!userId) return;
    const errorMsg =
      typeof req.body?.error === "string"
        ? req.body.error
        : "ad image generation timed out";
    const user = await userDb.getUserById(userId);
    const patch = adImageFailedPatch(user || {}, errorMsg);
    await userDb.updateUser(userId, patch);
    logAdImageCompletionMetric(userId, "failed", patch.adImageDurationMs ?? 0, 0);
    const updated = await userDb.getUserById(userId);
    return res.json({ status: adImageSnapshot(updated || patch) });
  } catch (err) {
    console.error("[ad-image] fail failed", err);
    return res.status(500).json({ message: "Failed to mark ad image failed" });
  }
});

// ───────────────────────────────── Ad copy ───────────────────────────────────

router.post("/ad-copy/start", authenticateToken, async (req, res) => {
  try {
    const userId = requireUserId(req, res);
    if (!userId) return;
    // startAdCopyForUser applies adCopyStartPatch synchronously and launches
    // the background per-image LLM loop. The orchestrator gates on
    // adImageStatus === 'ready' — until the image step ships, it will fail
    // immediately. The route returns the running snapshot regardless so the
    // UI can poll /ad-copy/status.
    await startAdCopyForUser(userId);
    const user = await userDb.getUserById(userId);
    const fallback = adCopyStartPatch();
    return res.json({ status: adCopySnapshot(user || fallback) });
  } catch (err) {
    console.error("[ad-copy] start failed", err);
    return res.status(500).json({ message: "Failed to start ad copy" });
  }
});

router.get("/ad-copy/status", authenticateToken, async (req, res) => {
  try {
    const userId = requireUserId(req, res);
    if (!userId) return;
    const user = await userDb.getUserById(userId);
    if (!user) return res.status(404).json({ message: "User not found" });
    return res.json({ status: adCopySnapshot(user) });
  } catch (err) {
    console.error("[ad-copy] status failed", err);
    return res.status(500).json({ message: "Failed to read ad copy status" });
  }
});

router.post("/ad-copy/complete", authenticateToken, async (req, res) => {
  try {
    const userId = requireUserId(req, res);
    if (!userId) return;
    const result = sanitizeAdCopyResult(req.body?.result);
    if (result.variants.length === 0) {
      return res.status(400).json({
        message:
          "result.variants must be a non-empty array of {id, headline, primaryText, cta, variety}",
      });
    }
    const user = await userDb.getUserById(userId);
    const patch = adCopyReadyPatch(user || {}, result);
    if (!patch) {
      return res
        .status(409)
        .json({ message: "ad copy is not in flight — call /start first" });
    }
    await userDb.updateUser(userId, patch);
    logAdCopyCompletionMetric(
      userId,
      "ready",
      patch.adCopyDurationMs ?? 0,
      result.variants.length
    );
    const updated = await userDb.getUserById(userId);
    return res.json({ status: adCopySnapshot(updated || patch) });
  } catch (err) {
    console.error("[ad-copy] complete failed", err);
    return res.status(500).json({ message: "Failed to complete ad copy" });
  }
});

router.post("/ad-copy/fail", authenticateToken, async (req, res) => {
  try {
    const userId = requireUserId(req, res);
    if (!userId) return;
    const errorMsg =
      typeof req.body?.error === "string"
        ? req.body.error
        : "ad copy generation timed out";
    const user = await userDb.getUserById(userId);
    const patch = adCopyFailedPatch(user || {}, errorMsg);
    await userDb.updateUser(userId, patch);
    logAdCopyCompletionMetric(userId, "failed", patch.adCopyDurationMs ?? 0, 0);
    const updated = await userDb.getUserById(userId);
    return res.json({ status: adCopySnapshot(updated || patch) });
  } catch (err) {
    console.error("[ad-copy] fail failed", err);
    return res.status(500).json({ message: "Failed to mark ad copy failed" });
  }
});

export default router;
