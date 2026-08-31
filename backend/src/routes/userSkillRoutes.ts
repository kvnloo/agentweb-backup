import express from "express";
import { skillService } from "../services/skillService";
import { userDb, orgDb } from "../services/db";
import { can } from "../services/orgAuthz";
import {
  canEditItem,
} from "../services/orgShareService";
import { resolveUserSkillAccess } from "../services/userSkillAccessService";
import { validateWelcomeMessage } from "../utils/welcomeMessageValidation";

const router = express.Router();

// Get user's own skills + org members' skills + public/system skills
router.get("/", async (req, res) => {
  try {
    const { userId } = (req as any).user;
    const { sharedOrgId } = await resolveUserSkillAccess(userId);

    const items = await skillService.getSkillsAvailableToUser(userId, sharedOrgId);
    res.json({ items, truncated: false });
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
    const { name, description, toolNames, systemPrompt, welcomeMessage } = req.body;

    if (!name || !description) {
      return res.status(400).json({ message: "Name and description are required" });
    }
    const welcomeMessageError = validateWelcomeMessage(welcomeMessage);
    if (welcomeMessageError) {
      return res.status(400).json({ message: welcomeMessageError });
    }

    const user = await userDb.getUserById(userId);
    const orgId = user?.orgId;

    // Skills are member-owned: any user may create their own. Org-wide
    // visibility is governed separately by the shareSettings `enabled` toggle.

    const skill = welcomeMessage !== undefined
      ? await skillService.createSkill(name, description, toolNames || [], systemPrompt, false, welcomeMessage)
      : await skillService.createSkill(name, description, toolNames || [], systemPrompt, false);

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

    const { name, description, toolNames, systemPrompt, welcomeMessage } = req.body;
    const welcomeMessageError = validateWelcomeMessage(welcomeMessage);
    if (welcomeMessageError) {
      return res.status(400).json({ message: welcomeMessageError });
    }
    const updated = {
      ...skill,
      ...(name !== undefined && { name }),
      ...(description !== undefined && { description }),
      ...(toolNames !== undefined && { toolNames }),
      ...(systemPrompt !== undefined && { systemPrompt }),
      ...(welcomeMessage !== undefined && { welcomeMessage }),
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

    // Skills are member-owned: the skill owner may delete regardless of
    // visibility (ENG-932 — a skill accidentally submitted for review must
    // not become undeletable by its own owner). The org owner may also
    // delete a same-org member's skill as an admin override, but only while
    // it's still private — deleting someone else's public/pending-review
    // skill on their behalf is a separate, unrequested capability.
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

      if (skill.visibility !== 'private') {
        return res.status(403).json({ message: "Cannot delete skills that are public or pending review" });
      }
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

// Withdraw a skill from the platform review queue back to private (ENG-932:
// "Submit for Review" previously had no owner-side way back).
router.post("/:skillId/withdraw-review", async (req, res) => {
  try {
    const { userId } = (req as any).user;
    const { skillId } = req.params;

    const skill = await skillService.withdrawFromReview(skillId, userId);

    res.json(skill);
  } catch (error: any) {
    if (error.message === 'Skill not found') return res.status(404).json({ message: error.message });
    if (error.message === 'Not authorized') return res.status(403).json({ message: error.message });
    if (error.message === 'Skill is not pending review') return res.status(400).json({ message: error.message });
    if (error.message === 'Skill was changed by someone else — refresh and try again') return res.status(409).json({ message: error.message });
    console.error("Error withdrawing skill from review:", error);
    res.status(500).json({ message: "Failed to withdraw skill from review" });
  }
});

export default router;
