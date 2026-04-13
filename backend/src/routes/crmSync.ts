import express, { Request, Response } from 'express';
import { authenticateToken, AuthenticatedRequest } from '../middleware/auth';
import { crmDb } from '../services/db';
import { externalCrmSyncService } from '../services/externalCrmSyncService';

const router = express.Router();

// All routes require authentication
router.use(authenticateToken);

/**
 * Verify that the user owns the lead list.
 */
async function verifyListOwnership(userId: string, listId: string): Promise<{ ok: boolean; error?: string; status?: number }> {
  const list = await crmDb.getLeadListById(listId);
  if (!list) return { ok: false, error: 'Lead list not found', status: 404 };
  if (list.userId !== userId) return { ok: false, error: 'Access denied', status: 403 };
  return { ok: true };
}

/**
 * @route GET /api/crm/sync/config/:listId/:provider
 * @desc Get sync configuration (API key masked)
 */
router.get('/config/:listId/:provider', async (req: Request, res: Response) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.user?.userId;
    if (!userId) return res.status(401).json({ message: 'Unauthorized' });

    const { listId, provider } = req.params;
    const ownership = await verifyListOwnership(userId, listId);
    if (!ownership.ok) return res.status(ownership.status!).json({ message: ownership.error });

    const config = await externalCrmSyncService.getConfig(userId, listId, provider);
    if (!config) {
      return res.json({ configured: false });
    }

    // Mask the API key
    return res.json({
      configured: true,
      provider: config.provider,
      autoSyncEnabled: config.autoSyncEnabled,
      contactFieldMapping: config.contactFieldMapping,
      dealFieldMapping: config.dealFieldMapping,
      lastPushSyncAt: config.lastPushSyncAt,
      lastPullSyncAt: config.lastPullSyncAt,
      lastSyncStatus: config.lastSyncStatus,
      lastSyncError: config.lastSyncError,
      apiKeyMasked: config.apiKeyEncrypted ? '••••••••' : '',
      createdAt: config.createdAt,
      updatedAt: config.updatedAt,
    });
  } catch (error: any) {
    console.error('Error getting sync config:', error);
    res.status(500).json({ message: error.message || 'Failed to get sync config' });
  }
});

/**
 * @route PUT /api/crm/sync/config/:listId/:provider
 * @desc Save or update sync configuration
 */
router.put('/config/:listId/:provider', async (req: Request, res: Response) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.user?.userId;
    if (!userId) return res.status(401).json({ message: 'Unauthorized' });

    const { listId, provider } = req.params;
    if (provider !== 'hubspot') {
      return res.status(400).json({ message: 'Unsupported provider. Currently only "hubspot" is supported.' });
    }

    const ownership = await verifyListOwnership(userId, listId);
    if (!ownership.ok) return res.status(ownership.status!).json({ message: ownership.error });

    const { apiKey, autoSyncEnabled, contactFieldMapping, dealFieldMapping } = req.body;

    const config = await externalCrmSyncService.saveConfig(userId, listId, provider, {
      apiKey,
      autoSyncEnabled,
      contactFieldMapping,
      dealFieldMapping,
    });

    return res.json({
      configured: true,
      provider: config.provider,
      autoSyncEnabled: config.autoSyncEnabled,
      contactFieldMapping: config.contactFieldMapping,
      dealFieldMapping: config.dealFieldMapping,
      apiKeyMasked: config.apiKeyEncrypted ? '••••••••' : '',
      createdAt: config.createdAt,
      updatedAt: config.updatedAt,
    });
  } catch (error: any) {
    console.error('Error saving sync config:', error);
    res.status(500).json({ message: error.message || 'Failed to save sync config' });
  }
});

/**
 * @route DELETE /api/crm/sync/config/:listId/:provider
 * @desc Remove sync configuration
 */
router.delete('/config/:listId/:provider', async (req: Request, res: Response) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.user?.userId;
    if (!userId) return res.status(401).json({ message: 'Unauthorized' });

    const { listId, provider } = req.params;
    const ownership = await verifyListOwnership(userId, listId);
    if (!ownership.ok) return res.status(ownership.status!).json({ message: ownership.error });

    await externalCrmSyncService.deleteConfig(userId, listId, provider);
    return res.json({ message: 'Sync configuration deleted' });
  } catch (error: any) {
    console.error('Error deleting sync config:', error);
    res.status(500).json({ message: error.message || 'Failed to delete sync config' });
  }
});

/**
 * @route POST /api/crm/sync/test/:listId/:provider
 * @desc Test connection with stored API key
 */
router.post('/test/:listId/:provider', async (req: Request, res: Response) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.user?.userId;
    if (!userId) return res.status(401).json({ message: 'Unauthorized' });

    const { listId, provider } = req.params;
    const ownership = await verifyListOwnership(userId, listId);
    if (!ownership.ok) return res.status(ownership.status!).json({ message: ownership.error });

    const result = await externalCrmSyncService.testConnection(userId, listId, provider);
    return res.json(result);
  } catch (error: any) {
    console.error('Error testing sync connection:', error);
    res.status(500).json({ message: error.message || 'Failed to test connection' });
  }
});

/**
 * @route POST /api/crm/sync/push/:listId/:provider
 * @desc Push all leads to external CRM
 */
router.post('/push/:listId/:provider', async (req: Request, res: Response) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.user?.userId;
    if (!userId) return res.status(401).json({ message: 'Unauthorized' });

    const { listId, provider } = req.params;
    const ownership = await verifyListOwnership(userId, listId);
    if (!ownership.ok) return res.status(ownership.status!).json({ message: ownership.error });

    const result = await externalCrmSyncService.pushAllLeads(userId, listId, provider);
    return res.json(result);
  } catch (error: any) {
    console.error('Error pushing leads to external CRM:', error);
    res.status(500).json({ message: error.message || 'Failed to push leads' });
  }
});

/**
 * @route POST /api/crm/sync/pull/:listId/:provider
 * @desc Pull contacts from external CRM into AgentWeb
 */
router.post('/pull/:listId/:provider', async (req: Request, res: Response) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.user?.userId;
    if (!userId) return res.status(401).json({ message: 'Unauthorized' });

    const { listId, provider } = req.params;
    const ownership = await verifyListOwnership(userId, listId);
    if (!ownership.ok) return res.status(ownership.status!).json({ message: ownership.error });

    const result = await externalCrmSyncService.pullAllContacts(userId, listId, provider);
    return res.json(result);
  } catch (error: any) {
    console.error('Error pulling contacts from external CRM:', error);
    res.status(500).json({ message: error.message || 'Failed to pull contacts' });
  }
});

export default router;
