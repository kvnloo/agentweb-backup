import { Request, Response } from 'express';
import { taskTemplateDb, userDb } from '../services/db';

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


    const { name, description, prompt, isInteractive, isDeepResearch, nameParameter, category, outputAsJson, outputAsHtml, isComplexTask, selectedLLMs, useSharedBrowser, turnOffHeadless, useKnowledgeBase, updateKnowledgeBase, updateLeadList, isAgenticDevMode } = req.body;

    if (!name || !prompt) {
      return res.status(400).json({ message: 'Name and prompt are required' });
    }

    // Extract parameters from the prompt
    const parameters = extractParameters(prompt);

    if (isDeepResearch) {
      console.warn('[ENG-805] isDeepResearch requested but forced false', { userId, source: 'createTemplate' });
    }

    // Validate nameParameter is one of the extracted parameters or null
    if (nameParameter && !parameters.includes(nameParameter)) {
      return res.status(400).json({ 
        message: 'Name parameter must be one of the parameters in the prompt' 
      });
    }

    const template = {
      templateId: Date.now().toString(),
      userId,
      name,
      description: description || '',
      prompt,
      parameters,
      nameParameter: nameParameter || null,
      isInteractive: Boolean(isInteractive),
      // Deep research was deprecated in agent-engine 2026-01-01 (e94a8e4a) -
      // any task/template flagged true will always fail there and page
      // oncall for a permanent, non-actionable failure. Never persist true.
      isDeepResearch: false,
      published: false, // New templates are not published by default
      outputAsJson: outputAsJson ? true : (outputAsHtml ? false : false), // Handle mutual exclusivity
      outputAsHtml: outputAsHtml ? true : (outputAsJson ? false : false), // Handle mutual exclusivity
      isComplexTask: Boolean(isComplexTask), // Added isComplexTask
      useSharedBrowser: Boolean(useSharedBrowser), // ADDED useSharedBrowser
      useKnowledgeBase: Boolean(useKnowledgeBase),
      updateKnowledgeBase: Boolean(updateKnowledgeBase),
      updateLeadList: Boolean(updateLeadList),
      isAgenticDevMode: Boolean(isAgenticDevMode),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      category: category || undefined, // Add category, default to undefined if not provided
      selectedLLMs: selectedLLMs || [] // Add selectedLLMs, default to empty array
    };

    const createdTemplate = await taskTemplateDb.createTemplate(template as any); // Cast to any for now if TaskTemplate type in db.ts isn't updated by this model yet
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

    // Get user to check if admin
    const user = await userDb.getUserById(userId);
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    // Get user's own templates
    const userTemplates = await taskTemplateDb.getTemplatesByUserId(userId);
    
    // If user is admin, also get all published templates
    let publishedTemplates: any[] = [];
    if (user.isAdmin) {
      publishedTemplates = await taskTemplateDb.getAllTemplates();
    } else {
      // For non-admin users, get all published templates by other users
      publishedTemplates = await taskTemplateDb.getPublishedTemplates();
    }
    
    // Combine user's templates with published templates, removing duplicates
    const allTemplates = [...userTemplates];
    
    // Add published templates that aren't already in the user's templates
    publishedTemplates.forEach(template => {
      if (template.userId !== userId && template.published) {
        allTemplates.push(template);
      }
    });
    
    res.json(allTemplates);
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

    // Get user to check if admin
    const user = await userDb.getUserById(userId);
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    // Check if user is the template owner or if the template is published or if user is admin
    if (template.userId !== userId && !template.published && !user.isAdmin) {
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

    // Get user to check if admin
    const user = await userDb.getUserById(userId);
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    // Check if user is the template owner or admin
    if (template.userId !== userId && !user.isAdmin) {
      return res.status(403).json({ message: 'Access denied' });
    }

    const { name, description, prompt, isInteractive, isDeepResearch, isComplexTask, published, nameParameter, category, outputAsJson, outputAsHtml, selectedLLMs, useSharedBrowser, turnOffHeadless, useKnowledgeBase, updateKnowledgeBase, updateLeadList, isAgenticDevMode } = req.body;

    const updates: any = {};
    if (name !== undefined) updates.name = name;
    if (description !== undefined) updates.description = description;
    if (category !== undefined) updates.category = category;
    
    // If prompt is updated, extract parameters
    if (prompt !== undefined) {
      updates.prompt = prompt;
      const newParameters = extractParameters(prompt);
      updates.parameters = newParameters;
      
      // If nameParameter is provided, validate it's in the new parameters
      if (nameParameter !== undefined) {
        if (nameParameter && !newParameters.includes(nameParameter)) {
          return res.status(400).json({ 
            message: 'Name parameter must be one of the parameters in the prompt' 
          });
        }
        updates.nameParameter = nameParameter || null;
      } else if (template.nameParameter && !newParameters.includes(template.nameParameter)) {
        // If existing nameParameter is no longer in the parameters, set it to null
        updates.nameParameter = null;
      }
    } else if (nameParameter !== undefined) {
      // If prompt is not updated but nameParameter is
      if (nameParameter && !template.parameters.includes(nameParameter)) {
        return res.status(400).json({ 
          message: 'Name parameter must be one of the parameters in the prompt' 
        });
      }
      updates.nameParameter = nameParameter || null;
    }
    
    if (isInteractive !== undefined) updates.isInteractive = Boolean(isInteractive);
    // Deep research was deprecated in agent-engine 2026-01-01 (e94a8e4a) -
    // never allow it to be turned back on, only ever off.
    if (isDeepResearch !== undefined) {
      updates.isDeepResearch = false;
      if (isDeepResearch) {
        console.warn('[ENG-805] isDeepResearch requested but forced false', { userId, templateId, source: 'updateTemplate' });
      }
    }
    if (isComplexTask !== undefined) updates.isComplexTask = Boolean(isComplexTask);
    
    // Handle outputAsJson and outputAsHtml mutual exclusivity
    if (outputAsJson !== undefined) {
      updates.outputAsJson = Boolean(outputAsJson);
      if (updates.outputAsJson) {
        updates.outputAsHtml = false; // If JSON is true, HTML must be false
      }
    }
    // Check outputAsHtml only if outputAsJson wasn't set to true in this update
    if (outputAsHtml !== undefined) updates.outputAsHtml = outputAsHtml ? true : (updates.outputAsJson === undefined ? template.outputAsJson : updates.outputAsJson) ? false : false;
    
    if (selectedLLMs !== undefined) updates.selectedLLMs = selectedLLMs;
    if (useSharedBrowser !== undefined) updates.useSharedBrowser = Boolean(useSharedBrowser);
    if (turnOffHeadless !== undefined) updates.turnOffHeadless = Boolean(turnOffHeadless);
    if (useKnowledgeBase !== undefined) updates.useKnowledgeBase = Boolean(useKnowledgeBase);
    if (updateKnowledgeBase !== undefined) updates.updateKnowledgeBase = Boolean(updateKnowledgeBase);
    if (updateLeadList !== undefined) updates.updateLeadList = Boolean(updateLeadList);
    if (isAgenticDevMode !== undefined) updates.isAgenticDevMode = Boolean(isAgenticDevMode);
    
    // Only allow admins to update the published status
    if (published !== undefined && user.isAdmin) {
      updates.published = Boolean(published);
    }

    const updatedTemplate = await taskTemplateDb.updateTemplate(templateId, updates);
    res.json(updatedTemplate);
  } catch (error) {
    console.error('Error in updateTemplate:', error);
    res.status(500).json({ message: 'Error updating template' });
  }
};

export const publishTemplate = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    // Get user to check if admin
    const user = await userDb.getUserById(userId);
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    // Only admins can publish templates
    if (!user.isAdmin) {
      return res.status(403).json({ message: 'Only admins can publish templates' });
    }

    const templateId = req.params.id;
    const template = await taskTemplateDb.getTemplateById(templateId);

    if (!template) {
      return res.status(404).json({ message: 'Template not found' });
    }

    const { published } = req.body;
    if (published === undefined) {
      return res.status(400).json({ message: 'Published status is required' });
    }

    const updatedTemplate = await taskTemplateDb.updateTemplate(templateId, {
      published: Boolean(published)
    });

    res.json(updatedTemplate);
  } catch (error) {
    console.error('Error in publishTemplate:', error);
    res.status(500).json({ message: 'Error publishing template' });
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

    // Get user to check if admin
    const user = await userDb.getUserById(userId);
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    // Check if user is the template owner or admin
    if (template.userId !== userId && !user.isAdmin) {
      return res.status(403).json({ message: 'Access denied' });
    }

    await taskTemplateDb.deleteTemplate(templateId);
    res.status(204).send();
  } catch (error) {
    console.error('Error in deleteTemplate:', error);
    res.status(500).json({ message: 'Error deleting template' });
  }
}; 