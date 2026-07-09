import { Request, Response } from "express";
import { skillService } from "../services/skillService";
import { userDb } from "../services/db";
import { findTiersAllowingSkill } from "../services/subscriptionService";

// ENG-173: a published skill that is in no subscription tier's allowedSkills is
// invisible to every non-wildcard user (list_available_skills filters it out), so the
// tools it bundles are undiscoverable — the exact failure that produced a false
// "capability missing" report. Warn the publishing admin without mutating entitlement.
async function entitlementWarnings(skill: any): Promise<string[] | undefined> {
  if (!skill || !skill.isPublished || !skill.skillId) return undefined;
  const { reachable } = await findTiersAllowingSkill(skill.skillId);
  if (reachable) return undefined;
  return [
    `Skill "${skill.name ?? skill.skillId}" is published but not in any subscription tier's allowedSkills — it will be invisible to all non-wildcard users, and its tools undiscoverable to the agent. Add it to the relevant tiers in Admin → Subscriptions.`,
  ];
}

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

    const warnings = await entitlementWarnings(skill);
    res.status(201).json(warnings ? { ...skill, warnings } : skill);
  } catch (error) {
    console.error("Error creating skill:", error);
    res.status(500).json({ message: "Failed to create skill" });
  }
};

export const getAllSkills = async (req: Request, res: Response) => {
  try {
    const allSkills = await skillService.getAllSkills();

    // Enrich private/pending skills with owner email
    const ownerIds = [...new Set(
      allSkills
        .filter(s => (s.visibility === 'private' || s.visibility === 'pending_review') && s.ownerId)
        .map(s => s.ownerId!)
    )];
    const ownerMap = new Map<string, string>();
    await Promise.all(ownerIds.map(async (id) => {
      const user = await userDb.getUserById(id);
      if (user?.email) ownerMap.set(id, user.email);
    }));

    const enriched = allSkills.map(s =>
      s.ownerId && ownerMap.has(s.ownerId) ? { ...s, ownerEmail: ownerMap.get(s.ownerId) } : s
    );

    res.status(200).json(enriched);
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
    const { name, description, toolNames, systemPrompt, isPublished } = req.body;

    const existingSkill = await skillService.getSkill(skillId);
    if (!existingSkill) {
      return res.status(404).json({ message: "Skill not found" });
    }

    const updatedSkill = {
      ...existingSkill,
      ...(name !== undefined && { name }),
      ...(description !== undefined && { description }),
      ...(toolNames !== undefined && { toolNames }),
      ...(systemPrompt !== undefined && { systemPrompt }),
      ...(isPublished !== undefined && { isPublished }),
      skillId,
    };
    await skillService.updateSkill(updatedSkill);

    const warnings = await entitlementWarnings(updatedSkill);
    res.status(200).json(warnings ? { ...updatedSkill, warnings } : updatedSkill);
  } catch (error) {
    console.error("Error updating skill:", error);
    res.status(500).json({ message: "Failed to update skill" });
  }
};

export const getSyncStatus = async (req: Request, res: Response) => {
  try {
    const status = await skillService.getSyncStatus();
    const environment = process.env.NODE_ENV === "development" ? "development" : "production";
    res.status(200).json({ skills: status, environment });
  } catch (error) {
    console.error("Error getting sync status:", error);
    res.status(500).json({ message: "Failed to get sync status" });
  }
};

export const syncSkill = async (req: Request, res: Response) => {
  try {
    const { skillId, direction } = req.body;

    if (!skillId || !direction) {
      return res.status(400).json({ message: "skillId and direction are required" });
    }

    if (direction !== 'prod-to-dev' && direction !== 'dev-to-prod') {
      return res.status(400).json({ message: 'direction must be "prod-to-dev" or "dev-to-prod"' });
    }

    const isDev = process.env.NODE_ENV === "development";
    const allowedDirection = isDev ? "dev-to-prod" : "prod-to-dev";
    if (direction !== allowedDirection) {
      return res.status(400).json({ message: `In ${isDev ? "dev" : "prod"} environment, only "${allowedDirection}" sync is allowed` });
    }

    const skill = await skillService.syncSkill(skillId, direction);

    if (!skill) {
      return res.status(404).json({ message: "Skill not found in source table" });
    }

    res.status(200).json(skill);
  } catch (error) {
    console.error("Error syncing skill:", error);
    res.status(500).json({ message: "Failed to sync skill" });
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
