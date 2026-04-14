import { ExternalCrmSyncService, ExternalCrmSyncConfig, FieldMapping } from '../services/externalCrmSyncService';

// ─── Mock dependencies ────────────────────────────────────────────────────────

jest.mock('../services/settingsService', () => ({
  settingsService: {
    getSetting: jest.fn(),
    setSetting: jest.fn(),
    deleteSetting: jest.fn(),
  },
}));

jest.mock('../services/db', () => ({
  crmDb: {
    getLeadListById: jest.fn(),
    getLeadsByListId: jest.fn(),
    updateLead: jest.fn(),
    batchCreateLeads: jest.fn(),
  },
}));

jest.mock('../utils/crypto', () => ({
  encryptPassword: jest.fn((pw: string) => `enc:${pw}`),
  decryptPassword: jest.fn((enc: string) => ({ password: enc.replace('enc:', ''), userId: 'user1' })),
}));

jest.mock('../services/hubspotService', () => ({
  hubspotService: {
    getValidAccessToken: jest.fn(),
  },
}));

jest.mock('../services/attioService', () => ({
  attioService: {
    getValidAccessToken: jest.fn(),
  },
}));

jest.mock('axios');
const axios = require('axios');

import { settingsService } from '../services/settingsService';
import { crmDb } from '../services/db';
import { hubspotService } from '../services/hubspotService';
import { attioService } from '../services/attioService';

const mockSettingsService = settingsService as jest.Mocked<typeof settingsService>;
const mockCrmDb = crmDb as jest.Mocked<typeof crmDb>;
const mockHubspotService = hubspotService as jest.Mocked<typeof hubspotService>;
const mockAttioService = attioService as jest.Mocked<typeof attioService>;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeConfig(overrides: Partial<ExternalCrmSyncConfig> = {}): ExternalCrmSyncConfig {
  return {
    provider: 'hubspot',
    listId: 'list1',
    userId: 'user1',
    accountId: 'acct1',
    autoSyncEnabled: false,
    contactFieldMapping: [
      { agentwebField: 'email', crmProperty: 'email', direction: 'both', enabled: true },
      { agentwebField: 'firstName', crmProperty: 'firstname', direction: 'both', enabled: true },
    ],
    dealFieldMapping: [
      { agentwebField: 'dealValue', crmProperty: 'amount', direction: 'both', enabled: true },
    ],
    customFieldMapping: [],
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
    ...overrides,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('ExternalCrmSyncService', () => {
  let service: ExternalCrmSyncService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new ExternalCrmSyncService();
  });

  // ─── getConfig ────────────────────────────────────────────────────────────

  describe('getConfig', () => {
    it('returns null when no setting exists', async () => {
      mockSettingsService.getSetting.mockResolvedValue(null);
      const result = await service.getConfig('user1', 'list1', 'hubspot');
      expect(result).toBeNull();
    });

    it('returns null when userId does not match', async () => {
      const config = makeConfig({ userId: 'other-user' });
      mockSettingsService.getSetting.mockResolvedValue({
        settingKey: 'ext_crm_sync_list1_hubspot',
        settingValue: JSON.stringify(config),
      } as any);
      const result = await service.getConfig('user1', 'list1', 'hubspot');
      expect(result).toBeNull();
    });

    it('returns parsed config when userId matches', async () => {
      const config = makeConfig();
      mockSettingsService.getSetting.mockResolvedValue({
        settingKey: 'ext_crm_sync_list1_hubspot',
        settingValue: JSON.stringify(config),
      } as any);
      const result = await service.getConfig('user1', 'list1', 'hubspot');
      expect(result).toMatchObject({ provider: 'hubspot', listId: 'list1', userId: 'user1' });
    });
  });

  // ─── saveConfig ───────────────────────────────────────────────────────────

  describe('saveConfig', () => {
    it('creates new config with encrypted API key when no existing config', async () => {
      mockSettingsService.getSetting.mockResolvedValue(null);
      mockSettingsService.setSetting.mockResolvedValue(undefined as any);

      await service.saveConfig('user1', 'list1', 'hubspot', { apiKey: 'my-token' });

      const call = mockSettingsService.setSetting.mock.calls[0];
      const saved = JSON.parse(call[1]);
      expect(saved.apiKeyEncrypted).toBe('enc:my-token');
      expect(saved.provider).toBe('hubspot');
      expect(saved.userId).toBe('user1');
    });

    it('preserves existing encrypted key when no new apiKey provided', async () => {
      const existing = makeConfig({ apiKeyEncrypted: 'enc:old-token' });
      mockSettingsService.getSetting.mockResolvedValue({
        settingValue: JSON.stringify(existing),
      } as any);
      mockSettingsService.setSetting.mockResolvedValue(undefined as any);

      await service.saveConfig('user1', 'list1', 'hubspot', { autoSyncEnabled: true });

      const call = mockSettingsService.setSetting.mock.calls[0];
      const saved = JSON.parse(call[1]);
      expect(saved.apiKeyEncrypted).toBe('enc:old-token');
      expect(saved.autoSyncEnabled).toBe(true);
    });

    it('stores accountId when provided (OAuth path)', async () => {
      mockSettingsService.getSetting.mockResolvedValue(null);
      mockSettingsService.setSetting.mockResolvedValue(undefined as any);

      await service.saveConfig('user1', 'list1', 'hubspot', { accountId: 'oauth-acct' });

      const call = mockSettingsService.setSetting.mock.calls[0];
      const saved = JSON.parse(call[1]);
      expect(saved.accountId).toBe('oauth-acct');
      expect(saved.apiKeyEncrypted).toBeUndefined();
    });

    it('saves custom field mapping', async () => {
      mockSettingsService.getSetting.mockResolvedValue(null);
      mockSettingsService.setSetting.mockResolvedValue(undefined as any);

      const customMapping: FieldMapping[] = [
        { agentwebField: 'source', crmProperty: 'lead_source', direction: 'push', enabled: true },
      ];
      await service.saveConfig('user1', 'list1', 'hubspot', { customFieldMapping: customMapping });

      const call = mockSettingsService.setSetting.mock.calls[0];
      const saved = JSON.parse(call[1]);
      expect(saved.customFieldMapping).toEqual(customMapping);
    });
  });

  // ─── deleteConfig ─────────────────────────────────────────────────────────

  describe('deleteConfig', () => {
    it('does nothing when no config exists', async () => {
      mockSettingsService.getSetting.mockResolvedValue(null);
      await service.deleteConfig('user1', 'list1', 'hubspot');
      expect(mockSettingsService.deleteSetting).not.toHaveBeenCalled();
    });

    it('deletes setting when config exists', async () => {
      mockSettingsService.getSetting.mockResolvedValue({
        settingValue: JSON.stringify(makeConfig()),
      } as any);
      mockSettingsService.deleteSetting.mockResolvedValue(undefined as any);

      await service.deleteConfig('user1', 'list1', 'hubspot');
      expect(mockSettingsService.deleteSetting).toHaveBeenCalledWith('ext_crm_sync_list1_hubspot');
    });
  });

  // ─── testConnection ───────────────────────────────────────────────────────

  describe('testConnection', () => {
    it('returns error when no config found', async () => {
      mockSettingsService.getSetting.mockResolvedValue(null);
      const result = await service.testConnection('user1', 'list1', 'hubspot');
      expect(result.valid).toBe(false);
      expect(result.error).toMatch(/no.*config/i);
    });

    it('returns error when config has no token or accountId', async () => {
      const config = makeConfig({ accountId: undefined, apiKeyEncrypted: undefined });
      mockSettingsService.getSetting.mockResolvedValue({
        settingValue: JSON.stringify(config),
      } as any);
      const result = await service.testConnection('user1', 'list1', 'hubspot');
      expect(result.valid).toBe(false);
    });

    it('returns valid=true on successful HubSpot API call (OAuth)', async () => {
      mockSettingsService.getSetting.mockResolvedValue({
        settingValue: JSON.stringify(makeConfig({ accountId: 'acct1' })),
      } as any);
      mockHubspotService.getValidAccessToken.mockResolvedValue('hs-token');
      axios.create.mockReturnValue({
        get: jest.fn().mockResolvedValue({ data: { results: [] } }),
      });

      const result = await service.testConnection('user1', 'list1', 'hubspot');
      expect(result.valid).toBe(true);
    });

    it('returns valid=false when HubSpot API call fails', async () => {
      mockSettingsService.getSetting.mockResolvedValue({
        settingValue: JSON.stringify(makeConfig({ accountId: 'acct1' })),
      } as any);
      mockHubspotService.getValidAccessToken.mockResolvedValue('hs-token');
      axios.create.mockReturnValue({
        get: jest.fn().mockRejectedValue({ response: { data: { message: 'Unauthorized' } } }),
      });

      const result = await service.testConnection('user1', 'list1', 'hubspot');
      expect(result.valid).toBe(false);
      expect(result.error).toBe('Unauthorized');
    });

    it('returns valid=true on successful Attio API call (manual token)', async () => {
      const config = makeConfig({ provider: 'attio', accountId: undefined, apiKeyEncrypted: 'enc:attio-token' });
      mockSettingsService.getSetting.mockResolvedValue({
        settingValue: JSON.stringify(config),
      } as any);
      axios.create.mockReturnValue({
        get: jest.fn().mockResolvedValue({ data: { data: [] } }),
      });

      const result = await service.testConnection('user1', 'list1', 'attio');
      expect(result.valid).toBe(true);
    });
  });

  // ─── getDistinctCustomFieldKeys ───────────────────────────────────────────

  describe('getDistinctCustomFieldKeys', () => {
    it('returns empty array when list has no leads', async () => {
      mockCrmDb.getLeadsByListId.mockResolvedValue({ items: [], lastEvaluatedKey: null, hasMore: false });
      const result = await service.getDistinctCustomFieldKeys('list1');
      expect(result).toEqual([]);
    });

    it('returns sorted unique keys across all leads', async () => {
      mockCrmDb.getLeadsByListId.mockResolvedValueOnce({
        items: [
          { leadId: 'l1', customFields: { source: 'web', userId: 'u1', chatCount: 5 } },
          { leadId: 'l2', customFields: { source: 'api', subscriptionType: 'pro' } },
        ],
        lastEvaluatedKey: null,
        hasMore: false,
      });
      const result = await service.getDistinctCustomFieldKeys('list1');
      expect(result).toEqual(['chatCount', 'source', 'subscriptionType', 'userId']);
    });

    it('paginates through all pages', async () => {
      mockCrmDb.getLeadsByListId
        .mockResolvedValueOnce({
          items: [{ leadId: 'l1', customFields: { source: 'web' } }],
          lastEvaluatedKey: { pk: 'page2' },
          hasMore: true,
        })
        .mockResolvedValueOnce({
          items: [{ leadId: 'l2', customFields: { userId: 'u1' } }],
          lastEvaluatedKey: null,
          hasMore: false,
        });

      const result = await service.getDistinctCustomFieldKeys('list1');
      expect(result).toEqual(['source', 'userId']);
    });

    it('ignores null and empty string values', async () => {
      mockCrmDb.getLeadsByListId.mockResolvedValue({
        items: [{ leadId: 'l1', customFields: { source: 'web', emptyField: '', nullField: null } }],
        lastEvaluatedKey: null,
        hasMore: false,
      });
      const result = await service.getDistinctCustomFieldKeys('list1');
      expect(result).toEqual(['source']);
    });
  });

  // ─── pushAllLeads (HubSpot) ───────────────────────────────────────────────

  describe('pushAllLeads - HubSpot', () => {
    it('throws when no config found', async () => {
      mockSettingsService.getSetting.mockResolvedValue(null);
      await expect(service.pushAllLeads('user1', 'list1', 'hubspot'))
        .rejects.toThrow(/no.*config/i);
    });

    it('throws when no token or accountId configured', async () => {
      const config = makeConfig({ accountId: undefined, apiKeyEncrypted: undefined });
      mockSettingsService.getSetting.mockResolvedValue({ settingValue: JSON.stringify(config) } as any);
      await expect(service.pushAllLeads('user1', 'list1', 'hubspot'))
        .rejects.toThrow(/no.*auth/i);
    });

    it('returns success result with zero errors for empty lead list', async () => {
      mockSettingsService.getSetting.mockResolvedValue({
        settingValue: JSON.stringify(makeConfig()),
      } as any);
      mockHubspotService.getValidAccessToken.mockResolvedValue('token');
      mockCrmDb.getLeadsByListId.mockResolvedValue({ items: [], lastEvaluatedKey: null, hasMore: false });
      mockSettingsService.setSetting.mockResolvedValue(undefined as any);

      const result = await service.pushAllLeads('user1', 'list1', 'hubspot');
      expect(result.errorCount).toBe(0);
      expect(result.successCount).toBe(0);
    });

    it('skips leads without email when pushing to HubSpot (no upsert possible)', async () => {
      const config = makeConfig();
      mockSettingsService.getSetting.mockResolvedValue({ settingValue: JSON.stringify(config) } as any);
      mockHubspotService.getValidAccessToken.mockResolvedValue('token');
      mockCrmDb.getLeadsByListId.mockResolvedValue({
        items: [{ leadId: 'l1', firstName: 'John' }], // no email
        lastEvaluatedKey: null,
        hasMore: false,
      });
      mockSettingsService.setSetting.mockResolvedValue(undefined as any);

      const mockClient = { post: jest.fn(), patch: jest.fn(), get: jest.fn(), put: jest.fn() };
      axios.create.mockReturnValue(mockClient);

      const result = await service.pushAllLeads('user1', 'list1', 'hubspot');
      expect(result.successCount).toBe(0);
      expect(mockClient.post).not.toHaveBeenCalled();
    });

    it('only syncs enabled field mappings', async () => {
      const config = makeConfig({
        contactFieldMapping: [
          { agentwebField: 'email', crmProperty: 'email', direction: 'both', enabled: true },
          { agentwebField: 'phone', crmProperty: 'phone', direction: 'both', enabled: false },
        ],
        dealFieldMapping: [],
        customFieldMapping: [],
      });
      mockSettingsService.getSetting.mockResolvedValue({ settingValue: JSON.stringify(config) } as any);
      mockHubspotService.getValidAccessToken.mockResolvedValue('token');
      mockCrmDb.getLeadsByListId.mockResolvedValue({
        items: [{ leadId: 'l1', email: 'test@test.com', phone: '1234' }],
        lastEvaluatedKey: null,
        hasMore: false,
      });
      mockSettingsService.setSetting.mockResolvedValue(undefined as any);
      mockCrmDb.updateLead.mockResolvedValue(undefined as any);

      const mockClient = {
        post: jest.fn()
          .mockResolvedValueOnce({ data: { results: [] } })  // search contact
          .mockResolvedValueOnce({ data: { id: 'c1', properties: {} } }), // create contact
        patch: jest.fn(),
        get: jest.fn(),
        put: jest.fn(),
      };
      axios.create.mockReturnValue(mockClient);

      await service.pushAllLeads('user1', 'list1', 'hubspot');

      // The contact create call should NOT include phone
      const createCall = mockClient.post.mock.calls.find(c => c[0].includes('/contacts') && !c[0].includes('search'));
      if (createCall) {
        expect(createCall[1].properties.phone).toBeUndefined();
      }
    });

    it('only syncs enabled custom field mappings', async () => {
      const config = makeConfig({
        customFieldMapping: [
          { agentwebField: 'source', crmProperty: 'lead_source', direction: 'push', enabled: true },
          { agentwebField: 'userId', crmProperty: 'aw_user_id', direction: 'push', enabled: false },
        ],
      });
      mockSettingsService.getSetting.mockResolvedValue({ settingValue: JSON.stringify(config) } as any);
      mockHubspotService.getValidAccessToken.mockResolvedValue('token');
      mockCrmDb.getLeadsByListId.mockResolvedValue({
        items: [{ leadId: 'l1', email: 'test@test.com', customFields: { source: 'web', userId: 'u1' } }],
        lastEvaluatedKey: null,
        hasMore: false,
      });
      mockSettingsService.setSetting.mockResolvedValue(undefined as any);
      mockCrmDb.updateLead.mockResolvedValue(undefined as any);

      const mockClient = {
        post: jest.fn()
          .mockResolvedValueOnce({ data: { results: [] } })  // search
          .mockResolvedValueOnce({ data: { id: 'c1', properties: {} } }), // create
        patch: jest.fn(),
        get: jest.fn(),
        put: jest.fn(),
      };
      axios.create.mockReturnValue(mockClient);

      await service.pushAllLeads('user1', 'list1', 'hubspot');

      const createCall = mockClient.post.mock.calls.find(c => c[0].includes('/contacts') && !c[0].includes('search'));
      if (createCall) {
        expect(createCall[1].properties.lead_source).toBe('web');
        expect(createCall[1].properties.aw_user_id).toBeUndefined();
      }
    });
  });

  // ─── pushAllLeads (Attio) ─────────────────────────────────────────────────

  describe('pushAllLeads - Attio', () => {
    it('throws when no config found for attio', async () => {
      mockSettingsService.getSetting.mockResolvedValue(null);
      await expect(service.pushAllLeads('user1', 'list1', 'attio'))
        .rejects.toThrow(/no.*config/i);
    });

    it('returns success result with zero errors for empty lead list (Attio)', async () => {
      const config = makeConfig({ provider: 'attio', accountId: 'attio-acct' });
      mockSettingsService.getSetting.mockResolvedValue({ settingValue: JSON.stringify(config) } as any);
      mockAttioService.getValidAccessToken.mockResolvedValue('attio-token');
      mockCrmDb.getLeadsByListId.mockResolvedValue({ items: [], lastEvaluatedKey: null, hasMore: false });
      mockSettingsService.setSetting.mockResolvedValue(undefined as any);

      const result = await service.pushAllLeads('user1', 'list1', 'attio');
      expect(result.errorCount).toBe(0);
      expect(result.successCount).toBe(0);
    });
  });

  // ─── autoSyncLead ─────────────────────────────────────────────────────────

  describe('autoSyncLead', () => {
    it('does nothing when auto-sync is disabled', async () => {
      const config = makeConfig({ autoSyncEnabled: false });
      mockSettingsService.getSetting.mockResolvedValue({ settingValue: JSON.stringify(config) } as any);

      await service.autoSyncLead('user1', 'list1', { leadId: 'l1', email: 'a@b.com' }, 'hubspot', 'created');

      expect(mockHubspotService.getValidAccessToken).not.toHaveBeenCalled();
    });

    it('does nothing when no config exists', async () => {
      mockSettingsService.getSetting.mockResolvedValue(null);

      await service.autoSyncLead('user1', 'list1', { leadId: 'l1', email: 'a@b.com' }, 'hubspot', 'created');

      expect(mockHubspotService.getValidAccessToken).not.toHaveBeenCalled();
    });

    it('does not throw on sync failure (fire-and-forget)', async () => {
      const config = makeConfig({ autoSyncEnabled: true });
      mockSettingsService.getSetting.mockResolvedValue({ settingValue: JSON.stringify(config) } as any);
      mockHubspotService.getValidAccessToken.mockRejectedValue(new Error('token error'));

      await expect(
        service.autoSyncLead('user1', 'list1', { leadId: 'l1', email: 'a@b.com' }, 'hubspot', 'created')
      ).resolves.not.toThrow();
    });
  });
});
