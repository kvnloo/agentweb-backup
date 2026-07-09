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
import {
  regenerateSingleIcpForUser,
  startIcpDiscoveryForUser,
} from "../services/onboardingIcpService";
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
  adCopyUpdateVariantPatch,
  logAdCopyCompletionMetric,
  sanitizeAdCopyResult,
} from "../services/adCopyStatusService";
import { startAdCopyForUser } from "../services/onboardingAdCopyService";
import { startAdImageGenerationForUser } from "../services/onboardingAdImageService";
import {
  appendRatingPatch,
  isAdVariantRating,
  isValidVariantId,
  ratingSummary,
} from "../services/adVariantRatingService";
import {
  appendImageRatingPatch,
  imageRatingSummary,
} from "../services/adImageVariantRatingService";

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

/**
 * Email pulled from the auth middleware. Used by status routes that need
 * a strong-consistent base-table read (via `userDb.getUserByEmailConsistent`)
 * to avoid the eventually-consistent UserIdIndex GSI returning stale rows
 * during the 0-1000ms window after an updateUser write.
 */
function requireUserEmail(req: Request, res: Response): string | null {
  const authReq = req as AuthenticatedRequest;
  const email = authReq.user?.email;
  if (!email) {
    res.status(401).json({ message: "User not authenticated" });
    return null;
  }
  return email;
}

// ───────────────────────────────────── ICP ─────────────────────────────────────

router.post("/icp/start", authenticateToken, async (req, res) => {
  try {
    const userId = requireUserId(req, res);
    if (!userId) return;
    // startIcpDiscoveryForUser applies icpStartPatch synchronously and
    // launches the background LLM call (fire-and-forget). Return the
    // running snapshot directly from the patch we just persisted — do
    // NOT read the user back via getUserById here. UserIdIndex is
    // eventually consistent, and a stale GSI read can return the
    // pre-update row (icpStatus='ready' + previous icpResult), which
    // tells the FE to stop polling. Source of truth for the response
    // is what we just wrote, not what the GSI happens to surface in
    // the next 100-1000ms.
    await startIcpDiscoveryForUser(userId);
    return res.json({ status: icpSnapshot(icpStartPatch()) });
  } catch (err) {
    console.error("[icp] start failed", err);
    return res.status(500).json({ message: "Failed to start icp" });
  }
});

router.get("/icp/status", authenticateToken, async (req, res) => {
  try {
    // Strong-consistent base-table read by email — see requireUserEmail
    // doc + the 2026-04-27 Maya regen-spinner-stuck investigation. The
    // GSI-based getUserById can return pre-update rows during the 0-1000ms
    // window after the regenerate-one POST flips icpStatus to 'running',
    // which causes the FE polling hook to terminate prematurely.
    const email = requireUserEmail(req, res);
    if (!email) return;
    const user = await userDb.getUserByEmailConsistent(email);
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
    // startAdImageGenerationForUser applies adImageStartPatch synchronously
    // and launches the background Brick 8 / Step 5 image-generation loop
    // (Gemini Pro, 3 variants in parallel, per-variant timeout). The route
    // returns the running snapshot immediately so the UI can poll
    // /ad-image/status. The orchestrator gates on creativeDirStatus ===
    // 'ready' — if creative direction hasn't completed, it patches with
    // adImageFailedPatch and the UI surfaces the gating reason.
    await startAdImageGenerationForUser(userId);
    const user = await userDb.getUserById(userId);
    const fallback = adImageStartPatch();
    return res.json({ status: adImageSnapshot(user || fallback) });
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

/**
 * POST /api/onboarding/ad-copy/update
 *
 * Inline-edit a single variant's headline / primaryText / cta on a
 * ready ad-copy result. Used by the Phase 4 reveal screen's click-to-edit
 * UX. Variety is intentionally NOT user-editable — it is the angle tag
 * the LLM picked from the Brick 10 set and changing it after the fact
 * would lie about which angle the variant tests.
 *
 * Validates that the user has a ready result, that the variant exists,
 * and that at least one editable field was supplied. Returns the latest
 * snapshot on success so the client can re-render in one round trip.
 */
router.post("/ad-copy/update", authenticateToken, async (req, res) => {
  try {
    const userId = requireUserId(req, res);
    if (!userId) return;

    const variantId = req.body?.variantId;
    if (typeof variantId !== "string" || variantId.length === 0) {
      return res
        .status(400)
        .json({ message: "variantId must be a non-empty string" });
    }

    const headline =
      typeof req.body?.headline === "string" ? req.body.headline : undefined;
    const primaryText =
      typeof req.body?.primaryText === "string"
        ? req.body.primaryText
        : undefined;
    const cta = typeof req.body?.cta === "string" ? req.body.cta : undefined;

    if (
      headline === undefined &&
      primaryText === undefined &&
      cta === undefined
    ) {
      return res.status(400).json({
        message:
          "supply at least one of: headline, primaryText, cta",
      });
    }

    const user = await userDb.getUserById(userId);
    if (!user) return res.status(404).json({ message: "User not found" });

    const patch = adCopyUpdateVariantPatch(user, {
      variantId,
      headline,
      primaryText,
      cta,
    });
    if (!patch) {
      return res.status(404).json({
        message:
          "ad-copy variant not found, or ad copy is not ready",
      });
    }

    await userDb.updateUser(userId, patch);
    const updated = await userDb.getUserById(userId);
    return res.json({ status: adCopySnapshot(updated || { ...user, ...patch }) });
  } catch (err) {
    console.error("[ad-copy] update failed", err);
    return res.status(500).json({ message: "Failed to update ad copy variant" });
  }
});

// ─────────────────────── BrandReview-gate per-card actions ───────────────────
//
// These three endpoints power the per-ICP-card actions on the BrandReview
// gate (the screen between dataGathering and adReveal). Personas don't
// carry an opaque id in storage, so we use index-based identity: the FE
// backfills `id: 'icp-{idx}'` when rendering, and we parse the index out
// of that string here. Future schema change (adding a stable persona id)
// can wrap these without changing the FE contract.

const ICP_ID_RE = /^icp-(\d+)$/;
const ICP_PERSONA_FIELDS = [
  "name",
  "pain",
  "desire",
  "objection",
  "meta_targeting_brief",
] as const;
const FIELD_MAX = 2000;
const VALUE_PROP_MAX = 2000;

function parseIcpIndex(icpId: unknown): number | null {
  if (typeof icpId !== "string") return null;
  const m = ICP_ID_RE.exec(icpId);
  if (!m) return null;
  const n = Number.parseInt(m[1], 10);
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
}


function sanitizePersonaPatch(raw: unknown): Record<string, string> | null {
  if (!raw || typeof raw !== "object") return null;
  const out: Record<string, string> = {};
  const v = raw as Record<string, unknown>;
  for (const f of ICP_PERSONA_FIELDS) {
    if (typeof v[f] === "string") {
      const trimmed = (v[f] as string).slice(0, FIELD_MAX);
      out[f] = trimmed;
    }
  }
  if (Object.keys(out).length === 0) return null;
  return out;
}

router.post("/icp/edit-one", authenticateToken, async (req, res) => {
  try {
    const userId = requireUserId(req, res);
    if (!userId) return;
    const idx = parseIcpIndex(req.body?.icpId);
    if (idx === null) {
      return res.status(400).json({ message: "icpId is required (format: icp-N)" });
    }
    const patchFields = sanitizePersonaPatch(req.body?.patch);
    if (!patchFields) {
      return res
        .status(400)
        .json({ message: "patch must include at least one of " + ICP_PERSONA_FIELDS.join(", ") });
    }
    const user = await userDb.getUserById(userId);
    const list: Array<Record<string, string>> = user?.icpResult ?? [];
    if (list.length === 0 || idx >= list.length) {
      return res.status(404).json({ message: "icp not found" });
    }
    // Record the user's own words as an anchor alongside the visible field.
    // Every later regeneration of this persona is driven from the anchor, so
    // it can neither be overwritten by a full-set run nor drift across
    // repeated regenerations (ENG-255). Merged, not replaced: a second edit to
    // a different field must not discard the first.
    const nextList = list.map((p, i) =>
      i === idx
        ? {
            ...p,
            ...patchFields,
            userIntent: { ...((p as any).userIntent ?? {}), ...patchFields },
          }
        : p
    );
    await userDb.updateUser(userId, {
      icpResult: nextList as Required<NonNullable<typeof user>>["icpResult"],
    });
    return res.json({ icpResult: nextList });
  } catch (err) {
    console.error("[icp] edit-one failed", err);
    return res.status(500).json({ message: "Failed to edit icp" });
  }
});

router.post("/icp/regenerate-one", authenticateToken, async (req, res) => {
  try {
    const userId = requireUserId(req, res);
    if (!userId) return;
    const idx = parseIcpIndex(req.body?.icpId);
    if (idx === null) {
      return res
        .status(400)
        .json({ message: "icpId is required (format: icp-N)" });
    }
    // Regenerate ONLY the persona the user clicked. This used to call
    // `startIcpDiscoveryForUser`, which re-ran the whole set from brand
    // context — replacing all five cards and destroying any the user had
    // edited, because the regeneration prompt never read `icpResult`
    // (ENG-255). Flip to `running` here, then hand off: the LLM round-trip is
    // ~20s and the FE polls `/icp/status` rather than holding this request
    // open.
    await userDb.updateUser(userId, icpStartPatch());
    void regenerateSingleIcpForUser(userId, idx).catch((err: unknown) => {
      console.error("[icp] regenerate-one failed", { userId, idx, err });
    });
    // Return the running snapshot directly from the patch we just wrote.
    // Do NOT read back via getUserById — UserIdIndex is eventually
    // consistent and the stale GSI row (icpStatus='ready' + old
    // icpResult) was the root cause of the regen-spinner-stuck bug
    // observed during the 2026-04-27 baseline rerun. With this change,
    // the FE always sees status='running' immediately after the POST
    // and keeps polling until the trigger persists fresh ICPs.
    return res.json({ status: icpSnapshot(icpStartPatch()) });
  } catch (err) {
    console.error("[icp] regenerate-one failed", err);
    return res.status(500).json({ message: "Failed to regenerate icp" });
  }
});

router.post("/icp/delete-one", authenticateToken, async (req, res) => {
  try {
    const userId = requireUserId(req, res);
    if (!userId) return;
    const idx = parseIcpIndex(req.body?.icpId);
    if (idx === null) {
      return res
        .status(400)
        .json({ message: "icpId is required (format: icp-N)" });
    }
    const user = await userDb.getUserById(userId);
    const list: Array<Record<string, string>> = user?.icpResult ?? [];
    if (list.length === 0 || idx >= list.length) {
      return res.status(404).json({ message: "icp not found" });
    }
    const nextList = list.filter((_, i) => i !== idx);
    await userDb.updateUser(userId, {
      icpResult: nextList as Required<NonNullable<typeof user>>["icpResult"],
    });
    return res.json({ icpResult: nextList });
  } catch (err) {
    console.error("[icp] delete-one failed", err);
    return res.status(500).json({ message: "Failed to delete icp" });
  }
});

// ─────────────────────── Ad-variant rating (Ads Tinder) ────────────────────
//
// Phase 4 reveal mobile UX is a Tinder-style card stack. Every swipe
// commits a rating to the User record, which feeds the LLM regen prompts
// to bias future variants away from rejected directions. See
// `adVariantRatingService.ts` for the pure-function side.
//
// POST /api/onboarding/ad-variant/rate
// Body: { variantId: string, rating: "like" | "reject" }
// Response: { summary: { likes, rejects, total } }
router.post("/ad-variant/rate", authenticateToken, async (req, res) => {
  try {
    const userId = requireUserId(req, res);
    if (!userId) return;

    const variantId = req.body?.variantId;
    if (!isValidVariantId(variantId)) {
      return res.status(400).json({
        message:
          "variantId must be a non-empty string up to 64 characters",
      });
    }

    const rating = req.body?.rating;
    if (!isAdVariantRating(rating)) {
      return res.status(400).json({
        message: 'rating must be "like" or "reject"',
      });
    }

    const user = await userDb.getUserById(userId);
    if (!user) return res.status(404).json({ message: "User not found" });

    const patch = appendRatingPatch(user, variantId, rating);
    // The patch object only has `adVariantsRated`; cast to any so the
    // partial-User update is accepted by `userDb.updateUser`.
    await userDb.updateUser(userId, patch as any);

    // Also log the signal to PromptSignals so the partner-portal Prompt
    // Templates tab can show like-rate per archetype + version. We
    // resolve the variant's promptVersion + archetype from the User
    // record's adImageResult so the metric carries the prompt context.
    const updatedUser = (await userDb.getUserById(userId)) as any;
    const variants = updatedUser?.adImageResult?.variants ?? [];
    const variant = variants.find((v: any) => v?.id === variantId);
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { logPromptSignal } = require("../services/promptSignalsService");
    void logPromptSignal({
      userId,
      variantId,
      promptVersion: variant?.promptVersion,
      archetype: variant?.archetype,
      signal: rating === "like" ? "like" : "skip",
    });

    return res.json({
      summary: ratingSummary(updatedUser || patch),
    });
  } catch (err) {
    console.error("[ad-variant] rate failed", err);
    return res
      .status(500)
      .json({ message: "Failed to record ad-variant rating" });
  }
});

// ─────────────────── Ad-IMAGE-variant rating (Ads Tinder) ───────────────────
//
// The image-side analogue of /ad-variant/rate. The Phase 4 image reveal deck
// fires this on every ♥/✕ commit. Stored on the User record under
// `adImageVariantsRated` (separate field from copy) and fed back into the
// next image generation as negative visual directions. See
// `adImageVariantRatingService.ts` for the pure-function side.
//
// POST /api/onboarding/ad-image-variant/rate
// Body: { variantId: string, rating: "like" | "reject" }
// Response: { summary: { likes, rejects, total } }
router.post("/ad-image-variant/rate", authenticateToken, async (req, res) => {
  try {
    const userId = requireUserId(req, res);
    if (!userId) return;

    const variantId = req.body?.variantId;
    if (!isValidVariantId(variantId)) {
      return res.status(400).json({
        message: "variantId must be a non-empty string up to 64 characters",
      });
    }

    const rating = req.body?.rating;
    if (!isAdVariantRating(rating)) {
      return res.status(400).json({ message: 'rating must be "like" or "reject"' });
    }

    const user = await userDb.getUserById(userId);
    if (!user) return res.status(404).json({ message: "User not found" });

    const patch = appendImageRatingPatch(user, variantId, rating);
    await userDb.updateUser(userId, patch as any);

    // Log the signal to PromptSignals attributed to the image variant's
    // prompt version + archetype so the partner-portal Prompt Templates tab
    // shows image like-rate per archetype. Image prompt versions are a
    // distinct namespace from copy (brick-8 vs brick-10) so they don't
    // collide in the metric.
    const updatedUser = (await userDb.getUserById(userId)) as any;
    const variants = updatedUser?.adImageResult?.variants ?? [];
    const variant = variants.find((v: any) => v?.id === variantId);
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { logPromptSignal } = require("../services/promptSignalsService");
    void logPromptSignal({
      userId,
      variantId,
      promptVersion: variant?.promptVersion,
      archetype: variant?.archetype,
      signal: rating === "like" ? "like" : "skip",
    });

    return res.json({ summary: imageRatingSummary(updatedUser || patch) });
  } catch (err) {
    console.error("[ad-image-variant] rate failed", err);
    return res
      .status(500)
      .json({ message: "Failed to record ad-image-variant rating" });
  }
});

// POST /api/onboarding/ad-set/signal
// Set-level prompt feedback (continue / regenerate). Records a signal
// row per ad variant so the partner-portal metrics correctly attribute
// the verdict to each prompt version + archetype that was in the set.
//
// Body: { signal: "continue_set" | "regenerate_set" }
router.post("/ad-set/signal", authenticateToken, async (req, res) => {
  try {
    const userId = requireUserId(req, res);
    if (!userId) return;
    const signal = req.body?.signal;
    if (signal !== "continue_set" && signal !== "regenerate_set") {
      return res
        .status(400)
        .json({ message: 'signal must be "continue_set" or "regenerate_set"' });
    }
    const user = (await userDb.getUserById(userId)) as any;
    const variants = user?.adImageResult?.variants ?? [];
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { logPromptSignal } = require("../services/promptSignalsService");
    if (Array.isArray(variants) && variants.length > 0) {
      for (const v of variants) {
        void logPromptSignal({
          userId,
          variantId: v?.id,
          promptVersion: v?.promptVersion,
          archetype: v?.archetype,
          signal,
        });
      }
    } else {
      void logPromptSignal({ userId, signal });
    }
    return res.json({ ok: true });
  } catch (err) {
    console.error("[ad-set] signal failed", err);
    return res.status(500).json({ message: "Failed to record ad-set signal" });
  }
});

router.post("/value-prop", authenticateToken, async (req, res) => {
  try {
    const userId = requireUserId(req, res);
    if (!userId) return;
    const raw = req.body?.valueProp;
    if (typeof raw !== "string") {
      return res
        .status(400)
        .json({ message: "valueProp must be a non-empty string" });
    }
    const trimmed = raw.trim().slice(0, VALUE_PROP_MAX);
    if (!trimmed) {
      return res
        .status(400)
        .json({ message: "valueProp must be a non-empty string" });
    }
    await userDb.updateUser(userId, { valueProp: trimmed });
    return res.json({ valueProp: trimmed });
  } catch (err) {
    console.error("[value-prop] failed", err);
    return res.status(500).json({ message: "Failed to save value prop" });
  }
});

export default router;
