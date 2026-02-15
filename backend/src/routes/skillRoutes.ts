import express from "express";
import {
  createSkill,
  getAllSkills,
  getSkill,
  updateSkill,
  deleteSkill
} from "../controllers/skillController";

const router = express.Router();

// Get all skills
router.get("/", getAllSkills);

// Create a new skill
router.post("/", createSkill);

// Get a specific skill
router.get("/:skillId", getSkill);

// Update a specific skill
router.put("/:skillId", updateSkill);

// Delete a specific skill
router.delete("/:skillId", deleteSkill);

export default router;
