import express from "express";
import { skillService, Skill } from "../services/skillService";
import { userDb, orgDb } from "../services/db";
import { can } from "../services/orgAuthz";
import {
  canEditItem,
  isFeatureEffectivelyEnabled,
} from "../services/orgShareService";

const router = express.Router();

// Get user's own skills + org members' skills + public/system skills
router.get("/", async (req, res) => {
  try {
    const { userId } = (req as any).user;
    const user = await userDb.getUserById(userId);
    const orgId = user?.orgId;
    const org = orgId ? await orgDb.getOrgById(orgId) : null;
    const skillsEnabled = isFeatureEffectivelyEnabled(
      { userId, orgId, orgRole: user?.orgRole as "owner" | "member" | undefined },
      org,
      "skills",
    );

    const [ownSkills, publicSkills, systemSkills, orgSkills] = await Promise.all([
      skillService.getSkillsByOwner(userId),
      skillService.getSkillsByVisibility('public'),
      skillService.getSkillsByVisibility('system'),
      (orgId && skillsEnabled) ? skillService.getSkillsByOrg(orgId, userId) : Promise.resolve([] as Skill[]),
    ]);

    const seen = new Set<string>();
    const all = [...ownSkills, ...orgSkills, ...publicSkills, ...systemSkills].filter(s => {
      if (seen.has(s.skillId)) return false;
      seen.add(s.skillId);
      return true;
    });
    res.json({ items: all, truncated: false });
  } catch (error) {
    console.error("Error fetching user skills:", error);
    res.status(500).json({ message: "Failed to fetch skills" });
  }
});

// Get only user's own skills
router.get("/mine", async (req, res) => {
  try {
    const { userId } = (req as any).user;
    const skills = await skillService.getSkillsByOwner(userId);
    res.json(skills);
  } catch (error) {
    console.error("Error fetching user's own skills:", error);
    res.status(500).json({ message: "Failed to fetch skills" });
  }
});

// Create a private skill
router.post("/", async (req, res) => {
  try {
    const { userId } = (req as any).user;
    const { name, description, toolNames, systemPrompt } = req.body;

    if (!name || !description) {
      return res.status(400).json({ message: "Name and description are required" });
    }

    const user = await userDb.getUserById(userId);
    const orgId = user?.orgId;

    // Skills are member-owned: any user may create their own. Org-wide
    // visibility is governed separately by the shareSettings `enabled` toggle.

    const skill = await skillService.createSkill(
      name,
      description,
      toolNames || [],
      systemPrompt,
      false // not published
    );

    // Set ownership, visibility, and org membership
    skill.ownerId = userId;
    skill.visibility = 'private';
    skill.isBuiltIn = false;
    if (orgId) skill.orgId = orgId;
    await skillService.updateSkill(skill);

    res.status(201).json(skill);
  } catch (error) {
    console.error("Error creating user skill:", error);
    res.status(500).json({ message: "Failed to create skill" });
  }
});

// Update own private skill (or org editor updating another member's skill)
router.put("/:skillId", async (req, res) => {
  try {
    const { userId } = (req as any).user;
    const { skillId } = req.params;
    const skill = await skillService.getSkill(skillId);

    if (!skill) return res.status(404).json({ message: "Skill not found" });

    // Resolve caller's user record and org context for permission check
    const callerUser = await userDb.getUserById(userId);
    const callerOrgId = callerUser?.orgId;
    const ownerUser = skill.ownerId && skill.ownerId !== userId
      ? await userDb.getUserById(skill.ownerId)
      : null;
    const ownerOrgId = skill.ownerId === userId ? callerOrgId : ownerUser?.orgId;
    const org = callerOrgId ? await orgDb.getOrgById(callerOrgId) : null;

    const callerUserLike = { userId, orgId: callerOrgId, orgRole: callerUser?.orgRole as "owner" | "member" | undefined };
    const skillItemLike = { userId: skill.ownerId };

    if (!canEditItem(skillItemLike, callerUserLike, org, ownerOrgId, "skills")) {
      return res.status(403).json({ message: "Not authorized" });
    }

    if (skill.visibility !== 'private') {
      return res.status(403).json({ message: "Cannot edit skills that are public or pending review" });
    }

    const { name, description, toolNames, systemPrompt } = req.body;
    const updated = {
      ...skill,
      ...(name !== undefined && { name }),
      ...(description !== undefined && { description }),
      ...(toolNames !== undefined && { toolNames }),
      ...(systemPrompt !== undefined && { systemPrompt }),
    };
    await skillService.updateSkill(updated);
    res.json(updated);
  } catch (error) {
    console.error("Error updating user skill:", error);
    res.status(500).json({ message: "Failed to update skill" });
  }
});

// Delete own private skill (owner or org owner/admin only; editors cannot delete)
router.delete("/:skillId", async (req, res) => {
  try {
    const { userId } = (req as any).user;
    const { skillId } = req.params;
    const skill = await skillService.getSkill(skillId);

    if (!skill) return res.status(404).json({ message: "Skill not found" });

    // Skills are member-owned: the skill owner may delete; the org owner may
    // also delete a same-org member's skill as an admin override.
    if (skill.ownerId !== userId) {
      const callerUser = await userDb.getUserById(userId);
      let allowed = false;
      if (callerUser?.orgId && skill.ownerId) {
        const callerOrg = await orgDb.getOrgById(callerUser.orgId);
        if (can({ userId, orgId: callerUser.orgId, orgRole: callerUser.orgRole }, callerOrg, "org:content:manage")) {
          const owner = await userDb.getUserById(skill.ownerId);
          if (owner?.orgId === callerUser.orgId) allowed = true;
        }
      }
      if (!allowed) return res.status(403).json({ message: "Not authorized" });
    }

    if (skill.visibility !== 'private') {
      return res.status(403).json({ message: "Cannot delete skills that are public or pending review" });
    }

    await skillService.deleteSkill(skillId);
    res.json({ message: "Skill deleted successfully" });
  } catch (error) {
    console.error("Error deleting user skill:", error);
    res.status(500).json({ message: "Failed to delete skill" });
  }
});

// Submit skill for platform review
router.post("/:skillId/submit-for-review", async (req, res) => {
  try {
    const { userId } = (req as any).user;
    const { skillId } = req.params;

    const skill = await skillService.submitForReview(skillId, userId);

    res.json(skill);
  } catch (error: any) {
    if (error.message === 'Skill not found') return res.status(404).json({ message: error.message });
    if (error.message === 'Not authorized') return res.status(403).json({ message: error.message });
    if (error.message === 'Only private skills can be submitted for review') return res.status(400).json({ message: error.message });
    console.error("Error submitting skill for review:", error);
    res.status(500).json({ message: "Failed to submit skill for review" });
  }
});

export default router;
