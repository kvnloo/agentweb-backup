import crypto from 'crypto';
import { crmDb } from './db';
import { decryptPassword, encryptPassword } from '../utils/crypto';
import { CrmAuth, CrmAdapter } from './adapters/crmAdapterTypes';
import { AttioAdapter } from './adapters/attioAdapter';
import { HubspotAdapter } from './adapters/hubspotAdapter';
import { HubSpotService, HubSpotPipelineStage } from './hubspotService';
import { AttioService } from './attioService';

// ─── CRM Adapter Registry ─────────────────────────────────────────────────────

const adapters: Record<string, CrmAdapter> = {
  attio: new AttioAdapter(),
  hubspot: new HubspotAdapter(),
};

function getAdapter(provider: string): CrmAdapter {
  const adapter = adapters[provider.toLowerCase()];
  if (!adapter) {
    throw new Error(`Unsupported CRM provider: "${provider}". Supported: ${Object.keys(adapters).join(', ')}`);
  }
  return adapter;
}

// ─── Interfaces ───────────────────────────────────────────────────────────────

export interface FieldMapping {
  agentwebField: string;
  crmProperty: string;
  direction: 'push' | 'pull' | 'both';
  enabled: boolean;
}

export interface ExternalCrmSyncConfig {
  provider: 'hubspot' | 'attio';
  listId: string;
  userId: string;
  // Auth — exactly one should be set
  accountId?: string;         // OAuth connected account
  apiKeyEncrypted?: string;   // Manual token (encrypted at rest)
  // Settings
  autoSyncEnabled: boolean;
  contactFieldMapping: FieldMapping[];
  dealFieldMapping: FieldMapping[];
  customFieldMapping: FieldMapping[];
  // Delete sync options
  deleteOnPush?: boolean;   // Delete CRM record when a local lead is deleted
  deleteOnPull?: boolean;   // Mark local lead as removed when CRM record is deleted
  // Human-readable display name — used when creating deal pipelines
  listName?: string;
  // Cached external IDs to skip redundant lookups
  externalPipelineId?: string;      // HubSpot deal pipeline ID
  hubspotDealStageMap?: Record<string, string>; // AgentWeb status value -> HubSpot stage ID
  // Sync state
  lastPushSyncAt?: string;
  lastPullSyncAt?: string;
  lastSyncStatus?: 'success' | 'error';
  lastSyncError?: string;
  createdAt: string;
  updatedAt: string;
  // Per-list webhook URL secret (embedded in webhook URL, verified on every request)
  webhookSecret?: string;
  // Whether incoming webhook events from the CRM should update AgentWeb leads (default: true)
  webhookEnabled?: boolean;
}

export interface SyncResult {
  successCount: number;
  newCount: number;
  updatedCount: number;
  errorCount: number;
  errors: string[];
  removedCount?: number;        // leads marked as CRM-removed (deleteOnPull)
  seenExternalIds?: string[];   // populated by adapters during pull, consumed by service for delete sweep
}

export interface CrmProperty {
  name: string;   // api key / slug
  label: string;  // human-readable display name
  type?: string;  // optional type hint for the UI
}

type StatusType = 'active' | 'won' | 'lost' | 'churned';
type StatusOption = { value: string; label: string; color: string; type: StatusType };

// ─── Default mappings ─────────────────────────────────────────────────────────

export const DEFAULT_HUBSPOT_CONTACT_MAPPING: FieldMapping[] = [
  { agentwebField: 'email', crmProperty: 'email', direction: 'both', enabled: true },
  { agentwebField: 'firstName', crmProperty: 'firstname', direction: 'both', enabled: true },
  { agentwebField: 'lastName', crmProperty: 'lastname', direction: 'both', enabled: true },
  { agentwebField: 'phone', crmProperty: 'phone', direction: 'both', enabled: true },
  { agentwebField: 'company', crmProperty: 'company', direction: 'both', enabled: true },
  { agentwebField: 'title', crmProperty: 'jobtitle', direction: 'both', enabled: true },
  { agentwebField: 'linkedin', crmProperty: 'hs_linkedin_url', direction: 'push', enabled: true },
];

// 'notes' has no standard HubSpot contact property — pushed as a custom property
// so ensureContactProperty runs before the push and creates it if absent.
export const DEFAULT_HUBSPOT_CUSTOM_MAPPING: FieldMapping[] = [
  // { agentwebField: 'notes', crmProperty: 'notes', direction: 'push', enabled: false },
];

export const DEFAULT_HUBSPOT_DEAL_MAPPING: FieldMapping[] = [
  { agentwebField: 'dealValue', crmProperty: 'amount', direction: 'both', enabled: true },
  { agentwebField: 'dealCurrency', crmProperty: 'deal_currency_code', direction: 'both', enabled: true },
  { agentwebField: 'status', crmProperty: 'dealstage', direction: 'both', enabled: true },
];

export const DEFAULT_ATTIO_CONTACT_MAPPING: FieldMapping[] = [
  { agentwebField: 'email', crmProperty: 'email_addresses', direction: 'both', enabled: true },
  { agentwebField: 'firstName', crmProperty: 'first_name', direction: 'both', enabled: true },
  { agentwebField: 'lastName', crmProperty: 'last_name', direction: 'both', enabled: true },
  { agentwebField: 'phone', crmProperty: 'phone_numbers', direction: 'both', enabled: true },
  { agentwebField: 'title', crmProperty: 'job_title', direction: 'both', enabled: true },
  { agentwebField: 'company', crmProperty: 'company', direction: 'both', enabled: true },
  { agentwebField: 'linkedin', crmProperty: 'linkedin', direction: 'push', enabled: true },
  // Note: 'company' is NOT a native text field on Attio People records.
  // It is synced as a list-entry attribute via DEFAULT_ATTIO_CUSTOM_MAPPING below.
];

// Attio has no separate deal entity in this integration. Deal/status fields live
// on the list entry alongside any other custom mappings.
export const DEFAULT_ATTIO_CUSTOM_MAPPING: FieldMapping[] = [
  { agentwebField: 'dealValue', crmProperty: 'deal_value', direction: 'both', enabled: true },
  { agentwebField: 'dealCurrency', crmProperty: 'deal_currency', direction: 'both', enabled: true },
  { agentwebField: 'status', crmProperty: 'deal_status', direction: 'both', enabled: true },
  { agentwebField: 'notes', crmProperty: 'notes', direction: 'push', enabled: false },
];

export const DEFAULT_ATTIO_DEAL_MAPPING: FieldMapping[] = [];

// ─── Helpers ──────────────────────────────────────────────────────────────────

// ─── Service ──────────────────────────────────────────────────────────────────

export class ExternalCrmSyncService {
  private formatError(err: any): string {
    return err?.response?.data?.message
      || err?.response?.data?.error
      || err?.message
      || 'Unknown error';
  }

  // ─── Config CRUD ────────────────────────────────────────────────────────────

  async getConfig(userId: string, listId: string, provider: string): Promise<ExternalCrmSyncConfig | null> {
    const list = await crmDb.getLeadListById(listId);
    if (!list) return null;

    const configs = (list as any).externalCrmSyncConfigs as Record<string, ExternalCrmSyncConfig> | undefined;
    if (!configs?.[provider]) return null;

    const config = configs[provider];
    if (config.userId !== userId) return null;
    return config;
  }

  /**
   * Backfills `webhookSecret` for configs that pre-date this feature.
   * Call this only from read-path handlers (GET routes) — not from saveConfig.
   */
  async ensureWebhookSecret(userId: string, listId: string, provider: string, config: ExternalCrmSyncConfig): Promise<void> {
    if (config.webhookSecret) return;
    config.webhookSecret = crypto.randomBytes(24).toString('hex');
    await crmDb.setLeadListCrmSyncConfig(listId, provider, config as any);
  }

  async saveConfig(
    userId: string,
    listId: string,
    provider: string,
    updates: {
      accountId?: string;
      apiKey?: string;
      autoSyncEnabled?: boolean;
      contactFieldMapping?: FieldMapping[];
      dealFieldMapping?: FieldMapping[];
      customFieldMapping?: FieldMapping[];
      deleteOnPush?: boolean;
      deleteOnPull?: boolean;
      webhookEnabled?: boolean;
      // Pipeline selection — only honoured before first sync (server enforces the lock)
      externalPipelineId?: string;   // HubSpot: chosen deal pipeline ID
      listName?: string;
    }
  ): Promise<ExternalCrmSyncConfig> {
    // Prevent configuring a second provider on the same list
    const list = await crmDb.getLeadListById(listId);
    const allConfigs = (list as any)?.externalCrmSyncConfigs as Record<string, ExternalCrmSyncConfig> | undefined;
    if (allConfigs) {
      const conflicting = Object.keys(allConfigs).find(p => p !== provider && allConfigs[p]?.userId);
      if (conflicting) {
        const name = conflicting.charAt(0).toUpperCase() + conflicting.slice(1);
        throw new Error(`This list is already connected to ${name}. Remove that configuration before adding a new one.`);
      }
    }

    const existing = await this.getConfig(userId, listId, provider);
    const now = new Date().toISOString();
    const isHubspot = provider === 'hubspot';

    const nextDealFieldMapping = updates.dealFieldMapping ?? existing?.dealFieldMapping
      ?? (isHubspot ? DEFAULT_HUBSPOT_DEAL_MAPPING : DEFAULT_ATTIO_DEAL_MAPPING);
    const nextCustomFieldMapping = updates.customFieldMapping ?? existing?.customFieldMapping
      ?? (isHubspot ? DEFAULT_HUBSPOT_CUSTOM_MAPPING : DEFAULT_ATTIO_CUSTOM_MAPPING);

    // Pipeline selection is locked once any sync has occurred.
    const alreadySynced = !!(existing?.lastPushSyncAt || existing?.lastPullSyncAt);

    // listName: display name used for creating new deal pipelines
    const resolvedListName = alreadySynced
      ? existing?.listName
      : (updates.listName ?? existing?.listName);

    // HubSpot deal pipeline
    const resolvedExternalPipelineId = alreadySynced
      ? existing?.externalPipelineId
      : (isHubspot ? (updates.externalPipelineId ?? existing?.externalPipelineId) : undefined);

    const config: ExternalCrmSyncConfig = {
      provider: provider as 'hubspot' | 'attio',
      listId,
      userId,
      accountId: updates.accountId ?? existing?.accountId,
      apiKeyEncrypted: existing?.apiKeyEncrypted,
      autoSyncEnabled: updates.autoSyncEnabled ?? existing?.autoSyncEnabled ?? false,
      contactFieldMapping: updates.contactFieldMapping ?? existing?.contactFieldMapping
        ?? (isHubspot ? DEFAULT_HUBSPOT_CONTACT_MAPPING : DEFAULT_ATTIO_CONTACT_MAPPING),
      dealFieldMapping: !isHubspot ? [] : nextDealFieldMapping,
      customFieldMapping: !isHubspot
        ? this.mergeAttioEntryMappings(nextCustomFieldMapping, nextDealFieldMapping)
        : nextCustomFieldMapping,
      deleteOnPush: updates.deleteOnPush ?? existing?.deleteOnPush ?? false,
      deleteOnPull: updates.deleteOnPull ?? existing?.deleteOnPull ?? false,
      webhookEnabled: updates.webhookEnabled ?? existing?.webhookEnabled ?? true,
      listName: resolvedListName,
      externalPipelineId: resolvedExternalPipelineId,
      hubspotDealStageMap: existing?.hubspotDealStageMap,
      lastPushSyncAt: existing?.lastPushSyncAt,
      lastPullSyncAt: existing?.lastPullSyncAt,
      lastSyncStatus: existing?.lastSyncStatus,
      lastSyncError: existing?.lastSyncError,
      createdAt: existing?.createdAt || now,
      updatedAt: now,
      // Preserve existing secret; generate once and never rotate (stable URL)
      webhookSecret: existing?.webhookSecret ?? crypto.randomBytes(24).toString('hex'),
    };

    // Note: We intentionally do NOT wipe externalPeopleListId here.
    // The adapters use verifyList() to actively test access on each sync.
    // If the new token is for the same workspace, the ID is preserved.
    // If not, the adapter gets a 404 and clears + re-discovers it automatically.

    // Handle mutually exclusive credentials: OAuth Account ID vs. Manual API Key
    if (updates.apiKey) {
      // New manual API key → encrypt and store; clear OAuth accountId
      config.apiKeyEncrypted = encryptPassword(updates.apiKey, userId);
      config.accountId = undefined;
    } else if (updates.accountId) {
      // New OAuth account → store and clear manual API key
      config.apiKeyEncrypted = undefined;
    } else if (updates.accountId === '') {
      // Explicitly clearing accountId
      config.accountId = undefined;
    }

    await crmDb.setLeadListCrmSyncConfig(listId, provider, config as any);
    return config;
  }

  async deleteConfig(userId: string, listId: string, provider: string): Promise<void> {
    const config = await this.getConfig(userId, listId, provider);
    if (!config) return;
    await crmDb.setLeadListCrmSyncConfig(listId, provider, null);
  }

  async getDefaultMappings(provider: string): Promise<{
    contactFieldMapping: FieldMapping[];
    dealFieldMapping: FieldMapping[];
    customFieldMapping: FieldMapping[];
  }> {
    const isHubspot = provider === 'hubspot';
    if (isHubspot) {
      return {
        contactFieldMapping: DEFAULT_HUBSPOT_CONTACT_MAPPING,
        dealFieldMapping: DEFAULT_HUBSPOT_DEAL_MAPPING,
        customFieldMapping: [], // Match frontend's current behavior for HubSpot
      };
    } else {
      return {
        contactFieldMapping: DEFAULT_ATTIO_CONTACT_MAPPING,
        dealFieldMapping: [],
        customFieldMapping: DEFAULT_ATTIO_CUSTOM_MAPPING,
      };
    }
  }

  // ─── Auth resolution ─────────────────────────────────────────────────────────
  // Resolves config into a CrmAuth object that adapters use to get a token.
  // If token-based, we decrypt here — adapters never touch encrypted data.

  private resolveAuth(config: ExternalCrmSyncConfig): CrmAuth {
    if (config.accountId) {
      return { type: 'oauth', userId: config.userId, accountId: config.accountId };
    }
    if (config.apiKeyEncrypted) {
      const { password } = decryptPassword(config.apiKeyEncrypted);
      return { type: 'token', apiKey: password };
    }
    throw new Error('No authentication method configured');
  }

  /**
   * Public wrapper around the private resolveAuth — used by crmWebhook.ts to
   * obtain auth credentials without exposing the internal resolveAuth method.
   */
  async resolveAuthForList(userId: string, listId: string, provider: string): Promise<CrmAuth> {
    const config = await this.getConfig(userId, listId, provider);
    if (!config) throw new Error(`No sync configuration found for list ${listId} / ${provider}`);
    return this.resolveAuth(config);
  }

  async testConnection(userId: string, listId: string, provider: string): Promise<{ valid: boolean; error?: string }> {
    const config = await this.getConfig(userId, listId, provider);
    if (!config) return { valid: false, error: 'No sync configuration found' };
    if (!config.accountId && !config.apiKeyEncrypted) {
      return { valid: false, error: 'No authentication configured' };
    }

    try {
      const auth = this.resolveAuth(config);
      const adapter = getAdapter(provider);
      return adapter.testConnection(auth);
    } catch (err: any) {
      return { valid: false, error: err.message || 'Unknown error' };
    }
  }

  // ─── External list discovery ──────────────────────────────────────────────────

  // External lists are no longer used — contacts sync directly without list membership.
  async getExternalLists(
    _userId: string,
    _listId: string,
    _provider: string,
    _options?: { accountId?: string; apiKey?: string }
  ): Promise<Array<{ id: string; name: string }>> {
    return [];
  }

  // Returns HubSpot deal pipelines so the user can pre-select one before first sync
  async getExternalPipelines(
    userId: string,
    listId: string,
    provider: string,
    options?: { accountId?: string; apiKey?: string }
  ): Promise<Array<{ id: string; name: string }>> {
    if (provider !== 'hubspot') return [];

    let auth: CrmAuth;

    if (options?.accountId) {
      // Use the provided accountId directly (works before config is saved)
      auth = { type: 'oauth', userId, accountId: options.accountId };
    } else if (options?.apiKey) {
      // Use the provided apiKey directly
      auth = { type: 'token', apiKey: options.apiKey };
    } else {
      const config = await this.getConfig(userId, listId, provider);
      if (!config) throw new Error('No sync configuration found. Save your connection settings first.');
      if (!config.accountId && !config.apiKeyEncrypted) {
        throw new Error('No authentication configured. Save your connection settings first.');
      }
      auth = this.resolveAuth(config);
    }

    const svc = await this.getHubSpotService(auth);
    const pipelines = await svc.listDealPipelines();
    return pipelines.map(p => ({ id: p.id, name: p.label }));
  }

  // ─── External property discovery ─────────────────────────────────────────────

  /**
   * Fetches available CRM properties/attributes for use in mapping dropdowns.
   *
   * HubSpot:
   *   objectType='contact' → all Contact properties (standard + custom)
   *   objectType='deal'    → all Deal properties only
   * Attio:
   *   All sections → People object attributes + list-entry attributes merged.
   *   objectType is ignored for Attio.
   *
   * Accepts inline accountId / apiKey to work before the config is saved.
   */
  async getExternalProperties(
    userId: string,
    listId: string,
    provider: string,
    options: { objectType?: 'contact' | 'deal'; accountId?: string; apiKey?: string }
  ): Promise<{ properties: CrmProperty[] }> {
    if (!['hubspot', 'attio'].includes(provider)) {
      throw new Error(`Unsupported provider: "${provider}". Supported: hubspot, attio`);
    }

    let auth: CrmAuth;
    if (options.accountId) {
      auth = { type: 'oauth', userId, accountId: options.accountId };
    } else if (options.apiKey) {
      auth = { type: 'token', apiKey: options.apiKey };
    } else {
      const config = await this.getConfig(userId, listId, provider);
      if (!config) throw new Error('No sync configuration found. Save your connection settings first.');
      if (!config.accountId && !config.apiKeyEncrypted) {
        throw new Error('No authentication configured. Save your connection settings first.');
      }
      auth = this.resolveAuth(config);
    }

    if (provider === 'hubspot') {
      const svc = await this.getHubSpotService(auth);
      if (options.objectType === 'deal') {
        const props = await svc.listDealProperties();
        return { properties: props.map(p => ({ name: p.name, label: p.label, type: p.type })) };
      }
      // Default: contact properties (used for Contact and Custom sections)
      const props = await svc.listContactProperties();
      return { properties: props.map(p => ({ name: p.name, label: p.label, type: p.type })) };
    }

    // Attio: return People object attributes only (contacts sync directly, no list)
    const svc = auth.type === 'token'
      ? AttioService.fromToken(auth.apiKey!)
      : await AttioService.create(auth.userId!, auth.accountId!);

    const peopleAttrs = await svc.getAllPeopleAttributes();
    const properties: CrmProperty[] = peopleAttrs.map(a => ({
      name: a.api_slug,
      label: a.title,
      type: a.type,
    }));

    return { properties };
  }

  // ─── Delete lead from CRM ─────────────────────────────────────────────────────

  /**
   * Deletes a lead's corresponding record(s) from the external CRM.
   * Only acts when deleteOnPush is enabled in config.
   * Called from the CRM lead delete route.
   */
  async deleteLeadFromCrm(userId: string, listId: string, provider: string, lead: any): Promise<void> {
    const config = await this.getConfig(userId, listId, provider);
    if (!config) throw new Error('No sync configuration found');
    if (!config.deleteOnPush) return;

    const auth = this.resolveAuth(config);

    if (provider === 'hubspot') {
      const svc = await this.getHubSpotService(auth);
      const contactId = lead.syncMetadata?.hubspot_contact_id ?? lead.customFields?.hubspot_contact_id;
      const dealId = lead.syncMetadata?.hubspot_deal_id ?? lead.customFields?.hubspot_deal_id;
      if (dealId) {
        await svc.deleteDeal(dealId).catch(err =>
          console.error(`[ExternalCrmSync] deleteLeadFromCrm: failed to delete deal ${dealId}:`, err.message)
        );
      }
      if (contactId) {
        await svc.deleteContact(contactId);
      }
      return;
    }

    if (provider === 'attio') {
      const svc = auth.type === 'token'
        ? AttioService.fromToken(auth.apiKey!)
        : await AttioService.create(auth.userId!, auth.accountId!);
      const recordId = lead.syncMetadata?.attio_record_id ?? lead.customFields?.attio_record_id;
      if (recordId) {
        await svc.deletePerson(recordId);
      }
    }
  }

  // ─── Custom field discovery ───────────────────────────────────────────────────

  async getDistinctCustomFieldKeys(listId: string, provider?: string): Promise<string[]> {
    const list = await crmDb.getLeadListById(listId);
    if (!list || !list.fieldNames) return [];

    const allToFilter = this.getStandardFieldKeys(provider);
    const keys = (list.fieldNames as string[]).filter(k => !allToFilter.includes(k));
    return Array.from(new Set(keys)).sort();
  }

  private getStandardFieldKeys(provider?: string): string[] {
    const internalFields = [
      'leadId', 'listId', 'createdAt', 'updatedAt', 'lastInteractionAt',
      'hubspot_contact_id', 'hubspot_deal_id', 'attio_record_id',
      'status', 'dealValue', 'dealCurrency', 'email', 'firstName', 'lastName', 'phone', 'company', 'title', 'linkedin',
      'chatSessionCount'
    ];

    const hubspotAliases = ['company_name', 'first_name', 'last_name', 'job_title', 'linkedin_url', 'phone_number'];
    const attioAliases = ['first_name', 'last_name', 'job_title', 'phone_number', 'linkedin_url'];

    let aliasesToFilter: string[] = [];
    if (provider === 'hubspot') {
      aliasesToFilter = hubspotAliases;
    } else if (provider === 'attio') {
      aliasesToFilter = attioAliases;
    }

    return Array.from(new Set([...internalFields, ...aliasesToFilter]));
  }

  // ─── Push: all leads → CRM ───────────────────────────────────────────────────

  async pushAllLeads(userId: string, listId: string, provider: string): Promise<SyncResult> {
    const config = await this.getConfig(userId, listId, provider);
    if (!config) throw new Error('No sync configuration found');
    if (!config.accountId && !config.apiKeyEncrypted) throw new Error('No authentication method configured');

    // Attach the human-readable list name so adapters can use it when naming external lists
    if (!config.listName) {
      const list = await crmDb.getLeadListById(listId);
      if (list?.name) config.listName = list.name;
    }

    try {
      await this.syncHubSpotStatusOptions(config, 'push');
    } catch (err) {
      console.warn('[ExternalCrmSync] syncHubSpotStatusOptions failed, continuing sync:', (err as Error).message);
    }

    const auth = this.resolveAuth(config);
    const adapter = getAdapter(provider);

    const totalResult: SyncResult = { successCount: 0, newCount: 0, updatedCount: 0, errorCount: 0, errors: [] };
    let lastKey: any = undefined;
    let hasLeads = false;

    do {
      const page = await crmDb.getLeadsByListId(listId, 500, lastKey);
      const chunk = page.items as any[];
      lastKey = page.lastEvaluatedKey;

      if (chunk.length > 0) {
        hasLeads = true;
        const chunkResult = await adapter.pushLeads(auth, chunk, config);

        // Accumulate results
        totalResult.successCount += chunkResult.successCount;
        totalResult.newCount += chunkResult.newCount;
        totalResult.updatedCount += chunkResult.updatedCount;
        totalResult.errorCount += chunkResult.errorCount;
        if (chunkResult.errors?.length > 0) {
          totalResult.errors.push(...chunkResult.errors);
        }
      }
    } while (lastKey);

    if (!hasLeads) {
      return { successCount: 0, newCount: 0, updatedCount: 0, errorCount: 0, errors: [] };
    }

    // Persist updated externalPeopleListId if the adapter set it
    await this.saveUpdatedConfig(config);
    await this.updateSyncTimestamp(config, 'push', totalResult.errorCount === 0);

    return totalResult;
  }

  // ─── Pull: CRM → all leads ────────────────────────────────────────────────────

  async pullAllContacts(userId: string, listId: string, provider: string): Promise<SyncResult> {
    const config = await this.getConfig(userId, listId, provider);
    if (!config) throw new Error('No sync configuration found');
    if (!config.accountId && !config.apiKeyEncrypted) throw new Error('No authentication method configured');

    if (!config.listName) {
      const list = await crmDb.getLeadListById(listId);
      if (list?.name) config.listName = list.name;
    }

    try {
      await this.syncHubSpotStatusOptions(config, 'pull');
    } catch (err) {
      console.warn('[ExternalCrmSync] syncHubSpotStatusOptions failed, continuing sync:', (err as Error).message);
    }

    const auth = this.resolveAuth(config);
    const adapter = getAdapter(provider);

    const result = await adapter.pullContacts(auth, listId, config);

    // Delete sweep: mark local leads as CRM-removed when deleteOnPull is enabled
    if (config.deleteOnPull && result.seenExternalIds) {
      result.removedCount = await this.markRemovedLeads(listId, provider, result.seenExternalIds);
    }
    // Strip internal field — not needed outside service
    delete result.seenExternalIds;

    // Persist updated externalPeopleListId if the adapter set/cleared it
    await this.saveUpdatedConfig(config);
    await this.updateSyncTimestamp(config, 'pull', result.errorCount === 0);

    return result;
  }

  // ─── Mark removed leads ───────────────────────────────────────────────────────

  /**
   * After a pull, find local leads whose CRM record ID is no longer in seenIds
   * and stamp `syncMetadata.crmRemovedAt` to flag them as removed in the CRM.
   * Returns count of newly-marked leads.
   */
  private async markRemovedLeads(
    listId: string,
    provider: string,
    seenIds: string[]
  ): Promise<number> {
    const seenSet = new Set(seenIds);
    const idField = provider === 'hubspot' ? 'hubspot_contact_id' : 'attio_record_id';

    let removedCount = 0;
    let lastKey: any = undefined;

    do {
      const page = await crmDb.getLeadsByListId(listId, 500, lastKey);
      lastKey = page.lastEvaluatedKey;

      for (const lead of page.items as any[]) {
        const externalId = lead.syncMetadata?.[idField];
        if (!externalId) continue;                          // never synced — skip
        if (seenSet.has(externalId)) continue;              // still exists in CRM — skip
        if (lead.syncMetadata?.crmRemovedAt) continue;      // already marked — skip

        await crmDb.updateLead(listId, lead.leadId, {
          syncMetadata: {
            ...(lead.syncMetadata || {}),
            crmRemovedAt: new Date().toISOString(),
          },
        }).catch(err => console.error(`[ExternalCrmSync] markRemovedLeads: failed for lead ${lead.leadId}:`, err.message));
        removedCount++;
      }
    } while (lastKey);

    return removedCount;
  }

  // ─── Auto-sync single lead (fire-and-forget) ──────────────────────────────────

  async autoSyncLead(
    userId: string,
    listId: string,
    lead: any,
    provider: 'hubspot' | 'attio',
    _eventType: 'created' | 'updated'
  ): Promise<void> {
    try {
      const config = await this.getConfig(userId, listId, provider);
      if (!config?.autoSyncEnabled) return;
      if (!config.accountId && !config.apiKeyEncrypted) return;

      await this.syncHubSpotStatusOptions(config, 'push');

      const auth = this.resolveAuth(config);
      const adapter = getAdapter(provider);
      await adapter.pushLeads(auth, [lead], config);
      await this.saveUpdatedConfig(config).catch(() => { });
    } catch (err: any) {
      const details = err.response?.data?.message || err.response?.data || err.message;
      console.error(`[ExternalCrmSync] Auto-sync failed for lead ${lead.leadId} in list ${listId}:`, details);
    }
  }

  // ─── Private helpers ──────────────────────────────────────────────────────────

  private async saveUpdatedConfig(config: ExternalCrmSyncConfig): Promise<void> {
    await crmDb.setLeadListCrmSyncConfig(config.listId, config.provider, config as any)
      .catch(() => { /* non-critical */ });
  }

  private async updateSyncTimestamp(
    config: ExternalCrmSyncConfig,
    direction: 'push' | 'pull',
    success: boolean
  ): Promise<void> {
    const now = new Date().toISOString();
    if (direction === 'push') config.lastPushSyncAt = now;
    else config.lastPullSyncAt = now;
    config.lastSyncStatus = success ? 'success' : 'error';
    config.updatedAt = now;
    await this.saveUpdatedConfig(config);
  }

  private mergeAttioEntryMappings(
    customMappings: FieldMapping[] = [],
    legacyDealMappings: FieldMapping[] = []
  ): FieldMapping[] {
    const merged = new Map<string, FieldMapping>();
    for (const mapping of [...DEFAULT_ATTIO_CUSTOM_MAPPING, ...legacyDealMappings, ...customMappings]) {
      merged.set(mapping.agentwebField, mapping);
    }
    return Array.from(merged.values());
  }

  private async syncHubSpotStatusOptions(
    config: ExternalCrmSyncConfig,
    syncDirection: 'push' | 'pull'
  ): Promise<void> {
    if (config.provider !== 'hubspot') return;

    const stageMapping = config.dealFieldMapping.find(m =>
      m.enabled &&
      m.agentwebField === 'status' &&
      m.crmProperty === 'dealstage'
    );
    if (!stageMapping) return;
    if (syncDirection === 'push' && stageMapping.direction === 'pull') return;
    if (syncDirection === 'pull' && stageMapping.direction === 'push') return;

    const list = await crmDb.getLeadListById(config.listId);
    if (!list) return;

    const svc = await this.getHubSpotService(this.resolveAuth(config));

    // ─── Pipeline discovery/creation ──────────────────────────────────────────
    const PIPELINE_LABEL = config.listName || 'Lead Pipeline';
    let pipelineId: string = 'default';

    // If the user pre-selected a pipeline, use it directly and skip discovery
    const preSelectedPipeline = config.externalPipelineId;
    if (preSelectedPipeline) {
      pipelineId = preSelectedPipeline;
      console.log(`[ExternalCrmSync] Using pre-selected pipeline: ${pipelineId}`);
    } else {
      const pipelines = await svc.listDealPipelines();
      const leadPipeline = pipelines.find(p =>
        p.label === PIPELINE_LABEL ||
        p.id === 'lead_pipeline' ||
        p.label.toLowerCase() === PIPELINE_LABEL.toLowerCase()
      );

      if (leadPipeline) {
        pipelineId = leadPipeline.id;
      } else {
        // Prepare initial stages for the new pipeline
        const statusConfig = this.normalizeStatusConfig(list.statusConfig);
        const initialStages = statusConfig.map((s, idx) => ({
          stageId: s.value,
          label: s.label,
          displayOrder: idx,
          probability: this.statusToProbability(s, statusConfig)
        }));

        if (initialStages.length === 0) {
          // HubSpot requires at least one stage to create a pipeline
          initialStages.push({ stageId: 'lead', label: 'Lead', displayOrder: 0, probability: 0.1 });
        }

        try {
          const newPipeline = await svc.createDealPipeline(PIPELINE_LABEL, initialStages);
          pipelineId = newPipeline.id;
        } catch (err: any) {
          console.warn(
            `[ExternalCrmSync] Failed to create custom pipeline "${PIPELINE_LABEL}". Falling back to "default".`,
            err.response?.data || err.message
          );
          pipelineId = 'default';
        }
      }
    }

    let stages: HubSpotPipelineStage[];
    try {
      stages = await svc.getDealPipelineStages(pipelineId);
    } catch (err: any) {
      console.error(
        `[ExternalCrmSync] failed to fetch HubSpot deal stages for list=${config.listId} pipeline=${pipelineId}: ${this.formatError(err)}`
      );
      throw err;
    }

    let didUpdateList = false;
    let statusConfig = this.normalizeStatusConfig(list.statusConfig);
    const stageMap: Record<string, string> = {};

    if (syncDirection === 'push') {
      const toCreate = statusConfig.filter(status => {
        const exactMatch = stages.find(stage => stage.id === status.value);
        if (exactMatch) {
          stageMap[status.value] = exactMatch.id;
          return false;
        }

        const labelMatch = stages.find(stage => this.normalizeLabel(stage.label) === this.normalizeLabel(status.label));
        if (labelMatch) {
          stageMap[status.value] = labelMatch.id;
          return false;
        }

        return true;
      });
      if (toCreate.length > 0) {
        let nextDisplayOrder = stages.reduce((max, stage) => Math.max(max, stage.displayOrder), -1) + 1;
        for (const status of toCreate) {
          const probability = this.statusToProbability(status, statusConfig);
          try {
            const createdStage = await svc.createDealStage(pipelineId, {
              stageId: status.value,
              label: status.label,
              displayOrder: nextDisplayOrder++,
              probability,
            });
            stages = [...stages, createdStage];
            stageMap[status.value] = createdStage.id;
          } catch (err: any) {
            console.error(
              `[ExternalCrmSync] failed to create HubSpot stage "${status.value}" for list=${config.listId}: ${this.formatError(err)}`
            );
            throw err;
          }
        }
      }
    }

    if (syncDirection === 'pull') {
      const existingValues = new Set(statusConfig.map(status => status.value));
      const pulledStatuses = stages
        .filter(stage =>
          !existingValues.has(stage.id) &&
          !statusConfig.some(status => this.normalizeLabel(status.label) === this.normalizeLabel(stage.label))
        )
        .map(stage => this.stageToStatusOption(stage));

      if (pulledStatuses.length > 0) {
        statusConfig = [...statusConfig, ...pulledStatuses];
        didUpdateList = true;
      }

      for (const status of statusConfig) {
        const exactMatch = stages.find(stage => stage.id === status.value);
        if (exactMatch) {
          stageMap[status.value] = exactMatch.id;
          continue;
        }

        const labelMatch = stages.find(stage => this.normalizeLabel(stage.label) === this.normalizeLabel(status.label));
        if (labelMatch) {
          stageMap[status.value] = labelMatch.id;
        }
      }
    }

    config.hubspotDealStageMap = Object.keys(stageMap).length > 0 ? stageMap : undefined;

    if (didUpdateList) {
      try {
        await crmDb.updateLeadList(config.listId, { statusConfig });
      } catch (err: any) {
        console.error(
          `[ExternalCrmSync] failed to persist AgentWeb statusConfig for list=${config.listId}: ${this.formatError(err)}`
        );
        throw err;
      }
    }
  }

  private async getHubSpotService(auth: CrmAuth): Promise<HubSpotService> {
    if (auth.type === 'token') return HubSpotService.fromToken(auth.apiKey);
    return HubSpotService.create(auth.userId, auth.accountId);
  }

  private normalizeStatusConfig(statusConfig: any): StatusOption[] {
    return Array.isArray(statusConfig) ? statusConfig.filter((entry): entry is StatusOption =>
      entry &&
      typeof entry.value === 'string' &&
      typeof entry.label === 'string' &&
      typeof entry.color === 'string' &&
      typeof entry.type === 'string'
    ) : [];
  }

  private statusToProbability(status: StatusOption, allStatuses: StatusOption[]): number {
    if (status.type === 'won') return 1.0;
    if (status.type === 'lost' || status.type === 'churned') return 0.0;

    const activeStatuses = allStatuses.filter(item => item.type === 'active');
    const index = Math.max(activeStatuses.findIndex(item => item.value === status.value), 0);
    const raw = ((index + 1) / (activeStatuses.length + 1)) * 0.9;
    return Math.max(0.1, Math.min(0.9, Math.round(raw * 10) / 10));
  }

  private stageToStatusOption(stage: HubSpotPipelineStage): StatusOption {
    const label = stage.label || stage.id;
    const normalized = `${stage.id} ${label} `.toLowerCase();
    const probability = Number(stage.metadata?.probability ?? NaN);

    let type: StatusType = 'active';
    if (probability >= 1 || normalized.includes('won')) type = 'won';
    else if (normalized.includes('churn')) type = 'churned';
    else if (probability === 0 || normalized.includes('lost')) type = 'lost';

    return {
      value: stage.id,
      label,
      color: this.colorForStatusType(type),
      type,
    };
  }

  private colorForStatusType(type: StatusType): string {
    if (type === 'won') return 'green';
    if (type === 'lost') return 'red';
    if (type === 'churned') return 'orange';
    return 'blue';
  }

  private normalizeLabel(value: string): string {
    return String(value || '').trim().toLowerCase();
  }
}

export const externalCrmSyncService = new ExternalCrmSyncService();
