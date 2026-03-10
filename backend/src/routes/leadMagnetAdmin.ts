import express, { Response } from 'express';
import { AuthenticatedRequest } from '../middleware/auth';
import { getLeadMagnetConfigDb } from '../services/leadMagnetConfigDb';

const router = express.Router();

// POST /api/admin/lead-magnets — create config
router.post('/', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { name, inputSchema, taskTemplateId, resultGate, ctaText, landingPageSlug, enabled } = req.body;
    if (!name || !taskTemplateId) {
      res.status(400).json({ error: 'name and taskTemplateId are required' });
      return;
    }

    const config = await getLeadMagnetConfigDb().create({
      name,
      inputSchema: inputSchema || { fields: [] },
      taskTemplateId,
      resultGate: resultGate || 'blur',
      ctaText: ctaText || '',
      landingPageSlug: landingPageSlug || '',
      enabled: enabled !== false,
    });

    res.status(201).json(config);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/admin/lead-magnets — list all configs
router.get('/', async (_req: AuthenticatedRequest, res: Response) => {
  try {
    const configs = await getLeadMagnetConfigDb().listAll();
    res.json(configs);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/admin/lead-magnets/:id — get config by ID
router.get('/:id', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const config = await getLeadMagnetConfigDb().getById(req.params.id);
    if (!config) {
      res.status(404).json({ error: 'Config not found' });
      return;
    }
    res.json(config);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// PUT /api/admin/lead-magnets/:id — update config
router.put('/:id', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const config = await getLeadMagnetConfigDb().update(req.params.id, req.body);
    res.json(config);
  } catch (error: any) {
    if (error.message.includes('not found')) {
      res.status(404).json({ error: error.message });
      return;
    }
    res.status(500).json({ error: error.message });
  }
});

// DELETE /api/admin/lead-magnets/:id — delete config
router.delete('/:id', async (req: AuthenticatedRequest, res: Response) => {
  try {
    await getLeadMagnetConfigDb().deleteById(req.params.id);
    res.json({ deleted: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
