import express from 'express';
import { authenticateToken } from '../middleware/auth';
import { getCustomerPortalPages } from '../services/customerPortalPages';
import { checkTokenUsage } from '../services/tokenUsageService';

const router = express.Router();

// Get current user's token usage and allowance
router.get('/usage', authenticateToken, async (req, res) => {
  try {
    const userId = (req as any).user?.userId;
    if (!userId) {
      return res.status(401).json({ error: 'Not authenticated' });
    }
    const usage = await checkTokenUsage(userId);
    res.json(usage);
  } catch (error) {
    console.error('Error getting token usage:', error);
    res.status(500).json({ error: 'Failed to get token usage' });
  }
});

// Get all available customer portal pages
router.get('/customer-portal-pages', authenticateToken, async (req, res) => {
  try {
    const pages = getCustomerPortalPages();
    res.json({ pages });
  } catch (error) {
    console.error('Error getting customer portal pages:', error);
    res.status(500).json({ error: 'Failed to get customer portal pages' });
  }
});

export default router;
