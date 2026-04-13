import { ExternalCrmSyncService } from '../services/externalCrmSyncService';
import { settingsService } from '../services/settingsService';
import { crmDb } from '../services/db';
import { leadListAlertService } from '../services/leadListAlertService';
import { encryptPassword, decryptPassword } from '../utils/crypto';
import { HubSpotService } from '../services/hubspotService';

jest.mock('../services/settingsService');
jest.mock('../services/db', () => ({
  crmDb: {
    getLeadsByListId: jest.fn(),
    getLeadListById: jest.fn(),
    batchCreateLeads: jest.fn(),
    updateLead: jest.fn(),
  },
}));
jest.mock('../services/leadListAlertService', () => ({
  leadListAlertService: {
    notifyLeadListOwnerIfConfigured: jest.fn(),
  },
}));
jest.mock('../utils/crypto');
jest.mock('../services/hubspotService');

const mockSettingsService = settingsService as jest.Mocked<typeof settingsService>;
const mockCrmDb = crmDb as jest.Mocked<typeof crmDb>;
const mockAlertService = leadListAlertService as jest.Mocked<typeof leadListAlertService>;
const mockEncrypt = encryptPassword as jest.MockedFunction<typeof encryptPassword>;
const mockDecrypt = decryptPassword as jest.MockedFunction<typeof decryptPassword>;

// Mock HubSpotService instance methods
const mockHubSpotInstance = {
  testConnection: jest.fn(),
  upsertContact: jest.fn(),
  createDeal: jest.fn(),
  updateDeal: jest.fn(),
  associateContactToDeal: jest.fn(),
  listContacts: jest.fn(),
  getDealsByContactId: jest.fn(),
};

(HubSpotService as unknown as jest.Mock).mockImplementation(() => mockHubSpotInstance);

// Keep static methods working
(HubSpotService.leadToContactProperties as jest.Mock) = jest.fn().mockImplementation(
  (lead: any) => ({ email: lead.email, firstname: lead.firstName })
);
(HubSpotService.leadToDealProperties as jest.Mock) = jest.fn().mockImplementation(
  (lead: any) => lead.dealValue ? { amount: String(lead.dealValue), dealname: 'Test Deal' } : null
);
(HubSpotService.contactToLeadData as jest.Mock) = jest.fn().mockImplementation(
  (contact: any) => ({
    email: contact.properties?.email,
    firstName: contact.properties?.firstname,
    customFields: { hubspot_contact_id: contact.id },
  })
);
(HubSpotService.dealToLeadUpdates as jest.Mock) = jest.fn().mockImplementation(
  (deal: any) => ({
    dealValue: parseFloat(deal.properties?.amount) || 0,
    customFields: { hubspot_deal_id: deal.id },
  })
);

describe('ExternalCrmSyncService', () => {
  let service: ExternalCrmSyncService;

  const baseConfig = {
    provider: 'hubspot' as const,
    listId: 'list123',
    userId: 'user123',
    apiKeyEncrypted: 'encrypted-key',
    autoSyncEnabled: true,
    contactFieldMapping: [],
    dealFieldMapping: [],
    lastPushSyncAt: undefined,
    lastPullSyncAt: undefined,
    lastSyncStatus: undefined,
    lastSyncError: undefined,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };

  beforeEach(() => {
    jest.clearAllMocks();
    service = new ExternalCrmSyncService();
    mockDecrypt.mockReturnValue({ password: 'test-api-key', userId: 'user123' });
    mockEncrypt.mockReturnValue('encrypted-key');
  });

  describe('getConfig', () => {
    it('returns config when setting exists and userId matches', async () => {
      mockSettingsService.getSetting.mockResolvedValue({
        settingName: 'crm_sync_list123_hubspot',
        settingValue: JSON.stringify(baseConfig),
        updatedAt: '2026-01-01T00:00:00.000Z',
        updatedBy: 'user123',
      });

      const config = await service.getConfig('user123', 'list123', 'hubspot');
      expect(config).not.toBeNull();
      expect(config!.provider).toBe('hubspot');
    });

    it('returns null when setting does not exist', async () => {
      mockSettingsService.getSetting.mockResolvedValue(null);
      const config = await service.getConfig('user123', 'list123', 'hubspot');
      expect(config).toBeNull();
    });

    it('returns null when userId does not match', async () => {
      mockSettingsService.getSetting.mockResolvedValue({
        settingName: 'crm_sync_list123_hubspot',
        settingValue: JSON.stringify(baseConfig),
        updatedAt: '2026-01-01T00:00:00.000Z',
        updatedBy: 'user123',
      });

      const config = await service.getConfig('different-user', 'list123', 'hubspot');
      expect(config).toBeNull();
    });
  });

  describe('saveConfig', () => {
    it('creates new config with encrypted API key', async () => {
      mockSettingsService.getSetting.mockResolvedValue(null);
      mockEncrypt.mockReturnValue('new-encrypted-key');

      const config = await service.saveConfig('user123', 'list123', 'hubspot', {
        apiKey: 'my-hubspot-token',
        autoSyncEnabled: true,
      });

      expect(config.apiKeyEncrypted).toBe('new-encrypted-key');
      expect(config.autoSyncEnabled).toBe(true);
      expect(mockEncrypt).toHaveBeenCalledWith('my-hubspot-token', 'user123');
      expect(mockSettingsService.setSetting).toHaveBeenCalledWith(
        'crm_sync_list123_hubspot',
        expect.any(String),
        expect.any(String),
        'user123'
      );
    });

    it('updates existing config preserving fields not in updates', async () => {
      mockSettingsService.getSetting.mockResolvedValue({
        settingName: 'crm_sync_list123_hubspot',
        settingValue: JSON.stringify({ ...baseConfig, lastPushSyncAt: '2026-02-01T00:00:00.000Z' }),
        updatedAt: '2026-01-01T00:00:00.000Z',
        updatedBy: 'user123',
      });

      const config = await service.saveConfig('user123', 'list123', 'hubspot', {
        autoSyncEnabled: false,
      });

      expect(config.autoSyncEnabled).toBe(false);
      expect(config.apiKeyEncrypted).toBe('encrypted-key'); // preserved
      expect(config.lastPushSyncAt).toBe('2026-02-01T00:00:00.000Z'); // preserved
    });
  });

  describe('deleteConfig', () => {
    it('deletes existing config', async () => {
      mockSettingsService.getSetting.mockResolvedValue({
        settingName: 'crm_sync_list123_hubspot',
        settingValue: JSON.stringify(baseConfig),
        updatedAt: '2026-01-01T00:00:00.000Z',
        updatedBy: 'user123',
      });

      await service.deleteConfig('user123', 'list123', 'hubspot');
      expect(mockSettingsService.deleteSetting).toHaveBeenCalledWith('crm_sync_list123_hubspot');
    });

    it('no-ops when config does not exist', async () => {
      mockSettingsService.getSetting.mockResolvedValue(null);
      await service.deleteConfig('user123', 'list123', 'hubspot');
      expect(mockSettingsService.deleteSetting).not.toHaveBeenCalled();
    });
  });

  describe('testConnection', () => {
    it('returns valid when HubSpot connection succeeds', async () => {
      mockSettingsService.getSetting.mockResolvedValue({
        settingName: 'crm_sync_list123_hubspot',
        settingValue: JSON.stringify(baseConfig),
        updatedAt: '2026-01-01T00:00:00.000Z',
        updatedBy: 'user123',
      });
      mockHubSpotInstance.testConnection.mockResolvedValue({ valid: true });

      const result = await service.testConnection('user123', 'list123', 'hubspot');
      expect(result.valid).toBe(true);
    });

    it('returns error when no config found', async () => {
      mockSettingsService.getSetting.mockResolvedValue(null);
      const result = await service.testConnection('user123', 'list123', 'hubspot');
      expect(result.valid).toBe(false);
      expect(result.error).toBe('No sync configuration found');
    });
  });

  describe('pushAllLeads', () => {
    it('pushes all leads to HubSpot and updates lastPushSyncAt on success', async () => {
      mockSettingsService.getSetting.mockResolvedValue({
        settingName: 'crm_sync_list123_hubspot',
        settingValue: JSON.stringify(baseConfig),
        updatedAt: '2026-01-01T00:00:00.000Z',
        updatedBy: 'user123',
      });

      (mockCrmDb.getLeadsByListId as jest.Mock).mockResolvedValue({
        items: [
          { leadId: 'lead1', listId: 'list123', email: 'a@test.com', firstName: 'A' },
          { leadId: 'lead2', listId: 'list123', email: 'b@test.com', firstName: 'B' },
        ],
        lastEvaluatedKey: undefined,
      });

      mockHubSpotInstance.upsertContact.mockResolvedValue({ contact: { id: 'hs1' }, isNew: true });
      (mockCrmDb.updateLead as jest.Mock).mockResolvedValue({});

      const result = await service.pushAllLeads('user123', 'list123', 'hubspot');
      expect(result.successCount).toBe(2);
      expect(result.errorCount).toBe(0);

      // Should update config with lastPushSyncAt
      const savedConfig = JSON.parse(
        (mockSettingsService.setSetting as jest.Mock).mock.calls[0][1]
      );
      expect(savedConfig.lastPushSyncAt).toBeDefined();
      expect(savedConfig.lastSyncStatus).toBe('success');
    });

    it('captures errors and does not update lastPushSyncAt on failure', async () => {
      mockSettingsService.getSetting.mockResolvedValue({
        settingName: 'crm_sync_list123_hubspot',
        settingValue: JSON.stringify(baseConfig),
        updatedAt: '2026-01-01T00:00:00.000Z',
        updatedBy: 'user123',
      });

      (mockCrmDb.getLeadsByListId as jest.Mock).mockResolvedValue({
        items: [{ leadId: 'lead1', listId: 'list123', email: 'fail@test.com' }],
        lastEvaluatedKey: undefined,
      });

      mockHubSpotInstance.upsertContact.mockRejectedValue(new Error('Rate limited'));

      const result = await service.pushAllLeads('user123', 'list123', 'hubspot');
      expect(result.errorCount).toBe(1);
      expect(result.errors[0]).toContain('fail@test.com');

      const savedConfig = JSON.parse(
        (mockSettingsService.setSetting as jest.Mock).mock.calls[0][1]
      );
      expect(savedConfig.lastPushSyncAt).toBeUndefined();
      expect(savedConfig.lastSyncStatus).toBe('error');
    });

    it('throws when no config found', async () => {
      mockSettingsService.getSetting.mockResolvedValue(null);
      await expect(service.pushAllLeads('user123', 'list123', 'hubspot')).rejects.toThrow('No sync configuration found');
    });
  });

  describe('pullAllContacts', () => {
    it('pulls contacts from HubSpot and creates leads', async () => {
      mockSettingsService.getSetting.mockResolvedValue({
        settingName: 'crm_sync_list123_hubspot',
        settingValue: JSON.stringify(baseConfig),
        updatedAt: '2026-01-01T00:00:00.000Z',
        updatedBy: 'user123',
      });

      mockHubSpotInstance.listContacts.mockResolvedValue({
        results: [{ id: 'hs1', properties: { email: 'a@test.com', firstname: 'A' } }],
        paging: undefined,
      });
      mockHubSpotInstance.getDealsByContactId.mockResolvedValue([]);

      (mockCrmDb.batchCreateLeads as jest.Mock).mockResolvedValue({
        successCount: 1,
        newCount: 1,
        mergedCount: 0,
        errorCount: 0,
        errors: [],
      });

      const result = await service.pullAllContacts('user123', 'list123', 'hubspot');
      expect(result.newCount).toBe(1);
      expect(result.errorCount).toBe(0);
      expect(mockCrmDb.batchCreateLeads).toHaveBeenCalledWith('list123', expect.any(Array));
    });

    it('includes deal data from associated deals', async () => {
      mockSettingsService.getSetting.mockResolvedValue({
        settingName: 'crm_sync_list123_hubspot',
        settingValue: JSON.stringify(baseConfig),
        updatedAt: '2026-01-01T00:00:00.000Z',
        updatedBy: 'user123',
      });

      mockHubSpotInstance.listContacts.mockResolvedValue({
        results: [{ id: 'hs1', properties: { email: 'a@test.com', firstname: 'A' } }],
        paging: undefined,
      });
      mockHubSpotInstance.getDealsByContactId.mockResolvedValue([
        { id: 'deal1', properties: { amount: '5000', deal_currency_code: 'USD', dealstage: 'won' } },
      ]);

      (mockCrmDb.batchCreateLeads as jest.Mock).mockResolvedValue({
        successCount: 1, newCount: 1, mergedCount: 0, errorCount: 0, errors: [],
      });

      await service.pullAllContacts('user123', 'list123', 'hubspot');

      const leads = (mockCrmDb.batchCreateLeads as jest.Mock).mock.calls[0][1];
      expect(leads[0].customFields.hubspot_deal_id).toBe('deal1');
    });
  });

  describe('autoSyncLead', () => {
    it('syncs lead when auto-sync is enabled', async () => {
      mockSettingsService.getSetting.mockResolvedValue({
        settingName: 'crm_sync_list123_hubspot',
        settingValue: JSON.stringify(baseConfig),
        updatedAt: '2026-01-01T00:00:00.000Z',
        updatedBy: 'user123',
      });

      mockHubSpotInstance.upsertContact.mockResolvedValue({ contact: { id: 'hs1' }, isNew: true });
      (mockCrmDb.updateLead as jest.Mock).mockResolvedValue({});

      await service.autoSyncLead('user123', 'list123', {
        leadId: 'lead1', listId: 'list123', email: 'test@example.com', firstName: 'Test',
      }, 'created');

      expect(mockHubSpotInstance.upsertContact).toHaveBeenCalled();
    });

    it('does nothing when auto-sync is disabled', async () => {
      mockSettingsService.getSetting.mockResolvedValue({
        settingName: 'crm_sync_list123_hubspot',
        settingValue: JSON.stringify({ ...baseConfig, autoSyncEnabled: false }),
        updatedAt: '2026-01-01T00:00:00.000Z',
        updatedBy: 'user123',
      });

      await service.autoSyncLead('user123', 'list123', {
        leadId: 'lead1', listId: 'list123', email: 'test@example.com',
      }, 'created');

      expect(mockHubSpotInstance.upsertContact).not.toHaveBeenCalled();
    });

    it('does nothing when no config exists', async () => {
      mockSettingsService.getSetting.mockResolvedValue(null);

      await service.autoSyncLead('user123', 'list123', {
        leadId: 'lead1', listId: 'list123', email: 'test@example.com',
      }, 'created');

      expect(mockHubSpotInstance.upsertContact).not.toHaveBeenCalled();
    });

    it('sends alert on failure and does not throw', async () => {
      mockSettingsService.getSetting.mockResolvedValue({
        settingName: 'crm_sync_list123_hubspot',
        settingValue: JSON.stringify(baseConfig),
        updatedAt: '2026-01-01T00:00:00.000Z',
        updatedBy: 'user123',
      });

      mockHubSpotInstance.upsertContact.mockRejectedValue(new Error('HubSpot error'));
      (mockCrmDb.getLeadListById as jest.Mock).mockResolvedValue({
        listId: 'list123',
        userId: 'user123',
        alertEvents: ['crm_sync.failed'],
      });

      // Should not throw
      await service.autoSyncLead('user123', 'list123', {
        leadId: 'lead1', listId: 'list123', email: 'test@example.com',
      }, 'created');

      expect(mockAlertService.notifyLeadListOwnerIfConfigured).toHaveBeenCalledWith(
        expect.objectContaining({ listId: 'list123' }),
        expect.objectContaining({ email: 'test@example.com' }),
        'crm_sync.failed',
        expect.objectContaining({ provider: 'hubspot', error: 'HubSpot error' }),
        expect.any(String)
      );
    });
  });
});
