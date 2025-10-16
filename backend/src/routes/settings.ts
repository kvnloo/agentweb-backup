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
    const setting = await settingsService.getSetting('email_campaign_tasks');
    const value = setting?.settingValue || '[]';
    let list: string[] = [];
    try {
      const parsed = JSON.parse(value);
      list = Array.isArray(parsed) ? parsed : [];
    } catch {
      list = [];
    }
    res.json({ taskIds: list });
  } catch (error) {
    console.error('Error getting email_campaign_tasks:', error);
    res.status(500).json({ error: 'Failed to get email_campaign_tasks' });
  }
});

// Add a taskId to email_campaign_tasks (customer accessible)
router.post('/customer/email-campaign-tasks/:taskId', authenticateToken, async (req, res) => {
  try {
    const { taskId } = req.params;
    if (!taskId) {
      return res.status(400).json({ error: 'taskId is required' });
    }

    const existing = await settingsService.getSetting('email_campaign_tasks');
    const currentValue = existing?.settingValue || '[]';
    let list: string[] = [];
    try {
      const parsed = JSON.parse(currentValue);
      list = Array.isArray(parsed) ? parsed : [];
    } catch {
      list = [];
    }
    if (!list.includes(taskId)) {
      list.push(taskId);
    }
    const updated = JSON.stringify(list);
    const updatedBy = req.user?.email || 'customer';
    await settingsService.setSetting('email_campaign_tasks', updated, 'Task IDs monitored by Campaign Performance', updatedBy);
    res.json({ taskIds: list });
  } catch (error) {
    console.error('Error updating email_campaign_tasks:', error);
    res.status(500).json({ error: 'Failed to update email_campaign_tasks' });
  }
});

// Remove a taskId from email_campaign_tasks (customer accessible)
router.delete('/customer/email-campaign-tasks/:taskId', authenticateToken, async (req, res) => {
  try {
    const { taskId } = req.params;
    if (!taskId) {
      return res.status(400).json({ error: 'taskId is required' });
    }

    const existing = await settingsService.getSetting('email_campaign_tasks');
    const currentValue = existing?.settingValue || '[]';
    let list: string[] = [];
    try {
      const parsed = JSON.parse(currentValue);
      list = Array.isArray(parsed) ? parsed : [];
    } catch {
      list = [];
    }
    const newList = list.filter((id) => id !== taskId);
    const updated = JSON.stringify(newList);
    const updatedBy = req.user?.email || 'customer';
    await settingsService.setSetting('email_campaign_tasks', updated, 'Task IDs monitored by Campaign Performance', updatedBy);
    res.json({ taskIds: newList });
  } catch (error) {
    console.error('Error removing from email_campaign_tasks:', error);
    res.status(500).json({ error: 'Failed to remove from email_campaign_tasks' });
  }
});
