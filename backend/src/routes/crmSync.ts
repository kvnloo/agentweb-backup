import express from 'express';
import { authenticateToken } from '../middleware/auth';
import { crmDb } from '../services/db';
import { attioService } from '../services/attioService';
import { hubspotService } from '../services/hubspotService';
import { getAccountsByUserId } from '../services/connectedAccountsDb';
import { externalCrmSyncService, DEFAULT_HUBSPOT_CONTACT_MAPPING, DEFAULT_HUBSPOT_DEAL_MAPPING, DEFAULT_ATTIO_CONTACT_MAPPING, DEFAULT_ATTIO_DEAL_MAPPING } from '../services/externalCrmSyncService';

const router = express.Router();
router.use(authenticateToken);

// ─── Types ────────────────────────────────────────────────────────────────────

interface SyncConfig {
  platform: 'hubspot' | 'attio';
  accountId: string;
  direction: 'push' | 'pull' | 'bidirectional';
  lastSyncedAt?: string;
  externalListId?: string;
  externalPeopleListId?: string;
  externalCompaniesListId?: string;
}

interface LeadRow {
  leadId: string;
  email?: string;
  firstName?: string;
  lastName?: string;
  phone?: string;
  company?: string;
  title?: string;
  notes?: string;
  linkedin?: string;
  customFields?: Record<string, any>;
  attioRecordId?: string;
}

// ─── Save / update sync config for a list ────────────────────────────────────

router.post('/config/:listId', async (req: any, res) => {
  const { listId } = req.params;
  const { platform, accountId, direction } = req.body as SyncConfig;

  if (!platform || !accountId || !direction) {
    return res.status(400).json({ error: 'platform, accountId and direction are required' });
  }
  if (!['hubspot', 'attio'].includes(platform)) {
    return res.status(400).json({ error: 'platform must be hubspot or attio' });
  }
  if (!['push', 'pull', 'bidirectional'].includes(direction)) {
    return res.status(400).json({ error: 'direction must be push, pull or bidirectional' });
  }

  const list = await crmDb.getLeadListById(listId);
  if (!list) return res.status(404).json({ error: 'List not found' });

  const existing = (list as any).syncConfig ?? {};
  await crmDb.updateLeadList(listId, {
    syncConfig: {
      ...existing,
      platform,
      accountId,
      direction,
    },
  });

  res.json({ success: true });
});

// ─── Get sync status for a list ──────────────────────────────────────────────

router.get('/status/:listId', async (req: any, res) => {
  const { listId } = req.params;
  const list = await crmDb.getLeadListById(listId);
  if (!list) return res.status(404).json({ error: 'List not found' });

  const syncConfig = (list as any).syncConfig ?? null;
  res.json({ syncConfig });
});

// ─── Trigger sync for a list ──────────────────────────────────────────────────
// direction=push  → our leads → CRM
// direction=pull  → CRM → our leads (not yet implemented, returns 501)
// direction=bidirectional → push only for now, pull TBD (conflict rule pending)

router.post('/run/:listId', async (req: any, res) => {
  const { listId } = req.params;
  const userId = req.user!.userId;

  const list = await crmDb.getLeadListById(listId);
  if (!list) return res.status(404).json({ error: 'List not found' });

  const syncConfig: SyncConfig | null = (list as any).syncConfig ?? null;
  if (!syncConfig) return res.status(400).json({ error: 'No sync config saved for this list. Configure sync first.' });

  const { platform, accountId, direction } = syncConfig;

  if (direction === 'pull') {
    return res.status(501).json({ error: 'Pull sync not yet implemented. Conflict resolution rule pending.' });
  }

  try {
    // Fetch all leads for the list (paginated)
    const allLeads: LeadRow[] = [];
    let lastKey: any = undefined;
    do {
      const page = await crmDb.getLeadsByListId(listId, 100, lastKey);
      allLeads.push(...(page.items as unknown as LeadRow[]));
      lastKey = page.lastEvaluatedKey;
    } while (lastKey);

    if (allLeads.length === 0) {
      return res.json({ success: true, synced: 0, message: 'No leads to sync' });
    }

    let synced = 0;

    if (platform === 'attio') {
      synced = await syncToAttio(userId, accountId, list, allLeads, syncConfig);
    } else {
      synced = await syncToHubSpot(userId, accountId, list, allLeads, syncConfig);
    }

    // Update lastSyncedAt
    await crmDb.updateLeadList(listId, {
      syncConfig: { ...syncConfig, lastSyncedAt: new Date().toISOString() },
    });

    res.json({ success: true, synced, total: allLeads.length });
  } catch (error: any) {
    console.error(`[CRM Sync] Error syncing list ${listId}:`, error?.response?.data ?? error);
    res.status(500).json({ error: error.message ?? 'Sync failed' });
  }
});

// ─── Attio sync handler ───────────────────────────────────────────────────────

async function syncToAttio(
  userId: string,
  accountId: string,
  list: any,
  leads: LeadRow[],
  syncConfig: SyncConfig
): Promise<number> {
  const listName = list.name as string;

  // Ensure both People and Companies lists exist in Attio
  const peopleListId = syncConfig.externalPeopleListId
    ?? await attioService.findOrCreateList(userId, listName, 'people', accountId);

  const companiesListId = syncConfig.externalCompaniesListId
    ?? await attioService.findOrCreateList(userId, `${listName} - Companies`, 'companies', accountId);

  // Persist list IDs so subsequent syncs skip the find step
  await crmDb.updateLeadList(list.listId, {
    syncConfig: {
      ...syncConfig,
      externalPeopleListId: peopleListId,
      externalCompaniesListId: companiesListId,
    },
  });

  // Collect all custom field keys across leads (+ notes) and ensure they exist
  // as list entry attributes on the Attio people list.
  // Attributes are scoped to the list — no global pollution on the people object.
  const customFieldKeys = new Set<string>();
  for (const lead of leads) {
    if (lead.notes) customFieldKeys.add('notes');
    if (lead.customFields) {
      Object.keys(lead.customFields).forEach(k => {
        if (lead.customFields![k] != null && String(lead.customFields![k]).trim()) {
          customFieldKeys.add(k);
        }
      });
    }
  }

  // Build slug map: original key → attio slug (find-or-create each attribute)
  const slugMap: Record<string, string> = {};
  for (const key of customFieldKeys) {
    const title = key.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/_/g, ' ')
      .replace(/\b\w/g, c => c.toUpperCase()); // "leadSource" → "Lead Source"
    slugMap[key] = await attioService.ensureListAttribute(userId, peopleListId, key, title, accountId);
  }

  let synced = 0;

  for (const lead of leads) {
    try {
      // 1. Handle company: find or create in Attio
      let companyId: string | undefined;
      if (lead.company) {
        const existingCompany = await attioService.findCompanyByName(userId, lead.company, accountId);
        if (existingCompany) {
          companyId = existingCompany.recordId;
        } else {
          const newCompany = await attioService.createCompany(userId, lead.company, accountId);
          companyId = newCompany.recordId;
        }
        // Add company to companies list
        await attioService.addCompanyToList(userId, companiesListId, companyId, accountId).catch(() => {
          // Ignore if already in list
        });
      }

      // 2. Handle person: upsert in Attio
      let personId: string;
      const personData = {
        firstName: lead.firstName,
        lastName: lead.lastName,
        phone: lead.phone,
        jobTitle: lead.title,
        linkedinUrl: lead.linkedin,
        companyId,
      };
      if (lead.email) {
        // PUT upsert — creates or updates atomically by email, no duplicates
        const person = await attioService.upsertPerson(userId, { ...personData, email: lead.email }, accountId);
        personId = person.recordId;
      } else if (lead.attioRecordId) {
        // No email but we have the Attio record ID from a previous sync — update directly
        await attioService.updatePerson(userId, lead.attioRecordId, personData, accountId);
        personId = lead.attioRecordId;
      } else {
        // No email, no prior record — create once and store the ID to avoid duplicates next sync
        const person = await attioService.createPerson(userId, {
          firstName: lead.firstName,
          lastName: lead.lastName,
          phone: lead.phone,
          jobTitle: lead.title,
          companyId,
        }, accountId);
        personId = person.recordId;
        // Persist attioRecordId so subsequent syncs update instead of creating duplicates
        await crmDb.updateLead(list.listId, lead.leadId, { attioRecordId: personId });
      }

      // 3. Build list entry values from notes + custom fields
      const entryValues: Record<string, any[]> = {};
      if (lead.notes && slugMap['notes']) {
        entryValues[slugMap['notes']] = [{ value: lead.notes }];
      }
      if (lead.customFields) {
        for (const [key, val] of Object.entries(lead.customFields)) {
          if (val != null && String(val).trim() && slugMap[key]) {
            entryValues[slugMap[key]] = [{ value: String(val) }];
          }
        }
      }

      // Guard: personId must be a non-empty string before touching list entries
      if (!personId) {
        console.error(`[CRM Sync/Attio] Lead ${lead.leadId}: upsert returned no record ID, skipping list entry`);
        synced++;
        continue;
      }

      // 4. Add person to people list, or update entry values if already present
      try {
        const existingEntryId = await attioService.findListEntry(userId, peopleListId, personId, accountId);
        if (existingEntryId) {
          if (Object.keys(entryValues).length > 0) {
            await attioService.updateListEntry(userId, peopleListId, existingEntryId, entryValues, accountId);
          }
        } else {
          await attioService.addPersonToList(userId, peopleListId, personId, accountId, entryValues);
        }
      } catch (listErr: any) {
        // List entry query/update failed — fall back to add-or-ignore so at least
        // the person record is in the list even if entry values can't be written.
        console.warn(`[CRM Sync/Attio] Lead ${lead.leadId}: list entry update failed (${listErr?.response?.data?.message ?? listErr.message}), falling back to add`);
        await attioService.addPersonToList(userId, peopleListId, personId, accountId, entryValues).catch(() => { });
      }

      synced++;
    } catch (err: any) {
      console.error(`[CRM Sync/Attio] Failed to sync lead ${lead.leadId}:`, err?.response?.data ?? err.message);
    }
  }

  return synced;
}

// ─── HubSpot sync handler ─────────────────────────────────────────────────────

async function syncToHubSpot(
  userId: string,
  accountId: string,
  list: any,
  leads: LeadRow[],
  syncConfig: SyncConfig
): Promise<number> {
  const listName = list.name as string;

  // Ensure HubSpot list exists
  const hsListId = syncConfig.externalListId
    ?? await hubspotService.findOrCreateList(userId, listName, accountId);

  // Persist list ID
  await crmDb.updateLeadList(list.listId, {
    syncConfig: { ...syncConfig, externalListId: hsListId },
  });

  // Extract and ensure custom properties exist in HubSpot
  const customFieldKeys = new Set<string>();
  for (const lead of leads) {
    if (lead.customFields) {
      Object.keys(lead.customFields).forEach(k => {
        if (lead.customFields![k] != null && String(lead.customFields![k]).trim()) {
          customFieldKeys.add(k);
        }
      });
    }
  }

  const slugMap: Record<string, string> = {};
  for (const key of customFieldKeys) {
    const title = key.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/_/g, ' ')
      .replace(/\b\w/g, c => c.toUpperCase());
    slugMap[key] = await hubspotService.ensureContactProperty(userId, key, title, accountId);
  }

  let synced = 0;
  const batchContactIds: string[] = [];

  const mapCustomFields = (leadCustomFields?: Record<string, any>) => {
    if (!leadCustomFields) return undefined;
    const mapped: Record<string, any> = {};
    for (const [k, v] of Object.entries(leadCustomFields)) {
      if (slugMap[k] && v != null && String(v).trim()) {
        mapped[slugMap[k]] = String(v);
      }
    }
    return Object.keys(mapped).length > 0 ? mapped : undefined;
  };

  for (const lead of leads) {
    try {
      // 1. Find or create contact
      let contactId: string;
      if (lead.email) {
        const existing = await hubspotService.findContactByEmail(userId, lead.email, accountId);
        if (existing) {
          await hubspotService.updateContact(userId, existing.contactId, {
            firstName: lead.firstName,
            lastName: lead.lastName,
            phone: lead.phone,
            jobTitle: lead.title,
            company: lead.company,
            linkedinUrl: lead.linkedin,
            customFields: mapCustomFields(lead.customFields),
          }, accountId);
          contactId = existing.contactId;
        } else {
          const contact = await hubspotService.createContact(userId, {
            email: lead.email,
            firstName: lead.firstName,
            lastName: lead.lastName,
            phone: lead.phone,
            jobTitle: lead.title,
            company: lead.company,
            linkedinUrl: lead.linkedin,
            customFields: mapCustomFields(lead.customFields),
          }, accountId);
          contactId = contact.contactId;
        }
      } else {
        const contact = await hubspotService.createContact(userId, {
          firstName: lead.firstName,
          lastName: lead.lastName,
          phone: lead.phone,
          company: lead.company,
          customFields: mapCustomFields(lead.customFields),
        }, accountId);
        contactId = contact.contactId;
      }

      batchContactIds.push(contactId);
      synced++;
    } catch (err: any) {
      console.error(`[CRM Sync/HubSpot] Failed to sync lead ${lead.leadId}:`, err?.response?.data ?? err.message);
    }
  }

  // Add all contacts to the HubSpot list in one batch
  if (batchContactIds.length > 0) {
    await hubspotService.addContactToList(userId, hsListId, batchContactIds, accountId);
  }

  return synced;
}

// ═══════════════════════════════════════════════════════════════════════════════
// External CRM Sync routes  (/api/crm-sync/external/...)
// Supports both OAuth-connected accounts and manual API tokens
// ═══════════════════════════════════════════════════════════════════════════════

async function verifyListOwnership(userId: string, listId: string): Promise<{ ok: boolean; status?: number; error?: string }> {
  const list = await crmDb.getLeadListById(listId);
  if (!list) return { ok: false, status: 404, error: 'Lead list not found' };
  if ((list as any).userId !== userId) return { ok: false, status: 403, error: 'Access denied' };
  return { ok: true };
}

// GET  /api/crm-sync/external/defaults/:provider
// Returns default field mappings for provider so the frontend can pre-populate
router.get('/external/defaults/:provider', (req: any, res) => {
  const { provider } = req.params;
  if (provider === 'hubspot') {
    return res.json({
      contactFieldMapping: DEFAULT_HUBSPOT_CONTACT_MAPPING,
      dealFieldMapping:    DEFAULT_HUBSPOT_DEAL_MAPPING,
    });
  }
  if (provider === 'attio') {
    return res.json({
      contactFieldMapping: DEFAULT_ATTIO_CONTACT_MAPPING,
      dealFieldMapping:    DEFAULT_ATTIO_DEAL_MAPPING,
    });
  }
  res.status(400).json({ error: 'Unsupported provider. Use hubspot or attio.' });
});

// GET  /api/crm-sync/external/custom-fields/:listId
// Returns sorted distinct custom field keys across all leads in the list
router.get('/external/custom-fields/:listId', async (req: any, res) => {
  try {
    const userId = req.user?.userId;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const { listId } = req.params;
    const ownership = await verifyListOwnership(userId, listId);
    if (!ownership.ok) return res.status(ownership.status!).json({ error: ownership.error });

    const keys = await externalCrmSyncService.getDistinctCustomFieldKeys(listId);
    res.json({ keys });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Failed to fetch custom fields' });
  }
});

// GET  /api/crm-sync/external/config/:listId/:provider
router.get('/external/config/:listId/:provider', async (req: any, res) => {
  try {
    const userId = req.user?.userId;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const { listId, provider } = req.params;
    const ownership = await verifyListOwnership(userId, listId);
    if (!ownership.ok) return res.status(ownership.status!).json({ error: ownership.error });

    const config = await externalCrmSyncService.getConfig(userId, listId, provider);
    if (!config) return res.json({ configured: false });

    res.json({
      configured: true,
      provider:            config.provider,
      accountId:           config.accountId,
      hasManualToken:      !!config.apiKeyEncrypted,
      autoSyncEnabled:     config.autoSyncEnabled,
      contactFieldMapping: config.contactFieldMapping,
      dealFieldMapping:    config.dealFieldMapping,
      customFieldMapping:  config.customFieldMapping,
      lastPushSyncAt:      config.lastPushSyncAt,
      lastPullSyncAt:      config.lastPullSyncAt,
      lastSyncStatus:      config.lastSyncStatus,
      lastSyncError:       config.lastSyncError,
      createdAt:           config.createdAt,
      updatedAt:           config.updatedAt,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Failed to get config' });
  }
});

// PUT  /api/crm-sync/external/config/:listId/:provider
router.put('/external/config/:listId/:provider', async (req: any, res) => {
  try {
    const userId = req.user?.userId;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const { listId, provider } = req.params;
    if (!['hubspot', 'attio'].includes(provider)) {
      return res.status(400).json({ error: 'Unsupported provider. Use hubspot or attio.' });
    }

    const ownership = await verifyListOwnership(userId, listId);
    if (!ownership.ok) return res.status(ownership.status!).json({ error: ownership.error });

    // Also persist the list name in externalCrmSyncService so push can use it for Attio list naming
    const list = await crmDb.getLeadListById(listId);

    const { accountId, apiKey, autoSyncEnabled, contactFieldMapping, dealFieldMapping, customFieldMapping } = req.body;

    const config = await externalCrmSyncService.saveConfig(userId, listId, provider, {
      accountId, apiKey, autoSyncEnabled, contactFieldMapping, dealFieldMapping, customFieldMapping,
    });

    res.json({
      configured:          true,
      provider:            config.provider,
      accountId:           config.accountId,
      hasManualToken:      !!config.apiKeyEncrypted,
      autoSyncEnabled:     config.autoSyncEnabled,
      contactFieldMapping: config.contactFieldMapping,
      dealFieldMapping:    config.dealFieldMapping,
      customFieldMapping:  config.customFieldMapping,
      createdAt:           config.createdAt,
      updatedAt:           config.updatedAt,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Failed to save config' });
  }
});

// DELETE  /api/crm-sync/external/config/:listId/:provider
router.delete('/external/config/:listId/:provider', async (req: any, res) => {
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

// POST  /api/crm-sync/external/test/:listId/:provider
router.post('/external/test/:listId/:provider', async (req: any, res) => {
  try {
    const userId = req.user?.userId;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const { listId, provider } = req.params;
    const ownership = await verifyListOwnership(userId, listId);
    if (!ownership.ok) return res.status(ownership.status!).json({ error: ownership.error });

    const result = await externalCrmSyncService.testConnection(userId, listId, provider);
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Failed to test connection' });
  }
});

// POST  /api/crm-sync/external/push/:listId/:provider
router.post('/external/push/:listId/:provider', async (req: any, res) => {
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

// POST  /api/crm-sync/external/pull/:listId/:provider
router.post('/external/pull/:listId/:provider', async (req: any, res) => {
  try {
    const userId = req.user?.userId;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const { listId, provider } = req.params;
    const ownership = await verifyListOwnership(userId, listId);
    if (!ownership.ok) return res.status(ownership.status!).json({ error: ownership.error });

    const result = await externalCrmSyncService.pullAllContacts(userId, listId, provider);
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Failed to pull contacts' });
  }
});

export default router;
