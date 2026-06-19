import express from 'express';
import { authenticateToken } from '../middleware/auth';
import { crmDb, userDb } from '../services/db';
import {
  externalCrmSyncService,
} from '../services/externalCrmSyncService';
import { ensureWebhookSubscriptions } from '../utils/hubspotWebhookSubscriptions';

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
    // Post-disconnect: config record exists but credential cleared → not configured.
    const hasCredential = !!(config.accountId || config.apiKeyEncrypted);
    res.json({
      configured: hasCredential,
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

    // Enforce one-account-per-list: reject if another list already uses this accountId.
    // Uses org-aware query so two team members can't independently bind the same portal.
    if (accountId) {
      const allLists = await crmDb.getLeadListsForUser(userId);
      const conflict = (allLists || []).find((l: any) => {
        if (l.listId === listId) return false;
        const cfg = l.externalCrmSyncConfigs?.[provider];
        return cfg?.accountId === accountId;
      });
      if (conflict) {
        return res.status(409).json({
          error: `This account is already linked to another list ("${(conflict as any).name || conflict.listId}"). Disconnect it there first.`,
        });
      }
    }

    const config = await externalCrmSyncService.saveConfig(userId, listId, provider, {
      accountId, apiKey, autoSyncEnabled,
      contactFieldMapping, dealFieldMapping, customFieldMapping,
      deleteOnPush, deleteOnPull, webhookEnabled,
      externalPipelineId, listName,
    });

    // Fire-and-forget: register webhook subscriptions for any custom HubSpot
    // properties in the mapping that aren't already subscribed in the public app.
    // Only for HubSpot OAuth connections — manual token users use per-list webhooks.
    if (provider === 'hubspot' && (accountId || config.accountId)) {
      void ensureWebhookSubscriptions(
        contactFieldMapping ?? config.contactFieldMapping ?? [],
        customFieldMapping ?? config.customFieldMapping ?? [],
      );
    }

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

// DELETE /api/crm-sync/config/:listId/:provider/account
// Disconnects the OAuth account from this list (clears accountId + credentials)
// while preserving field mappings and other settings.
// Only the user's explicit action in the CRM sync dialog triggers this — OAuth
// revocation from the settings page does NOT call this route, so the account
// remains "used" and blocked from linking to other lists unless manually disconnected.
router.delete('/config/:listId/:provider/account', async (req: any, res) => {
  try {
    const userId = req.user?.userId;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const { listId, provider } = req.params;
    const ownership = await verifyListOwnership(userId, listId);
    if (!ownership.ok) return res.status(ownership.status!).json({ error: ownership.error });

    await externalCrmSyncService.disconnectAccount(userId, listId, provider);
    res.json({ message: 'Account disconnected' });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Failed to disconnect account' });
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
    const axiosData = err.response?.data;
    console.error('[external-pipelines] error', {
      message: err.message,
      status: err.response?.status,
      data: axiosData,
    });
    res.status(500).json({ error: err.message || 'Failed to fetch external pipelines' });
  }
});

// PUT /api/crm-sync/config/:listId/:provider/pipeline
// Re-points a HubSpot list to a different deal pipeline AFTER the first sync
// (the normal config save locks the pipeline once synced). The client then
// triggers a push (POST /push/...) to migrate existing deals into the new pipeline.
router.put('/config/:listId/:provider/pipeline', async (req: any, res) => {
  try {
    const userId = req.user?.userId;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const { listId, provider } = req.params;
    if (provider !== 'hubspot') {
      return res.status(400).json({ error: 'Changing the deal pipeline is only supported for HubSpot.' });
    }

    const ownership = await verifyListOwnership(userId, listId);
    if (!ownership.ok) return res.status(ownership.status!).json({ error: ownership.error });

    const { externalPipelineId } = req.body as { externalPipelineId?: string };
    if (!externalPipelineId) {
      return res.status(400).json({ error: 'externalPipelineId is required.' });
    }

    const config = await externalCrmSyncService.changePipeline(userId, listId, provider, externalPipelineId);
    res.json({ config });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Failed to change pipeline' });
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
      if (accountId) {
        const allLists = await crmDb.getLeadListsForUser(userId);
        const conflict = (allLists || []).find((l: any) => {
          if (l.listId === listId) return false;
          const cfg = l.externalCrmSyncConfigs?.[provider];
          return cfg?.accountId === accountId;
        });
        if (conflict) {
          return res.status(409).json({
            error: `This account is already linked to another list ("${(conflict as any).name || conflict.listId}"). Disconnect it there first.`,
          });
        }
      }
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
// Starts the push in the background and returns 202 immediately. A full-list
// push can take minutes (sequential per-lead CRM API calls); holding the HTTP
// connection open caused upstream proxies to sever it at ~40s and surface a
// spurious "Push failed" even though the backend kept running and succeeded.
// The client polls GET .../status for progress and the final result.
router.post('/push/:listId/:provider', async (req: any, res) => {
  try {
    const userId = req.user?.userId;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const { listId, provider } = req.params;
    const ownership = await verifyListOwnership(userId, listId);
    if (!ownership.ok) return res.status(ownership.status!).json({ error: ownership.error });

    // Validation (config + auth) happens synchronously inside startPushJob and
    // throws here; the actual push runs detached (completion is not awaited).
    const { job } = await externalCrmSyncService.startPushJob(userId, listId, provider);
    res.status(202).json(job);
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Failed to push leads' });
  }
});

// GET /api/crm-sync/push/:listId/:provider/status
// Returns the latest push job (running/completed/error) for the polling UI.
router.get('/push/:listId/:provider/status', async (req: any, res) => {
  try {
    const userId = req.user?.userId;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const { listId, provider } = req.params;
    const ownership = await verifyListOwnership(userId, listId);
    if (!ownership.ok) return res.status(ownership.status!).json({ error: ownership.error });

    const job = await externalCrmSyncService.getPushJob(userId, listId, provider);
    if (!job) return res.json({ status: 'idle' });
    res.json(job);
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Failed to get push status' });
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

// ─── Used accounts ────────────────────────────────────────────────────────────

// GET /api/crm-sync/used-accounts
// Returns all connected account IDs that are already linked to a lead list for
// this user, so the UI can disable those accounts in the selector.
router.get('/used-accounts', async (req: any, res) => {
  try {
    const userId = req.user?.userId;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const lists = await crmDb.getLeadListsByUserId(userId);
    const used: Array<{ accountId: string; listId: string; listName: string; provider: string }> = [];

    for (const list of (lists || [])) {
      const configs = (list as any).externalCrmSyncConfigs as Record<string, any> | undefined;
      if (!configs) continue;
      for (const [provider, config] of Object.entries(configs)) {
        if (config?.accountId) {
          used.push({
            accountId: config.accountId,
            listId: list.listId,
            listName: (list as any).name || list.listId,
            provider,
          });
        }
      }
    }

    res.json({ used });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Failed to fetch used accounts' });
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
