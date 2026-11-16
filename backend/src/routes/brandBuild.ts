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
  buildAutoFailPatchIfStuck,
  buildFailedPatch,
  buildStartPatch,
  logCompletionMetric,
  snapshot,
} from "../services/brandBuildStatusService";
import {
  claimBrandBuildRun,
  triggerBrandBuildForUser,
} from "../services/onboardingBrandBuildService";
import { cronJobRegistry } from "../utils/cronJobRegistry";
import { viewAfterUnclaimedStart } from "../utils/startResponseView";

const router = express.Router();

/**
 * POST /api/onboarding/brand-build/start
 *
 * Body (optional): { companyUrl?: string, companyName?: string, goal?: string }
 *
 * (1) Persists the supplied companyUrl/companyName/goal onto the User record
 *     so the orchestrator has them. (2) Flips brandBuildStatus to "building".
 * (3) Fires the direct scrape-then-LLM brand build in the background. Returns
 *     the running snapshot immediately so the UI can poll /status.
 *
 * No agent-mode work plan, no chat session. The whole pipeline is in
 * `onboardingBrandBuildService.triggerBrandBuildForUser`.
 */
router.post("/brand-build/start", authenticateToken, async (req, res) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.user?.userId;
    if (!userId) {
      return res.status(401).json({ message: "User not authenticated" });
    }

    const body = (req.body ?? {}) as {
      companyUrl?: string;
      companyName?: string;
      goal?: string;
    };

    // Idempotency. The FE now calls /start TWICE per onboarding run by
    // design: once optimistically when the user submits the brand screen
    // (so the LLM churns while they answer the next 1-2 screens of
    // questions — latency hiding), and again when they actually land on
    // the buildingBrand screen. The second call must NOT re-trigger the
    // LLM if the first already kicked it off. Persist any updated
    // companyUrl/companyName/goal regardless so an in-flight URL edit
    // still lands, but skip both buildStartPatch and the trigger when
    // status is already running/ready.
    const existing = await userDb.getUserById(userId);
    const existingStatus = (existing as any)?.brandBuildStatus;
    // Brand-build uses 'building' as its in-flight state (NOT 'running' —
    // that's the per-step convention ad-image/icp/competitor use). If we
    // checked for 'running' here, the buildingBrand-screen `/start` call
    // would never be recognized as idempotent and would re-fire the LLM,
    // undoing the prefetch latency savings.
    const alreadyInFlight =
      existingStatus === "building" || existingStatus === "ready";

    const inputPatch: Record<string, unknown> = {};
    if (typeof body.companyUrl === "string" && body.companyUrl.trim()) {
      inputPatch.productDomain = body.companyUrl.trim();
    }
    if (typeof body.companyName === "string" && body.companyName.trim()) {
      inputPatch.companyName = body.companyName.trim();
    }
    if (typeof body.goal === "string" && body.goal.trim()) {
      inputPatch.goal = body.goal.trim();
    }

    if (alreadyInFlight) {
      // Persist any URL/name/goal updates but DO NOT re-fire the LLM.
      if (Object.keys(inputPatch).length > 0) {
        await userDb.updateUser(userId, inputPatch as any);
      }
      const refreshed = await userDb.getUserById(userId);
      return res.json({ status: snapshot(refreshed || existing || {}) });
    }

    // ENG-238 root-cause guard. Do NOT start a build when no website URL is
    // resolvable. The dominant brand-build failure class (~77% of failures in
    // prod telemetry) was a `/start` fired with an empty companyUrl for a user
    // who had no URL on their record: the status flipped to `building`, the
    // background trigger's pickCompanyUrl returned null, and it immediately
    // failed with "no companyUrl on User record" — a dead-on-arrival build
    // that surfaced as a failure metric and stranded the user at
    // `brand_submitted`. Resolve the effective URL from the same sources the
    // trigger uses (body → productDomain → brandGuidelines.brandData.domain →
    // companyUrl). If none is resolvable, persist any supplied name/goal so
    // nothing is lost, skip both the status flip and the trigger, and return a
    // `needsUrl` snapshot so the UI routes to the "no website" path.
    const ex = existing as any;
    const effectiveUrl =
      (typeof body.companyUrl === "string" && body.companyUrl.trim()) ||
      (typeof ex?.productDomain === "string" && ex.productDomain.trim()) ||
      (typeof ex?.brandGuidelines?.brandData?.domain === "string" &&
        ex.brandGuidelines.brandData.domain.trim()) ||
      (typeof ex?.companyUrl === "string" && ex.companyUrl.trim()) ||
      "";

    if (!effectiveUrl) {
      if (Object.keys(inputPatch).length > 0) {
        await userDb.updateUser(userId, inputPatch as any);
      }
      const refreshed = await userDb.getUserById(userId);
      return res.json({
        status: { ...snapshot(refreshed || existing || {}), needsUrl: true },
      });
    }

    // Persist any supplied companyUrl/companyName/goal up front, regardless
    // of which branch below claims the axis — the claim's own patch only
    // carries the status fields (see `claimBrandBuildRun`), not these.
    if (Object.keys(inputPatch).length > 0) {
      await userDb.updateUser(userId, inputPatch as any);
    }

    // Eager DAG sub-task 2: when the user is on `useEagerPipeline`, the
    // orchestrator owns step ordering — its `brandDna` runner claims this
    // SAME axis itself (via `claimBrandBuildRun`) when it actually fires
    // the step, inside the SAME reconcile pass we're about to kick off.
    //
    // Checked BEFORE claiming here (ENG-2308 fix-of-a-fix, caught live —
    // same shape as the icp/competitor/creativeDir/adCopy/adImage
    // pre-claim bug): claiming in this route first would always win an
    // instant before handing off to reconcileForUser, permanently
    // starving runBrandDna's own claim moments later — so the real Emma
    // session never actually ran, and triggerBrandBuildForUser's own
    // "did Emma call update_brand_guidelines" check saw a false negative.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const {
      isEagerPipelineActiveFor,
      reconcileForUser,
    } = require("../services/onboardingOrchestratorWiring");
    const current = await userDb.getUserById(userId);
    if (isEagerPipelineActiveFor(current as any)) {
      void reconcileForUser(userId).catch((e: unknown) => {
        console.error("[brandBuild] background reconcile crashed", e);
      });
      const view = await viewAfterUnclaimedStart(userId, "brandBuildStatus", "building", buildStartPatch);
      return res.json({ status: snapshot(view as any) });
    }

    const patch = await claimBrandBuildRun(userId);
    if (!patch) {
      // Lost the race — another concurrent /brand-build/start already
      // claimed it. Same idempotent posture as the alreadyInFlight branch
      // above; just surface whatever is currently persisted.
      const view = await viewAfterUnclaimedStart(userId, "brandBuildStatus", "building", buildStartPatch);
      return res.json({ status: snapshot(view as any) });
    }
    // Fire-and-forget background work; route returns immediately so the UI
    // can poll /status without holding an HTTP connection open for ~30s.
    // expectedStartedAt: this claim's own startedAt, so a later reclaim's
    // zombie failure write can't stomp a terminal state WE or the
    // reclaiming run have since published (ENG-2308 review follow-up).
    // Tracked so a deploy's graceful shutdown waits for the build's pre/post
    // steps too (the Emma turn inside is already tracked on its own).
    void cronJobRegistry.track(
      "onboardingBrandBuild",
      triggerBrandBuildForUser(userId, {
        expectedStartedAt: patch.brandBuildStartedAt,
      }).catch((e) => {
        console.error("[brandBuild] background trigger crashed", e);
      }),
    );
    // Return the snapshot built from the patch we just persisted — do NOT
    // read back via getUserById here (ENG-2308 review follow-up, mirrors
    // icp/competitor/creative-dir/ad-copy's own fix for the same issue):
    // UserIdIndex is eventually consistent, and a stale GSI read right
    // after this write can return the pre-update row (e.g. no
    // brandBuildStatus, or a stale ready/failed from a previous attempt),
    // telling the FE to stop polling for a build that is in fact running.
    return res.json({ status: snapshot(patch) });
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

    // Watchdog: a build orphaned by a lost fire-and-forget job (deploy /
    // instance recycle / crash) stays `building` forever, leaving the UI on an
    // infinite spinner. On read, force-fail any build past the hard wall so the
    // user gets a visible error + retry instead of a silent stuck state, and so
    // long-stuck users (the `brand_submitted` cohort) are reset on next poll.
    const autoFail = buildAutoFailPatchIfStuck(user as any);
    if (autoFail) {
      // `getUserById` reads the eventually-consistent UserIdIndex GSI, which
      // can lag a just-written terminal status by ~100-1000ms (see
      // getUserByEmailConsistent docs / the 2026-04-27 Maya regen-stuck bug).
      // Force-failing off that stale read could clobber a build that actually
      // just completed `ready`, flipping a success into a spurious failure the
      // user then sees as "This step failed". Before writing, re-read the row
      // with a strongly-consistent GetItem and re-derive the stuck check from
      // that authoritative view. If the fresh read is no longer stuck (the
      // build resolved), trust it and return without clobbering.
      const authEmail = (authReq.user as any)?.email || (user as any)?.email;
      const fresh = authEmail
        ? await userDb.getUserByEmailConsistent(authEmail)
        : null;
      if (fresh) {
        const freshAutoFail = buildAutoFailPatchIfStuck(fresh as any);
        if (!freshAutoFail) {
          return res.json({ status: snapshot(fresh as any) });
        }
        await userDb.updateUser(userId, freshAutoFail as any);
        logCompletionMetric(
          userId,
          "failed",
          freshAutoFail.brandBuildDurationMs ?? 0
        );
        const refreshed = await userDb.getUserById(userId);
        return res.json({
          status: snapshot(refreshed || (freshAutoFail as any)),
        });
      }
      // No authoritative consistent re-read available (no email to key the
      // strongly-consistent GetItem, or it came back empty). We deliberately do
      // NOT force-fail off the eventually-consistent GSI read here: that could
      // clobber a build that actually just completed `ready` (the ~100-1000ms
      // GSI lag the guard above exists to close). Return the current view
      // unchanged; the next poll — which carries the JWT email — resolves it.
      return res.json({ status: snapshot(user) });
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
