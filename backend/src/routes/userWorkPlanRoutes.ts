import express from "express";
import { workPlanService, WorkPlan } from "../services/workPlanService";
import { emailService } from "../services/emailService";
import { userDb, orgDb } from "../services/db";

const router = express.Router();

// Get user's own plans + org members' plans + public/system plans
router.get("/", async (req, res) => {
  try {
    const { userId } = (req as any).user;
    const user = await userDb.getUserById(userId);
    const orgId = user?.orgId;
    const org = orgId ? await orgDb.getOrgById(orgId) : null;
    const wpEnabled = org?.shareSettings?.workPlans?.enabled === true;

    const [ownPlans, publicPlans, orgPlans] = await Promise.all([
      workPlanService.getWorkPlansByOwner(userId),
      workPlanService.getPublicPlansForAgentMode(),
      (orgId && wpEnabled) ? workPlanService.getWorkPlansByOrg(orgId, userId) : Promise.resolve([] as WorkPlan[]),
    ]);

    const seen = new Set<string>();
    const all = [...ownPlans, ...orgPlans, ...publicPlans].filter(p => {
      if (seen.has(p.planId)) return false;
      seen.add(p.planId);
      return true;
    });
    res.json({ items: all, truncated: false });
  } catch (error) {
    console.error("Error fetching user work plans:", error);
    res.status(500).json({ message: "Failed to fetch work plans" });
  }
});

// Get only user's own plans
router.get("/mine", async (req, res) => {
  try {
    const { userId } = (req as any).user;
    const plans = await workPlanService.getWorkPlansByOwner(userId);
    res.json(plans);
  } catch (error) {
    console.error("Error fetching user's own work plans:", error);
    res.status(500).json({ message: "Failed to fetch work plans" });
  }
});

// Create a private work plan
router.post("/", async (req, res) => {
  try {
    const { userId } = (req as any).user;
    const { title, description, steps, welcomeMessage, autocomplete, requireLogin, showLoginSignup, defaultModel } = req.body;

    if (!title || !steps || !Array.isArray(steps) || steps.length === 0) {
      return res.status(400).json({ message: "Title and at least one step are required" });
    }

    const normalizedSteps = steps.map((s: any, i: number) => ({
      stepCount: s.stepCount || i + 1,
      title: s.title || `Step ${i + 1}`,
      description: s.description,
      ...(s.userInstructions !== undefined && { userInstructions: s.userInstructions }),
      requiredFunctionCalls: s.requiredFunctionCalls || [],
      skillIds: s.skillIds || [],
    }));

    const user = await userDb.getUserById(userId);
    const orgId = user?.orgId;

    const plan = await workPlanService.createWorkPlan({
      title,
      description,
      steps: normalizedSteps,
      welcomeMessage,
      autocomplete: autocomplete || false,
      requireLogin: requireLogin || false,
      showLoginSignup: showLoginSignup || 'after_plan_completed',
      showInAgentMode: false,
      defaultModel,
      ownerId: userId,
      ...(orgId && { orgId }),
      visibility: 'private',
      isBuiltIn: false,
    });

    res.status(201).json(plan);
  } catch (error) {
    console.error("Error creating user work plan:", error);
    res.status(500).json({ message: "Failed to create work plan" });
  }
});

// Update own private plan
router.put("/:planId", async (req, res) => {
  try {
    const { userId } = (req as any).user;
    const { planId } = req.params;
    const plan = await workPlanService.getWorkPlan(planId);

    if (!plan) return res.status(404).json({ message: "Work plan not found" });
    if (plan.ownerId !== userId) return res.status(403).json({ message: "Not authorized" });
    if (plan.visibility !== 'private') {
      return res.status(403).json({ message: "Cannot edit plans that are public or pending review" });
    }

    const { title, description, steps, welcomeMessage, autocomplete, requireLogin, showLoginSignup, defaultModel } = req.body;
    const updated = {
      ...plan,
      ...(title !== undefined && { title }),
      ...(description !== undefined && { description }),
      ...(steps !== undefined && { steps }),
      ...(welcomeMessage !== undefined && { welcomeMessage }),
      ...(autocomplete !== undefined && { autocomplete }),
      ...(requireLogin !== undefined && { requireLogin }),
      ...(showLoginSignup !== undefined && { showLoginSignup }),
      ...(defaultModel !== undefined && { defaultModel }),
    };
    await workPlanService.updateWorkPlan(updated);
    res.json(updated);
  } catch (error) {
    console.error("Error updating user work plan:", error);
    res.status(500).json({ message: "Failed to update work plan" });
  }
});

// Delete own private plan
router.delete("/:planId", async (req, res) => {
  try {
    const { userId } = (req as any).user;
    const { planId } = req.params;
    const plan = await workPlanService.getWorkPlan(planId);

    if (!plan) return res.status(404).json({ message: "Work plan not found" });
    if (plan.ownerId !== userId) return res.status(403).json({ message: "Not authorized" });
    if (plan.visibility !== 'private') {
      return res.status(403).json({ message: "Cannot delete plans that are public or pending review" });
    }

    await workPlanService.deleteWorkPlan(planId);
    res.json({ message: "Work plan deleted successfully" });
  } catch (error) {
    console.error("Error deleting user work plan:", error);
    res.status(500).json({ message: "Failed to delete work plan" });
  }
});

// Submit plan for platform review
router.post("/:planId/submit-for-review", async (req, res) => {
  try {
    const { userId } = (req as any).user;
    const userEmail = (req as any).user.email;
    const { planId } = req.params;

    const plan = await workPlanService.submitForReview(planId, userId);

    emailService.sendOncallAlert(
      'Work Plan Submitted for Review',
      `User ${userEmail} submitted work plan "${plan.title}" for platform review.`,
      { planId: plan.planId, planTitle: plan.title, userId, userEmail }
    ).catch(err => console.error('Failed to send oncall alert for plan review:', err));

    res.json(plan);
  } catch (error: any) {
    if (error.message === 'Work plan not found') return res.status(404).json({ message: error.message });
    if (error.message === 'Not authorized') return res.status(403).json({ message: error.message });
    if (error.message === 'Only private plans can be submitted for review') return res.status(400).json({ message: error.message });
    console.error("Error submitting work plan for review:", error);
    res.status(500).json({ message: "Failed to submit work plan for review" });
  }
});

export default router;
