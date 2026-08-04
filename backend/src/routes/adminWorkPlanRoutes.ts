import express from "express";
import multer from "multer";
import sharp from "sharp";
import { workPlanService } from "../services/workPlanService";
import { normalizeWorkPlanSteps } from "../services/workPlanSteps";
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
    const normalized = steps !== undefined ? normalizeWorkPlanSteps(steps) : undefined;
    const normalizedSteps = normalized?.steps;
    const warnings = normalized?.warnings ?? [];
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
    await workPlanService.updateWorkPlan(updated);
    res.json(warnings.length > 0 ? { ...updated, warnings } : updated);
  } catch (error) {
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

    const updated = await workPlanThumbnailService.generateAIThumbnail(plan);
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
    res.json(updated);
  } catch (error) {
    console.error("Error removing thumbnail:", error);
    res.status(500).json({ message: "Failed to remove thumbnail" });
  }
});

export default router;
