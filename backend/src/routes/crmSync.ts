import express from 'express';
import { authenticateToken } from '../middleware/auth';
import { crmDb, userDb } from '../services/db';
import {
  externalCrmSyncService,
} from '../services/externalCrmSyncService';

const router = express.Router();
router.use(authenticateToken);

// ─── Helpers ──────────────────────────────────────────────────────────────────

// Grants access when the user owns the list OR belongs to the same org as the
// list owner. Mirrors `canAccessCrmList` in crm.ts so org members share lead
// lists (and their CRM sync configs) consistently across every CRM surface.
async function verifyListOwnership(
  userId: string,
  listId: string
): Promise<{ ok: boolean; status?: number; error?: string }> {
  const list = await crmDb.getLeadListById(listId);
  if (!list) return { ok: false, status: 404, error: 'Lead list not found' };

  const ownerId = (list as any).userId;
  if (ownerId === userId) return { ok: true };

  const [user, owner] = await Promise.all([
    userDb.getUserById(userId),
    userDb.getUserById(ownerId),
  ]);
  if (user?.orgId && owner?.orgId && user.orgId === owner.orgId) return { ok: true };

  return { ok: false, status: 403, error: 'Access denied' };
}

// ─── Default field mappings ───────────────────────────────────────────────────

// GET /api/crm-sync/defaults/:provider
router.get('/defaults/:provider', async (req: any, res) => {
  try {
    const { provider } = req.params;
    if (!['hubspot', 'attio'].includes(provider)) {
      return res.status(400).json({ error: 'Unsupported provider. Use hubspot or attio.' });
    }
    const defaults = await externalCrmSyncService.getDefaultMappings(provider);
    res.json(defaults);
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Failed to fetch default mappings' });
  }
});
// ─── Custom field discovery ───────────────────────────────────────────────────

// GET /api/crm-sync/custom-fields/:listId
router.get('/custom-fields/:listId', async (req: any, res) => {
  try {
    const userId = req.user?.userId;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const { listId } = req.params;
    const provider = req.query.provider as string;

    const ownership = await verifyListOwnership(userId, listId);
    if (!ownership.ok) return res.status(ownership.status!).json({ error: ownership.error });

    const [keys, defaults] = await Promise.all([
      externalCrmSyncService.getDistinctCustomFieldKeys(listId, provider),
      provider ? externalCrmSyncService.getDefaultMappings(provider) : Promise.resolve(null)
    ]);

    res.json({
      keys,
      defaults: defaults?.customFieldMapping || []
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Failed to fetch custom fields' });
  }
});

// ─── Sync configuration ───────────────────────────────────────────────────────

// GET /api/crm-sync/config/:listId/:provider
router.get('/config/:listId/:provider', async (req: any, res) => {
  try {
    const userId = req.user?.userId;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const { listId, provider } = req.params;
    const ownership = await verifyListOwnership(userId, listId);
    if (!ownership.ok) return res.status(ownership.status!).json({ error: ownership.error });

    const config = await externalCrmSyncService.getConfig(userId, listId, provider);
    if (!config) return res.json({ configured: false });

    // Lazily backfill webhookSecret for configs created before this feature was added.
    // Non-fatal: if the write fails the config is still returned without a webhookUrl.
    if (!config.webhookSecret) {
      try {
        await externalCrmSyncService.ensureWebhookSecret(userId, listId, provider, config);
      } catch (backfillErr: any) {
        console.warn(`[CrmSync] ensureWebhookSecret failed for list ${listId}/${provider}: ${backfillErr.message}`);
      }
    }

    const backendUrl = process.env.BACKEND_URL || 'http://localhost:3001';
    res.json({
      configured: true,
      provider: config.provider,
      accountId: config.accountId,
      hasManualToken: !!config.apiKeyEncrypted,
      autoSyncEnabled: config.autoSyncEnabled,
      contactFieldMapping: config.contactFieldMapping,
      dealFieldMapping: config.dealFieldMapping,
      customFieldMapping: config.customFieldMapping,
      deleteOnPush: config.deleteOnPush ?? false,
      deleteOnPull: config.deleteOnPull ?? false,
      webhookEnabled: config.webhookEnabled ?? true,
      listName: config.listName,
      externalPipelineId: config.externalPipelineId,
      lastPushSyncAt: config.lastPushSyncAt,
      lastPullSyncAt: config.lastPullSyncAt,
      lastSyncStatus: config.lastSyncStatus,
      lastSyncError: config.lastSyncError,
      createdAt: config.createdAt,
      updatedAt: config.updatedAt,
      // Webhook URL — secret embedded as query param so HubSpot/Attio can call it with no custom headers
      webhookUrl: config.webhookSecret
        ? `${backendUrl}/api/crm/${provider}/${listId}/webhook?secret=${config.webhookSecret}`
        : undefined,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Failed to get config' });
  }
});

// PUT /api/crm-sync/config/:listId/:provider
router.put('/config/:listId/:provider', async (req: any, res) => {
  try {
    const userId = req.user?.userId;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const { listId, provider } = req.params;
    if (!['hubspot', 'attio'].includes(provider)) {
      return res.status(400).json({ error: 'Unsupported provider. Use hubspot or attio.' });
    }

    const ownership = await verifyListOwnership(userId, listId);
    if (!ownership.ok) return res.status(ownership.status!).json({ error: ownership.error });

    const {
      accountId, apiKey, autoSyncEnabled,
      contactFieldMapping, dealFieldMapping, customFieldMapping,
      deleteOnPush, deleteOnPull, webhookEnabled,
      externalPipelineId, listName,
    } = req.body;

    // Validate Attio API key length before encrypting and storing it.
    if (apiKey && provider === 'attio' && apiKey.trim().length !== 64) {
      return res.status(400).json({
        error: `Invalid Attio API key: keys must be exactly 64 characters (yours is ${apiKey.trim().length}). Copy the full key from Attio Settings → API Keys.`,
      });
    }

    const config = await externalCrmSyncService.saveConfig(userId, listId, provider, {
      accountId, apiKey, autoSyncEnabled,
      contactFieldMapping, dealFieldMapping, customFieldMapping,
      deleteOnPush, deleteOnPull, webhookEnabled,
      externalPipelineId, listName,
    });

    res.json({
      configured: true,
      provider: config.provider,
      accountId: config.accountId,
      hasManualToken: !!config.apiKeyEncrypted,
      autoSyncEnabled: config.autoSyncEnabled,
      contactFieldMapping: config.contactFieldMapping,
      dealFieldMapping: config.dealFieldMapping,
      customFieldMapping: config.customFieldMapping,
      deleteOnPush: config.deleteOnPush ?? false,
      deleteOnPull: config.deleteOnPull ?? false,
      webhookEnabled: config.webhookEnabled ?? true,
      listName: config.listName,
      externalPipelineId: config.externalPipelineId,
      createdAt: config.createdAt,
      updatedAt: config.updatedAt,
      // Webhook URL — secret embedded as query param so HubSpot/Attio can call it with no custom headers
      webhookUrl: config.webhookSecret
        ? `${process.env.BACKEND_URL || 'http://localhost:3001'}/api/crm/${provider}/${listId}/webhook?secret=${config.webhookSecret}`
        : undefined,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Failed to save config' });
  }
});

// DELETE /api/crm-sync/config/:listId/:provider
router.delete('/config/:listId/:provider', async (req: any, res) => {
  try {
    const userId = req.user?.userId;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const { listId, provider } = req.params;
    const ownership = await verifyListOwnership(userId, listId);
    if (!ownership.ok) return res.status(ownership.status!).json({ error: ownership.error });

    await externalCrmSyncService.deleteConfig(userId, listId, provider);
    res.json({ message: 'Sync configuration deleted' });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Failed to delete config' });
  }
});

// ─── External property discovery ─────────────────────────────────────────────

// GET /api/crm-sync/external-properties/:listId/:provider?objectType=contact|deal
// Returns CRM properties/attributes for use in the mapping dropdowns.
router.get('/external-properties/:listId/:provider', async (req: any, res) => {
  try {
    const userId = req.user?.userId;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const { listId, provider } = req.params;
    if (!['hubspot', 'attio'].includes(provider)) {
      return res.status(400).json({ error: 'Unsupported provider. Use hubspot or attio.' });
    }

    const ownership = await verifyListOwnership(userId, listId);
    if (!ownership.ok) return res.status(ownership.status!).json({ error: ownership.error });

    const { objectType, accountId, apiKey } = req.query as {
      objectType?: 'contact' | 'deal';
      accountId?: string;
      apiKey?: string;
    };

    const result = await externalCrmSyncService.getExternalProperties(userId, listId, provider, {
      objectType,
      accountId,
      apiKey,
    });
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Failed to fetch CRM properties' });
  }
});

// Returns HubSpot deal pipelines so the user can pre-select one.
router.get('/external-pipelines/:listId/:provider', async (req: any, res) => {
  try {
    const userId = req.user?.userId;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const { listId, provider } = req.params;
    const ownership = await verifyListOwnership(userId, listId);
    if (!ownership.ok) return res.status(ownership.status!).json({ error: ownership.error });

    const { accountId, apiKey } = req.query as { accountId?: string; apiKey?: string };
    const pipelines = await externalCrmSyncService.getExternalPipelines(userId, listId, provider, { accountId, apiKey });
    res.json({ pipelines });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Failed to fetch external pipelines' });
  }
});

// ─── Test connection ──────────────────────────────────────────────────────────

// POST /api/crm-sync/test/:listId/:provider
router.post('/test/:listId/:provider', async (req: any, res) => {
  try {
    const userId = req.user?.userId;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const { listId, provider } = req.params;
    const ownership = await verifyListOwnership(userId, listId);
    if (!ownership.ok) return res.status(ownership.status!).json({ error: ownership.error });

    console.log(`[CrmSync] Testing connection for list ${listId} provider ${provider}...`);
    const { apiKey, accountId } = req.body ?? {};
    const result = await externalCrmSyncService.testConnection(userId, listId, provider, { apiKey, accountId });
    console.log(`[CrmSync] Test result:`, JSON.stringify(result));

    // On successful test with new inline credentials, persist a minimal config so the
    // webhookSecret is generated immediately and the webhook URL can be copied without
    // requiring a separate Save step.
    if (result.valid && (apiKey || accountId)) {
      const saved = await externalCrmSyncService.saveConfig(userId, listId, provider, { apiKey, accountId });
      const backendUrl = process.env.BACKEND_URL || 'http://localhost:3001';
      const webhookUrl = saved.webhookSecret
        ? `${backendUrl}/api/crm/${provider}/${listId}/webhook?secret=${saved.webhookSecret}`
        : undefined;
      return res.json({ ...result, webhookUrl });
    }

    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Failed to test connection' });
  }
});

// ─── Sync operations ──────────────────────────────────────────────────────────

// POST /api/crm-sync/push/:listId/:provider
router.post('/push/:listId/:provider', async (req: any, res) => {
  try {
    const userId = req.user?.userId;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const { listId, provider } = req.params;
    const ownership = await verifyListOwnership(userId, listId);
    if (!ownership.ok) return res.status(ownership.status!).json({ error: ownership.error });

    const result = await externalCrmSyncService.pushAllLeads(userId, listId, provider);
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Failed to push leads' });
  }
});

// POST /api/crm-sync/pull/:listId/:provider
router.post('/pull/:listId/:provider', async (req: any, res) => {
  try {
    const userId = req.user?.userId;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const { listId, provider } = req.params;
    const ownership = await verifyListOwnership(userId, listId);
    if (!ownership.ok) return res.status(ownership.status!).json({ error: ownership.error });

    const result = await externalCrmSyncService.pullAllContacts(userId, listId, provider);
    res.json(result);
  } catch (err: any) {
    console.error(`[crmSync] Pull error for provider ${req.params?.provider}:`, err.response?.data || err);
    res.status(500).json({ error: err.response?.data?.message || err.message || 'Failed to pull contacts' });
  }
});

// ─── Delete lead from CRM ─────────────────────────────────────────────────────

// POST /api/crm-sync/delete-lead/:listId/:provider
// Body: { lead } — the full lead object (needs syncMetadata with CRM IDs)
// Called when deleteOnPush is enabled and a lead is deleted locally.
router.post('/delete-lead/:listId/:provider', async (req: any, res) => {
  try {
    const userId = req.user?.userId;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const { listId, provider } = req.params;
    if (!['hubspot', 'attio'].includes(provider)) {
      return res.status(400).json({ error: 'Unsupported provider. Use hubspot or attio.' });
    }

    const ownership = await verifyListOwnership(userId, listId);
    if (!ownership.ok) return res.status(ownership.status!).json({ error: ownership.error });

    const { lead } = req.body;
    if (!lead) return res.status(400).json({ error: 'Missing lead in request body' });

    await externalCrmSyncService.deleteLeadFromCrm(userId, listId, provider, lead);
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Failed to delete lead from CRM' });
  }
});

export default router;
