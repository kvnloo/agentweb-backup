import express from 'express';
import { authenticateToken } from '../middleware/auth';
import { googleAdsService } from '../services/googleAdsService';

const router = express.Router();
router.use(authenticateToken);

// GET /api/google-ads/campaigns?customerId=<id>
router.get('/campaigns', async (req: any, res) => {
  const { customerId } = req.query;
  if (!customerId || typeof customerId !== 'string') {
    return res.status(400).json({ error: 'customerId query parameter is required' });
  }
  try {
    const campaigns = await googleAdsService.listCampaigns(req.user.userId, customerId);
    res.json({ success: true, campaigns });
  } catch (error: any) {
    if (error.isGoogleAdsAuthError) return res.status(401).json({ error: error.message });
    console.error('[Google Ads /campaigns]', error);
    res.status(500).json({ error: 'Failed to fetch campaigns' });
  }
});

export default router;
