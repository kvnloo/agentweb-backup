import express from 'express';
import { settingsService } from '../services/settingsService';
import { authenticateToken, requireAdmin } from '../middleware/auth';

const router = express.Router();

// Function to extract variables from HTML content and subject
const extractVariables = (htmlContent: string, subject?: string): { variables: string[], arrayVariables: string[] } => {
  const variableRegex = /\{\{([^}]+)\}\}/g;
  const allVariables: string[] = [];
  const regularVariables: string[] = [];
  const arrayVariableNames = new Set<string>();
  let match;

  // Collect all variables from HTML content
  while ((match = variableRegex.exec(htmlContent)) !== null) {
    const variable = match[1].trim();
    if (!allVariables.includes(variable)) {
      allVariables.push(variable);
    }
  }

  // Also collect variables from subject if provided
  if (subject) {
    const subjectRegex = /\{\{([^}]+)\}\}/g;
    let subjectMatch;
    while ((subjectMatch = subjectRegex.exec(subject)) !== null) {
      const variable = subjectMatch[1].trim();
      if (!allVariables.includes(variable)) {
        allVariables.push(variable);
      }
    }
  }

  // Find all _n and _n_ patterns first
  const nPatterns = new Set<string>();
  allVariables.forEach(variable => {
    const nMatch = variable.match(/^(.+)_n(?:_(.+))?$/);
    if (nMatch) {
      const baseName = nMatch[1];
      const suffix = nMatch[2];
      if (suffix) {
        nPatterns.add(`${baseName}_n_${suffix}`);
      } else {
        nPatterns.add(`${baseName}_n`);
      }
    }
  });

  // Now process all variables
  const processedArrayNames = new Set<string>();

  allVariables.forEach(variable => {
    let isArrayVariable = false;

    // Check if this variable matches any _n pattern
    nPatterns.forEach(nPattern => {
      const baseName = nPattern.replace(/_n.*$/, '');
      const numericMatch = variable.match(new RegExp(`^${baseName}_(\\d+)(?:_|$)`));
      if (numericMatch) {
        if (!processedArrayNames.has(nPattern)) {
          arrayVariableNames.add(nPattern);
          processedArrayNames.add(nPattern);
        }
        isArrayVariable = true;
      }
    });

    // Check if this is already an _n pattern
    const nMatch = variable.match(/^(.+)_n(?:_(.+))?$/);
    if (nMatch) {
      const baseName = nMatch[1];
      const suffix = nMatch[2];
      const fullName = suffix ? `${baseName}_n_${suffix}` : `${baseName}_n`;
      if (!processedArrayNames.has(fullName)) {
        arrayVariableNames.add(fullName);
        processedArrayNames.add(fullName);
      }
      isArrayVariable = true;
    }

    if (!isArrayVariable) {
      regularVariables.push(variable);
    }
  });

  return { variables: regularVariables, arrayVariables: Array.from(arrayVariableNames) };
};

// Get all settings
router.get('/', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const settings = await settingsService.getAllSettings();
    res.json(settings);
  } catch (error) {
    console.error('Error getting settings:', error);
    res.status(500).json({ error: 'Failed to get settings' });
  }
});

// Email Templates endpoints (customer accessible) - MUST be before /:settingName route

// Get all email templates for a user
router.get('/email-templates', authenticateToken, async (req, res) => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    
    const settingName = `email_templates_${userId}`;
    const setting = await settingsService.getSetting(settingName);
    
    let templates = [];
    if (setting) {
      try {
        templates = JSON.parse(setting.settingValue);
        
        // Add backward compatibility: extract variables for templates that don't have them
        let needsUpdate = false;
        templates = templates.map((template: any) => {
          if (!template.variables || !template.arrayVariables) {
            const { variables, arrayVariables } = extractVariables(template.html_content, template.subject);
            needsUpdate = true;
            return {
              ...template,
              variables: template.variables || variables,
              arrayVariables: template.arrayVariables || arrayVariables
            };
          }
          return template;
        });
        
        // If we updated any templates, save them back to the database
        if (needsUpdate) {
          try {
            await settingsService.setSetting(
              settingName, 
              JSON.stringify(templates), 
              'User email templates', 
              req.user?.email
            );
          } catch (error) {
            console.error('Error updating templates with variables:', error);
            // Don't fail the request, just log the error
          }
        }
      } catch (error) {
        console.error('Error parsing email templates:', error);
        templates = [];
      }
    }
    
    res.json({ templates });
  } catch (error) {
    console.error('Error getting email templates:', error);
    res.status(500).json({ error: 'Failed to get email templates' });
  }
});

// Create or update an email template
router.post('/email-templates', authenticateToken, async (req, res) => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    
    const { template_name, subject, html_content, variables, arrayVariables } = req.body;
    
    if (!template_name || !subject || !html_content) {
      return res.status(400).json({ 
        error: 'template_name, subject, and html_content are required' 
      });
    }
    
    const settingName = `email_templates_${userId}`;
    const existingSetting = await settingsService.getSetting(settingName);
    
    let templates = [];
    if (existingSetting) {
      try {
        templates = JSON.parse(existingSetting.settingValue);
      } catch (error) {
        console.error('Error parsing existing templates:', error);
        templates = [];
      }
    }
    
    // Use provided variables if available, otherwise extract them
    let finalVariables = variables;
    let finalArrayVariables = arrayVariables;
    if (!finalVariables || !finalArrayVariables) {
      const extracted = extractVariables(html_content, subject);
      finalVariables = extracted.variables;
      finalArrayVariables = extracted.arrayVariables;
    }
    
    // Check if template already exists
    const existingTemplateIndex = templates.findIndex(
      (t: any) => t.template_name === template_name
    );
    
    const newTemplate = {
      template_name,
      subject,
      html_content,
      variables: finalVariables,
      arrayVariables: finalArrayVariables,
      created_at: existingTemplateIndex >= 0 ? templates[existingTemplateIndex].created_at : new Date().toISOString(),
      updated_at: new Date().toISOString()
    };
    
    if (existingTemplateIndex >= 0) {
      templates[existingTemplateIndex] = newTemplate;
    } else {
      templates.push(newTemplate);
    }
    
    await settingsService.setSetting(
      settingName, 
      JSON.stringify(templates), 
      'User email templates', 
      req.user?.email
    );
    
    res.json({ 
      success: true, 
      message: 'Email template saved successfully',
      template: newTemplate
    });
  } catch (error) {
    console.error('Error saving email template:', error);
    res.status(500).json({ error: 'Failed to save email template' });
  }
});

// Delete an email template
router.delete('/email-templates/:templateName', authenticateToken, async (req, res) => {
  try {
    const userId = req.user?.userId;
    const { templateName } = req.params;
    
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    
    if (!templateName) {
      return res.status(400).json({ error: 'templateName is required' });
    }
    
    const settingName = `email_templates_${userId}`;
    const existingSetting = await settingsService.getSetting(settingName);
    
    if (!existingSetting) {
      return res.status(404).json({ error: 'No templates found' });
    }
    
    let templates = [];
    try {
      templates = JSON.parse(existingSetting.settingValue);
    } catch (error) {
      console.error('Error parsing templates:', error);
      return res.status(500).json({ error: 'Failed to parse templates' });
    }
    
    const initialLength = templates.length;
    templates = templates.filter((t: any) => t.template_name !== templateName);
    
    if (templates.length < initialLength) {
      await settingsService.setSetting(
        settingName, 
        JSON.stringify(templates), 
        'User email templates', 
        req.user?.email
      );
    }
    
    res.json({ 
      success: true, 
      message: 'Email template deleted successfully' 
    });
  } catch (error) {
    console.error('Error deleting email template:', error);
    res.status(500).json({ error: 'Failed to delete email template' });
  }
});

// Get a specific setting
router.get('/:settingName', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { settingName } = req.params;
    const setting = await settingsService.getSetting(settingName);
    
    if (!setting) {
      return res.status(404).json({ error: 'Setting not found' });
    }
    
    res.json(setting);
  } catch (error) {
    console.error('Error getting setting:', error);
    res.status(500).json({ error: 'Failed to get setting' });
  }
});

// Create or update a setting
router.post('/', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { settingName, settingValue, description } = req.body;
    const updatedBy = req.user?.email || 'unknown';
    
    if (!settingName || !settingValue) {
      return res.status(400).json({ error: 'settingName and settingValue are required' });
    }
    
    const setting = await settingsService.setSetting(settingName, settingValue, description, updatedBy);
    res.json(setting);
  } catch (error) {
    console.error('Error setting setting:', error);
    res.status(500).json({ error: 'Failed to set setting' });
  }
});

// Update a specific setting
router.put('/:settingName', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { settingName } = req.params;
    const { settingValue, description } = req.body;
    const updatedBy = req.user?.email || 'unknown';
    
    if (settingValue === undefined) {
      return res.status(400).json({ error: 'settingValue is required' });
    }
    
    const setting = await settingsService.setSetting(settingName, settingValue, description, updatedBy);
    res.json(setting);
  } catch (error) {
    console.error('Error updating setting:', error);
    res.status(500).json({ error: 'Failed to update setting' });
  }
});

// Delete a setting
router.delete('/:settingName', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { settingName } = req.params;
    
    await settingsService.deleteSetting(settingName);
    res.json({ success: true, message: 'Setting deleted successfully' });
  } catch (error) {
    console.error('Error deleting setting:', error);
    res.status(500).json({ error: 'Failed to delete setting' });
  }
});

// Individual Work Plan endpoints - MUST be before /:settingName route to avoid conflicts
// These endpoints allow saving individual work plans to prevent conflicts when multiple admins edit different plans

// Get a specific work plan by ID
router.get('/agent-mode-predefined-workplans/:planId', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { planId } = req.params;
    const setting = await settingsService.getSetting('agent-mode-predefined-workplans');
    
    if (!setting || !setting.settingValue) {
      return res.status(404).json({ error: 'No predefined work plans found' });
    }
    
    const workPlans = JSON.parse(setting.settingValue);
    const workPlan = workPlans.find((wp: any) => wp.id === planId);
    
    if (!workPlan) {
      return res.status(404).json({ error: 'Work plan not found' });
    }
    
    res.json(workPlan);
  } catch (error) {
    console.error('Error getting work plan:', error);
    res.status(500).json({ error: 'Failed to get work plan' });
  }
});

// Create a new work plan
router.post('/agent-mode-predefined-workplans', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const workPlan = req.body;
    const updatedBy = req.user?.email || 'unknown';
    
    if (!workPlan.title || !workPlan.steps || !Array.isArray(workPlan.steps)) {
      return res.status(400).json({ error: 'title and steps are required' });
    }
    
    // Generate ID if not provided
    if (!workPlan.id) {
      workPlan.id = `plan_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    }
    
    // Validate and normalize the work plan
    const validatedWorkPlan = {
      id: workPlan.id,
      title: workPlan.title.trim(),
      welcomeMessage: workPlan.welcomeMessage?.trim() || undefined,
      autocomplete: workPlan.autocomplete || false,
      requireLogin: workPlan.requireLogin || false,
      showLoginSignup: workPlan.showLoginSignup || 'after_plan_completed',
      steps: workPlan.steps
        .filter((step: any) => step.title && step.title.trim().length > 0)
        .map((step: any, index: number) => ({
          stepCount: index + 1,
          title: step.title.trim(),
          description: step.description?.trim() || undefined,
          requiredFunctionCalls: step.requiredFunctionCalls?.filter((f: string) => f.trim().length > 0) || undefined
        }))
    };
    
    if (validatedWorkPlan.title.length === 0 || validatedWorkPlan.steps.length === 0) {
      return res.status(400).json({ error: 'Work plan must have a title and at least one step' });
    }
    
    // Get existing work plans
    const setting = await settingsService.getSetting('agent-mode-predefined-workplans');
    let workPlans = [];
    
    if (setting && setting.settingValue) {
      try {
        workPlans = JSON.parse(setting.settingValue);
      } catch (error) {
        console.error('Error parsing existing work plans:', error);
        workPlans = [];
      }
    }
    
    // Check if ID already exists
    if (workPlans.some((wp: any) => wp.id === validatedWorkPlan.id)) {
      return res.status(409).json({ error: 'Work plan with this ID already exists' });
    }
    
    // Add the new work plan
    workPlans.push(validatedWorkPlan);
    
    // Save back to settings
    await settingsService.setSetting(
      'agent-mode-predefined-workplans',
      JSON.stringify(workPlans),
      'Agent Mode predefined work plans for Emma AI assistant',
      updatedBy
    );
    
    res.json({ success: true, workPlan: validatedWorkPlan });
  } catch (error) {
    console.error('Error creating work plan:', error);
    res.status(500).json({ error: 'Failed to create work plan' });
  }
});

// Update a specific work plan
router.put('/agent-mode-predefined-workplans/:planId', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { planId } = req.params;
    const workPlan = req.body;
    const updatedBy = req.user?.email || 'unknown';
    
    if (!workPlan.title || !workPlan.steps || !Array.isArray(workPlan.steps)) {
      return res.status(400).json({ error: 'title and steps are required' });
    }
    
    // Get existing work plans
    const setting = await settingsService.getSetting('agent-mode-predefined-workplans');
    
    if (!setting || !setting.settingValue) {
      return res.status(404).json({ error: 'No predefined work plans found' });
    }
    
    let workPlans = [];
    try {
      workPlans = JSON.parse(setting.settingValue);
    } catch (error) {
      console.error('Error parsing existing work plans:', error);
      return res.status(500).json({ error: 'Failed to parse existing work plans' });
    }
    
    // Find the work plan index
    const planIndex = workPlans.findIndex((wp: any) => wp.id === planId);
    
    if (planIndex === -1) {
      return res.status(404).json({ error: 'Work plan not found' });
    }
    
    // Validate and normalize the work plan
    const validatedWorkPlan = {
      id: planId, // Preserve the ID
      title: workPlan.title.trim(),
      welcomeMessage: workPlan.welcomeMessage?.trim() || undefined,
      autocomplete: workPlan.autocomplete || false,
      requireLogin: workPlan.requireLogin || false,
      showLoginSignup: workPlan.showLoginSignup || 'after_plan_completed',
      steps: workPlan.steps
        .filter((step: any) => step.title && step.title.trim().length > 0)
        .map((step: any, index: number) => ({
          stepCount: index + 1,
          title: step.title.trim(),
          description: step.description?.trim() || undefined,
          requiredFunctionCalls: step.requiredFunctionCalls?.filter((f: string) => f.trim().length > 0) || undefined
        }))
    };
    
    if (validatedWorkPlan.title.length === 0 || validatedWorkPlan.steps.length === 0) {
      return res.status(400).json({ error: 'Work plan must have a title and at least one step' });
    }
    
    // Update the work plan in the array
    workPlans[planIndex] = validatedWorkPlan;
    
    // Save back to settings
    await settingsService.setSetting(
      'agent-mode-predefined-workplans',
      JSON.stringify(workPlans),
      'Agent Mode predefined work plans for Emma AI assistant',
      updatedBy
    );
    
    res.json({ success: true, workPlan: validatedWorkPlan });
  } catch (error) {
    console.error('Error updating work plan:', error);
    res.status(500).json({ error: 'Failed to update work plan' });
  }
});

// Delete a specific work plan
router.delete('/agent-mode-predefined-workplans/:planId', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { planId } = req.params;
    const updatedBy = req.user?.email || 'unknown';
    
    // Get existing work plans
    const setting = await settingsService.getSetting('agent-mode-predefined-workplans');
    
    if (!setting || !setting.settingValue) {
      return res.status(404).json({ error: 'No predefined work plans found' });
    }
    
    let workPlans = [];
    try {
      workPlans = JSON.parse(setting.settingValue);
    } catch (error) {
      console.error('Error parsing existing work plans:', error);
      return res.status(500).json({ error: 'Failed to parse existing work plans' });
    }
    
    // Filter out the work plan to delete
    const initialLength = workPlans.length;
    workPlans = workPlans.filter((wp: any) => wp.id !== planId);
    
    if (workPlans.length === initialLength) {
      return res.status(404).json({ error: 'Work plan not found' });
    }
    
    // Save back to settings
    await settingsService.setSetting(
      'agent-mode-predefined-workplans',
      JSON.stringify(workPlans),
      'Agent Mode predefined work plans for Emma AI assistant',
      updatedBy
    );
    
    res.json({ success: true, message: 'Work plan deleted successfully' });
  } catch (error) {
    console.error('Error deleting work plan:', error);
    res.status(500).json({ error: 'Failed to delete work plan' });
  }
});

// These are intentionally placed after export for clarity but will still be registered.

// Get email_campaign_tasks (customer accessible)
router.get('/customer/email-campaign-tasks', authenticateToken, async (req, res) => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    
    const settingName = `user-${userId}-email_campaign_tasks`;
    const setting = await settingsService.getSetting(settingName);
    
    let taskIds = [];
    if (setting) {
      try {
        taskIds = JSON.parse(setting.settingValue);
        // Ensure it's an array
        if (!Array.isArray(taskIds)) {
          taskIds = [];
        }
      } catch (error) {
        console.error('Error parsing email campaign tasks:', error);
        taskIds = [];
      }
    }
    
    res.json({ taskIds });
  } catch (error) {
    console.error('Error getting email campaign tasks:', error);
    res.status(500).json({ error: 'Failed to get email campaign tasks' });
  }
});

// Add a specific task to email campaign monitoring (customer accessible)
router.post('/customer/email-campaign-tasks/:taskId', authenticateToken, async (req, res) => {
  try {
    const userId = req.user?.userId;
    const { taskId } = req.params;
    
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    
    if (!taskId || taskId.trim() === '') {
      return res.status(404).json({ error: 'Not Found' });
    }
    
    const settingName = `user-${userId}-email_campaign_tasks`;
    const existingSetting = await settingsService.getSetting(settingName);
    
    let taskIds = [];
    if (existingSetting) {
      try {
        taskIds = JSON.parse(existingSetting.settingValue);
        if (!Array.isArray(taskIds)) {
          taskIds = [];
        }
      } catch (error) {
        console.error('Error parsing existing tasks:', error);
        taskIds = [];
      }
    }
    
    // Add taskId if not already present
    if (!taskIds.includes(taskId)) {
      taskIds.push(taskId);
      
      await settingsService.setSetting(
        settingName, 
        JSON.stringify(taskIds), 
        'User-monitored email campaign tasks', 
        req.user?.email
      );
    }
    
    res.json({ 
      message: 'Task added to email campaign monitoring',
      taskIds
    });
  } catch (error) {
    console.error('Error adding email campaign task:', error);
    res.status(500).json({ error: 'Failed to add email campaign task' });
  }
});

// Create or update email campaign tasks (customer accessible)
router.post('/customer/email-campaign-tasks', authenticateToken, async (req, res) => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    
    const { tasks } = req.body;
    
    if (!Array.isArray(tasks)) {
      return res.status(400).json({ error: 'tasks must be an array' });
    }
    
    const settingName = `user-${userId}-email_campaign_tasks`;
    await settingsService.setSetting(
      settingName, 
      JSON.stringify(tasks), 
      'User-monitored email campaign tasks', 
      req.user?.email
    );
    
    res.json({ 
      success: true, 
      message: 'Email campaign tasks saved successfully',
      tasks
    });
  } catch (error) {
    console.error('Error saving email campaign tasks:', error);
    res.status(500).json({ error: 'Failed to save email campaign tasks' });
  }
});

// Remove a specific email campaign task (customer accessible)
router.delete('/customer/email-campaign-tasks/:taskId', authenticateToken, async (req, res) => {
  try {
    const userId = req.user?.userId;
    const { taskId } = req.params;
    
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    
    if (!taskId) {
      return res.status(400).json({ error: 'taskId is required' });
    }
    
    const settingName = `user-${userId}-email_campaign_tasks`;
    const existingSetting = await settingsService.getSetting(settingName);
    
    let taskIds = [];
    if (existingSetting) {
      try {
        taskIds = JSON.parse(existingSetting.settingValue);
        if (!Array.isArray(taskIds)) {
          taskIds = [];
        }
      } catch (error) {
        console.error('Error parsing tasks:', error);
        return res.status(500).json({ error: 'Failed to parse tasks' });
      }
    }
    
    const initialLength = taskIds.length;
    taskIds = taskIds.filter((id: string) => id !== taskId);
    
    if (taskIds.length < initialLength) {
      await settingsService.setSetting(
        settingName, 
        JSON.stringify(taskIds), 
        'User-monitored email campaign tasks', 
        req.user?.email
      );
    }
    
    res.json({ 
      message: 'Task removed from email campaign monitoring',
      taskIds
    });
  } catch (error) {
    console.error('Error removing customer email campaign task:', error);
    res.status(500).json({ error: 'Failed to remove email campaign task' });
  }
});

export default router;