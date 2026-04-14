import axios from 'axios';
import { settingsService } from './settingsService';
import { crmDb } from './db';
import { hubspotService } from './hubspotService';
import { attioService } from './attioService';
import { encryptPassword, decryptPassword } from '../utils/crypto';

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
  apiKeyEncrypted?: string;   // Manual token (encrypted)
  // Settings
  autoSyncEnabled: boolean;
  contactFieldMapping: FieldMapping[];
  dealFieldMapping: FieldMapping[];
  customFieldMapping: FieldMapping[];
  // Cached external IDs to skip redundant lookups
  externalListId?: string;          // HubSpot list ID
  externalPeopleListId?: string;    // Attio people list ID
  // Sync state
  lastPushSyncAt?: string;
  lastPullSyncAt?: string;
  lastSyncStatus?: 'success' | 'error';
  lastSyncError?: string;
  createdAt: string;
  updatedAt: string;
}

export interface SyncResult {
  successCount: number;
  newCount: number;
  updatedCount: number;
  errorCount: number;
  errors: string[];
}

// ─── Default mappings ─────────────────────────────────────────────────────────

export const DEFAULT_HUBSPOT_CONTACT_MAPPING: FieldMapping[] = [
  { agentwebField: 'email', crmProperty: 'email', direction: 'both', enabled: true },
  { agentwebField: 'firstName', crmProperty: 'firstname', direction: 'both', enabled: true },
  { agentwebField: 'lastName', crmProperty: 'lastname', direction: 'both', enabled: true },
  { agentwebField: 'phone', crmProperty: 'phone', direction: 'both', enabled: true },
  { agentwebField: 'company', crmProperty: 'company', direction: 'both', enabled: true },
  { agentwebField: 'title', crmProperty: 'jobtitle', direction: 'both', enabled: true },
  { agentwebField: 'linkedin', crmProperty: 'hs_linkedin_url', direction: 'push', enabled: true },
  { agentwebField: 'notes', crmProperty: 'notes', direction: 'push', enabled: true },
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
  { agentwebField: 'company', crmProperty: 'company_name', direction: 'both', enabled: true },
  { agentwebField: 'title', crmProperty: 'job_title', direction: 'both', enabled: true },
  { agentwebField: 'linkedin', crmProperty: 'linkedin_url', direction: 'push', enabled: true },
];

export const DEFAULT_ATTIO_DEAL_MAPPING: FieldMapping[] = [
  { agentwebField: 'dealValue', crmProperty: 'deal_value', direction: 'both', enabled: true },
  { agentwebField: 'dealCurrency', crmProperty: 'deal_currency', direction: 'both', enabled: true },
  { agentwebField: 'status', crmProperty: 'deal_status', direction: 'both', enabled: true },
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function settingKey(listId: string, provider: string): string {
  return `ext_crm_sync_${listId}_${provider}`;
}

function getNestedValue(obj: any, path: string): any {
  return path.split('.').reduce((cur, part) => (cur == null ? undefined : cur[part]), obj);
}

function chunkArray<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function buildPushProps(lead: any, mapping: FieldMapping[]): Record<string, string> {
  const props: Record<string, string> = {};
  for (const m of mapping) {
    if (!m.enabled || m.direction === 'pull') continue;
    // Custom fields live in lead.customFields, standard fields at root
    const value = lead.customFields?.[m.agentwebField] ?? getNestedValue(lead, m.agentwebField);
    if (value != null && String(value).trim() !== '') {
      props[m.crmProperty] = String(value);
    }
  }
  return props;
}

// ─── Service ──────────────────────────────────────────────────────────────────

export class ExternalCrmSyncService {

  // ─── Config CRUD ────────────────────────────────────────────────────────

  async getConfig(userId: string, listId: string, provider: string): Promise<ExternalCrmSyncConfig | null> {
    const setting = await settingsService.getSetting(settingKey(listId, provider));
    if (!setting) return null;
    try {
      const config: ExternalCrmSyncConfig = JSON.parse(setting.settingValue);
      if (config.userId !== userId) return null;
      return config;
    } catch {
      return null;
    }
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
    }
  ): Promise<ExternalCrmSyncConfig> {
    const existing = await this.getConfig(userId, listId, provider);
    const now = new Date().toISOString();
    const isHubspot = provider === 'hubspot';

    const config: ExternalCrmSyncConfig = {
      provider: provider as 'hubspot' | 'attio',
      listId,
      userId,
      accountId: updates.accountId ?? existing?.accountId,
      apiKeyEncrypted: existing?.apiKeyEncrypted,
      autoSyncEnabled: updates.autoSyncEnabled ?? existing?.autoSyncEnabled ?? false,
      contactFieldMapping: updates.contactFieldMapping ?? existing?.contactFieldMapping
        ?? (isHubspot ? DEFAULT_HUBSPOT_CONTACT_MAPPING : DEFAULT_ATTIO_CONTACT_MAPPING),
      dealFieldMapping: updates.dealFieldMapping ?? existing?.dealFieldMapping
        ?? (isHubspot ? DEFAULT_HUBSPOT_DEAL_MAPPING : DEFAULT_ATTIO_DEAL_MAPPING),
      customFieldMapping: updates.customFieldMapping ?? existing?.customFieldMapping ?? [],
      externalListId: existing?.externalListId,
      externalPeopleListId: existing?.externalPeopleListId,
      lastPushSyncAt: existing?.lastPushSyncAt,
      lastPullSyncAt: existing?.lastPullSyncAt,
      lastSyncStatus: existing?.lastSyncStatus,
      lastSyncError: existing?.lastSyncError,
      createdAt: existing?.createdAt || now,
      updatedAt: now,
    };

    // Clear cached external IDs if the account changed (new connection)
    if (updates.accountId && updates.accountId !== existing?.accountId) {
      config.externalListId = undefined;
      config.externalPeopleListId = undefined;
    }

    // New manual API key provided → encrypt it; clear OAuth accountId
    if (updates.apiKey) {
      config.apiKeyEncrypted = encryptPassword(updates.apiKey, userId);
      config.accountId = undefined;
    }

    await settingsService.setSetting(
      settingKey(listId, provider),
      JSON.stringify(config),
      `External CRM sync config for list ${listId} → ${provider}`,
      userId
    );

    return config;
  }

  async deleteConfig(userId: string, listId: string, provider: string): Promise<void> {
    const config = await this.getConfig(userId, listId, provider);
    if (!config) return;
    await settingsService.deleteSetting(settingKey(listId, provider));
  }

  // ─── Token resolution ────────────────────────────────────────────────────

  private async resolveToken(config: ExternalCrmSyncConfig, userId: string): Promise<string> {
    if (config.accountId) {
      if (config.provider === 'hubspot') {
        return hubspotService.getValidAccessToken(userId, config.accountId);
      } else {
        return attioService.getValidAccessToken(userId, config.accountId);
      }
    }
    if (config.apiKeyEncrypted) {
      const { password } = decryptPassword(config.apiKeyEncrypted);
      return password;
    }
    throw new Error('No authentication method configured');
  }

  private makeClient(token: string, baseURL: string) {
    return axios.create({
      baseURL,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    });
  }

  // ─── Test connection ─────────────────────────────────────────────────────

  async testConnection(userId: string, listId: string, provider: string): Promise<{ valid: boolean; error?: string }> {
    const config = await this.getConfig(userId, listId, provider);
    if (!config) return { valid: false, error: 'No sync configuration found' };
    if (!config.accountId && !config.apiKeyEncrypted) {
      return { valid: false, error: 'No authentication configured' };
    }

    try {
      const token = await this.resolveToken(config, userId);

      if (provider === 'hubspot') {
        const client = this.makeClient(token, 'https://api.hubapi.com');
        await client.get('/crm/v3/objects/contacts', { params: { limit: 1 } });
      } else {
        const client = this.makeClient(token, 'https://api.attio.com/v2');
        await client.get('/objects');
      }

      return { valid: true };
    } catch (err: any) {
      const msg = err.response?.data?.message || err.message || 'Unknown error';
      return { valid: false, error: msg };
    }
  }

  // ─── Custom field discovery ──────────────────────────────────────────────

  async getDistinctCustomFieldKeys(listId: string): Promise<string[]> {
    const keys = new Set<string>();
    let lastKey: any = undefined;

    do {
      const page = await crmDb.getLeadsByListId(listId, 100, lastKey);
      for (const lead of (page.items as any[])) {
        if (lead.customFields && typeof lead.customFields === 'object') {
          for (const [k, v] of Object.entries(lead.customFields)) {
            if (v != null && String(v).trim() !== '') {
              keys.add(k);
            }
          }
        }
      }
      lastKey = page.lastEvaluatedKey;
    } while (lastKey);

    return Array.from(keys).sort();
  }

  // ─── Push: all leads → CRM ───────────────────────────────────────────────

  async pushAllLeads(userId: string, listId: string, provider: string): Promise<SyncResult> {
    const config = await this.getConfig(userId, listId, provider);
    if (!config) throw new Error('No sync configuration found');
    if (!config.accountId && !config.apiKeyEncrypted) throw new Error('No authentication method configured');

    const token = await this.resolveToken(config, userId);
    const result: SyncResult = { successCount: 0, newCount: 0, updatedCount: 0, errorCount: 0, errors: [] };

    let lastKey: any = undefined;
    const allLeads: any[] = [];
    do {
      const page = await crmDb.getLeadsByListId(listId, 100, lastKey);
      allLeads.push(...(page.items as any[]));
      lastKey = page.lastEvaluatedKey;
    } while (lastKey);

    if (allLeads.length === 0) return result;

    if (provider === 'hubspot') {
      await this.pushToHubSpot(token, allLeads, config, result);
    } else {
      await this.pushToAttio(token, allLeads, config, result);
    }

    await this.updateSyncTimestamp(config, 'push', result.errorCount === 0);
    return result;
  }

  // ─── Pull: CRM → all leads ────────────────────────────────────────────────

  async pullAllContacts(userId: string, listId: string, provider: string): Promise<SyncResult> {
    const config = await this.getConfig(userId, listId, provider);
    if (!config) throw new Error('No sync configuration found');
    if (!config.accountId && !config.apiKeyEncrypted) throw new Error('No authentication method configured');

    const token = await this.resolveToken(config, userId);
    const result: SyncResult = { successCount: 0, newCount: 0, updatedCount: 0, errorCount: 0, errors: [] };

    if (provider === 'hubspot') {
      await this.pullFromHubSpot(token, listId, config, result);
    } else {
      await this.pullFromAttio(token, listId, config, result);
    }

    await this.updateSyncTimestamp(config, 'pull', result.errorCount === 0);
    return result;
  }

  // ─── Auto-sync single lead (fire-and-forget) ─────────────────────────────

  async autoSyncLead(
    userId: string,
    listId: string,
    lead: any,
    provider: 'hubspot' | 'attio',
    eventType: 'created' | 'updated'
  ): Promise<void> {
    try {
      const config = await this.getConfig(userId, listId, provider);
      if (!config?.autoSyncEnabled) return;
      if (!config.accountId && !config.apiKeyEncrypted) return;

      const token = await this.resolveToken(config, userId);
      const singleResult: SyncResult = { successCount: 0, newCount: 0, updatedCount: 0, errorCount: 0, errors: [] };

      if (provider === 'hubspot') {
        await this.pushToHubSpot(token, [lead], config, singleResult);
      } else {
        await this.pushToAttio(token, [lead], config, singleResult);
      }
    } catch (err: any) {
      const details = err.response?.data?.message || err.response?.data || err.message;
      console.error(`[ExternalCrmSync] Auto-sync failed for lead ${lead.leadId} in list ${listId}:`, details);
    }
  }

  // ─── HubSpot push implementation ─────────────────────────────────────────

  private async pushToHubSpot(
    token: string,
    leads: any[],
    config: ExternalCrmSyncConfig,
    result: SyncResult
  ): Promise<void> {
    const client = this.makeClient(token, 'https://api.hubapi.com');

    // Pre-create any custom properties needed
    const customMappingEnabled = config.customFieldMapping.filter(m => m.enabled && m.direction !== 'pull');
    for (const m of customMappingEnabled) {
      await this.ensureHubSpotProperty(client, m.crmProperty).catch(() => { /* non-fatal */ });
    }

    for (const lead of leads) {
      try {
        if (!lead.email) continue; // HubSpot requires email to upsert

        // Build contact properties from enabled mappings
        const contactProps = buildPushProps(lead, config.contactFieldMapping);
        const customProps = buildPushProps(lead, config.customFieldMapping);
        const allContactProps = { ...contactProps, ...customProps };

        if (Object.keys(allContactProps).length === 0) continue;

        // Search for existing contact by email
        let contactId: string | undefined;
        try {
          const searchRes = await client.post('/crm/v3/objects/contacts/search', {
            filterGroups: [{ filters: [{ propertyName: 'email', operator: 'EQ', value: lead.email }] }],
            properties: ['email'],
            limit: 1,
          });
          const hits = (searchRes.data as any).results;
          if (hits?.length > 0) contactId = hits[0].id;
        } catch { /* treat as not found */ }

        if (contactId) {
          await client.patch(`/crm/v3/objects/contacts/${contactId}`, { properties: allContactProps });
          result.updatedCount++;
        } else {
          const createRes = await client.post('/crm/v3/objects/contacts', { properties: allContactProps });
          contactId = (createRes.data as any).id;
          result.newCount++;
        }
        result.successCount++;

        // Deal fields
        const dealProps = buildPushProps(lead, config.dealFieldMapping);
        if (contactId && Object.keys(dealProps).length > 0) {
          await this.upsertHubSpotDeal(client, contactId, dealProps, lead);
        }

        // Persist HubSpot contact ID back to lead
        if (contactId) {
          await crmDb.updateLead(lead.listId || config.listId, lead.leadId, {
            customFields: { ...(lead.customFields || {}), hubspot_contact_id: contactId },
          }).catch(() => { /* non-critical */ });
        }
      } catch (err: any) {
        result.errorCount++;
        const msg = err.response?.data?.message || err.message || 'Unknown error';
        result.errors.push(`${lead.email || lead.leadId}: ${msg}`);
      }
    }
  }

  private async ensureHubSpotProperty(client: any, propertyName: string): Promise<void> {
    const slug = propertyName.toLowerCase().replace(/[^a-z0-9_]/g, '_');
    try {
      await client.get(`/crm/v3/properties/contacts/${slug}`);
    } catch (e: any) {
      if (e.response?.status === 404) {
        await client.post('/crm/v3/properties/contacts', {
          name: slug,
          label: slug.replace(/_/g, ' ').replace(/\b\w/g, (c: string) => c.toUpperCase()),
          type: 'string',
          fieldType: 'text',
          groupName: 'contactinformation',
        });
      }
    }
  }

  private async upsertHubSpotDeal(client: any, contactId: string, dealProps: Record<string, string>, lead: any): Promise<void> {
    const existingDealId = lead.customFields?.hubspot_deal_id;
    let dealId: string;

    if (existingDealId) {
      try {
        await client.patch(`/crm/v3/objects/deals/${existingDealId}`, { properties: dealProps });
        dealId = existingDealId;
      } catch {
        // Deal may have been deleted, create new
        const res = await client.post('/crm/v3/objects/deals', { properties: this.addDealName(dealProps, lead) });
        dealId = (res.data as any).id;
        await this.associateHubSpotDeal(client, contactId, dealId);
      }
    } else {
      const res = await client.post('/crm/v3/objects/deals', { properties: this.addDealName(dealProps, lead) });
      dealId = (res.data as any).id;
      await this.associateHubSpotDeal(client, contactId, dealId);
    }

    if (dealId) {
      await crmDb.updateLead(lead.listId || '', lead.leadId, {
        customFields: { ...(lead.customFields || {}), hubspot_deal_id: dealId },
      }).catch(() => { });
    }
  }

  private addDealName(props: Record<string, string>, lead: any): Record<string, string> {
    if (props.dealname) return props;
    const name = [lead.firstName, lead.lastName].filter(Boolean).join(' ') || lead.email || 'Unknown';
    return { ...props, dealname: `${name} - Deal` };
  }

  private async associateHubSpotDeal(client: any, contactId: string, dealId: string): Promise<void> {
    await client.put(
      `/crm/v3/objects/contacts/${contactId}/associations/deals/${dealId}/contact_to_deal`
    );
  }

  // ─── HubSpot pull implementation ─────────────────────────────────────────

  private async pullFromHubSpot(
    token: string,
    listId: string,
    config: ExternalCrmSyncConfig,
    result: SyncResult
  ): Promise<void> {
    const client = this.makeClient(token, 'https://api.hubapi.com');

    // Build the properties to fetch based on enabled pull-direction mappings
    const pullContactMappings = config.contactFieldMapping.filter(m => m.enabled && m.direction !== 'push');
    const pullDealMappings = config.dealFieldMapping.filter(m => m.enabled && m.direction !== 'push');
    const pullCustomMappings = config.customFieldMapping.filter(m => m.enabled && m.direction !== 'push');

    const contactProps = [
      ...pullContactMappings.map(m => m.crmProperty),
      ...pullCustomMappings.map(m => m.crmProperty),
    ].join(',');

    const allLeadData: any[] = [];
    let after: string | undefined;

    do {
      const params: any = { limit: 100, properties: contactProps || 'email,firstname,lastname' };
      if (after) params.after = after;
      const res = await client.get('/crm/v3/objects/contacts', { params });
      const data = res.data as any;

      for (const contact of (data.results || [])) {
        const leadData: Record<string, any> = {};
        const customFields: Record<string, any> = { hubspot_contact_id: contact.id };

        // Map contact fields back
        for (const m of pullContactMappings) {
          const val = contact.properties?.[m.crmProperty];
          if (val != null && val !== '') leadData[m.agentwebField] = val;
        }

        // Map custom fields back
        for (const m of pullCustomMappings) {
          const val = contact.properties?.[m.crmProperty];
          if (val != null && val !== '') customFields[m.agentwebField] = val;
        }

        // Fetch associated deals if deal pull mappings exist
        if (pullDealMappings.length > 0) {
          try {
            const dealProps = pullDealMappings.map(m => m.crmProperty).join(',');
            const assocRes = await client.get(`/crm/v3/objects/contacts/${contact.id}/associations/deals`);
            const assocIds = ((assocRes.data as any).results || []).map((r: any) => r.id);
            if (assocIds.length > 0) {
              const dealRes = await client.get(`/crm/v3/objects/deals/${assocIds[0]}`, { params: { properties: dealProps } });
              const deal = dealRes.data as any;
              for (const m of pullDealMappings) {
                const val = deal.properties?.[m.crmProperty];
                if (val != null && val !== '') leadData[m.agentwebField] = val;
              }
              customFields.hubspot_deal_id = deal.id;
            }
          } catch { /* skip deal fetch errors */ }
        }

        if (Object.keys(customFields).length > 0) leadData.customFields = customFields;
        allLeadData.push(leadData);
      }

      after = data.paging?.next?.after;
    } while (after);

    if (allLeadData.length === 0) return;

    const batchResult = await crmDb.batchCreateLeads(listId, allLeadData);
    result.successCount = batchResult.successCount;
    result.newCount = batchResult.newCount;
    result.updatedCount = batchResult.mergedCount;
    result.errorCount = batchResult.errorCount;
    result.errors = batchResult.errors;
  }

  // ─── Attio push implementation ────────────────────────────────────────────

  private async pushToAttio(
    token: string,
    leads: any[],
    config: ExternalCrmSyncConfig,
    result: SyncResult
  ): Promise<void> {
    const client = this.makeClient(token, 'https://api.attio.com/v2');

    // Ensure the people list exists
    const listName = config.listId; // will be overridden by list name in route layer
    let peopleListId = config.externalPeopleListId;
    if (!peopleListId) {
      peopleListId = await this.findOrCreateAttioList(client, `AgentWeb - ${config.listId}`, 'people');
      // Persist for future syncs (fire-and-forget)
      config.externalPeopleListId = peopleListId;
    }

    // Ensure list entry attributes for deal + custom field mappings
    const entryMappings = [
      ...config.dealFieldMapping.filter(m => m.enabled && m.direction !== 'pull'),
      ...config.customFieldMapping.filter(m => m.enabled && m.direction !== 'pull'),
    ];
    for (const m of entryMappings) {
      await this.ensureAttioListAttribute(client, peopleListId, m.crmProperty).catch(() => { /* non-fatal */ });
    }

    for (const lead of leads) {
      try {
        // Build person upsert body from contact mapping
        const personBody = this.buildAttioPersonBody(lead, config.contactFieldMapping);

        // Upsert person
        let personId: string;
        if (lead.email) {
          const res = await client.put('/objects/people/records', {
            matching_attribute: 'email_addresses',
            values: personBody,
          });
          personId = (res.data as any).data?.id?.record_id ?? (res.data as any).id?.record_id;
        } else if (lead.attioRecordId) {
          await client.patch(`/objects/people/records/${lead.attioRecordId}`, { values: personBody });
          personId = lead.attioRecordId;
        } else {
          const res = await client.post('/objects/people/records', { values: personBody });
          personId = (res.data as any).data?.id?.record_id ?? (res.data as any).id?.record_id;
          await crmDb.updateLead(lead.listId || config.listId, lead.leadId, { attioRecordId: personId }).catch(() => { });
        }

        if (!personId) {
          result.errorCount++;
          result.errors.push(`${lead.leadId}: Attio returned no record ID`);
          continue;
        }

        // Build list entry values from deal + custom field mappings
        const entryValues: Record<string, any[]> = {};
        for (const m of entryMappings) {
          const value = lead.customFields?.[m.agentwebField] ?? getNestedValue(lead, m.agentwebField);
          if (value != null && String(value).trim() !== '') {
            entryValues[m.crmProperty] = [{ value: String(value) }];
          }
        }

        // Add to list or update existing entry
        try {
          const existingRes = await client.get(`/lists/${peopleListId}/entries`, {
            params: { 'filter[record_id]': personId },
          });
          const entries = (existingRes.data as any).data || [];
          if (entries.length > 0 && Object.keys(entryValues).length > 0) {
            await client.patch(`/lists/${peopleListId}/entries/${entries[0].id.entry_id}`, {
              entry_values: entryValues,
            });
          } else if (entries.length === 0) {
            await client.post(`/lists/${peopleListId}/entries`, {
              record_id: personId,
              entry_values: entryValues,
            });
          }
        } catch {
          // Fallback: try to add (ignore duplicate errors)
          await client.post(`/lists/${peopleListId}/entries`, {
            record_id: personId,
            entry_values: entryValues,
          }).catch(() => { });
        }

        result.successCount++;
        result.newCount++;
      } catch (err: any) {
        result.errorCount++;
        const msg = err.response?.data?.message || err.message || 'Unknown error';
        result.errors.push(`${lead.email || lead.leadId}: ${msg}`);
      }
    }
  }

  private buildAttioPersonBody(lead: any, contactMapping: FieldMapping[]): Record<string, any> {
    const body: Record<string, any> = {};
    for (const m of contactMapping) {
      if (!m.enabled || m.direction === 'pull') continue;
      const value = getNestedValue(lead, m.agentwebField);
      if (value == null || String(value).trim() === '') continue;

      // Attio uses arrays for multi-value fields
      if (m.crmProperty === 'email_addresses') {
        body.email_addresses = [{ email_address: String(value) }];
      } else if (m.crmProperty === 'phone_numbers') {
        body.phone_numbers = [{ original_phone_number: String(value) }];
      } else if (m.crmProperty === 'first_name' || m.crmProperty === 'last_name') {
        if (!body.name) body.name = [{}];
        body.name[0][m.crmProperty] = String(value);
      } else {
        body[m.crmProperty] = [{ value: String(value) }];
      }
    }
    return body;
  }

  private async findOrCreateAttioList(client: any, name: string, objectSlug: string): Promise<string> {
    // Search existing lists
    try {
      const res = await client.get('/lists');
      const lists = (res.data as any).data || [];
      const found = lists.find((l: any) => l.name === name && l.api_slug?.includes(objectSlug));
      if (found) return found.id?.list_id ?? found.list_id;
    } catch { /* create fresh */ }

    const res = await client.post('/lists', { name, api_slug: `${objectSlug}_${Date.now()}` });
    return (res.data as any).data?.id?.list_id ?? (res.data as any).id?.list_id;
  }

  private async ensureAttioListAttribute(client: any, listId: string, slug: string): Promise<void> {
    const cleanSlug = slug.toLowerCase().replace(/[^a-z0-9_]/g, '_');
    try {
      await client.get(`/lists/${listId}/attributes/${cleanSlug}`);
    } catch (e: any) {
      if (e.response?.status === 404) {
        const title = cleanSlug.replace(/_/g, ' ').replace(/\b\w/g, (c: string) => c.toUpperCase());
        await client.post(`/lists/${listId}/attributes`, {
          api_slug: cleanSlug,
          name: title,
          type: 'text',
          is_required: false,
        }).catch(() => { /* already exists race condition */ });
      }
    }
  }

  // ─── Attio pull implementation ────────────────────────────────────────────

  private async pullFromAttio(
    token: string,
    listId: string,
    config: ExternalCrmSyncConfig,
    result: SyncResult
  ): Promise<void> {
    const client = this.makeClient(token, 'https://api.attio.com/v2');

    const peopleListId = config.externalPeopleListId;
    if (!peopleListId) {
      result.errors.push('No Attio list configured. Run a push first to create the list.');
      result.errorCount++;
      return;
    }

    const pullContactMappings = config.contactFieldMapping.filter(m => m.enabled && m.direction !== 'push');
    const pullEntryMappings = [
      ...config.dealFieldMapping.filter(m => m.enabled && m.direction !== 'push'),
      ...config.customFieldMapping.filter(m => m.enabled && m.direction !== 'push'),
    ];

    const allLeadData: any[] = [];
    let cursor: string | undefined;

    do {
      const params: any = { limit: 50 };
      if (cursor) params.cursor = cursor;
      const res = await client.get(`/lists/${peopleListId}/entries`, { params });
      const data = res.data as any;

      for (const entry of (data.data || [])) {
        const personId = entry.record_id?.record_id ?? entry.record_id;
        const leadData: Record<string, any> = {};
        const customFields: Record<string, any> = { attio_record_id: personId };

        // Fetch full person record
        try {
          const personRes = await client.get(`/objects/people/records/${personId}`);
          const personValues = (personRes.data as any).data?.values ?? {};

          for (const m of pullContactMappings) {
            if (m.crmProperty === 'email_addresses') {
              const val = personValues.email_addresses?.[0]?.email_address;
              if (val) leadData[m.agentwebField] = val;
            } else if (m.crmProperty === 'phone_numbers') {
              const val = personValues.phone_numbers?.[0]?.original_phone_number;
              if (val) leadData[m.agentwebField] = val;
            } else if (m.crmProperty === 'first_name') {
              const val = personValues.name?.[0]?.first_name;
              if (val) leadData[m.agentwebField] = val;
            } else if (m.crmProperty === 'last_name') {
              const val = personValues.name?.[0]?.last_name;
              if (val) leadData[m.agentwebField] = val;
            } else {
              const val = personValues[m.crmProperty]?.[0]?.value;
              if (val != null && val !== '') leadData[m.agentwebField] = val;
            }
          }
        } catch { /* skip person fetch errors */ }

        // Map list entry values (deal + custom fields)
        const entryValues = entry.entry_values ?? {};
        for (const m of pullEntryMappings) {
          const cleanSlug = m.crmProperty.toLowerCase().replace(/[^a-z0-9_]/g, '_');
          const val = entryValues[cleanSlug]?.[0]?.value;
          if (val != null && val !== '') customFields[m.agentwebField] = val;
        }

        if (Object.keys(customFields).length > 0) leadData.customFields = customFields;
        allLeadData.push(leadData);
      }

      cursor = data.next_cursor;
    } while (cursor);

    if (allLeadData.length === 0) return;

    const batchResult = await crmDb.batchCreateLeads(listId, allLeadData);
    result.successCount = batchResult.successCount;
    result.newCount = batchResult.newCount;
    result.updatedCount = batchResult.mergedCount;
    result.errorCount = batchResult.errorCount;
    result.errors = batchResult.errors;
  }

  // ─── Sync timestamp helper ────────────────────────────────────────────────

  private async updateSyncTimestamp(
    config: ExternalCrmSyncConfig,
    direction: 'push' | 'pull',
    success: boolean
  ): Promise<void> {
    const now = new Date().toISOString();
    const update: Partial<ExternalCrmSyncConfig> = { updatedAt: now };

    if (direction === 'push') update.lastPushSyncAt = now;
    else update.lastPullSyncAt = now;

    update.lastSyncStatus = success ? 'success' : 'error';
    Object.assign(config, update);

    await settingsService.setSetting(
      settingKey(config.listId, config.provider),
      JSON.stringify(config),
      `External CRM sync config for list ${config.listId} → ${config.provider}`,
      config.userId
    ).catch(() => { /* non-critical */ });
  }
}

export const externalCrmSyncService = new ExternalCrmSyncService();
