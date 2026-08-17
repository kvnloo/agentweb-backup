import express from "express";
import multer from "multer";
import sharp from "sharp";
import { workPlanService } from "../services/workPlanService";
import { normalizeWorkPlanSteps, findAmbiguousMergeTargets, findConflictingMergeTargets, findStepContentLoss, mergeWorkPlanSteps, summarizeStepChange } from "../services/workPlanSteps";
import { workPlanThumbnailService } from "../services/workPlanThumbnailService";

const THUMBNAIL_MAX_BYTES = 2 * 1024 * 1024; // 2 MB
const THUMBNAIL_ACCEPTED_TYPES = new Set(['image/jpeg', 'image/jpg', 'image/png', 'image/webp']);

const thumbnailUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: THUMBNAIL_MAX_BYTES },
});

const router = express.Router();

// Get all work plans
router.get("/", async (req, res) => {
  try {
    const plans = await workPlanService.getAllWorkPlans();
    res.json(plans);
  } catch (error) {
    console.error("Error fetching all work plans:", error);
    res.status(500).json({ message: "Failed to fetch work plans" });
  }
});

// Get pending review queue
router.get("/pending-review", async (req, res) => {
  try {
    const plans = await workPlanService.getWorkPlansByVisibility('pending_review');
    res.json(plans);
  } catch (error) {
    console.error("Error fetching pending review plans:", error);
    res.status(500).json({ message: "Failed to fetch pending review plans" });
  }
});

// Get sync status
router.get("/sync-status", async (req, res) => {
  try {
    const status = await workPlanService.getSyncStatus();
    const environment = process.env.NODE_ENV === "development" ? "development" : "production";
    res.json({ plans: status, environment });
  } catch (error) {
    console.error("Error getting work plan sync status:", error);
    res.status(500).json({ message: "Failed to get sync status" });
  }
});

// Get a specific work plan
router.get("/:planId", async (req, res) => {
  try {
    const plan = await workPlanService.getWorkPlan(req.params.planId);
    if (!plan) return res.status(404).json({ message: "Work plan not found" });
    res.json(plan);
  } catch (error) {
    console.error("Error fetching work plan:", error);
    res.status(500).json({ message: "Failed to fetch work plan" });
  }
});

// Create work plan (admin can set any visibility)
router.post("/", async (req, res) => {
  try {
    const { title, description, steps, welcomeMessage, autocomplete, requireLogin, showLoginSignup, showInAgentMode, defaultModel, category, visibility } = req.body;

    if (!title || !steps || !Array.isArray(steps) || steps.length === 0) {
      return res.status(400).json({ message: "Title and at least one step are required" });
    }

    const { steps: normalizedSteps, warnings } = normalizeWorkPlanSteps(steps);

    const plan = await workPlanService.createWorkPlan({
      title,
      description,
      steps: normalizedSteps,
      welcomeMessage,
      autocomplete: autocomplete || false,
      requireLogin: requireLogin || false,
      showLoginSignup: showLoginSignup || 'after_plan_completed',
      showInAgentMode: showInAgentMode !== false,
      defaultModel,
      category,
      visibility: visibility || 'system',
      isBuiltIn: true,
    });

    workPlanThumbnailService.generateAIThumbnail(plan).catch((err) =>
      console.error(`[AdminWorkPlans] Auto thumbnail generation failed for ${plan.planId}:`, err)
    );

    res.status(201).json(warnings.length > 0 ? { ...plan, warnings } : plan);
  } catch (error) {
    console.error("Error creating admin work plan:", error);
    res.status(500).json({ message: "Failed to create work plan" });
  }
});

// Update any work plan
router.put("/:planId", async (req, res) => {
  try {
    const plan = await workPlanService.getWorkPlan(req.params.planId);
    if (!plan) return res.status(404).json({ message: "Work plan not found" });

    const { title, description, steps, welcomeMessage, autocomplete, requireLogin, showLoginSignup, showInAgentMode, defaultModel, category, visibility } = req.body;
    if (steps !== undefined && !Array.isArray(steps)) {
      return res.status(400).json({ message: "steps must be an array" });
    }
    // A caller that decided this write was safe by reading the plan first can
    // stake the revision it saw. `null` is a real value here ("the plan had no
    // revision"), so presence of the key is what counts (ENG-890).
    const stake = "expectedStepsRev" in req.body
      ? { expectedStepsRev: req.body.expectedStepsRev }
      : {};
    const normalized = steps !== undefined ? normalizeWorkPlanSteps(steps) : undefined;
    let normalizedSteps = normalized?.steps;
    const warnings = normalized?.warnings ?? [];

    // ENG-1221. These guards used to live only inside manage_predefined_work_plan,
    // one layer ABOVE the write — so a caller reaching this endpoint directly got
    // no protection, `steps_mode` silently ignored, and every omitted field on a
    // partial steps array erased. That destroyed all ten step descriptions on the
    // Google Pre-Launch Gate plan and answered HTTP 200 with a null diff.
    // The rules now live where the damage happens, and the tool shares them.
    let stepsChange: ReturnType<typeof summarizeStepChange> | undefined;
    // Validated whether or not steps came with it. Nesting this under "steps
    // were supplied" is accept-and-disregard by another name: the caller is
    // answered 200 for a mode we never looked at.
    const rawMode = (req.body as any).steps_mode ?? (req.body as any).stepsMode;
    if (rawMode !== undefined && rawMode !== 'merge' && rawMode !== 'replace') {
      return res.status(400).json({
        message: `Unrecognised steps_mode "${rawMode}". Use "merge" to amend named steps, or "replace" to store exactly what you send.`,
      });
    }
    if (normalizedSteps !== undefined) {
      const mode: 'merge' | 'replace' = rawMode === 'merge' ? 'merge' : 'replace';
      const existingSteps: any[] = Array.isArray(plan.steps) ? plan.steps : [];

      if (mode === 'merge') {
        // `normalizeWorkPlanSteps` FILLS IN what a partial step omits — `title`
        // becomes "Step N", `stepCount` the array position, the two list fields
        // []. Merging those invented values over real ones is the same data loss
        // by a different route: it is exactly how the Pre-Launch Gate titles
        // were truncated from "Step 1: Scope the launch" to "Step 1". A
        // synthesised stepCount is worse still, because merge resolution trusts
        // stepCount ahead of title — so a title-only entry would silently amend
        // whichever step happened to sit at that array position.
        //
        // So: normalized VALUES, but the raw payload as the authority on which
        // keys the caller actually sent. Only camelCase is consulted, because
        // that is all `normalizeWorkPlanSteps` reads; the MCP tool resolves its
        // snake_case aliases before it ever reaches this route (ENG-889).
        // Treating `required_function_calls` as supplied here would merge the
        // normalizer's default [] over the stored list.
        const rawSteps: any[] = steps;
        const supplied = normalizedSteps.map((norm: any, i: number) => {
          const raw = rawSteps[i] ?? {};
          const has = (key: string) => raw[key] !== undefined;
          const out: any = {};
          if (has('stepCount')) out.stepCount = norm.stepCount;
          if (has('title')) out.title = norm.title;
          if (has('description')) out.description = norm.description;
          if (has('userInstructions')) out.userInstructions = norm.userInstructions;
          if (has('requiredFunctionCalls')) out.requiredFunctionCalls = norm.requiredFunctionCalls;
          if (has('skillIds')) out.skillIds = norm.skillIds;
          if (has('expectedAssetCount')) out.expectedAssetCount = norm.expectedAssetCount;
          return out;
        });

        // An entry carrying neither selector names no step. Amending whatever
        // sits at its array position is the same silent wrong-step edit the
        // ambiguity check below already refuses to make.
        const untargeted = supplied
          .map((s: any, i: number) => ({ s, position: i + 1 }))
          .filter(({ s }: any) => s.stepCount === undefined && s.title === undefined)
          .map(({ position }: any) => position);
        if (untargeted.length > 0) {
          return res.status(400).json({
            message: 'Refusing to merge: a supplied step names neither stepCount nor title, so there is no way to tell which step it amends.',
            untargetedStepPositions: untargeted,
            howToProceed: [
              'Give each step a stepCount to amend an existing step, or a title to amend it by name (a title matching nothing is appended as a new step).',
            ],
          });
        }

        const ambiguous = findAmbiguousMergeTargets(existingSteps, supplied);
        if (ambiguous.length > 0) {
          return res.status(400).json({
            message: 'Refusing to merge: a step title matches more than one step, so there is no way to tell which one to amend.',
            ambiguousSteps: ambiguous,
            howToProceed: ['Retry with stepCount on each ambiguous step to name the one you mean.'],
          });
        }
        const conflicting = findConflictingMergeTargets(existingSteps, supplied);
        if (conflicting.length > 0) {
          return res.status(400).json({
            message: 'Refusing to merge: more than one supplied step resolves to the same existing step, so they would silently overwrite each other.',
            conflictingSteps: conflicting,
            howToProceed: ['Combine the changes for each step into a single entry, then retry.'],
          });
        }
        normalizedSteps = mergeWorkPlanSteps(existingSteps, supplied);
      } else if (req.body.confirm_step_removal !== true) {
        // A replace stores exactly what was sent, so both a shrink and a
        // gutting of the steps it keeps are destructive. Refuse either.
        if (normalizedSteps.length < existingSteps.length) {
          const preview = summarizeStepChange(existingSteps, normalizedSteps, 'replace');
          return res.status(400).json({
            message: `Refusing to update: this payload would take the plan from ${preview.stepsBefore} steps to ${preview.stepsAfter}, removing ${preview.stepsRemoved}.`,
            stepsWouldBeRemoved: preview.stepsRemoved,
            removedStepTitles: preview.droppedStepTitles,
            howToProceed: [
              'To amend specific steps without touching the others, retry with steps_mode="merge" and only the steps you are changing.',
              'To intentionally rewrite the plan with fewer steps, retry with confirm_step_removal=true.',
            ],
          });
        }
        const contentLoss = findStepContentLoss(existingSteps, normalizedSteps);
        if (contentLoss.length > 0) {
          return res.status(400).json({
            message: `Refusing to update: this payload keeps the steps but would blank fields that are currently set on ${contentLoss.length} of them. A replace stores exactly what you send, so any field you omit is erased.`,
            stepsWouldBeRemoved: 0,
            stepContentLoss: contentLoss,
            howToProceed: [
              'To amend specific steps without touching the others, retry with steps_mode="merge" and only the steps you are changing.',
              'To keep these steps as they are, re-send each one with its current fields.',
              'To intentionally clear them, retry with confirm_step_removal=true.',
            ],
          });
        }
      }

      // AC3: a step change always reports a diff. A 200 with a null diff used to
      // be indistinguishable from a successful no-op, which is exactly why a
      // destructive write could pass unnoticed.
      stepsChange = summarizeStepChange(existingSteps, normalizedSteps, mode);
    }
    const updated = {
      ...plan,
      ...(title !== undefined && { title }),
      ...(description !== undefined && { description }),
      ...(normalizedSteps !== undefined && { steps: normalizedSteps }),
      ...(welcomeMessage !== undefined && { welcomeMessage }),
      ...(autocomplete !== undefined && { autocomplete }),
      ...(requireLogin !== undefined && { requireLogin }),
      ...(showLoginSignup !== undefined && { showLoginSignup }),
      ...(showInAgentMode !== undefined && { showInAgentMode }),
      ...(defaultModel !== undefined && { defaultModel }),
      ...(category !== undefined && { category }),
      ...(visibility !== undefined && { visibility }),
    };
    // `updated` was built by spreading the plan we read, so it carries the
    // pre-write revision. Answer with the one the write produced.
    const steps_rev = await workPlanService.updateWorkPlan(updated, stake);
    const saved = {
      ...updated,
      steps_rev,
      // ENG-1221 AC3 — always surface the diff when steps moved, so a
      // destructive write can never read as a successful no-op.
      ...(stepsChange && { stepsChange }),
    };
    res.json(warnings.length > 0 ? { ...saved, warnings } : saved);
  } catch (error: any) {
    // A competing write landed between the caller's read and this one, so the
    // payload was judged against steps that no longer exist. Retryable, unlike
    // the 404 below — hence a distinct status (ENG-890).
    if (error?.message === "Work plan steps changed") {
      return res.status(409).json({ message: "Work plan changed since it was read — re-read it and retry" });
    }
    // The plan was deleted between the read above and the write.
    if (error?.message === "Work plan not found") {
      return res.status(404).json({ message: "Work plan not found" });
    }
    console.error("Error updating admin work plan:", error);
    res.status(500).json({ message: "Failed to update work plan" });
  }
});

// Delete any work plan
router.delete("/:planId", async (req, res) => {
  try {
    const plan = await workPlanService.getWorkPlan(req.params.planId);
    if (!plan) return res.status(404).json({ message: "Work plan not found" });

    await workPlanService.deleteWorkPlan(req.params.planId);
    res.json({ message: "Work plan deleted successfully" });
  } catch (error) {
    console.error("Error deleting admin work plan:", error);
    res.status(500).json({ message: "Failed to delete work plan" });
  }
});

// Approve a work plan
router.post("/:planId/approve", async (req, res) => {
  try {
    const plan = await workPlanService.approveWorkPlan(req.params.planId);
    res.json(plan);
  } catch (error: any) {
    if (error.message === 'Work plan steps changed') {
      return res.status(409).json({ message: "Work plan changed since it was read — re-read it and retry" });
    }
    if (error.message === 'Work plan not found') return res.status(404).json({ message: error.message });
    if (error.message === 'Plan is not pending review') return res.status(400).json({ message: error.message });
    console.error("Error approving work plan:", error);
    res.status(500).json({ message: "Failed to approve work plan" });
  }
});

// Reject a work plan
router.post("/:planId/reject", async (req, res) => {
  try {
    const { feedback } = req.body;
    if (!feedback) return res.status(400).json({ message: "Feedback is required when rejecting" });

    const plan = await workPlanService.rejectWorkPlan(req.params.planId, feedback);
    res.json(plan);
  } catch (error: any) {
    if (error.message === 'Work plan steps changed') {
      return res.status(409).json({ message: "Work plan changed since it was read — re-read it and retry" });
    }
    if (error.message === 'Work plan not found') return res.status(404).json({ message: error.message });
    if (error.message === 'Plan is not pending review') return res.status(400).json({ message: error.message });
    console.error("Error rejecting work plan:", error);
    res.status(500).json({ message: "Failed to reject work plan" });
  }
});

// Sync a work plan between environments
router.post("/sync", async (req, res) => {
  try {
    const { planId, direction } = req.body;
    if (!planId || !direction) return res.status(400).json({ message: "planId and direction are required" });
    if (direction !== 'prod-to-dev' && direction !== 'dev-to-prod') {
      return res.status(400).json({ message: 'direction must be "prod-to-dev" or "dev-to-prod"' });
    }

    const isDev = process.env.NODE_ENV === "development";
    const allowedDirection = isDev ? "dev-to-prod" : "prod-to-dev";
    if (direction !== allowedDirection) {
      return res.status(400).json({ message: `In ${isDev ? "dev" : "prod"} environment, only "${allowedDirection}" sync is allowed` });
    }

    const plan = await workPlanService.syncWorkPlan(planId, direction);
    if (!plan) return res.status(404).json({ message: "Work plan not found in source table" });
    res.json(plan);
  } catch (error) {
    console.error("Error syncing work plan:", error);
    res.status(500).json({ message: "Failed to sync work plan" });
  }
});

// ── Thumbnail endpoints ────────────────────────────────────────────────────

// Trigger AI thumbnail generation for a work plan
router.post("/:planId/thumbnail/generate", async (req, res) => {
  try {
    const plan = await workPlanService.getWorkPlan(req.params.planId);
    if (!plan) return res.status(404).json({ message: "Work plan not found" });

    // User-initiated: supersede any generation already running so the admin's
    // request wins rather than racing an older job for the same baseline.
    const { outcome, plan: updated } = await workPlanThumbnailService.generateAIThumbnailDetailed(
      plan,
      { supersedeInFlight: true },
    );
    // The plan was deleted while the thumbnail was rendering.
    if (outcome === 'gone' || !updated) {
      return res.status(404).json({ message: "Work plan not found" });
    }
    // Someone changed the plan mid-render, so the generated thumbnail was
    // correctly discarded rather than allowed to overwrite newer state. The
    // admin is waiting on this response — tell them it did not apply instead of
    // returning 200 with an unchanged plan (ENG-889).
    if (outcome === 'superseded') {
      return res.status(409).json({
        message: "The plan changed while the thumbnail was generating, so it was not applied. Try again.",
        plan: updated,
      });
    }
    res.json(updated);
  } catch (error) {
    console.error("Error generating thumbnail:", error);
    res.status(500).json({ message: "Failed to generate thumbnail" });
  }
});

// Upload a custom thumbnail image (multipart/form-data, field name: "thumbnail")
router.post(
  "/:planId/thumbnail/upload",
  thumbnailUpload.single("thumbnail"),
  async (req, res) => {
    try {
      const plan = await workPlanService.getWorkPlan(req.params.planId);
      if (!plan) return res.status(404).json({ message: "Work plan not found" });

      if (!req.file) {
        return res.status(400).json({ message: "No file uploaded" });
      }

      const { mimetype, buffer } = req.file;

      if (!THUMBNAIL_ACCEPTED_TYPES.has(mimetype)) {
        return res.status(400).json({
          message: "Unsupported file format. Accepted: JPG, PNG, WebP",
        });
      }

      const metadata = await sharp(buffer).metadata();
      const { width = 0, height = 0 } = metadata;
      if (width > height) {
        return res.status(400).json({
          message:
            "Landscape images are not accepted. Please use a square (1:1) or vertical (3:4) image.",
        });
      }

      const updated = await workPlanThumbnailService.uploadCustomThumbnail(
        plan,
        buffer,
        mimetype,
      );
      // null means the plan was deleted while the upload was in flight.
      if (!updated) return res.status(404).json({ message: "Work plan not found" });
      res.json(updated);
    } catch (error: any) {
      // multer file-size limit throws a specific error
      if (error.code === "LIMIT_FILE_SIZE") {
        return res.status(400).json({ message: "File exceeds 2 MB limit" });
      }
      console.error("Error uploading thumbnail:", error);
      res.status(500).json({ message: "Failed to upload thumbnail" });
    }
  },
);

// Remove current thumbnail and revert to AI-generated (or placeholder if generation fails)
router.delete("/:planId/thumbnail", async (req, res) => {
  try {
    const plan = await workPlanService.getWorkPlan(req.params.planId);
    if (!plan) return res.status(404).json({ message: "Work plan not found" });

    const updated = await workPlanThumbnailService.removeThumbnail(plan);
    // null means the plan was deleted while the clear was in flight.
    if (!updated) return res.status(404).json({ message: "Work plan not found" });
    res.json(updated);
  } catch (error) {
    console.error("Error removing thumbnail:", error);
    res.status(500).json({ message: "Failed to remove thumbnail" });
  }
});

export default router;
