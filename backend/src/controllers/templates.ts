import { Request, Response } from 'express';
import { taskTemplateDb } from '../services/db';

interface AuthRequest extends Request {
  user?: { userId: string; email: string };
}

// Helper function to extract parameters from prompt
const extractParameters = (prompt: string): string[] => {
  const paramRegex = /\[([^\]]+)\]/g;
  const matches = prompt.match(paramRegex) || [];
  
  // Extract parameter names without brackets and remove duplicates
  return [...new Set(matches.map(match => match.slice(1, -1)))];
};

export const createTemplate = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const { name, description, prompt, isInteractive, isDeepResearch } = req.body;
    
    if (!name || !prompt) {
      return res.status(400).json({ message: 'Name and prompt are required' });
    }

    // Extract parameters from the prompt
    const parameters = extractParameters(prompt);

    const template = {
      templateId: Date.now().toString(),
      userId,
      name,
      description: description || '',
      prompt,
      parameters,
      isInteractive: Boolean(isInteractive),
      isDeepResearch: Boolean(isDeepResearch),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    const createdTemplate = await taskTemplateDb.createTemplate(template);
    res.status(201).json(createdTemplate);
  } catch (error) {
    console.error('Error in createTemplate:', error);
    res.status(500).json({ message: 'Error creating template' });
  }
};

export const getTemplates = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const templates = await taskTemplateDb.getTemplatesByUserId(userId);
    res.json(templates);
  } catch (error) {
    console.error('Error in getTemplates:', error);
    res.status(500).json({ message: 'Error fetching templates' });
  }
};

export const getTemplate = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const templateId = req.params.id;
    const template = await taskTemplateDb.getTemplateById(templateId);

    if (!template) {
      return res.status(404).json({ message: 'Template not found' });
    }

    // Check if user is the template owner
    if (template.userId !== userId) {
      return res.status(403).json({ message: 'Access denied' });
    }

    res.json(template);
  } catch (error) {
    console.error('Error in getTemplate:', error);
    res.status(500).json({ message: 'Error fetching template' });
  }
};

export const updateTemplate = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const templateId = req.params.id;
    const template = await taskTemplateDb.getTemplateById(templateId);

    if (!template) {
      return res.status(404).json({ message: 'Template not found' });
    }

    // Check if user is the template owner
    if (template.userId !== userId) {
      return res.status(403).json({ message: 'Access denied' });
    }

    const { name, description, prompt, isInteractive, isDeepResearch } = req.body;
    
    const updates: any = {};
    if (name !== undefined) updates.name = name;
    if (description !== undefined) updates.description = description;
    
    // If prompt is updated, extract parameters
    if (prompt !== undefined) {
      updates.prompt = prompt;
      updates.parameters = extractParameters(prompt);
    }
    
    if (isInteractive !== undefined) updates.isInteractive = Boolean(isInteractive);
    if (isDeepResearch !== undefined) updates.isDeepResearch = Boolean(isDeepResearch);

    const updatedTemplate = await taskTemplateDb.updateTemplate(templateId, updates);
    res.json(updatedTemplate);
  } catch (error) {
    console.error('Error in updateTemplate:', error);
    res.status(500).json({ message: 'Error updating template' });
  }
};

export const deleteTemplate = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const templateId = req.params.id;
    const template = await taskTemplateDb.getTemplateById(templateId);

    if (!template) {
      return res.status(404).json({ message: 'Template not found' });
    }

    // Check if user is the template owner
    if (template.userId !== userId) {
      return res.status(403).json({ message: 'Access denied' });
    }

    await taskTemplateDb.deleteTemplate(templateId);
    res.status(204).send();
  } catch (error) {
    console.error('Error in deleteTemplate:', error);
    res.status(500).json({ message: 'Error deleting template' });
  }
}; 