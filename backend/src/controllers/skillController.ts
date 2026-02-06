import { Request, Response } from "express";
import { skillService } from "../services/skillService";

export const createSkill = async (req: Request, res: Response) => {
  try {
    const { name, description, toolNames, systemPrompt, isPublished } = req.body;
    
    if (!name || !description) {
      return res.status(400).json({ message: "Name and description are required" });
    }

    const skill = await skillService.createSkill(
          name,
          description,
          toolNames || [],
          systemPrompt,
          isPublished
    );

    res.status(201).json(skill);
  } catch (error) {
    console.error("Error creating skill:", error);
    res.status(500).json({ message: "Failed to create skill" });
  }
};

export const getAllSkills = async (req: Request, res: Response) => {
  try {
    const allSkills = await skillService.getAllSkills();
    res.status(200).json(allSkills);
  } catch (error) {
    console.error("Error fetching skills:", error);
    res.status(500).json({ message: "Failed to fetch skills" });
  }
};

export const getSkill = async (req: Request, res: Response) => {
  try {
    const { skillId } = req.params;
    const skill = await skillService.getSkill(skillId);
    
    if (!skill) {
      return res.status(404).json({ message: "Skill not found" });
    }

    res.status(200).json(skill);
  } catch (error) {
    console.error("Error fetching skill:", error);
    res.status(500).json({ message: "Failed to fetch skill" });
  }
};

export const updateSkill = async (req: Request, res: Response) => {
  try {
    const { skillId } = req.params;
    const updates = req.body;

    const existingSkill = await skillService.getSkill(skillId);
    if (!existingSkill) {
      return res.status(404).json({ message: "Skill not found" });
    }

    const updatedSkill = { ...existingSkill, ...updates, skillId }; // Ensure ID matches
    await skillService.updateSkill(updatedSkill);

    res.status(200).json(updatedSkill);
  } catch (error) {
    console.error("Error updating skill:", error);
    res.status(500).json({ message: "Failed to update skill" });
  }
};

export const deleteSkill = async (req: Request, res: Response) => {
  try {
    const { skillId } = req.params;
    
    const existingSkill = await skillService.getSkill(skillId);
    if (!existingSkill) {
      return res.status(404).json({ message: "Skill not found" });
    }

    await skillService.deleteSkill(skillId);
    res.status(200).json({ message: "Skill deleted successfully" });
  } catch (error) {
    console.error("Error deleting skill:", error);
    res.status(500).json({ message: "Failed to delete skill" });
  }
};
