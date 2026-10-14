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
import { viewAfterUnclaimedStart } from "../utils/startResponseView";
import { withClearedError } from "../utils/clearErrorOnClaim";
import { trackBackgroundRun } from "../utils/trackedBackgroundRun";
import {
  ensurePersonaIds,
  ICPPersona,
  ICP_TIMEOUT_MS,
  icpStartPatch,
  icpReadyPatch,
  icpFailedPatch,
  icpSnapshot,
  logICPCompletionMetric,
  MINTED_ICP_ID_RE,
  sanitizeICPPersonas,
} from "../services/icpStatusService";
import {
  ICP_LIST_CONTENDED,
  writeIcpCard,
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
    // startIcpDiscoveryForUser claims the non-running -> running transition
    // with a DynamoDB ConditionExpression and launches the background LLM
    // call (fire-and-forget). Return the running snapshot directly from the
    // patch we just persisted — do NOT read the user back via getUserById
    // here. UserIdIndex is eventually consistent, and a stale GSI read can
    // return the pre-update row (icpStatus='ready' + previous icpResult),
    // which tells the FE to stop polling. Source of truth for the response
    // is what we just wrote, not what the GSI happens to surface in
    // the next 100-1000ms.
    const patch = await startIcpDiscoveryForUser(userId);
    if (!patch) {
      // Lost the race (ENG-2308) — a concurrent /icp/start already claimed
      // this run (e.g. OutreachIcpPick's watchdog re-firing while the first
      // call's generation is still in flight). Do NOT launch a second
      // parallel LLM call; return the in-flight snapshot instead.
      const existing = await viewAfterUnclaimedStart(userId, "icpStatus", "running", icpStartPatch);
      return res.json({ status: icpSnapshot(existing) });
    }
    return res.json({ status: icpSnapshot(patch) });
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

    // Self-healing migration: personas persisted before stable ids existed
    // carry none, so the FE would fall back to positional `icp-N` refs — the
    // refs that go stale the moment a delete splices the array. Mint them on
    // the way out and persist, so the browser holds real ids BEFORE it can
    // mutate anything. Idempotent: only writes when something is missing.
    // Best-effort — a failed write must not break the status poll.
    const personas = (user as { icpResult?: ICPPersona[] }).icpResult;
    if (Array.isArray(personas) && personas.length > 0 && personas.some((p) => !p?.id)) {
      const withIds = ensurePersonaIds(personas);
      const userId = (req as AuthenticatedRequest).user?.userId;
      if (userId) {
        try {
          await userDb.updateUser(userId, { icpResult: withIds } as any);
        } catch (err) {
          console.error("[icp] persona id backfill failed", { userId, err });
        }
      }
      return res.json({ status: icpSnapshot({ ...user, icpResult: withIds }) });
    }

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
    // startCompetitorStrategyForUser claims the non-running -> running
    // transition with a DynamoDB ConditionExpression and launches the
    // background per-ICP LLM loop (fire-and-forget). Return the running
    // snapshot directly from the patch we just persisted — do NOT read the
    // user back via getUserById on the win path (ENG-2308 review follow-up,
    // mirrors icp/start's own fix for the same issue): UserIdIndex is
    // eventually consistent, and a stale GSI read right after this write
    // can return the pre-update row (competitorStatus='ready' + previous
    // result), which tells the FE to stop polling.
    const patch = await startCompetitorStrategyForUser(userId);
    if (!patch) {
      // Lost the race (ENG-2308) — a concurrent caller (the route itself,
      // or the icp-ready cascade kickoff) already claimed this run. Do NOT
      // launch a second parallel per-ICP LLM loop; return the in-flight
      // snapshot instead. Fine to re-read here: we have no winning patch of
      // our own to fall back on, so the eventually-consistent GSI row is
      // the best available source of truth either way.
      const existing = await viewAfterUnclaimedStart(userId, "competitorStatus", "running", competitorStartPatch);
      return res.json({ status: competitorSnapshot(existing) });
    }
    return res.json({ status: competitorSnapshot(patch) });
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
    // startCreativeDirForUser claims the non-running -> running transition
    // with a DynamoDB ConditionExpression (ENG-2308) and launches the
    // background LLM call (fire-and-forget). Return the running snapshot
    // directly from the patch we just persisted on the win path — do NOT
    // read back via getUserById there (ENG-2308 review follow-up, mirrors
    // icp/start): UserIdIndex is eventually consistent and a stale GSI read
    // can return the pre-update row.
    const patch = await startCreativeDirForUser(userId);
    if (!patch) {
      // Lost the race (ENG-2308) — a concurrent caller already claimed this
      // run. No winning patch of our own, so the eventually-consistent GSI
      // row is the best available source of truth.
      const existing = await viewAfterUnclaimedStart(userId, "creativeDirStatus", "running", creativeDirStartPatch);
      return res.json({ status: creativeDirSnapshot(existing) });
    }
    return res.json({ status: creativeDirSnapshot(patch) });
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
    // startAdImageGenerationForUser claims the run with a DynamoDB
    // ConditionExpression (ENG-2308) and launches the background Brick 8 /
    // Step 5 image-generation loop (Gemini Pro, 3 variants in parallel,
    // per-variant timeout) — or no-ops (returns null) if a concurrent caller
    // already claimed it, so we don't burn a second Gemini run. The
    // orchestrator gates on creativeDirStatus === 'ready' — if creative
    // direction hasn't completed, it patches with adImageFailedPatch and the
    // UI surfaces the gating reason.
    //
    // Unlike the other four axes' routes, we always re-read below rather
    // than returning the winning value directly: the resolved value here is
    // just an AdImageRunIdentity (runId/startedAt), not a full
    // AdImageStatusFields patch, so there's nothing snapshot-shaped to
    // return on a win — and on the eager-pipeline branch this always
    // resolves to null regardless of whether the claim succeeds (the
    // orchestrator's own runAdImage owns that claim instead), so a
    // winning-patch shortcut wouldn't even apply there.
    await startAdImageGenerationForUser(userId);
    const view = await viewAfterUnclaimedStart(userId, "adImageStatus", "running", adImageStartPatch);
    return res.json({ status: adImageSnapshot(view) });
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
    // startAdCopyForUser claims the non-running -> running transition with a
    // DynamoDB ConditionExpression (ENG-2308) and launches the background
    // per-image LLM loop (fire-and-forget — the orchestrator gates on
    // adImageStatus === 'ready' and fails fast if not, but that happens
    // after this function returns regardless, so there's nothing to gain by
    // re-reading here). Return the running snapshot directly from the patch
    // we just persisted on the win path — do NOT read back via getUserById
    // there (ENG-2308 review follow-up, mirrors icp/start): UserIdIndex is
    // eventually consistent and a stale GSI read can return the pre-update
    // row. The FE polls /ad-copy/status shortly after regardless.
    const patch = await startAdCopyForUser(userId);
    if (!patch) {
      // Lost the race (ENG-2308) — a concurrent caller already claimed this
      // run. No winning patch of our own, so the eventually-consistent GSI
      // row is the best available source of truth.
      const existing = await viewAfterUnclaimedStart(userId, "adCopyStatus", "running", adCopyStartPatch);
      return res.json({ status: adCopySnapshot(existing) });
    }
    return res.json({ status: adCopySnapshot(patch) });
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
// gate (the screen between dataGathering and adReveal). Newer personas carry a
// stable `id`; older ones don't, and the FE names those `icp-{idx}`, which we
// parse into an index here. writeIcpCard pins that index to the card's identity
// on the first read, so a retry never lands on a different card.

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

/**
 * Resolve an `icpId` from the FE to an index into the stored persona list.
 *
 * Prefers the persona's stable `id`. Positional `icp-<n>` refs are still
 * honoured for records written before ids existed — but they are exactly the
 * refs that go stale when `/icp/delete-one` splices the array, so they are a
 * fallback, not the contract.
 *
 * Returns `{ status }` rather than throwing so callers can distinguish a
 * malformed ref (400) from one naming a persona that is gone (404).
 */
function resolveIcpIndex(
  list: Array<Record<string, unknown>>,
  icpId: unknown,
): { index: number } | { status: 400 | 404 } {
  if (typeof icpId !== "string" || !icpId) return { status: 400 };

  const byId = list.findIndex((p) => p && (p as any).id === icpId);
  if (byId >= 0) return { index: byId };

  const positional = parseIcpIndex(icpId);
  if (positional !== null) {
    if (positional >= list.length) return { status: 404 };
    return { index: positional };
  }

  // Looks like a minted id, but no persona carries it — the card was deleted
  // or regenerated away under the caller.
  if (MINTED_ICP_ID_RE.test(icpId)) return { status: 404 };
  return { status: 400 };
}

/**
 * Reject a missing/blank `icpId` before we spend a DynamoDB read on it. The
 * id-vs-position resolution below needs the persona list, but "you sent no id
 * at all" is a 400 regardless of what the user has stored.
 */
function hasIcpIdShape(icpId: unknown): icpId is string {
  return typeof icpId === "string" && icpId.length > 0;
}

const ICP_ID_ERROR = {
  400: { message: "icpId is required (a persona id, or the legacy icp-N form)" },
  404: { message: "icp not found" },
} as const;

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
    if (!hasIcpIdShape(req.body?.icpId)) {
      return res.status(400).json(ICP_ID_ERROR[400]);
    }
    const patchFields = sanitizePersonaPatch(req.body?.patch);
    if (!patchFields) {
      return res
        .status(400)
        .json({ message: "patch must include at least one of " + ICP_PERSONA_FIELDS.join(", ") });
    }
    // One card, written alone (see writeIcpCard): concurrent edits, deletes and
    // regenerations of other cards or fields never overwrite each other.
    const outcome = await writeIcpCard(
      userId,
      (list) => resolveIcpIndex(list as unknown as Array<Record<string, unknown>>, req.body?.icpId),
      { type: "edit", patch: patchFields },
    );
    if (!outcome.ok) {
      return res.status(outcome.status).json(ICP_ID_ERROR[outcome.status]);
    }
    return res.json({ icpResult: outcome.icpResult });
  } catch (err) {
    if ((err as any)?.code === ICP_LIST_CONTENDED) {
      return res.status(409).json({ message: "The personas changed while saving. Please try again." });
    }
    console.error("[icp] edit-one failed", err);
    return res.status(500).json({ message: "Failed to edit icp" });
  }
});

router.post("/icp/regenerate-one", authenticateToken, async (req, res) => {
  try {
    const userId = requireUserId(req, res);
    if (!userId) return;
    if (!hasIcpIdShape(req.body?.icpId)) {
      return res.status(400).json(ICP_ID_ERROR[400]);
    }
    const existing = await userDb.getUserById(userId);
    const resolved = resolveIcpIndex(existing?.icpResult ?? [], req.body?.icpId);
    if ("status" in resolved) {
      return res.status(resolved.status).json(ICP_ID_ERROR[resolved.status]);
    }
    const idx = resolved.index;
    // Regenerate ONLY the persona the user clicked. This used to call
    // `startIcpDiscoveryForUser`, which re-ran the whole set from brand
    // context — replacing all five cards and destroying any the user had
    // edited, because the regeneration prompt never read `icpResult`
    // (ENG-255). Flip to `running` here, then hand off: the LLM round-trip is
    // ~20s and the FE polls `/icp/status` rather than holding this request
    // open.
    //
    // Not guarded like /icp/start's claim (ENG-2308): icpStatus is one per-user
    // flag shared by every regenerate-one call, while the real concurrency unit
    // is the PERSONA, and two different cards regenerating at once is a tested,
    // intended flow (ENG-255; BrandReview's `regeneratingIds` is a Set). A global
    // guard would silently drop the second card's request.
    //
    // What IS guarded is the join below: an in-flight claim is reused only while
    // it is still the live one. Two rapid clicks on the SAME card still run twice
    // (the FE disables a card's control once its spinner shows).
    //
    // If a claim (a full /icp/start run or another card's regeneration) is already
    // in flight, KEEP its icpStartedAt:
    // that run's completion write is conditioned on it (ENG-2308), so stamping
    // a fresh one here would make its whole-set result get dropped.
    // Read it consistently: the indexed read can still show the pre-claim row
    // for a moment, which made this miss a run that started seconds ago.
    let live: any = existing;
    try {
      live = (await userDb.getUserByIdConsistent(userId)) ?? existing;
    } catch {
      /* keep the indexed read */
    }
    const inFlightStartedAt =
      live?.icpStatus === "running" &&
      typeof live?.icpStartedAt === "string" &&
      Date.now() - Date.parse(live.icpStartedAt) < ICP_TIMEOUT_MS
        ? live.icpStartedAt
        : undefined;
    let joined = Boolean(inFlightStartedAt);
    let startWrite = joined
      ? { ...icpStartPatch(), icpStartedAt: inFlightStartedAt }
      : icpStartPatch();
    if (joined) {
      try {
        // Only join if that run is STILL the live one: it may have finished in
        // the moment since the read, and forcing `running` after that would leave
        // nobody to flip the status back.
        await userDb.updateUser(userId, withClearedError(startWrite, "icpError"), {
          condition: {
            expression: "#icpStatus = :icpJoinRunning AND #icpStartedAt = :icpJoinStartedAt",
            names: { "#icpStatus": "icpStatus", "#icpStartedAt": "icpStartedAt" },
            values: { ":icpJoinRunning": "running", ":icpJoinStartedAt": inFlightStartedAt },
          },
        });
      } catch (err: any) {
        if (err?.code !== "ConditionalCheckFailedException") throw err;
        joined = false;
        startWrite = icpStartPatch();
        await userDb.updateUser(userId, withClearedError(startWrite, "icpError"));
      }
    } else {
      await userDb.updateUser(userId, withClearedError(startWrite, "icpError"));
    }
    // Tracked so a deploy's graceful shutdown waits for it instead of killing the
    // regeneration mid-flight and leaving the axis `running` until its timeout.
    trackBackgroundRun(
      "onboardingIcpRegenerate",
      (joined
        ? regenerateSingleIcpForUser(userId, idx, { statusOwnedElsewhere: true })
        : regenerateSingleIcpForUser(userId, idx)
      ).catch((err: unknown) => {
        console.error("[icp] regenerate-one failed", { userId, idx, err });
      }),
    );
    // Return the running snapshot directly from the patch we just wrote.
    // Do NOT read back via getUserById — UserIdIndex is eventually
    // consistent and the stale GSI row (icpStatus='ready' + old
    // icpResult) was the root cause of the regen-spinner-stuck bug
    // observed during the 2026-04-27 baseline rerun. With this change,
    // the FE always sees status='running' immediately after the POST
    // and keeps polling until the trigger persists fresh ICPs.
    return res.json({ status: icpSnapshot(startWrite) });
  } catch (err) {
    console.error("[icp] regenerate-one failed", err);
    return res.status(500).json({ message: "Failed to regenerate icp" });
  }
});

router.post("/icp/delete-one", authenticateToken, async (req, res) => {
  try {
    const userId = requireUserId(req, res);
    if (!userId) return;
    if (!hasIcpIdShape(req.body?.icpId)) {
      return res.status(400).json(ICP_ID_ERROR[400]);
    }
    const outcome = await writeIcpCard(
      userId,
      (list) => resolveIcpIndex(list as unknown as Array<Record<string, unknown>>, req.body?.icpId),
      { type: "delete" },
    );
    if (!outcome.ok) {
      return res.status(outcome.status).json(ICP_ID_ERROR[outcome.status]);
    }
    return res.json({ icpResult: outcome.icpResult });
  } catch (err) {
    if ((err as any)?.code === ICP_LIST_CONTENDED) {
      return res.status(409).json({ message: "The personas changed while saving. Please try again." });
    }
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
