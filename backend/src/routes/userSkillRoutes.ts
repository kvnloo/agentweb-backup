import express from "express";
import { skillService } from "../services/skillService";
import { emailService } from "../services/emailService";
import { userDb } from "../services/db";

const router = express.Router();

// Get user's own skills + org members' skills + public/system skills
router.get("/", async (req, res) => {
  try {
    const { userId } = (req as any).user;
    const user = await userDb.getUserById(userId);
    const orgId = user?.orgId;

    const [ownSkills, publicSkills, systemSkills, orgSkills] = await Promise.all([
      skillService.getSkillsByOwner(userId),
      skillService.getSkillsByVisibility('public'),
      skillService.getSkillsByVisibility('system'),
      orgId ? skillService.getSkillsByOrg(orgId) : Promise.resolve([]),
    ]);

    const seen = new Set<string>();
    const all = [...ownSkills, ...orgSkills, ...publicSkills, ...systemSkills].filter(s => {
      if (seen.has(s.skillId)) return false;
      seen.add(s.skillId);
      return true;
    });
    res.json(all);
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

// Update own private skill
router.put("/:skillId", async (req, res) => {
  try {
    const { userId } = (req as any).user;
    const { skillId } = req.params;
    const skill = await skillService.getSkill(skillId);

    if (!skill) return res.status(404).json({ message: "Skill not found" });
    if (skill.ownerId !== userId) return res.status(403).json({ message: "Not authorized" });
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

// Delete own private skill
router.delete("/:skillId", async (req, res) => {
  try {
    const { userId } = (req as any).user;
    const { skillId } = req.params;
    const skill = await skillService.getSkill(skillId);

    if (!skill) return res.status(404).json({ message: "Skill not found" });
    if (skill.ownerId !== userId) return res.status(403).json({ message: "Not authorized" });
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
    const userEmail = (req as any).user.email;
    const { skillId } = req.params;

    const skill = await skillService.submitForReview(skillId, userId);

    // Notify oncall
    emailService.sendOncallAlert(
      'Skill Submitted for Review',
      `User ${userEmail} submitted skill "${skill.name}" for platform review.`,
      { skillId: skill.skillId, skillName: skill.name, userId, userEmail }
    ).catch(err => console.error('Failed to send oncall alert for skill review:', err));

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
