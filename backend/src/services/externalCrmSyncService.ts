import crypto from 'crypto';
import { crmDb, userDb } from './db';
import { decryptPassword, encryptPassword } from '../utils/crypto';
import { CrmAuth, CrmAdapter } from './adapters/crmAdapterTypes';
import { AttioAdapter } from './adapters/attioAdapter';
import { HubspotAdapter, HUBSPOT_LIST_IDENTITY_MAPPING } from './adapters/hubspotAdapter';
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

// State of an async (background) full-list push. Persisted on the sync config so
// it survives a page refresh and is visible to any org member sharing the list.
// The push runs detached from the HTTP request, so the client polls the status
// endpoint instead of holding a long-lived connection open (which upstream
// proxies sever at ~40s, producing a spurious "Push failed").
export interface PushJob {
  jobId: string;
  status: 'running' | 'completed' | 'error';
  startedAt: string;
  finishedAt?: string;
  result?: SyncResult;
  error?: string;
  // Live progress, written per 500-lead chunk while running (push-only).
  processedCount?: number;  // leads pushed so far (authoritative — sum of real chunk sizes)
  totalCount?: number;      // best-effort denominator from list.leadCount (may drift)
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
  // Latest async full-list push job (status + result for the polling UI)
  pushJob?: PushJob;
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
// HUBSPOT_LIST_IDENTITY_MAPPING (listName/listId) is defined in hubspotAdapter to
// avoid a circular import — this module constructs a HubspotAdapter at load time —
// and spread in here so it also surfaces as a dialog default for new configs.
export const DEFAULT_HUBSPOT_CUSTOM_MAPPING: FieldMapping[] = [
  { agentwebField: 'notes', crmProperty: 'notes', direction: 'both', enabled: true },
  ...HUBSPOT_LIST_IDENTITY_MAPPING,
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

export const DEFAULT_ATTIO_DEAL_MAPPING: FieldMapping[] = [];

export const DEFAULT_ATTIO_CUSTOM_MAPPING: FieldMapping[] = [
  { agentwebField: 'notes', crmProperty: 'notes', direction: 'both', enabled: true },
];

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
    if (!(await this.canAccessConfig(userId, config.userId))) return null;
    return config;
  }

  // A config is accessible to its creator or to any member of the creator's org,
  // matching the org-aware list sharing enforced in the crm/crmSync routes.
  private async canAccessConfig(userId: string, configUserId: string): Promise<boolean> {
    if (configUserId === userId) return true;
    const [user, owner] = await Promise.all([
      userDb.getUserById(userId),
      userDb.getUserById(configUserId),
    ]);
    return !!(user?.orgId && owner?.orgId && user.orgId === owner.orgId);
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

    let nextDealFieldMapping = updates.dealFieldMapping ?? existing?.dealFieldMapping
      ?? (isHubspot ? DEFAULT_HUBSPOT_DEAL_MAPPING : DEFAULT_ATTIO_DEAL_MAPPING);
    let nextCustomFieldMapping = updates.customFieldMapping ?? existing?.customFieldMapping
      ?? (isHubspot ? DEFAULT_HUBSPOT_CUSTOM_MAPPING : DEFAULT_ATTIO_CUSTOM_MAPPING);

    // Attio has no separate "deal" object — deal mappings are stored as list-entry (custom) attrs.
    // When saving for Attio, merge any deal mappings into customFieldMapping and clear dealFieldMapping.
    if (!isHubspot && nextDealFieldMapping.length > 0) {
      const existingCustomKeys = new Set(nextCustomFieldMapping.map((m: FieldMapping) => m.agentwebField));
      const dealEntries = nextDealFieldMapping.filter((m: FieldMapping) => !existingCustomKeys.has(m.agentwebField));
      nextCustomFieldMapping = [...nextCustomFieldMapping, ...dealEntries];
      nextDealFieldMapping = [];
    }

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
      // Default ON: a configured sync should push new/edited leads automatically.
      // Matches the UI toggle default. A partial save (e.g. from Test Connection)
      // therefore won't silently disable auto-sync on a brand-new config.
      autoSyncEnabled: updates.autoSyncEnabled ?? existing?.autoSyncEnabled ?? true,
      contactFieldMapping: updates.contactFieldMapping ?? existing?.contactFieldMapping
        ?? (isHubspot ? DEFAULT_HUBSPOT_CONTACT_MAPPING : DEFAULT_ATTIO_CONTACT_MAPPING),
      dealFieldMapping: nextDealFieldMapping,
      customFieldMapping: nextCustomFieldMapping,
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

    // Reconnecting an OAuth account: a preserved pipeline/stage/sync state belongs to
    // the PREVIOUSLY connected account. If the new account doesn't contain that pipeline,
    // it's stale (a different account was connected) — drop the account-specific state so
    // the user can pick a valid pipeline. Field mappings are account-agnostic and kept.
    // On the same account the pipeline still exists, so everything is preserved.
    if (isHubspot && updates.accountId && config.externalPipelineId) {
      try {
        const svc = await HubSpotService.create(userId, updates.accountId);
        const pipelines = await svc.listDealPipelines();
        const stillValid = pipelines.some(p => p.id === config.externalPipelineId);
        if (!stillValid) {
          config.externalPipelineId = undefined;
          config.hubspotDealStageMap = undefined;
          config.lastPushSyncAt = undefined;
          config.lastPullSyncAt = undefined;
          config.lastSyncStatus = undefined;
          config.lastSyncError = undefined;
        }
      } catch {
        // Can't reach HubSpot to validate — leave state intact rather than wiping on a
        // transient error.
      }
    }

    await crmDb.setLeadListCrmSyncConfig(listId, provider, config as any);
    return config;
  }

  async deleteConfig(userId: string, listId: string, provider: string): Promise<void> {
    const config = await this.getConfig(userId, listId, provider);
    if (!config) return;
    await crmDb.setLeadListCrmSyncConfig(listId, provider, null);
  }

  /**
   * Disconnect the OAuth account from a list without wiping field mappings.
   * Clears accountId, apiKeyEncrypted, and webhookSecret so the account is no
   * longer "used" (drops out of used-accounts) and can be linked to another list.
   * All other settings (mappings, autoSyncEnabled, webhookEnabled) are preserved.
   */
  async disconnectAccount(userId: string, listId: string, provider: string): Promise<void> {
    const config = await this.getConfig(userId, listId, provider);
    if (!config) return;
    const now = new Date().toISOString();
    const disconnected: ExternalCrmSyncConfig = {
      ...config,
      accountId: undefined,
      apiKeyEncrypted: undefined,
      webhookSecret: undefined,
      autoSyncEnabled: false,
      // Mark as not configured so the UI returns to account-selection state
      updatedAt: now,
    };
    await crmDb.setLeadListCrmSyncConfig(listId, provider, disconnected as any);
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
        customFieldMapping: DEFAULT_HUBSPOT_CUSTOM_MAPPING,
      };
    } else {
      return {
        contactFieldMapping: DEFAULT_ATTIO_CONTACT_MAPPING,
        dealFieldMapping: DEFAULT_ATTIO_DEAL_MAPPING,
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

  async testConnection(
    userId: string,
    listId: string,
    provider: string,
    inline?: { apiKey?: string; accountId?: string }
  ): Promise<{ valid: boolean; error?: string }> {
    let auth: CrmAuth | null = null;

    // Use inline credentials if provided (e.g. user testing before first save or after delete)
    if (inline?.apiKey) {
      auth = { type: 'token', apiKey: inline.apiKey };
    } else if (inline?.accountId) {
      auth = { type: 'oauth', userId, accountId: inline.accountId };
    } else {
      const config = await this.getConfig(userId, listId, provider);
      if (!config) return { valid: false, error: 'No sync configuration found' };
      if (!config.accountId && !config.apiKeyEncrypted) {
        return { valid: false, error: 'No authentication configured' };
      }
      auth = this.resolveAuth(config);
    }

    try {
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
    if (provider !== 'hubspot' && provider !== 'attio') return [];

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

    if (provider === 'hubspot') {
      const svc = await this.getHubSpotService(auth);
      const pipelines = await svc.listDealPipelines();
      return pipelines.map(p => ({ id: p.id, name: p.label }));
    } else {
      const svc = auth.type === 'token'
        ? AttioService.fromToken(auth.apiKey!)
        : await AttioService.create(auth.userId!, auth.accountId!);
      return svc.getAllLists();
    }
  }

  // Re-points a HubSpot list's sync config to a different deal pipeline AFTER the
  // first sync (the normal saveConfig path locks the pipeline once synced). Clears
  // the stage map so the next push rebuilds it for the new pipeline. Migration of
  // existing deals is performed by re-pushing the list (the caller triggers the
  // push job); the adapter moves each existing deal to config.externalPipelineId.
  async changePipeline(
    userId: string,
    listId: string,
    provider: string,
    newPipelineId: string
  ): Promise<ExternalCrmSyncConfig> {
    if (provider !== 'hubspot') {
      throw new Error('Changing the deal pipeline is only supported for HubSpot.');
    }
    if (!newPipelineId) {
      throw new Error('A target pipeline is required.');
    }

    const config = await this.getConfig(userId, listId, provider);
    if (!config) throw new Error('No sync configuration found for this list.');
    if (!config.accountId && !config.apiKeyEncrypted) {
      throw new Error('No authentication configured for this list.');
    }

    // Validate the target pipeline exists in the connected HubSpot account.
    const svc = await this.getHubSpotService(this.resolveAuth(config));
    const pipelines = await svc.listDealPipelines();
    if (!pipelines.some(p => p.id === newPipelineId)) {
      throw new Error(`Pipeline not found in HubSpot: ${newPipelineId}`);
    }

    // Bypass the saveConfig "locked after sync" guard: write the new pipeline and
    // clear the stale stage map so the next push recomputes it for the new pipeline.
    const updated: ExternalCrmSyncConfig = {
      ...config,
      externalPipelineId: newPipelineId,
      hubspotDealStageMap: undefined,
      updatedAt: new Date().toISOString(),
    };
    await crmDb.setLeadListCrmSyncConfig(listId, provider, updated as any);
    return updated;
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

    // Attio: contacts use People attributes, while deal mappings use Deals attributes.
    const svc = auth.type === 'token'
      ? AttioService.fromToken(auth.apiKey!)
      : await AttioService.create(auth.userId!, auth.accountId!);



    // Attio: merge People object attributes + list-entry attributes

    const peopleAttrs = await svc.getAllPeopleAttributes();
    const properties: CrmProperty[] = [];

    for (const a of peopleAttrs) {
      if (a.type === 'personal-name') {
        // Expand the composite name attribute into selectable first_name / last_name sub-fields.
        // The adapter's buildPersonValues already handles these slugs specially, so they map
        // correctly to values.name[0].first_name / values.name[0].last_name on write.
        properties.push({ name: 'first_name', label: 'First Name', type: 'text' });
        properties.push({ name: 'last_name', label: 'Last Name', type: 'text' });
        // Also keep the composite 'name' for full-name string mappings
        properties.push({ name: a.api_slug, label: a.title, type: a.type });
      } else {
        properties.push({ name: a.api_slug, label: a.title, type: a.type });
      }
    }

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

  // A running push job is considered abandoned (its process died mid-sync) after
  // this long, so a new push may take over rather than the list being stuck.
  private static readonly STALE_PUSH_JOB_MS = 20 * 60 * 1000;

  async pushAllLeads(userId: string, listId: string, provider: string): Promise<SyncResult> {
    const config = await this.getConfig(userId, listId, provider);
    if (!config) throw new Error('No sync configuration found');
    if (!config.accountId && !config.apiKeyEncrypted) throw new Error('No authentication method configured');
    return this.runPush(config, listId, provider);
  }

  /**
   * Starts a full-list push in the background and returns immediately with a
   * running job. The HTTP route should return 202 + this job; the client then
   * polls getPushJob for progress/result. Validation (config + auth) happens
   * synchronously here so the caller gets a real error for misconfiguration
   * rather than a job that fails asynchronously.
   *
   * Returns `completion` — a promise that resolves when the background push
   * finishes — purely so tests (and any future caller that wants to await it)
   * can do so. Route handlers intentionally do NOT await it.
   */
  async startPushJob(
    userId: string,
    listId: string,
    provider: string
  ): Promise<{ job: PushJob; completion: Promise<void> }> {
    const config = await this.getConfig(userId, listId, provider);
    if (!config) throw new Error('No sync configuration found');
    if (!config.accountId && !config.apiKeyEncrypted) throw new Error('No authentication method configured');

    // Idempotency: if a fresh push is already running, return it instead of
    // launching a duplicate (double-click, two open tabs, etc.).
    const existing = config.pushJob;
    if (existing?.status === 'running' && !this.isPushJobStale(existing)) {
      return { job: existing, completion: Promise.resolve() };
    }

    const job: PushJob = {
      jobId: crypto.randomBytes(12).toString('hex'),
      status: 'running',
      startedAt: new Date().toISOString(),
    };
    config.pushJob = job;
    await this.persistPushJob(config, job);

    const completion = this.runPush(config, listId, provider)
      .then(async (result) => {
        const done: PushJob = { ...job, status: 'completed', finishedAt: new Date().toISOString(), result };
        config.pushJob = done;
        await this.persistPushJob(config, done);
      })
      .catch(async (err: any) => {
        const message = this.formatError(err);
        console.error(`[ExternalCrmSync] push job ${job.jobId} failed for list ${listId}/${provider}: ${message}`);
        const failed: PushJob = { ...job, status: 'error', finishedAt: new Date().toISOString(), error: message };
        config.pushJob = failed;
        config.lastSyncStatus = 'error';
        config.lastSyncError = message;
        await this.persistPushJob(config, failed);
      });

    return { job, completion };
  }

  /** Returns the latest push job for the list, or null if none / no access. */
  async getPushJob(userId: string, listId: string, provider: string): Promise<PushJob | null> {
    const config = await this.getConfig(userId, listId, provider);
    return config?.pushJob ?? null;
  }

  /** Provider-agnostic lookup: returns the first configured provider on the list
   *  whose push job is currently running (and not stale), for refresh-resume of
   *  the progress card. Returns null when none. Access-checked like getConfig. */
  async getRunningPushJobForList(
    userId: string,
    listId: string
  ): Promise<{ provider: string; job: PushJob } | null> {
    const list = await crmDb.getLeadListById(listId);
    if (!list) return null;
    const configs = (list as any).externalCrmSyncConfigs as Record<string, ExternalCrmSyncConfig> | undefined;
    if (!configs) return null;
    for (const [provider, config] of Object.entries(configs)) {
      const job = config?.pushJob;
      if (!job || job.status !== 'running' || this.isPushJobStale(job)) continue;
      if (!(await this.canAccessConfig(userId, config.userId))) continue;
      return { provider, job };
    }
    return null;
  }

  private isPushJobStale(job: PushJob): boolean {
    const started = Date.parse(job.startedAt);
    if (Number.isNaN(started)) return true;
    return Date.now() - started > ExternalCrmSyncService.STALE_PUSH_JOB_MS;
  }

  /** Re-reads the config map and writes back only the pushJob field, so a job
   *  status update doesn't clobber a concurrent config edit. */
  private async persistPushJob(config: ExternalCrmSyncConfig, job: PushJob): Promise<void> {
    config.updatedAt = new Date().toISOString();
    await crmDb.setLeadListCrmSyncConfig(config.listId, config.provider, config as any)
      .catch((err: any) => console.error(`[ExternalCrmSync] failed to persist push job ${job.jobId}:`, this.formatError(err)));
  }

  /** Writes live push progress onto the running job (no-op for the synchronous
   *  pushAllLeads path, which runs runPush without a job). Cheap: one config
   *  write per 500-lead chunk. */
  private async reportPushProgress(config: ExternalCrmSyncConfig, processed: number, total?: number): Promise<void> {
    const job = config.pushJob;
    if (!job || job.status !== 'running') return;
    job.processedCount = processed;
    if (total !== undefined) job.totalCount = total;
    await this.persistPushJob(config, job);
  }

  // ─── Per-list push serialization ──────────────────────────────────────────────

  /**
   * In-process per-list lock. Ensures only ONE push operation (full push or
   * single-lead auto-sync) runs for a given list at a time, so two concurrent
   * pushes can't both create a deal for the same lead before either has written
   * its deal id back (the duplicate-deal race). Serializes within this process
   * only — cross-instance serialization would require a distributed lock.
   */
  private listPushLocks = new Map<string, Promise<unknown>>();

  private async withListPushLock<T>(listId: string, fn: () => Promise<T>): Promise<T> {
    // Wait for any in-progress push on this list to finish before claiming the lock.
    while (this.listPushLocks.has(listId)) {
      try { await this.listPushLocks.get(listId); } catch { /* prior push's failure is its own concern */ }
    }
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    this.listPushLocks.set(listId, held);
    try {
      return await fn();
    } finally {
      this.listPushLocks.delete(listId);
      release();
    }
  }

  /** Core push loop, operating on an already-resolved config. */
  private async runPush(config: ExternalCrmSyncConfig, listId: string, provider: string): Promise<SyncResult> {
    // Attach the human-readable list name + seed the progress denominator from the
    // maintained leadCount (best-effort; used only for the % in the progress card).
    let totalCount: number | undefined;
    {
      const list = await crmDb.getLeadListById(listId);
      if (list?.name && !config.listName) config.listName = list.name;
      if (typeof (list as any)?.leadCount === 'number') totalCount = (list as any).leadCount;
    }

    // Serialize all pushes for this list (full push + single-lead auto-sync) so two
    // concurrent runs can't both create a deal for the same lead before either has
    // written its deal id back (the duplicate-deal race).
    return this.withListPushLock(listId, async () => {
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

      let processed = 0;
      await this.reportPushProgress(config, 0, totalCount);

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

          processed += chunk.length;
          await this.reportPushProgress(config, processed, totalCount);
        }
      } while (lastKey);

      if (!hasLeads) {
        return { successCount: 0, newCount: 0, updatedCount: 0, errorCount: 0, errors: [] };
      }

      // Persist updated externalPeopleListId if the adapter set it
      await this.saveUpdatedConfig(config);
      await this.updateSyncTimestamp(config, 'push', totalResult.errorCount === 0);

      return totalResult;
    });
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
        if (lead.syncMetadata?.crmRemovedAt || lead.syncMetadata?.crmRemoved) continue; // already marked — skip

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
    let config: ExternalCrmSyncConfig | null = null;
    try {
      config = await this.getConfig(userId, listId, provider);
      if (!config?.autoSyncEnabled) return;
      if (!config.accountId && !config.apiKeyEncrypted) return;
      // Capture the non-null config so the narrowing flows into the lock closure
      // below (the reassignable `config` would widen back to `… | null` inside it).
      const cfg = config;

      const auth = this.resolveAuth(cfg);
      const adapter = getAdapter(provider);
      // Serialize with any concurrent push for this list, and re-read the lead
      // inside the lock so a deal id written by a just-finished push is seen here
      // (update instead of creating a duplicate deal).
      const result = await this.withListPushLock(listId, async () => {
        await this.syncHubSpotStatusOptions(cfg, 'push');
        // Re-read inside the lock so a deal id written by a just-finished push is
        // seen here (update instead of creating a duplicate deal). Defensive: a
        // transient read error shouldn't fail the whole auto-sync — fall back to
        // the in-hand lead.
        const fresh = await this.reReadLead(listId, lead);
        return adapter.pushLeads(auth, [fresh], cfg);
      });

      // The adapter catches per-lead failures (e.g. an invalid email) into
      // result.errors rather than throwing. A real-time auth failure (revoked
      // token) usually throws out of pushLeads, but treat any non-zero
      // errorCount as a failed sync too, mirroring the manual-push semantics
      // in runPush (errorCount === 0 ⇒ success).
      if (result.errorCount > 0) {
        const detail = result.errors[0] || 'Auto-sync reported an error';
        console.error(`[ExternalCrmSync] Auto-sync error for lead ${lead.leadId} in list ${listId}:`, detail);
        config.lastSyncError = detail;
        await this.updateSyncTimestamp(config, 'push', false);
        return;
      }

      // Success — persist the contact-id writeback the adapter made on `config`
      // and record a healthy sync status so a previously-failed connection
      // clears its error banner.
      await this.updateSyncTimestamp(config, 'push', true);
    } catch (err: any) {
      const details = err.response?.data?.message || err.response?.data || err.message;
      console.error(`[ExternalCrmSync] Auto-sync failed for lead ${lead.leadId} in list ${listId}:`, details);
      // Surface the failure on the config so the CRM UI can flag a connection
      // that needs attention (e.g. a revoked HubSpot token). Without this,
      // real-time failures are invisible because only manual push wrote status.
      if (config) {
        config.lastSyncError = typeof details === 'string' ? details : JSON.stringify(details);
        await this.updateSyncTimestamp(config, 'push', false).catch(() => { });
      }
    }
  }

  // ─── Private helpers ──────────────────────────────────────────────────────────

  /**
   * Re-reads a lead by id (used inside the per-list push lock so a deal id a
   * just-finished push wrote back is visible here). Falls back to the in-hand
   * lead on any error — a transient read failure shouldn't abort the auto-sync.
   */
  private async reReadLead(listId: string, lead: any): Promise<any> {
    try {
      const fresh = await crmDb.getLeadById(listId, lead.leadId);
      return fresh ?? lead;
    } catch {
      return lead;
    }
  }

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
    if (success) config.lastSyncError = undefined;
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
