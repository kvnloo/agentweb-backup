import express from 'express';
import { settingsService } from '../services/settingsService';
import { authenticateToken, requireAdmin } from '../middleware/auth';

const router = express.Router();

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
    
    if (!settingValue) {
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
    res.json({ message: 'Setting deleted successfully' });
  } catch (error) {
    console.error('Error deleting setting:', error);
    res.status(500).json({ error: 'Failed to delete setting' });
  }
});

export default router;

// Customer-accessible helpers for specific settings
// These are intentionally placed after export for clarity but will still be registered.

// Get email_campaign_tasks (customer accessible)
router.get('/customer/email-campaign-tasks', authenticateToken, async (req, res) => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const setting = await settingsService.getSetting(`user-${userId}-email_campaign_tasks`);
    let taskIds: string[] = [];
    if (setting) {
      try {
        const parsed = JSON.parse(setting.settingValue);
        taskIds = Array.isArray(parsed) ? parsed : [];
      } catch {
        taskIds = [];
      }
    }
    res.json({ taskIds });
  } catch (error) {
    console.error('Error getting customer email campaign tasks:', error);
    res.status(500).json({ error: 'Failed to get email campaign tasks' });
  }
});

// Add a taskId to email_campaign_tasks (customer accessible)
router.post('/customer/email-campaign-tasks/:taskId', authenticateToken, async (req, res) => {
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
    let taskIds: string[] = existingSetting ? JSON.parse(existingSetting.settingValue) : [];

    if (!taskIds.includes(taskId)) {
      taskIds.push(taskId);
      await settingsService.setSetting(settingName, JSON.stringify(taskIds), 'User-monitored email campaign tasks', req.user?.email);
    }
    res.json({ message: 'Task added to email campaign monitoring', taskIds });
  } catch (error) {
    console.error('Error adding customer email campaign task:', error);
    res.status(500).json({ error: 'Failed to add email campaign task' });
  }
});

// Remove a taskId from email_campaign_tasks (customer accessible)
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
    let taskIds: string[] = existingSetting ? JSON.parse(existingSetting.settingValue) : [];

    const initialLength = taskIds.length;
    taskIds = taskIds.filter((id) => id !== taskId);

    if (taskIds.length < initialLength) {
      await settingsService.setSetting(settingName, JSON.stringify(taskIds), 'User-monitored email campaign tasks', req.user?.email);
    }
    res.json({ message: 'Task removed from email campaign monitoring', taskIds });
  } catch (error) {
    console.error('Error removing customer email campaign task:', error);
    res.status(500).json({ error: 'Failed to remove email campaign task' });
  }
});
