import express from "express";
import { workPlanService, WorkPlan } from "../services/workPlanService";
import { normalizeWorkPlanSteps } from "../services/workPlanSteps";
import { userDb, orgDb } from "../services/db";
import { can } from "../services/orgAuthz";
import { checkPlanDefaultModelWrite, isUserAdminSafe, planAdminStatusApplies } from "../services/agentMode/modelPin";
import { workPlanStepModels } from "../services/agentMode/workPlanStepModelsInstance";
import { anyStepCarriesModel, checkPlanStepModelsWrite, checkStoredStepModelsForPublic } from "../services/agentMode/workPlanStepModels";
import {
  canEditItem,
  isFeatureEffectivelyEnabled,
  listOrgVisibleItems,
} from "../services/orgShareService";

const router = express.Router();

// Get user's own plans + org members' plans + public/system plans
router.get("/", async (req, res) => {
  try {
    const { userId } = (req as any).user;
    const user = await userDb.getUserById(userId);
    const orgId = user?.orgId;
    const org = orgId ? await orgDb.getOrgById(orgId) : null;
    const enabled = isFeatureEffectivelyEnabled(
      { userId, orgId, orgRole: user?.orgRole as "owner" | "member" | undefined },
      org,
      "workPlans",
    );

    const [ownPlans, publicPlans, fanout] = await Promise.all([
      workPlanService.getWorkPlansByOwner(userId),
      workPlanService.getPublicPlansForAgentMode(),
      orgId
        ? listOrgVisibleItems({
            callerUserId: userId,
            orgId,
            featureEnabled: enabled,
            getOwnerItems: async () => [],
            getMemberIds:  async () => (await orgDb.getOrgMembers(orgId)).map((m: any) => m.userId),
            getItemsForOwner: (uid: string) => workPlanService.getWorkPlansByOwner(uid),
            getId: (p: any) => p.planId,
          })
        : Promise.resolve({ items: [] as WorkPlan[], truncated: false }),
    ]);

    const seen = new Set<string>();
    const all = [...ownPlans, ...fanout.items, ...publicPlans].filter(p => {
      if (seen.has(p.planId)) return false;
      seen.add(p.planId);
      return true;
    });
    res.json({ items: all, truncated: fanout.truncated });
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

    const user = await userDb.getUserById(userId);
    const orgId = user?.orgId;

    // ENG-903: an unservable/unselectable plan model is refused now (422), not at launch.
    // A plan created by an org member is org-scoped (shared with the org), so the creator's
    // admin status does not clear an adminOnly pin.
    // ENG-669: a user-authored pin must also be in the owner's plan (the launch re-checks the launcher's).
    const modelCheck = await checkPlanDefaultModelWrite(
      () => planAdminStatusApplies({ visibility: 'private', ownerId: userId, orgId }) ? isUserAdminSafe(userId) : Promise.resolve(false),
      defaultModel,
      undefined,
      userId,
    );
    if (!modelCheck.ok) return res.status(422).json(modelCheck.body);

    // ENG-2378: a step `model` is stored (and validated like the plan default) only while the switch is on.
    const stepModelsEnabled = anyStepCarriesModel(steps) && await workPlanStepModels.isEnabled();
    const { steps: normalizedSteps, warnings } = normalizeWorkPlanSteps(steps, { stepModelsEnabled });
    const stepModelCheck = await checkPlanStepModelsWrite(
      () => planAdminStatusApplies({ visibility: 'private', ownerId: userId, orgId }) ? isUserAdminSafe(userId) : Promise.resolve(false),
      normalizedSteps,
      undefined,
      userId,
    );
    if (!stepModelCheck.ok) return res.status(422).json(stepModelCheck.body);

    // Work plans are member-owned: any user may create their own. Org-wide
    // visibility is governed separately by the shareSettings `enabled` toggle.

    const plan = await workPlanService.createWorkPlan({
      title,
      description,
      steps: normalizedSteps,
      welcomeMessage,
      autocomplete: autocomplete || false,
      requireLogin: requireLogin || false,
      showLoginSignup: showLoginSignup || 'after_plan_completed',
      showInAgentMode: false,
      defaultModel: modelCheck.touched ? modelCheck.value : undefined,
      ownerId: userId,
      ...(orgId && { orgId }),
      visibility: 'private',
      isBuiltIn: false,
    });

    res.status(201).json(warnings.length > 0 ? { ...plan, warnings } : plan);
  } catch (error) {
    console.error("Error creating user work plan:", error);
    res.status(500).json({ message: "Failed to create work plan" });
  }
});

// Update own private plan (or org editor updating another member's plan)
router.put("/:planId", async (req, res) => {
  try {
    const { userId } = (req as any).user;
    const { planId } = req.params;
    const plan = await workPlanService.getWorkPlan(planId);

    if (!plan) return res.status(404).json({ message: "Work plan not found" });
    if (plan.visibility !== 'private') {
      return res.status(403).json({ message: "Cannot edit plans that are public or pending review" });
    }

    // Resolve caller's user record and org context for permission check
    const callerUser = await userDb.getUserById(userId);
    const callerOrgId = callerUser?.orgId;
    const ownerUser = plan.ownerId && plan.ownerId !== userId
      ? await userDb.getUserById(plan.ownerId)
      : null;
    const ownerOrgId = plan.ownerId === userId ? callerOrgId : ownerUser?.orgId;
    const org = callerOrgId ? await orgDb.getOrgById(callerOrgId) : null;

    const callerUserLike = { userId, orgId: callerOrgId, orgRole: callerUser?.orgRole as "owner" | "member" | undefined };
    const planItemLike = { userId: plan.ownerId };

    if (!canEditItem(planItemLike, callerUserLike, org, ownerOrgId, "workPlans")) {
      return res.status(403).json({ message: "Not authorized" });
    }

    const { title, description, steps, welcomeMessage, autocomplete, requireLogin, showLoginSignup, defaultModel } = req.body;
    if (steps !== undefined && !Array.isArray(steps)) {
      return res.status(400).json({ message: "steps must be an array" });
    }
    // Normalize here too. This path used to store the caller's step objects
    // verbatim, which made the same resource behave differently by verb and
    // left it the one write path with no report of what it discarded (ENG-889).
    // ENG-903: validate only a CHANGED model; re-sending the stored value never blocks an edit.
    // ENG-669: a changed pin must be in the plan OWNER's plan (an org editor edits it for the owner).
    const modelCheck = await checkPlanDefaultModelWrite(
      () => planAdminStatusApplies(plan) ? isUserAdminSafe(plan.ownerId) : Promise.resolve(false),
      defaultModel,
      plan.defaultModel,
      plan.ownerId || userId,
    );
    if (!modelCheck.ok) return res.status(422).json(modelCheck.body);
    const stepModelsEnabled = (anyStepCarriesModel(steps) || anyStepCarriesModel(plan.steps)) && await workPlanStepModels.isEnabled();
    const normalized = steps !== undefined ? normalizeWorkPlanSteps(steps, { stepModelsEnabled, storedSteps: plan.steps, keepStoredWhenOmitted: true }) : undefined;
    if (normalized) {
      // ENG-2378: only a NEW or CHANGED step model is validated; an unchanged stored one is tolerated.
      const stepModelCheck = await checkPlanStepModelsWrite(
        () => planAdminStatusApplies(plan) ? isUserAdminSafe(plan.ownerId) : Promise.resolve(false),
        normalized.steps,
        plan.steps,
        plan.ownerId || userId,
      );
      if (!stepModelCheck.ok) return res.status(422).json(stepModelCheck.body);
    }
    const warnings = normalized?.warnings ?? [];
    const updated = {
      ...plan,
      ...(title !== undefined && { title }),
      ...(description !== undefined && { description }),
      ...(normalized !== undefined && { steps: normalized.steps }),
      ...(welcomeMessage !== undefined && { welcomeMessage }),
      ...(autocomplete !== undefined && { autocomplete }),
      ...(requireLogin !== undefined && { requireLogin }),
      ...(showLoginSignup !== undefined && { showLoginSignup }),
      ...(modelCheck.touched && { defaultModel: modelCheck.value }),
    };
    // Same stake as the admin PUT: `null` means "the plan I read had no
    // revision", so presence of the key is what counts (ENG-890).
    const stake = "expectedStepsRev" in req.body
      ? { expectedStepsRev: req.body.expectedStepsRev }
      : {};
    const steps_rev = await workPlanService.updateWorkPlan(updated, stake);
    const saved = { ...updated, steps_rev };
    res.json(warnings.length > 0 ? { ...saved, warnings } : saved);
  } catch (error: any) {
    // A competing write landed between the caller's read and this one.
    if (error?.message === "Work plan steps changed") {
      return res.status(409).json({ message: "Work plan changed since it was read — re-read it and retry" });
    }
    // The plan was deleted between the read above and the write.
    if (error?.message === "Work plan not found") {
      return res.status(404).json({ message: "Work plan not found" });
    }
    console.error("Error updating user work plan:", error);
    res.status(500).json({ message: "Failed to update work plan" });
  }
});

// Delete own private plan (owner or org owner/admin only; editors cannot delete)
router.delete("/:planId", async (req, res) => {
  try {
    const { userId } = (req as any).user;
    const { planId } = req.params;
    const plan = await workPlanService.getWorkPlan(planId);

    if (!plan) return res.status(404).json({ message: "Work plan not found" });
    if (plan.visibility !== 'private') {
      return res.status(403).json({ message: "Cannot delete plans that are public or pending review" });
    }

    // Work plans are member-owned: the plan owner may delete; the org owner may
    // also delete a same-org member's plan as an admin override.
    if (plan.ownerId !== userId) {
      const callerUser = await userDb.getUserById(userId);
      let allowed = false;
      if (callerUser?.orgId && plan.ownerId) {
        const callerOrg = await orgDb.getOrgById(callerUser.orgId);
        if (can({ userId, orgId: callerUser.orgId, orgRole: callerUser.orgRole }, callerOrg, "org:content:manage")) {
          const owner = await userDb.getUserById(plan.ownerId);
          if (owner?.orgId === callerUser.orgId) allowed = true;
        }
      }
      if (!allowed) return res.status(403).json({ message: "Not authorized" });
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
    const { planId } = req.params;

    // ENG-2378: submitting widens who can launch this plan (an approved plan is launched by non-admins), so its step
    // models must be selectable by a NON-admin now, not discovered at the first launch. The owner's own plan only: any
    // other caller gets the service's usual refusal. Nothing is written when a model is refused.
    const existing = await workPlanService.getWorkPlan(planId);
    if (existing && existing.ownerId === userId && existing.visibility === 'private') {
      const stepModelCheck = await checkStoredStepModelsForPublic(existing.steps, () => workPlanStepModels.shouldHonor());
      if (!stepModelCheck.ok) return res.status(422).json(stepModelCheck.body);
    }
    const plan = await workPlanService.submitForReview(planId, userId);

    res.json(plan);
  } catch (error: any) {
    if (error.message === 'Work plan steps changed') {
      return res.status(409).json({ message: "Work plan changed since it was read — re-read it and retry" });
    }
    if (error.message === 'Work plan not found') return res.status(404).json({ message: error.message });
    if (error.message === 'Not authorized') return res.status(403).json({ message: error.message });
    if (error.message === 'Only private plans can be submitted for review') return res.status(400).json({ message: error.message });
    console.error("Error submitting work plan for review:", error);
    res.status(500).json({ message: "Failed to submit work plan for review" });
  }
});

export default router;
