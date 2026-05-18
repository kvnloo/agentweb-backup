import express from "express";
import { userDb, orgDb, taskDb } from "../services/db";
import { workPlanService } from "../services/workPlanService";
import { skillService } from "../services/skillService";
import { htmlTemplateService } from "../services/htmlTemplateService";
import { getLandingPagesByOwner } from "../services/v0Service";

const router = express.Router();

router.get("/:userId/removal-preview", async (req, res) => {
  try {
    const callerId = (req as any).user.userId;
    const caller = await userDb.getUserById(callerId);
    if (!caller?.orgId || caller.orgRole !== "owner") {
      return res.status(403).json({ message: "Org owner only" });
    }

    const target = await userDb.getUserById(req.params.userId);
    if (!target) {
      return res.status(404).json({ message: "Member not found in your org" });
    }
    if (target.orgId !== caller.orgId) {
      return res.status(404).json({ message: "Member not found in your org" });
    }

    const [taskList, templates, landingPages, workPlans, skills] = await Promise.all([
      taskDb.getTasksByUserId(target.userId).then((a) => (a ?? []).length),
      htmlTemplateService.getTemplatesByOwner(target.userId).then((a) => a.length),
      getLandingPagesByOwner(target.userId).then((a) => a.length),
      workPlanService.getWorkPlansByOwner(target.userId).then((a) => a.length),
      skillService.getSkillsByOwner(target.userId).then((a) => a.length),
    ]);

    res.json({
      userId: target.userId,
      itemCounts: {
        knowledgeBase: taskList,
        htmlTemplates: templates,
        landingPages,
        workPlans,
        skills,
      },
    });
  } catch (e) {
    console.error("Error in removal-preview:", e);
    res.status(500).json({ message: "Failed to fetch removal preview" });
  }
});

export default router;
