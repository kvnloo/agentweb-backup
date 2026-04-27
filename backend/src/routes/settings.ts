import express from 'express';
import { settingsService } from '../services/settingsService';
import { authenticateToken, requireAdmin } from '../middleware/auth';
import { userDb } from '../services/db';
import { linkedInOutreachService } from '../services/linkedInOutreachService';
import { agentModeService } from '../services/agentModeService';

const router = express.Router();

// ---- Site-Wide Unipile Accounts CRUD (admin-only) ----

const SITE_WIDE_UNIPILE_SETTING = 'site-wide-unipile-accounts';

// Get all site-wide Unipile accounts with live connectivity status
router.get('/site-wide-unipile-accounts', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const setting = await settingsService.getSetting(SITE_WIDE_UNIPILE_SETTING);
    const accounts: any[] = setting?.settingValue ? JSON.parse(setting.settingValue) : [];

    // Verify live connectivity for each account in parallel
    const accountsWithStatus = await Promise.all(
      accounts.map(async (account) => ({
        ...account,
        connected: await linkedInOutreachService.isAccountConnected(account.account_id),
      }))
    );

    res.json({ accounts: accountsWithStatus });
  } catch (error) {
    console.error('Error getting site-wide Unipile accounts:', error);
    res.status(500).json({ error: 'Failed to get site-wide Unipile accounts' });
  }
});

// Add a site-wide Unipile account
router.post('/site-wide-unipile-accounts', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { account_id, account_name, user_email } = req.body;
    if (!account_id) {
      return res.status(400).json({ error: 'account_id is required' });
    }

    const setting = await settingsService.getSetting(SITE_WIDE_UNIPILE_SETTING);
    const accounts = setting?.settingValue ? JSON.parse(setting.settingValue) : [];

    // Check for duplicate
    if (accounts.some((a: any) => a.account_id === account_id)) {
      return res.status(409).json({ error: 'Account already added as site-wide' });
    }

    const now = new Date().toISOString();
    const newAccount = {
      account_id,
      account_name: account_name || account_id,
      user_email: user_email || null,
      added_by: req.user?.email,
      added_at: now,
      enabled: true,
    };

    accounts.push(newAccount);
    await settingsService.setSetting(SITE_WIDE_UNIPILE_SETTING, JSON.stringify(accounts), 'Site-wide Unipile accounts for enrichment', req.user?.email);
    res.json({ account: newAccount });
  } catch (error) {
    console.error('Error adding site-wide Unipile account:', error);
    res.status(500).json({ error: 'Failed to add site-wide Unipile account' });
  }
});

// Toggle enabled state of a site-wide Unipile account
router.patch('/site-wide-unipile-accounts/:accountId', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { accountId } = req.params;
    const { enabled } = req.body;

    const setting = await settingsService.getSetting(SITE_WIDE_UNIPILE_SETTING);
    if (!setting?.settingValue) {
      return res.status(404).json({ error: 'No site-wide Unipile accounts found' });
    }

    const accounts = JSON.parse(setting.settingValue);
    const index = accounts.findIndex((a: any) => a.account_id === accountId);
    if (index === -1) {
      return res.status(404).json({ error: 'Account not found' });
    }

    accounts[index].enabled = enabled;
    await settingsService.setSetting(SITE_WIDE_UNIPILE_SETTING, JSON.stringify(accounts), 'Site-wide Unipile accounts for enrichment', req.user?.email);
    res.json({ account: accounts[index] });
  } catch (error) {
    console.error('Error updating site-wide Unipile account:', error);
    res.status(500).json({ error: 'Failed to update site-wide Unipile account' });
  }
});

// Remove a site-wide Unipile account
router.delete('/site-wide-unipile-accounts/:accountId', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { accountId } = req.params;

    const setting = await settingsService.getSetting(SITE_WIDE_UNIPILE_SETTING);
    if (!setting?.settingValue) {
      return res.status(404).json({ error: 'No site-wide Unipile accounts found' });
    }

    const accounts = JSON.parse(setting.settingValue);
    const filtered = accounts.filter((a: any) => a.account_id !== accountId);
    if (filtered.length === accounts.length) {
      return res.status(404).json({ error: 'Account not found' });
    }

    await settingsService.setSetting(SITE_WIDE_UNIPILE_SETTING, JSON.stringify(filtered), 'Site-wide Unipile accounts for enrichment', req.user?.email);
    res.json({ success: true });
  } catch (error) {
    console.error('Error removing site-wide Unipile account:', error);
    res.status(500).json({ error: 'Failed to remove site-wide Unipile account' });
  }
});

// ---- Scoring Judges CRUD (admin-only) ----

// Get default scoring prompt
router.get('/scoring-judges/default-prompt', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const setting = await settingsService.getSetting('default-scoring-prompt');
    const { DEFAULT_SCORING_SYSTEM_PROMPT } = await import('../services/sessionScoringService');
    res.json({
      systemPrompt: setting?.settingValue || DEFAULT_SCORING_SYSTEM_PROMPT,
      isCustom: !!setting?.settingValue,
    });
  } catch (error) {
    console.error('Error getting default scoring prompt:', error);
    res.status(500).json({ error: 'Failed to get default scoring prompt' });
  }
});

// Update default scoring prompt
router.put('/scoring-judges/default-prompt', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { systemPrompt } = req.body;
    if (!systemPrompt) {
      return res.status(400).json({ error: 'systemPrompt is required' });
    }
    await settingsService.setSetting('default-scoring-prompt', systemPrompt.trim(), 'Default scoring judge system prompt', req.user?.email);
    res.json({ systemPrompt: systemPrompt.trim() });
  } catch (error) {
    console.error('Error updating default scoring prompt:', error);
    res.status(500).json({ error: 'Failed to update default scoring prompt' });
  }
});

// Reset default scoring prompt to hardcoded default
router.delete('/scoring-judges/default-prompt', authenticateToken, requireAdmin, async (req, res) => {
  try {
    await settingsService.deleteSetting('default-scoring-prompt');
    const { DEFAULT_SCORING_SYSTEM_PROMPT } = await import('../services/sessionScoringService');
    res.json({ systemPrompt: DEFAULT_SCORING_SYSTEM_PROMPT });
  } catch (error) {
    console.error('Error resetting default scoring prompt:', error);
    res.status(500).json({ error: 'Failed to reset default scoring prompt' });
  }
});

// Get all scoring judges
router.get('/scoring-judges', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const setting = await settingsService.getSetting('scoring-judges');
    const judges = setting?.settingValue ? JSON.parse(setting.settingValue) : [];
    res.json({ judges });
  } catch (error) {
    console.error('Error getting scoring judges:', error);
    res.status(500).json({ error: 'Failed to get scoring judges' });
  }
});

// Create a scoring judge
router.post('/scoring-judges', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { name, systemPrompt } = req.body;
    if (!name || !systemPrompt) {
      return res.status(400).json({ error: 'name and systemPrompt are required' });
    }

    const setting = await settingsService.getSetting('scoring-judges');
    const judges = setting?.settingValue ? JSON.parse(setting.settingValue) : [];

    const now = new Date().toISOString();
    const newJudge = {
      id: `judge_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      name: name.trim(),
      systemPrompt: systemPrompt.trim(),
      createdAt: now,
      updatedAt: now,
    };

    judges.push(newJudge);
    await settingsService.setSetting('scoring-judges', JSON.stringify(judges), 'Custom scoring judges', req.user?.email);
    res.json({ judge: newJudge });
  } catch (error) {
    console.error('Error creating scoring judge:', error);
    res.status(500).json({ error: 'Failed to create scoring judge' });
  }
});

// Update a scoring judge
router.put('/scoring-judges/:judgeId', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { judgeId } = req.params;
    const { name, systemPrompt } = req.body;

    const setting = await settingsService.getSetting('scoring-judges');
    if (!setting?.settingValue) {
      return res.status(404).json({ error: 'No scoring judges found' });
    }

    const judges = JSON.parse(setting.settingValue);
    const index = judges.findIndex((j: any) => j.id === judgeId);
    if (index === -1) {
      return res.status(404).json({ error: 'Judge not found' });
    }

    if (name) judges[index].name = name.trim();
    if (systemPrompt) judges[index].systemPrompt = systemPrompt.trim();
    judges[index].updatedAt = new Date().toISOString();

    await settingsService.setSetting('scoring-judges', JSON.stringify(judges), 'Custom scoring judges', req.user?.email);
    res.json({ judge: judges[index] });
  } catch (error) {
    console.error('Error updating scoring judge:', error);
    res.status(500).json({ error: 'Failed to update scoring judge' });
  }
});

// Delete a scoring judge
router.delete('/scoring-judges/:judgeId', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { judgeId } = req.params;

    const setting = await settingsService.getSetting('scoring-judges');
    if (!setting?.settingValue) {
      return res.status(404).json({ error: 'No scoring judges found' });
    }

    const judges = JSON.parse(setting.settingValue);
    const filtered = judges.filter((j: any) => j.id !== judgeId);
    if (filtered.length === judges.length) {
      return res.status(404).json({ error: 'Judge not found' });
    }

    await settingsService.setSetting('scoring-judges', JSON.stringify(filtered), 'Custom scoring judges', req.user?.email);
    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting scoring judge:', error);
    res.status(500).json({ error: 'Failed to delete scoring judge' });
  }
});

// ---- CRM Enrichment Config (admin-only) ----

const CRM_ENRICHMENT_CONFIG_KEY = 'crm-enrichment-config';

const CRM_ENRICHMENT_DEFAULTS = {
  enrichmentModel: 'gemini-3-flash-preview',
  dataExtractionModel: 'gemini-3-flash-preview',
  context: '',
};

router.get('/crm-enrichment-config', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const setting = await settingsService.getSetting(CRM_ENRICHMENT_CONFIG_KEY);
    let config = { ...CRM_ENRICHMENT_DEFAULTS };
    if (setting?.settingValue) {
      try {
        config = { ...CRM_ENRICHMENT_DEFAULTS, ...JSON.parse(setting.settingValue) };
      } catch {
        // malformed stored value — fall back to defaults
      }
    }
    const allModels = await agentModeService.getSupportedModels(true);
    const availableModels = allModels.filter((m) => !m.includes('live'));
    res.json({ config, availableModels });
  } catch (error) {
    console.error('Error getting CRM enrichment config:', error);
    res.status(500).json({ error: 'Failed to get CRM enrichment config' });
  }
});

router.put('/crm-enrichment-config', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { enrichmentModel, dataExtractionModel, context } = req.body;
    if (!enrichmentModel || !dataExtractionModel) {
      return res.status(400).json({ error: 'enrichmentModel and dataExtractionModel are required' });
    }
    const config = {
      enrichmentModel: String(enrichmentModel),
      dataExtractionModel: String(dataExtractionModel),
      context: typeof context === 'string' ? context : '',
    };
    await settingsService.setSetting(
      CRM_ENRICHMENT_CONFIG_KEY,
      JSON.stringify(config),
      'CRM enrichment model configuration',
      req.user?.email || 'admin',
    );
    res.json({ config });
  } catch (error) {
    console.error('Error saving CRM enrichment config:', error);
    res.status(500).json({ error: 'Failed to save CRM enrichment config' });
  }
});

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

// Save Clarity replay session link (customer accessible) - MUST be before /:settingName route
router.post('/replay-sessions', authenticateToken, async (req, res) => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { clarityProjectId, trackingUserId } = req.body;
    if (!clarityProjectId || !trackingUserId) {
      return res.status(400).json({ error: 'clarityProjectId and trackingUserId are required' });
    }

    const replayUrl = `https://clarity.microsoft.com/projects/view/${clarityProjectId}/impressions?CustomUserId=is%3B${trackingUserId}`;
    const settingName = `replay_sessions_${trackingUserId}`;

    await settingsService.setSetting(
      settingName,
      JSON.stringify({
        replayUrl,
        clarityProjectId,
        trackingUserId,
        lastTracked: new Date().toISOString()
      }),
      'Clarity replay session link',
      req.user?.email
    );

    res.json({ success: true, replayUrl });
  } catch (error) {
    console.error('Error saving replay session:', error);
    res.status(500).json({ error: 'Failed to save replay session' });
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

// Get sync status for all predefined work plans (compares prod vs dev)
router.get('/agent-mode-predefined-workplans/sync-status', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const status = await settingsService.getPlanSyncStatus();
    const environment = process.env.NODE_ENV === "development" ? "development" : "production";
    res.status(200).json({ plans: status, environment });
  } catch (error) {
    console.error('Error getting plan sync status:', error);
    res.status(500).json({ error: 'Failed to get plan sync status' });
  }
});

// Sync a predefined work plan between prod and dev
router.post('/agent-mode-predefined-workplans/sync', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { planId, direction } = req.body;

    if (!planId || !direction) {
      return res.status(400).json({ error: 'planId and direction are required' });
    }

    if (direction !== 'prod-to-dev' && direction !== 'dev-to-prod') {
      return res.status(400).json({ error: 'direction must be "prod-to-dev" or "dev-to-prod"' });
    }

    const isDev = process.env.NODE_ENV === "development";
    const allowedDirection = isDev ? "dev-to-prod" : "prod-to-dev";
    if (direction !== allowedDirection) {
      return res.status(400).json({ error: `In ${isDev ? "dev" : "prod"} environment, only "${allowedDirection}" sync is allowed` });
    }

    const plan = await settingsService.syncPlan(planId, direction);

    if (!plan) {
      return res.status(404).json({ error: 'Plan not found in source environment' });
    }

    res.status(200).json(plan);
  } catch (error) {
    console.error('Error syncing plan:', error);
    res.status(500).json({ error: 'Failed to sync plan' });
  }
});

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
      description: workPlan.description?.trim() || undefined,
      welcomeMessage: workPlan.welcomeMessage?.trim() || undefined,
      autocomplete: workPlan.autocomplete || false,
      requireLogin: workPlan.requireLogin || false,
      showLoginSignup: workPlan.showLoginSignup || 'after_plan_completed',
      showInAgentMode: workPlan.showInAgentMode || false,
      defaultModel: workPlan.defaultModel?.trim() || undefined,
      steps: workPlan.steps
        .filter((step: any) => step.title && step.title.trim().length > 0)
        .map((step: any, index: number) => ({
          stepCount: index + 1,
          title: step.title.trim(),
          description: step.description?.trim() || undefined,
          requiredFunctionCalls: step.requiredFunctionCalls?.filter((f: string) => f.trim().length > 0) || undefined,
          skillIds: step.skillIds?.filter((id: string) => id.trim().length > 0) || undefined
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
    
    // If work plan has no ID, check if one with same title exists
    if (!validatedWorkPlan.id || !workPlans.some((wp: any) => wp.id === validatedWorkPlan.id)) {
      const existingPlan = workPlans.find((wp: any) => 
        wp.title && wp.title.trim().toLowerCase() === validatedWorkPlan.title.trim().toLowerCase()
      );
      
      if (existingPlan) {
        console.log('Found existing plan without ID:', existingPlan);
        // Give it an ID if it doesn't have one
        if (!existingPlan.id) {
          existingPlan.id = validatedWorkPlan.id;
        }
        // Update the existing plan
        const planIndex = workPlans.findIndex((wp: any) => 
          wp.title && wp.title.trim().toLowerCase() === validatedWorkPlan.title.trim().toLowerCase()
        );
        validatedWorkPlan.id = existingPlan.id;
        workPlans[planIndex] = validatedWorkPlan;
      } else {
        // Add the new work plan
        workPlans.push(validatedWorkPlan);
      }
    } else {
      // Add the new work plan
      workPlans.push(validatedWorkPlan);
    }
    
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
      description: workPlan.description?.trim() || undefined,
      welcomeMessage: workPlan.welcomeMessage?.trim() || undefined,
      autocomplete: workPlan.autocomplete || false,
      requireLogin: workPlan.requireLogin || false,
      showLoginSignup: workPlan.showLoginSignup || 'after_plan_completed',
      showInAgentMode: workPlan.showInAgentMode || false,
      defaultModel: workPlan.defaultModel?.trim() || undefined,
      steps: workPlan.steps
        .filter((step: any) => step.title && step.title.trim().length > 0)
        .map((step: any, index: number) => ({
          stepCount: index + 1,
          title: step.title.trim(),
          description: step.description?.trim() || undefined,
          requiredFunctionCalls: step.requiredFunctionCalls?.filter((f: string) => f.trim().length > 0) || undefined,
          skillIds: step.skillIds?.filter((id: string) => id.trim().length > 0) || undefined
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

// Get Google Drive service account email for sharing instructions
router.get('/google-drive/service-account-email', authenticateToken, async (req, res) => {
  try {
    const { getGoogleDriveServiceAccountEmail } = await import('../utils/secretsManager');
    const email = await getGoogleDriveServiceAccountEmail();
    res.json({ email });
  } catch (error) {
    console.error('Error fetching Google Drive service account email:', error);
    res.status(500).json({ error: 'Failed to fetch Google Drive service account email' });
  }
});

// Add a Google Drive folder to the current user's account
// Verifies the folder is accessible via the service account and fetches its name
router.post('/google-drive/folders', authenticateToken, async (req, res) => {
  try {
    const { folderId } = req.body;
    const userId = (req as any).user?.userId;

    if (!folderId || typeof folderId !== 'string' || !folderId.trim()) {
      return res.status(400).json({ error: 'folderId is required' });
    }

    const trimmedFolderId = folderId.trim();

    // Verify folder is accessible and get its name via the service account
    const { getSecret } = await import('../utils/secretsManager');
    const { google } = await import('googleapis');

    const environment = process.env.NODE_ENV || 'development';
    const secretName = environment === 'production'
      ? 'prod/AgentWeb/Google/Share'
      : 'dev/AgentWeb/Google/Share';

    const secretString = await getSecret(secretName);
    const credentials = JSON.parse(secretString);

    const auth = new google.auth.GoogleAuth({
      credentials,
      scopes: ['https://www.googleapis.com/auth/drive.readonly'],
    });

    const drive = google.drive({ version: 'v3', auth });

    let folderName: string;
    try {
      const fileResponse = await drive.files.get({
        fileId: trimmedFolderId,
        fields: 'id, name, mimeType',
      });

      if (fileResponse.data.mimeType !== 'application/vnd.google-apps.folder') {
        return res.status(400).json({ error: 'The provided ID is not a folder' });
      }

      folderName = fileResponse.data.name || trimmedFolderId;
    } catch (driveError: any) {
      if (driveError.code === 404 || driveError.status === 404) {
        return res.status(400).json({
          error: 'Folder not found. Make sure you have shared the folder with the service account email before adding it.'
        });
      }
      throw driveError;
    }

    // Get current user and update folders
    const user = await userDb.getUserById(userId);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const existingFolders = user.googleDriveFolders || [];

    // Check if folder already exists
    if (existingFolders.some((f: { folderId: string }) => f.folderId === trimmedFolderId)) {
      return res.status(400).json({ error: 'This folder has already been added' });
    }

    const updatedFolders = [...existingFolders, { folderId: trimmedFolderId, name: folderName }];
    await userDb.updateUser(userId, { googleDriveFolders: updatedFolders });

    res.json({ folder: { folderId: trimmedFolderId, name: folderName }, googleDriveFolders: updatedFolders });
  } catch (error) {
    console.error('Error adding Google Drive folder:', error);
    res.status(500).json({ error: 'Failed to add Google Drive folder' });
  }
});

// Remove a Google Drive folder from the current user's account
router.delete('/google-drive/folders/:folderId', authenticateToken, async (req, res) => {
  try {
    const { folderId } = req.params;
    const userId = (req as any).user?.userId;

    const user = await userDb.getUserById(userId);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const existingFolders = user.googleDriveFolders || [];
    const updatedFolders = existingFolders.filter((f: { folderId: string }) => f.folderId !== folderId);

    await userDb.updateUser(userId, { googleDriveFolders: updatedFolders });

    res.json({ googleDriveFolders: updatedFolders });
  } catch (error) {
    console.error('Error removing Google Drive folder:', error);
    res.status(500).json({ error: 'Failed to remove Google Drive folder' });
  }
});

// List files inside a Google Drive folder
// Verifies the folder belongs to the user and is accessible via the service account
router.get('/google-drive/folders/:folderId/files', authenticateToken, async (req, res) => {
  try {
    const { folderId } = req.params;
    const userId = (req as any).user?.userId;

    // Verify folder belongs to this user
    const user = await userDb.getUserById(userId);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const userFolders = user.googleDriveFolders || [];
    if (!userFolders.some((f: { folderId: string }) => f.folderId === folderId)) {
      return res.status(403).json({ error: 'Folder not found on your account' });
    }

    const { getSecret } = await import('../utils/secretsManager');
    const { google } = await import('googleapis');

    const environment = process.env.NODE_ENV || 'development';
    const secretName = environment === 'production'
      ? 'prod/AgentWeb/Google/Share'
      : 'dev/AgentWeb/Google/Share';

    const secretString = await getSecret(secretName);
    const credentials = JSON.parse(secretString);

    const auth = new google.auth.GoogleAuth({
      credentials,
      scopes: ['https://www.googleapis.com/auth/drive.readonly'],
    });

    const drive = google.drive({ version: 'v3', auth });

    const response = await drive.files.list({
      q: `'${folderId}' in parents and trashed = false`,
      fields: 'files(id, name, mimeType, size, modifiedTime)',
      orderBy: 'name',
      pageSize: 100,
    });

    const files = (response.data.files || []).map((f) => ({
      id: f.id,
      name: f.name,
      mimeType: f.mimeType,
      size: f.size ? parseInt(f.size, 10) : undefined,
      modifiedTime: f.modifiedTime,
    }));

    res.json({ files });
  } catch (error) {
    console.error('Error listing Google Drive folder files:', error);
    res.status(500).json({ error: 'Failed to list folder files' });
  }
});

export default router;