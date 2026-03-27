import express from "express";
import { v4 as uuidv4 } from "uuid";
import { scheduleTemplateService } from "../services/scheduleTemplateService";
import { scheduleTemplateDb } from "../services/db";

const router = express.Router();

// Get all schedule templates
router.get("/", async (req, res) => {
  try {
    const templates = await scheduleTemplateService.getAllTemplates();
    res.json(templates);
  } catch (error) {
    console.error("Error fetching all schedule templates:", error);
    res.status(500).json({ message: "Failed to fetch schedule templates" });
  }
});

// Get pending review queue
router.get("/pending-review", async (req, res) => {
  try {
    const templates = await scheduleTemplateService.getTemplatesByVisibility('pending_review');
    res.json(templates);
  } catch (error) {
    console.error("Error fetching pending review templates:", error);
    res.status(500).json({ message: "Failed to fetch pending review templates" });
  }
});

// Get a specific template
router.get("/:templateId", async (req, res) => {
  try {
    const template = await scheduleTemplateService.getTemplateById(req.params.templateId);
    if (!template) return res.status(404).json({ message: "Template not found" });
    res.json(template);
  } catch (error) {
    console.error("Error fetching schedule template:", error);
    res.status(500).json({ message: "Failed to fetch schedule template" });
  }
});

// Create template (admin can set any visibility, defaults to system)
router.post("/", async (req, res) => {
  try {
    const {
      name, description, category, visibility,
      startingMessage, variables, keywords,
      requiredFunctionCalls, functionCallMinCalls,
      suggestedFrequency, frequencyIntervalDays,
      emailNotifications, dailyDigest, llmModel,
    } = req.body;

    if (!name || !startingMessage) {
      return res.status(400).json({ message: "name and startingMessage are required" });
    }

    // Extract variables from message
    const variableRegex = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g;
    const messageVarNames = new Set<string>();
    let match;
    while ((match = variableRegex.exec(startingMessage)) !== null) {
      messageVarNames.add(match[1]);
    }
    const inputVars = Array.isArray(variables) ? variables : [];
    const normalizedVariables = Array.from(messageVarNames).map(varName => {
      const existing = inputVars.find((v: any) => v.name === varName);
      return { name: varName, description: existing?.description || '', type: existing?.type || 'text' };
    });

    const user = (req as any).user;
    const now = new Date().toISOString();

    const template = {
      templateId: uuidv4(),
      createdBy: user.userId,
      name,
      description: description || '',
      category: category || 'General',
      visibility: (visibility || 'system') as 'system' | 'private' | 'public' | 'pending_review',
      startingMessage,
      variables: normalizedVariables,
      keywords: keywords || [],
      requiredFunctionCalls: requiredFunctionCalls || [],
      functionCallMinCalls: functionCallMinCalls || {},
      suggestedFrequency: suggestedFrequency || 'daily',
      ...(suggestedFrequency === 'every_n_days' && { frequencyIntervalDays }),
      emailNotifications: emailNotifications || [],
      dailyDigest: dailyDigest || false,
      llmModel: llmModel || '',
      usageCount: 0,
      createdAt: now,
      updatedAt: now,
    };

    await scheduleTemplateDb.createTemplate(template);
    res.status(201).json(template);
  } catch (error) {
    console.error("Error creating admin schedule template:", error);
    res.status(500).json({ message: "Failed to create schedule template" });
  }
});

// Update any template
router.put("/:templateId", async (req, res) => {
  try {
    const existing = await scheduleTemplateService.getTemplateById(req.params.templateId);
    if (!existing) return res.status(404).json({ message: "Template not found" });

    const {
      name, description, category, visibility,
      startingMessage, variables, keywords,
      requiredFunctionCalls, functionCallMinCalls,
      suggestedFrequency, frequencyIntervalDays,
      emailNotifications, dailyDigest, llmModel,
    } = req.body;

    const updates: any = { updatedAt: new Date().toISOString() };

    if (name !== undefined) updates.name = name;
    if (description !== undefined) updates.description = description;
    if (category !== undefined) updates.category = category;
    if (visibility !== undefined) updates.visibility = visibility;
    if (keywords !== undefined) updates.keywords = keywords;
    if (requiredFunctionCalls !== undefined) updates.requiredFunctionCalls = requiredFunctionCalls;
    if (functionCallMinCalls !== undefined) updates.functionCallMinCalls = functionCallMinCalls;
    if (suggestedFrequency !== undefined) updates.suggestedFrequency = suggestedFrequency;
    if (frequencyIntervalDays !== undefined) updates.frequencyIntervalDays = frequencyIntervalDays;
    if (emailNotifications !== undefined) updates.emailNotifications = emailNotifications;
    if (dailyDigest !== undefined) updates.dailyDigest = dailyDigest;
    if (llmModel !== undefined) updates.llmModel = llmModel;

    if (startingMessage !== undefined) {
      updates.startingMessage = startingMessage;
      const variableRegex = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g;
      const messageVarNames = new Set<string>();
      let match;
      while ((match = variableRegex.exec(startingMessage)) !== null) {
        messageVarNames.add(match[1]);
      }
      const inputVars = Array.isArray(variables) ? variables : (existing.variables || []);
      updates.variables = Array.from(messageVarNames).map(varName => {
        const existingVar = inputVars.find((v: any) => v.name === varName);
        return { name: varName, description: existingVar?.description || '', type: existingVar?.type || 'text' };
      });
    } else if (variables !== undefined) {
      updates.variables = variables;
    }

    const updated = await scheduleTemplateDb.updateTemplate(req.params.templateId, updates);
    res.json(updated || { ...existing, ...updates });
  } catch (error) {
    console.error("Error updating admin schedule template:", error);
    res.status(500).json({ message: "Failed to update schedule template" });
  }
});

// Delete any template
router.delete("/:templateId", async (req, res) => {
  try {
    const existing = await scheduleTemplateService.getTemplateById(req.params.templateId);
    if (!existing) return res.status(404).json({ message: "Template not found" });

    await scheduleTemplateDb.deleteTemplate(req.params.templateId);
    res.json({ message: "Schedule template deleted successfully" });
  } catch (error) {
    console.error("Error deleting admin schedule template:", error);
    res.status(500).json({ message: "Failed to delete schedule template" });
  }
});

// Approve a template
router.post("/:templateId/approve", async (req, res) => {
  try {
    const template = await scheduleTemplateService.approveTemplate(req.params.templateId);
    res.json(template);
  } catch (error: any) {
    if (error.message === 'Template not found') return res.status(404).json({ message: error.message });
    if (error.message === 'Template is not pending review') return res.status(400).json({ message: error.message });
    console.error("Error approving schedule template:", error);
    res.status(500).json({ message: "Failed to approve schedule template" });
  }
});

// Reject a template
router.post("/:templateId/reject", async (req, res) => {
  try {
    const { feedback } = req.body;
    if (!feedback) return res.status(400).json({ message: "Feedback is required when rejecting" });

    const template = await scheduleTemplateService.rejectTemplate(req.params.templateId, feedback);
    res.json(template);
  } catch (error: any) {
    if (error.message === 'Template not found') return res.status(404).json({ message: error.message });
    if (error.message === 'Template is not pending review') return res.status(400).json({ message: error.message });
    console.error("Error rejecting schedule template:", error);
    res.status(500).json({ message: "Failed to reject schedule template" });
  }
});

export default router;
