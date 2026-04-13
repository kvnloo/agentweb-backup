import { HubSpotService, FieldMapping, DEFAULT_CONTACT_MAPPING, DEFAULT_DEAL_MAPPING } from './hubspotService';
import { settingsService } from './settingsService';
import { crmDb } from './db';
import { leadListAlertService } from './leadListAlertService';
import { encryptPassword, decryptPassword } from '../utils/crypto';

export interface ExternalCrmSyncConfig {
  provider: 'hubspot';
  listId: string;
  userId: string;
  apiKeyEncrypted: string;
  autoSyncEnabled: boolean;
  contactFieldMapping: FieldMapping[];
  dealFieldMapping: FieldMapping[];
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

function getSettingName(listId: string, provider: string): string {
  return `crm_sync_${listId}_${provider}`;
}

export class ExternalCrmSyncService {
  async getConfig(userId: string, listId: string, provider: string): Promise<ExternalCrmSyncConfig | null> {
    const setting = await settingsService.getSetting(getSettingName(listId, provider));
    if (!setting) return null;
    const config: ExternalCrmSyncConfig = JSON.parse(setting.settingValue);
    if (config.userId !== userId) return null;
    return config;
  }

  async saveConfig(
    userId: string,
    listId: string,
    provider: string,
    updates: {
      apiKey?: string;
      autoSyncEnabled?: boolean;
      contactFieldMapping?: FieldMapping[];
      dealFieldMapping?: FieldMapping[];
    }
  ): Promise<ExternalCrmSyncConfig> {
    const existing = await this.getConfig(userId, listId, provider);
    const now = new Date().toISOString();

    const config: ExternalCrmSyncConfig = {
      provider: provider as 'hubspot',
      listId,
      userId,
      apiKeyEncrypted: existing?.apiKeyEncrypted || '',
      autoSyncEnabled: updates.autoSyncEnabled ?? existing?.autoSyncEnabled ?? false,
      contactFieldMapping: updates.contactFieldMapping ?? existing?.contactFieldMapping ?? DEFAULT_CONTACT_MAPPING,
      dealFieldMapping: updates.dealFieldMapping ?? existing?.dealFieldMapping ?? DEFAULT_DEAL_MAPPING,
      lastPushSyncAt: existing?.lastPushSyncAt,
      lastPullSyncAt: existing?.lastPullSyncAt,
      lastSyncStatus: existing?.lastSyncStatus,
      lastSyncError: existing?.lastSyncError,
      createdAt: existing?.createdAt || now,
      updatedAt: now,
    };

    if (updates.apiKey) {
      config.apiKeyEncrypted = encryptPassword(updates.apiKey, userId);
    }

    await settingsService.setSetting(
      getSettingName(listId, provider),
      JSON.stringify(config),
      `CRM sync config for list ${listId} to ${provider}`,
      userId
    );

    return config;
  }

  async deleteConfig(userId: string, listId: string, provider: string): Promise<void> {
    const config = await this.getConfig(userId, listId, provider);
    if (!config) return;
    await settingsService.deleteSetting(getSettingName(listId, provider));
  }

  async testConnection(userId: string, listId: string, provider: string): Promise<{ valid: boolean; error?: string }> {
    const config = await this.getConfig(userId, listId, provider);
    if (!config || !config.apiKeyEncrypted) {
      return { valid: false, error: 'No sync configuration found' };
    }

    const apiKey = this.decryptApiKey(config);
    const hubspot = new HubSpotService(apiKey);
    return hubspot.testConnection();
  }

  async pushAllLeads(userId: string, listId: string, provider: string): Promise<SyncResult> {
    const config = await this.getConfig(userId, listId, provider);
    if (!config || !config.apiKeyEncrypted) {
      throw new Error('No sync configuration found');
    }

    const apiKey = this.decryptApiKey(config);
    const hubspot = new HubSpotService(apiKey);
    const result: SyncResult = { successCount: 0, newCount: 0, updatedCount: 0, errorCount: 0, errors: [] };

    // Paginate through all leads
    let lastKey: any = undefined;
    do {
      const page = await crmDb.getLeadsByListId(listId, 100, lastKey);
      const leads = page.items || [];
      lastKey = page.lastEvaluatedKey;

      for (const lead of leads) {
        try {
          await this.pushSingleLeadToHubSpot(hubspot, lead, config);
          result.successCount++;
          // We can't easily distinguish new vs updated at the batch level without checking each,
          // so we count total success. The upsertContact inside handles create vs update.
        } catch (err: any) {
          result.errorCount++;
          const msg = err.response?.data?.message || err.message || 'Unknown error';
          result.errors.push(`${lead.email || lead.leadId}: ${msg}`);
        }
      }
    } while (lastKey);

    // Update sync timestamps only on zero errors (matches admin sync pattern)
    const now = new Date().toISOString();
    if (result.errorCount === 0) {
      config.lastPushSyncAt = now;
      config.lastSyncStatus = 'success';
      config.lastSyncError = undefined;
    } else {
      config.lastSyncStatus = 'error';
      config.lastSyncError = `${result.errorCount} error(s): ${result.errors.slice(0, 3).join('; ')}`;
    }
    config.updatedAt = now;
    await settingsService.setSetting(
      getSettingName(listId, provider),
      JSON.stringify(config),
      `CRM sync config for list ${listId} to ${provider}`,
      userId
    );

    return result;
  }

  async pullAllContacts(userId: string, listId: string, provider: string): Promise<SyncResult> {
    const config = await this.getConfig(userId, listId, provider);
    if (!config || !config.apiKeyEncrypted) {
      throw new Error('No sync configuration found');
    }

    const apiKey = this.decryptApiKey(config);
    const hubspot = new HubSpotService(apiKey);
    const result: SyncResult = { successCount: 0, newCount: 0, updatedCount: 0, errorCount: 0, errors: [] };

    // Paginate through all HubSpot contacts
    let after: string | undefined;
    const allLeadData: any[] = [];

    do {
      const page = await hubspot.listContacts(after, 100);
      for (const contact of page.results) {
        const leadData = HubSpotService.contactToLeadData(contact, config.contactFieldMapping);

        // Try to get associated deals
        try {
          const deals = await hubspot.getDealsByContactId(contact.id);
          if (deals.length > 0) {
            const dealUpdates = HubSpotService.dealToLeadUpdates(deals[0], config.dealFieldMapping);
            Object.assign(leadData, dealUpdates);
            // Merge customFields
            if (dealUpdates.customFields) {
              leadData.customFields = { ...leadData.customFields, ...dealUpdates.customFields };
            }
          }
        } catch {
          // Skip deal fetch errors
        }

        allLeadData.push(leadData);
      }
      after = page.paging?.next?.after;
    } while (after);

    if (allLeadData.length === 0) {
      return result;
    }

    // Use batchCreateLeads which handles dedup/merge
    const batchResult = await crmDb.batchCreateLeads(listId, allLeadData);
    result.successCount = batchResult.successCount;
    result.newCount = batchResult.newCount;
    result.updatedCount = batchResult.mergedCount;
    result.errorCount = batchResult.errorCount;
    result.errors = batchResult.errors;

    // Update sync timestamps
    const now = new Date().toISOString();
    if (result.errorCount === 0) {
      config.lastPullSyncAt = now;
      config.lastSyncStatus = 'success';
      config.lastSyncError = undefined;
    } else {
      config.lastSyncStatus = 'error';
      config.lastSyncError = `${result.errorCount} error(s): ${result.errors.slice(0, 3).join('; ')}`;
    }
    config.updatedAt = now;
    await settingsService.setSetting(
      getSettingName(listId, provider),
      JSON.stringify(config),
      `CRM sync config for list ${listId} to ${provider}`,
      userId
    );

    return result;
  }

  async autoSyncLead(userId: string, listId: string, lead: any, eventType: 'created' | 'updated'): Promise<void> {
    try {
      const config = await this.getConfig(userId, listId, 'hubspot');
      if (!config || !config.autoSyncEnabled || !config.apiKeyEncrypted) {
        return;
      }

      const apiKey = this.decryptApiKey(config);
      const hubspot = new HubSpotService(apiKey);
      await this.pushSingleLeadToHubSpot(hubspot, lead, config);
    } catch (err: any) {
      console.error(`Auto-sync to external CRM failed for lead ${lead.leadId} in list ${listId}:`, err.message);

      // Send alert via existing alert service
      try {
        const list = await crmDb.getLeadListById(listId);
        if (list) {
          await leadListAlertService.notifyLeadListOwnerIfConfigured(
            list,
            lead,
            'crm_sync.failed',
            {
              provider: 'hubspot',
              eventType,
              error: err.message || 'Unknown error',
            },
            new Date().toISOString()
          );
        }
      } catch (alertErr: any) {
        console.error('Failed to send sync failure alert:', alertErr.message);
      }
    }
  }

  private async pushSingleLeadToHubSpot(
    hubspot: HubSpotService,
    lead: any,
    config: ExternalCrmSyncConfig
  ): Promise<void> {
    if (!lead.email) return; // Can't sync without email

    // Upsert contact
    const contactProps = HubSpotService.leadToContactProperties(lead, config.contactFieldMapping);
    const { contact } = await hubspot.upsertContact(contactProps);

    // Store HubSpot contact ID on the lead for future reference
    const customFieldUpdates: Record<string, any> = { hubspot_contact_id: contact.id };

    // Upsert deal if lead has deal data
    const dealProps = HubSpotService.leadToDealProperties(lead, config.dealFieldMapping);
    if (dealProps) {
      const existingDealId = lead.customFields?.hubspot_deal_id;
      let deal;
      if (existingDealId) {
        try {
          deal = await hubspot.updateDeal(existingDealId, dealProps);
        } catch {
          // Deal may have been deleted, create new
          deal = await hubspot.createDeal(dealProps);
          await hubspot.associateContactToDeal(contact.id, deal.id);
        }
      } else {
        deal = await hubspot.createDeal(dealProps);
        await hubspot.associateContactToDeal(contact.id, deal.id);
      }
      customFieldUpdates.hubspot_deal_id = deal.id;
    }

    // Update lead with HubSpot IDs (fire and forget)
    try {
      await crmDb.updateLead(lead.listId, lead.leadId, {
        customFields: { ...(lead.customFields || {}), ...customFieldUpdates },
      });
    } catch {
      // Non-critical: HubSpot sync succeeded even if we can't store the IDs back
    }
  }

  private decryptApiKey(config: ExternalCrmSyncConfig): string {
    const { password } = decryptPassword(config.apiKeyEncrypted);
    return password;
  }
}

export const externalCrmSyncService = new ExternalCrmSyncService();
