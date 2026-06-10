import express from 'express';
import { authenticateToken } from '../middleware/auth';
import { HubSpotService } from '../services/hubspotService';

const router = express.Router();
router.use(authenticateToken);

function getService(req: any): HubSpotService {
  const apiKey = req.query.apiKey as string | undefined;
  if (apiKey) return HubSpotService.fromToken(apiKey);
  return HubSpotService.create(req.user.userId) as any;
}

// GET /api/hubspot/campaigns
router.get('/', async (req: any, res) => {
  try {
    const svc = await getService(req);
    const cursor = req.query.cursor as string | undefined;
    const result = await svc.listCampaigns(cursor);
    res.json(result);
  } catch (err: any) {
    const status = err?.response?.status ?? 500;
    res.status(status).json({ error: err?.response?.data?.message ?? err.message ?? 'Failed to list campaigns' });
  }
});

// POST /api/hubspot/campaigns
router.post('/', async (req: any, res) => {
  try {
    const { name, startDate, notes, utm } = req.body;
    if (!name || !String(name).trim()) {
      return res.status(400).json({ error: 'Campaign name is required' });
    }
    const svc = await getService(req);
    const campaign = await svc.createCampaign(name, { startDate, notes, utm });
    res.status(201).json(campaign);
  } catch (err: any) {
    if (err.message?.toLowerCase().includes('name')) {
      return res.status(400).json({ error: err.message });
    }
    const status = err?.response?.status ?? 500;
    res.status(status).json({ error: err?.response?.data?.message ?? err.message ?? 'Failed to create campaign' });
  }
});

// GET /api/hubspot/campaigns/:guid
router.get('/:guid', async (req: any, res) => {
  try {
    const svc = await getService(req);
    const campaign = await svc.getCampaign(req.params.guid);
    res.json(campaign);
  } catch (err: any) {
    const status = err?.response?.status ?? 500;
    res.status(status).json({ error: err?.response?.data?.message ?? err.message ?? 'Failed to get campaign' });
  }
});

// PATCH /api/hubspot/campaigns/:guid
router.patch('/:guid', async (req: any, res) => {
  try {
    const svc = await getService(req);
    const campaign = await svc.updateCampaign(req.params.guid, req.body);
    res.json(campaign);
  } catch (err: any) {
    const status = err?.response?.status ?? 500;
    res.status(status).json({ error: err?.response?.data?.message ?? err.message ?? 'Failed to update campaign' });
  }
});

// DELETE /api/hubspot/campaigns/:guid
router.delete('/:guid', async (req: any, res) => {
  try {
    const svc = await getService(req);
    await svc.deleteCampaign(req.params.guid);
    res.status(204).send();
  } catch (err: any) {
    const status = err?.response?.status ?? 500;
    res.status(status).json({ error: err?.response?.data?.message ?? err.message ?? 'Failed to delete campaign' });
  }
});

// GET /api/hubspot/campaigns/:guid/metrics
router.get('/:guid/metrics', async (req: any, res) => {
  try {
    const svc = await getService(req);
    const metrics = await svc.getCampaignMetrics(req.params.guid);
    res.json(metrics);
  } catch (err: any) {
    const status = err?.response?.status ?? 500;
    res.status(status).json({ error: err?.response?.data?.message ?? err.message ?? 'Failed to get campaign metrics' });
  }
});

export default router;
