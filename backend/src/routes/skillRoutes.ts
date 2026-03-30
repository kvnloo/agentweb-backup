import express from "express";
import {
  createSkill,
  getAllSkills,
  getSkill,
  updateSkill,
  deleteSkill,
  syncSkill,
  getSyncStatus,
} from "../controllers/skillController";
import { skillService } from "../services/skillService";

const router = express.Router();

// Get all skills
router.get("/", getAllSkills);

// Create a new skill
router.post("/", createSkill);

// Get pending review queue
router.get("/pending-review", async (req, res) => {
  try {
    const skills = await skillService.getSkillsByVisibility('pending_review');
    res.json(skills);
  } catch (error) {
    console.error("Error fetching pending review skills:", error);
    res.status(500).json({ message: "Failed to fetch pending review skills" });
  }
});

// Approve a skill
router.post("/:skillId/approve", async (req, res) => {
  try {
    const skill = await skillService.approveSkill(req.params.skillId);
    res.json(skill);
  } catch (error: any) {
    if (error.message === 'Skill not found') return res.status(404).json({ message: error.message });
    if (error.message === 'Skill is not pending review') return res.status(400).json({ message: error.message });
    console.error("Error approving skill:", error);
    res.status(500).json({ message: "Failed to approve skill" });
  }
});

// Reject a skill
router.post("/:skillId/reject", async (req, res) => {
  try {
    const { feedback } = req.body;
    if (!feedback) return res.status(400).json({ message: "Feedback is required when rejecting" });

    const skill = await skillService.rejectSkill(req.params.skillId, feedback);
    res.json(skill);
  } catch (error: any) {
    if (error.message === 'Skill not found') return res.status(404).json({ message: error.message });
    if (error.message === 'Skill is not pending review') return res.status(400).json({ message: error.message });
    console.error("Error rejecting skill:", error);
    res.status(500).json({ message: "Failed to reject skill" });
  }
});

// Get sync status for all skills (compares prod vs dev)
router.get("/sync-status", getSyncStatus);

// Sync a skill between prod and dev tables
router.post("/sync", syncSkill);

// Get a specific skill
router.get("/:skillId", getSkill);

// Update a specific skill
router.put("/:skillId", updateSkill);

// Delete a specific skill
router.delete("/:skillId", deleteSkill);

export default router;
