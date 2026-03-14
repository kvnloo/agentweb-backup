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

const router = express.Router();

// Get all skills
router.get("/", getAllSkills);

// Create a new skill
router.post("/", createSkill);

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
