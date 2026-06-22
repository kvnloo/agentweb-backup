import { ExternalCrmSyncService, ExternalCrmSyncConfig, FieldMapping } from '../services/externalCrmSyncService';

// ─── Mock dependencies ────────────────────────────────────────────────────────

jest.mock('../services/db', () => ({
  crmDb: {
    getLeadListById: jest.fn(),
    getLeadsByListId: jest.fn(),
    updateLead: jest.fn(),
    batchCreateLeads: jest.fn(),
    setLeadListCrmSyncConfig: jest.fn().mockResolvedValue(undefined),
  },
  userDb: {
    // Default: users have no org, so only the config owner can access it.
    getUserById: jest.fn().mockResolvedValue(null),
  },
}));

jest.mock('../utils/crypto', () => ({
  encryptPassword: jest.fn((pw: string) => `enc:${pw}`),
  decryptPassword: jest.fn((enc: string) => ({ password: enc.replace('enc:', ''), userId: 'user1' })),
}));

const mockHubSpotServiceInstance = {
  testConnection: jest.fn().mockResolvedValue({ valid: true }),
  ensureContactProperty: jest.fn().mockResolvedValue('aw_notes'),
  ensureDealProperty: jest.fn().mockResolvedValue('amount'),
  upsertContact: jest.fn().mockResolvedValue({ contactId: 'c1', isNew: true }),
  createContact: jest.fn().mockResolvedValue({ contactId: 'c1' }),
  updateContact: jest.fn().mockResolvedValue({ contactId: 'c1' }),
  createDeal: jest.fn().mockResolvedValue('d1'),
  updateDeal: jest.fn().mockResolvedValue(undefined),
  associateContactToDeal: jest.fn().mockResolvedValue(undefined),
  listContactsPage: jest.fn().mockResolvedValue({ results: [], nextCursor: undefined }),
  getContactDealAssociations: jest.fn().mockResolvedValue([]),
  getDeal: jest.fn().mockResolvedValue(null),
  getDealPipelineStages: jest.fn().mockResolvedValue([]),
  createDealStage: jest.fn().mockResolvedValue({ id: 'stage_1', label: 'Stage 1', displayOrder: 0, metadata: { probability: 0.1 } }),
  listDealPipelines: jest.fn().mockResolvedValue([]),
  listContactProperties: jest.fn().mockResolvedValue([]),
  listDealProperties: jest.fn().mockResolvedValue([]),
  deleteContact: jest.fn().mockResolvedValue(undefined),
  deleteDeal: jest.fn().mockResolvedValue(undefined),
};

const mockAttioServiceInstance = {
  testConnection: jest.fn().mockResolvedValue({ valid: true }),
  loadAttributeTypes: jest.fn().mockResolvedValue(new Map()),
  ensureListAttribute: jest.fn().mockResolvedValue('slug'),
  upsertPersonByValues: jest.fn().mockResolvedValue({ recordId: 'p1', isNew: true }),
  createPersonByValues: jest.fn().mockResolvedValue('p1'),
  updatePersonByValues: jest.fn().mockResolvedValue(undefined),
  getPersonValues: jest.fn().mockResolvedValue({}),
  findListEntry: jest.fn().mockResolvedValue('e1'),
  updateListEntry: jest.fn().mockResolvedValue(undefined),
  addPersonToList: jest.fn().mockResolvedValue(undefined),
  listListEntries: jest.fn().mockResolvedValue({ entries: [], nextCursor: undefined }),
  findCompanyByName: jest.fn().mockResolvedValue({ recordId: 'comp_123', name: 'Test Corp' }),
  createCompany: jest.fn().mockResolvedValue({ recordId: 'comp_123', name: 'Test Corp' }),
  getCompanyById: jest.fn().mockResolvedValue({ recordId: 'comp_123', name: 'Test Corp' }),
  getAllPeopleAttributes: jest.fn().mockResolvedValue([]),
  listListAttributes: jest.fn().mockResolvedValue([]),
  deletePerson: jest.fn().mockResolvedValue(undefined),
};

jest.mock('../services/hubspotService', () => ({
  HubSpotService: {
    create: jest.fn(),
    fromToken: jest.fn(),
  },
}));

jest.mock('../services/attioService', () => ({
  AttioService: {
    create: jest.fn(),
    fromToken: jest.fn(),
  },
}));

jest.mock('axios');
const axios = require('axios');

import { crmDb } from '../services/db';
import { HubSpotService } from '../services/hubspotService';
import { AttioService } from '../services/attioService';

const mockCrmDb = crmDb as jest.Mocked<typeof crmDb>;
const mockHubSpotCreate = HubSpotService.create as jest.Mock;
const mockHubSpotFromToken = HubSpotService.fromToken as jest.Mock;
const mockAttioCreate = AttioService.create as jest.Mock;
const mockAttioFromToken = AttioService.fromToken as jest.Mock;

/**
 * Helper: configure crmDb.getLeadListById to return a list with
 * externalCrmSyncConfigs[provider] = config (or null if config is null).
 */
function mockListWithConfig(config: ExternalCrmSyncConfig | null, provider = 'hubspot', extraListFields: Record<string, any> = {}) {
  const externalCrmSyncConfigs = config ? { [provider]: config } : {};
  mockCrmDb.getLeadListById.mockResolvedValue({
    listId: 'list1',
    userId: 'user1',
    name: 'Test List',
    externalCrmSyncConfigs,
    ...extraListFields,
  } as any);
}

function mockNoConfig() {
  mockCrmDb.getLeadListById.mockResolvedValue({
    listId: 'list1',
    userId: 'user1',
    name: 'Test List',
    externalCrmSyncConfigs: {},
  } as any);
}

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

// Batch push is ON by default; these service tests assert on the per-lead path,
// so pin the kill switch off for the whole file.
beforeAll(() => { process.env.HUBSPOT_BATCH_PUSH_ENABLED = 'false'; });
afterAll(() => { delete process.env.HUBSPOT_BATCH_PUSH_ENABLED; });

describe('ExternalCrmSyncService', () => {
  let service: ExternalCrmSyncService;

  beforeEach(() => {
    jest.clearAllMocks();
    mockHubSpotCreate.mockResolvedValue(mockHubSpotServiceInstance);
    mockHubSpotFromToken.mockReturnValue(mockHubSpotServiceInstance);
    mockAttioCreate.mockResolvedValue(mockAttioServiceInstance);
    mockAttioFromToken.mockReturnValue(mockAttioServiceInstance);
    mockHubSpotServiceInstance.testConnection.mockResolvedValue({ valid: true });
    mockHubSpotServiceInstance.ensureContactProperty.mockResolvedValue('aw_notes');
    mockHubSpotServiceInstance.ensureDealProperty.mockResolvedValue('amount');
    mockHubSpotServiceInstance.upsertContact.mockResolvedValue({ contactId: 'c1', isNew: true });
    mockHubSpotServiceInstance.createContact.mockResolvedValue({ contactId: 'c1' });
    mockHubSpotServiceInstance.updateContact.mockResolvedValue({ contactId: 'c1' });
    mockHubSpotServiceInstance.createDeal.mockResolvedValue('d1');
    mockHubSpotServiceInstance.updateDeal.mockResolvedValue(undefined);
    mockHubSpotServiceInstance.associateContactToDeal.mockResolvedValue(undefined);
    mockHubSpotServiceInstance.listContactsPage.mockResolvedValue({ results: [], nextCursor: undefined });
    mockHubSpotServiceInstance.getContactDealAssociations.mockResolvedValue([]);
    mockHubSpotServiceInstance.getDeal.mockResolvedValue(null);
    mockHubSpotServiceInstance.getDealPipelineStages.mockResolvedValue([]);
    mockHubSpotServiceInstance.createDealStage.mockResolvedValue({ id: 'stage_1', label: 'Stage 1', displayOrder: 0, metadata: { probability: 0.1 } });
    mockHubSpotServiceInstance.listDealPipelines.mockResolvedValue([]);
    mockCrmDb.setLeadListCrmSyncConfig.mockResolvedValue(undefined as any);
    service = new ExternalCrmSyncService();
  });

  // ─── saveConfig — reconnect pipeline validation ────────────────────────────
  describe('saveConfig reconnect pipeline validation', () => {
    it('clears a stale pipeline + stage map + sync timestamps when reconnecting a DIFFERENT account', async () => {
      // Disconnected config (accountId cleared) that still carries the old account's
      // pipeline/stage/sync state; the new account does NOT contain that pipeline.
      mockListWithConfig(makeConfig({
        accountId: undefined,
        externalPipelineId: 'old_pipe',
        hubspotDealStageMap: { lead: 'old_stage' },
        lastPushSyncAt: '2024-02-01T00:00:00.000Z',
      }));
      mockHubSpotServiceInstance.listDealPipelines.mockResolvedValue([
        { id: 'different_pipe', label: 'Other', displayOrder: 0, stages: [] },
      ]);

      await service.saveConfig('user1', 'list1', 'hubspot', { accountId: 'new_acct' });

      const persisted = mockCrmDb.setLeadListCrmSyncConfig.mock.calls[0][2] as ExternalCrmSyncConfig;
      expect(persisted.externalPipelineId).toBeUndefined();
      expect(persisted.hubspotDealStageMap).toBeUndefined();
      expect(persisted.lastPushSyncAt).toBeUndefined();
      // Field mappings are account-agnostic and must be preserved.
      expect(persisted.contactFieldMapping.length).toBeGreaterThan(0);
    });

    it('keeps the pipeline when reconnecting the SAME account (pipeline still exists)', async () => {
      mockListWithConfig(makeConfig({
        accountId: undefined,
        externalPipelineId: 'keep_pipe',
        hubspotDealStageMap: { lead: 'stage_1' },
        lastPushSyncAt: '2024-02-01T00:00:00.000Z',
      }));
      mockHubSpotServiceInstance.listDealPipelines.mockResolvedValue([
        { id: 'keep_pipe', label: 'Sales', displayOrder: 0, stages: [] },
      ]);

      await service.saveConfig('user1', 'list1', 'hubspot', { accountId: 'same_acct' });

      const persisted = mockCrmDb.setLeadListCrmSyncConfig.mock.calls[0][2] as ExternalCrmSyncConfig;
      expect(persisted.externalPipelineId).toBe('keep_pipe');
      expect(persisted.lastPushSyncAt).toBe('2024-02-01T00:00:00.000Z');
    });

    it('does not destroy pipeline state if HubSpot validation fails (transient error)', async () => {
      mockListWithConfig(makeConfig({
        accountId: undefined,
        externalPipelineId: 'old_pipe',
        lastPushSyncAt: '2024-02-01T00:00:00.000Z',
      }));
      mockHubSpotServiceInstance.listDealPipelines.mockRejectedValue(new Error('HubSpot down'));

      await service.saveConfig('user1', 'list1', 'hubspot', { accountId: 'new_acct' });

      const persisted = mockCrmDb.setLeadListCrmSyncConfig.mock.calls[0][2] as ExternalCrmSyncConfig;
      expect(persisted.externalPipelineId).toBe('old_pipe');
    });
  });

  // ─── changePipeline ───────────────────────────────────────────────────────
  describe('changePipeline', () => {
    it('throws for a non-hubspot provider', async () => {
      mockListWithConfig(makeConfig({ provider: 'attio' as any }), 'attio');
      await expect(service.changePipeline('user1', 'list1', 'attio', 'p1')).rejects.toThrow(/hubspot/i);
    });

    it('throws when no sync configuration exists', async () => {
      mockNoConfig();
      await expect(service.changePipeline('user1', 'list1', 'hubspot', 'p1')).rejects.toThrow(/configuration/i);
    });

    it('throws when the target pipeline does not exist in HubSpot', async () => {
      mockListWithConfig(makeConfig({ lastPushSyncAt: '2024-02-01T00:00:00.000Z', externalPipelineId: 'old' }));
      mockHubSpotServiceInstance.listDealPipelines.mockResolvedValue([{ id: '123', label: 'Sales', displayOrder: 0, stages: [] }]);
      await expect(service.changePipeline('user1', 'list1', 'hubspot', '999')).rejects.toThrow(/not found/i);
    });

    it('updates externalPipelineId and clears the stage map even after a sync (lock bypass)', async () => {
      mockListWithConfig(makeConfig({
        lastPushSyncAt: '2024-02-01T00:00:00.000Z',
        externalPipelineId: 'old',
        hubspotDealStageMap: { lead: 'old_stage_1' },
      }));
      mockHubSpotServiceInstance.listDealPipelines.mockResolvedValue([
        { id: 'new123', label: 'Partnerships', displayOrder: 0, stages: [] },
      ]);

      const result = await service.changePipeline('user1', 'list1', 'hubspot', 'new123');

      expect(mockCrmDb.setLeadListCrmSyncConfig).toHaveBeenCalledTimes(1);
      const persisted = mockCrmDb.setLeadListCrmSyncConfig.mock.calls[0][2] as ExternalCrmSyncConfig;
      expect(persisted.externalPipelineId).toBe('new123');
      expect(persisted.hubspotDealStageMap).toBeUndefined();
      expect(result.externalPipelineId).toBe('new123');
    });
  });

  // ─── getConfig ────────────────────────────────────────────────────────────

  describe('getConfig', () => {
    it('returns null when list does not exist', async () => {
      mockCrmDb.getLeadListById.mockResolvedValue(null);
      const result = await service.getConfig('user1', 'list1', 'hubspot');
      expect(result).toBeNull();
    });

    it('returns null when no config for provider', async () => {
      mockNoConfig();
      const result = await service.getConfig('user1', 'list1', 'hubspot');
      expect(result).toBeNull();
    });

    it('returns null when userId does not match', async () => {
      const config = makeConfig({ userId: 'other-user' });
      mockListWithConfig(config);
      const result = await service.getConfig('user1', 'list1', 'hubspot');
      expect(result).toBeNull();
    });

    it('returns config when userId matches', async () => {
      const config = makeConfig();
      mockListWithConfig(config);
      const result = await service.getConfig('user1', 'list1', 'hubspot');
      expect(result).toMatchObject({ provider: 'hubspot', listId: 'list1', userId: 'user1' });
    });

    it('returns config for an org member when the config owner is in the same org', async () => {
      const { userDb } = require('../services/db');
      userDb.getUserById.mockImplementation((id: string) =>
        Promise.resolve(id === 'other-user' ? { userId: 'other-user', orgId: 'org-A' } : { userId: 'user1', orgId: 'org-A' })
      );
      const config = makeConfig({ userId: 'other-user' });
      mockListWithConfig(config);
      const result = await service.getConfig('user1', 'list1', 'hubspot');
      expect(result).toMatchObject({ userId: 'other-user' });
    });

    it('returns null when the requester and config owner are in different orgs', async () => {
      const { userDb } = require('../services/db');
      userDb.getUserById.mockImplementation((id: string) =>
        Promise.resolve(id === 'other-user' ? { userId: 'other-user', orgId: 'org-B' } : { userId: 'user1', orgId: 'org-A' })
      );
      const config = makeConfig({ userId: 'other-user' });
      mockListWithConfig(config);
      const result = await service.getConfig('user1', 'list1', 'hubspot');
      expect(result).toBeNull();
    });

  });

  // ─── ensureWebhookSecret ──────────────────────────────────────────────────

  describe('ensureWebhookSecret', () => {
    it('generates a webhookSecret, sets it on the config in-place, and persists it', async () => {
      const config = makeConfig();
      delete (config as any).webhookSecret;
      mockCrmDb.setLeadListCrmSyncConfig.mockResolvedValue(undefined as any);

      await service.ensureWebhookSecret('user1', 'list1', 'hubspot', config);

      expect(config.webhookSecret).toBeDefined();
      expect(typeof config.webhookSecret).toBe('string');
      expect(config.webhookSecret!.length).toBeGreaterThan(0);

      expect(mockCrmDb.setLeadListCrmSyncConfig).toHaveBeenCalledWith(
        'list1',
        'hubspot',
        expect.objectContaining({ webhookSecret: config.webhookSecret })
      );
    });
  });

  // ─── saveConfig ───────────────────────────────────────────────────────────

  describe('saveConfig', () => {
    it('creates new config with encrypted API key when no existing config', async () => {
      mockNoConfig();
      mockCrmDb.setLeadListCrmSyncConfig.mockResolvedValue(undefined as any);

      await service.saveConfig('user1', 'list1', 'hubspot', { apiKey: 'my-token' });

      const call = mockCrmDb.setLeadListCrmSyncConfig.mock.calls[0];
      const saved = call[2] as Record<string, any>;
      expect(saved.apiKeyEncrypted).toBe('enc:my-token');
      expect(saved.provider).toBe('hubspot');
      expect(saved.userId).toBe('user1');
    });

    it('preserves existing encrypted key when no new apiKey provided', async () => {
      const existing = makeConfig({ apiKeyEncrypted: 'enc:old-token' });
      mockListWithConfig(existing);
      mockCrmDb.setLeadListCrmSyncConfig.mockResolvedValue(undefined as any);

      await service.saveConfig('user1', 'list1', 'hubspot', { autoSyncEnabled: true });

      const call = mockCrmDb.setLeadListCrmSyncConfig.mock.calls[0];
      const saved = call[2] as Record<string, any>;
      expect(saved.apiKeyEncrypted).toBe('enc:old-token');
      expect(saved.autoSyncEnabled).toBe(true);
    });

    it('defaults autoSyncEnabled to true for a brand-new config', async () => {
      // A user who sets up a sync expects new/edited leads to flow automatically.
      // The DB default must match the UI toggle (which defaults ON), otherwise a
      // partial save (e.g. from Test Connection) silently disables auto-sync.
      mockNoConfig();
      mockCrmDb.setLeadListCrmSyncConfig.mockResolvedValue(undefined as any);

      await service.saveConfig('user1', 'list1', 'hubspot', { apiKey: 'my-token' });

      const call = mockCrmDb.setLeadListCrmSyncConfig.mock.calls[0];
      const saved = call[2] as Record<string, any>;
      expect(saved.autoSyncEnabled).toBe(true);
    });

    it('honours an explicit autoSyncEnabled=false on a new config', async () => {
      mockNoConfig();
      mockCrmDb.setLeadListCrmSyncConfig.mockResolvedValue(undefined as any);

      await service.saveConfig('user1', 'list1', 'hubspot', { apiKey: 'my-token', autoSyncEnabled: false });

      const call = mockCrmDb.setLeadListCrmSyncConfig.mock.calls[0];
      const saved = call[2] as Record<string, any>;
      expect(saved.autoSyncEnabled).toBe(false);
    });

    it('preserves an existing autoSyncEnabled=false across a partial save', async () => {
      // Test Connection persists a partial config with no autoSyncEnabled — it must
      // not flip an existing explicit choice back to the default.
      const existing = makeConfig({ autoSyncEnabled: false, apiKeyEncrypted: 'enc:old' });
      mockListWithConfig(existing);
      mockCrmDb.setLeadListCrmSyncConfig.mockResolvedValue(undefined as any);

      await service.saveConfig('user1', 'list1', 'hubspot', { apiKey: 'new-token' });

      const call = mockCrmDb.setLeadListCrmSyncConfig.mock.calls[0];
      const saved = call[2] as Record<string, any>;
      expect(saved.autoSyncEnabled).toBe(false);
    });

    it('stores accountId when provided (OAuth path)', async () => {
      mockNoConfig();
      mockCrmDb.setLeadListCrmSyncConfig.mockResolvedValue(undefined as any);

      await service.saveConfig('user1', 'list1', 'hubspot', { accountId: 'oauth-acct' });

      const call = mockCrmDb.setLeadListCrmSyncConfig.mock.calls[0];
      const saved = call[2] as Record<string, any>;
      expect(saved.accountId).toBe('oauth-acct');
      expect(saved.apiKeyEncrypted).toBeUndefined();
    });

    it('saves custom field mapping', async () => {
      mockNoConfig();
      mockCrmDb.setLeadListCrmSyncConfig.mockResolvedValue(undefined as any);

      const customMapping: FieldMapping[] = [
        { agentwebField: 'source', crmProperty: 'lead_source', direction: 'push', enabled: true },
      ];
      await service.saveConfig('user1', 'list1', 'hubspot', { customFieldMapping: customMapping });

      const call = mockCrmDb.setLeadListCrmSyncConfig.mock.calls[0];
      const saved = call[2] as Record<string, any>;
      expect(saved.customFieldMapping).toEqual(customMapping);
    });

    it('merges Attio deal mappings into custom mappings', async () => {
      mockNoConfig();
      mockCrmDb.setLeadListCrmSyncConfig.mockResolvedValue(undefined as any);

      await service.saveConfig('user1', 'list1', 'attio', {
        dealFieldMapping: [
          { agentwebField: 'status', crmProperty: 'deal_status', direction: 'both', enabled: true },
        ],
        customFieldMapping: [
          { agentwebField: 'company', crmProperty: 'company_name', direction: 'push', enabled: true },
        ],
      });

      const call = mockCrmDb.setLeadListCrmSyncConfig.mock.calls[0];
      const saved = call[2] as Record<string, any>;
      expect(saved.dealFieldMapping).toEqual([]);
      expect(saved.customFieldMapping).toEqual(expect.arrayContaining([
        expect.objectContaining({ agentwebField: 'status', crmProperty: 'deal_status' }),
        expect.objectContaining({ agentwebField: 'company', crmProperty: 'company_name' }),
      ]));
    });

    it('keeps the pipeline ID locked after first sync', async () => {
      const existing = makeConfig({
        provider: 'hubspot',
        listName: 'Locked Pipeline',
        externalPipelineId: 'pipeline-123',
        lastPushSyncAt: '2024-02-01T00:00:00.000Z',
      });
      mockListWithConfig(existing);
      mockCrmDb.setLeadListCrmSyncConfig.mockResolvedValue(undefined as any);

      await service.saveConfig('user1', 'list1', 'hubspot', {
        externalPipelineId: 'pipeline-999',
        listName: 'Renamed Pipeline',
      });

      const call = mockCrmDb.setLeadListCrmSyncConfig.mock.calls[0];
      const saved = call[2] as Record<string, any>;
      expect(saved.externalPipelineId).toBe('pipeline-123');
      expect(saved.listName).toBe('Locked Pipeline');
    });
  });

  // ─── deleteConfig ─────────────────────────────────────────────────────────

  describe('deleteConfig', () => {
    it('does nothing when no config exists', async () => {
      mockNoConfig();
      await service.deleteConfig('user1', 'list1', 'hubspot');
      expect(mockCrmDb.setLeadListCrmSyncConfig).not.toHaveBeenCalled();
    });

    it('calls setLeadListCrmSyncConfig with null when config exists', async () => {
      mockListWithConfig(makeConfig());
      mockCrmDb.setLeadListCrmSyncConfig.mockResolvedValue(undefined as any);

      await service.deleteConfig('user1', 'list1', 'hubspot');
      expect(mockCrmDb.setLeadListCrmSyncConfig).toHaveBeenCalledWith('list1', 'hubspot', null);
    });
  });

  // ─── disconnectAccount ────────────────────────────────────────────────────

  describe('disconnectAccount', () => {
    it('does nothing when no config exists', async () => {
      mockNoConfig();
      await service.disconnectAccount('user1', 'list1', 'hubspot');
      expect(mockCrmDb.setLeadListCrmSyncConfig).not.toHaveBeenCalled();
    });

    it('clears accountId, apiKeyEncrypted, and webhookSecret', async () => {
      mockListWithConfig(makeConfig({ accountId: 'acct1', apiKeyEncrypted: 'enc:key', webhookSecret: 'secret123' }));
      mockCrmDb.setLeadListCrmSyncConfig.mockResolvedValue(undefined as any);

      await service.disconnectAccount('user1', 'list1', 'hubspot');

      const call = mockCrmDb.setLeadListCrmSyncConfig.mock.calls[0];
      const saved = call[2] as ExternalCrmSyncConfig;
      expect(saved.accountId).toBeUndefined();
      expect(saved.apiKeyEncrypted).toBeUndefined();
      expect(saved.webhookSecret).toBeUndefined();
    });

    it('preserves field mappings', async () => {
      const config = makeConfig({ accountId: 'acct1' });
      mockListWithConfig(config);
      mockCrmDb.setLeadListCrmSyncConfig.mockResolvedValue(undefined as any);

      await service.disconnectAccount('user1', 'list1', 'hubspot');

      const saved = mockCrmDb.setLeadListCrmSyncConfig.mock.calls[0][2] as ExternalCrmSyncConfig;
      expect(saved.contactFieldMapping).toEqual(config.contactFieldMapping);
      expect(saved.dealFieldMapping).toEqual(config.dealFieldMapping);
      expect(saved.customFieldMapping).toEqual(config.customFieldMapping);
    });

    it('disables autoSyncEnabled on disconnect but preserves webhookEnabled', async () => {
      mockListWithConfig(makeConfig({ accountId: 'acct1', autoSyncEnabled: true, webhookEnabled: true }));
      mockCrmDb.setLeadListCrmSyncConfig.mockResolvedValue(undefined as any);

      await service.disconnectAccount('user1', 'list1', 'hubspot');

      const saved = mockCrmDb.setLeadListCrmSyncConfig.mock.calls[0][2] as ExternalCrmSyncConfig;
      expect(saved.autoSyncEnabled).toBe(false);
      expect(saved.webhookEnabled).toBe(true);
    });

    it('does NOT set config to null (unlike deleteConfig)', async () => {
      mockListWithConfig(makeConfig({ accountId: 'acct1' }));
      mockCrmDb.setLeadListCrmSyncConfig.mockResolvedValue(undefined as any);

      await service.disconnectAccount('user1', 'list1', 'hubspot');

      const saved = mockCrmDb.setLeadListCrmSyncConfig.mock.calls[0][2];
      expect(saved).not.toBeNull();
    });
  });

  // ─── getDefaultMappings ─────────────────────────────────────────────────────

  describe('getDefaultMappings', () => {
    it('includes push-only listName/listId in the HubSpot custom mapping defaults', async () => {
      const defaults = await service.getDefaultMappings('hubspot');
      expect(defaults.customFieldMapping).toEqual(expect.arrayContaining([
        expect.objectContaining({ agentwebField: 'listName', crmProperty: 'lead_list_name', direction: 'push', enabled: true }),
        expect.objectContaining({ agentwebField: 'listId', crmProperty: 'lead_list_id', direction: 'push', enabled: true }),
      ]));
    });

    it('does not add listName/listId to the Attio custom mapping defaults', async () => {
      const defaults = await service.getDefaultMappings('attio');
      const fields = defaults.customFieldMapping.map(m => m.agentwebField);
      expect(fields).not.toContain('listName');
      expect(fields).not.toContain('listId');
    });
  });

  // ─── testConnection ───────────────────────────────────────────────────────

  describe('testConnection', () => {
    it('returns error when no config found', async () => {
      mockCrmDb.getLeadListById.mockResolvedValue(null);
      const result = await service.testConnection('user1', 'list1', 'hubspot');
      expect(result.valid).toBe(false);
      expect(result.error).toMatch(/no.*config/i);
    });

    it('returns error when config has no token or accountId', async () => {
      const config = makeConfig({ accountId: undefined, apiKeyEncrypted: undefined });
      mockListWithConfig(config);
      const result = await service.testConnection('user1', 'list1', 'hubspot');
      expect(result.valid).toBe(false);
    });

    it('returns valid=true on successful HubSpot API call (OAuth)', async () => {
      mockListWithConfig(makeConfig({ accountId: 'acct1' }));
      mockHubSpotCreate.mockResolvedValue(mockHubSpotServiceInstance);
      axios.create.mockReturnValue({
        get: jest.fn().mockResolvedValue({ data: { results: [] } }),
      });

      const result = await service.testConnection('user1', 'list1', 'hubspot');
      expect(result.valid).toBe(true);
    });

    it('returns valid=false when HubSpot API call fails', async () => {
      mockListWithConfig(makeConfig({ accountId: 'acct1' }));
      mockHubSpotServiceInstance.testConnection.mockResolvedValue({ valid: false, error: 'Unauthorized' });

      const result = await service.testConnection('user1', 'list1', 'hubspot');
      expect(result.valid).toBe(false);
      expect(result.error).toBe('Unauthorized');
    });

    it('returns valid=true on successful Attio API call (manual token)', async () => {
      const config = makeConfig({ provider: 'attio', accountId: undefined, apiKeyEncrypted: 'enc:attio-token' });
      mockListWithConfig(config, 'attio');
      axios.create.mockReturnValue({
        get: jest.fn().mockResolvedValue({ data: { data: [] } }),
      });

      const result = await service.testConnection('user1', 'list1', 'attio');
      expect(result.valid).toBe(true);
    });
  });

  // ─── getDistinctCustomFieldKeys ───────────────────────────────────────────

  describe('getDistinctCustomFieldKeys', () => {
    it('returns empty array if list or fieldNames is missing', async () => {
      mockCrmDb.getLeadListById.mockResolvedValue(null);
      const result = await service.getDistinctCustomFieldKeys('list1');
      expect(result).toEqual([]);
    });

    it('filters standard fields regardless of provider', async () => {
      mockCrmDb.getLeadListById.mockResolvedValue({
        listId: 'list1',
        fieldNames: ['email', 'firstName', 'real_custom_field']
      });
      const result = await service.getDistinctCustomFieldKeys('list1', 'hubspot');
      expect(result).toEqual(['real_custom_field']);
    });

    it('filters company_name for hubspot', async () => {
      mockCrmDb.getLeadListById.mockResolvedValue({
        listId: 'list1',
        fieldNames: ['company_name', 'real_custom_field']
      });
      const result = await service.getDistinctCustomFieldKeys('list1', 'hubspot');
      expect(result).toEqual(['real_custom_field']);
    });

    it('does NOT filter company_name for attio', async () => {
      mockCrmDb.getLeadListById.mockResolvedValue({
        listId: 'list1',
        fieldNames: ['company_name', 'real_custom_field']
      });
      const result = await service.getDistinctCustomFieldKeys('list1', 'attio');
      expect(result).toEqual(['company_name', 'real_custom_field']);
    });

    it('filters first_name and last_name for both providers', async () => {
      mockCrmDb.getLeadListById.mockResolvedValue({
        listId: 'list1',
        fieldNames: ['first_name', 'last_name', 'real_custom_field']
      });

      const hubspotResult = await service.getDistinctCustomFieldKeys('list1', 'hubspot');
      expect(hubspotResult).toEqual(['real_custom_field']);

      const attioResult = await service.getDistinctCustomFieldKeys('list1', 'attio');
      expect(attioResult).toEqual(['real_custom_field']);
    });

    it('removes duplicates and sorts results', async () => {
      mockCrmDb.getLeadListById.mockResolvedValue({
        listId: 'list1',
        fieldNames: ['z_field', 'a_field', 'z_field']
      });
      const result = await service.getDistinctCustomFieldKeys('list1', 'hubspot');
      expect(result).toEqual(['a_field', 'z_field']);
    });

    it('filters chatSessionCount as a standard field', async () => {
      mockCrmDb.getLeadListById.mockResolvedValue({
        listId: 'list1',
        fieldNames: ['chatSessionCount', 'real_custom_field']
      });
      const result = await service.getDistinctCustomFieldKeys('list1');
      expect(result).toEqual(['real_custom_field']);
    });
  });

  // ─── pushAllLeads (HubSpot) ───────────────────────────────────────────────

  describe('pushAllLeads - HubSpot', () => {
    it('throws when no config found', async () => {
      mockCrmDb.getLeadListById.mockResolvedValue(null);
      await expect(service.pushAllLeads('user1', 'list1', 'hubspot'))
        .rejects.toThrow(/no.*config/i);
    });

    it('throws when no token or accountId configured', async () => {
      const config = makeConfig({ accountId: undefined, apiKeyEncrypted: undefined });
      mockListWithConfig(config);
      await expect(service.pushAllLeads('user1', 'list1', 'hubspot'))
        .rejects.toThrow(/no.*auth/i);
    });

    it('returns success result with zero errors for empty lead list', async () => {
      mockListWithConfig(makeConfig());
      mockHubSpotCreate.mockResolvedValue(mockHubSpotServiceInstance);
      mockCrmDb.getLeadsByListId.mockResolvedValue({ items: [], lastEvaluatedKey: null, hasMore: false });

      const result = await service.pushAllLeads('user1', 'list1', 'hubspot');
      expect(result.errorCount).toBe(0);
      expect(result.successCount).toBe(0);
    });

    it('resolves the HubSpot service once for a multi-chunk push, not per chunk', async () => {
      mockListWithConfig(makeConfig());
      mockHubSpotCreate.mockResolvedValue(mockHubSpotServiceInstance);
      mockCrmDb.updateLead.mockResolvedValue(undefined as any);
      mockCrmDb.getLeadsByListId
        .mockResolvedValueOnce({ items: [{ leadId: 'l1', email: 'a@b.com' }], lastEvaluatedKey: { leadId: 'l1' } as any, hasMore: true })
        .mockResolvedValueOnce({ items: [{ leadId: 'l2', email: 'c@d.com' }], lastEvaluatedKey: null, hasMore: false });

      await service.pushAllLeads('user1', 'list1', 'hubspot');

      expect(mockCrmDb.getLeadsByListId).toHaveBeenCalledTimes(2); // two chunks processed
      expect(mockHubSpotCreate).toHaveBeenCalledTimes(1);          // one service reused across both
    });

    it('creates (not upserts) a contact for leads without email when pushing to HubSpot', async () => {
      const config = makeConfig();
      mockListWithConfig(config);
      mockHubSpotCreate.mockResolvedValue(mockHubSpotServiceInstance);
      mockHubSpotServiceInstance.createContact.mockResolvedValue({ contactId: 'c1' });
      mockCrmDb.getLeadsByListId.mockResolvedValue({
        items: [{ leadId: 'l1', firstName: 'John' }], // no email
        lastEvaluatedKey: null,
        hasMore: false,
      });

      const result = await service.pushAllLeads('user1', 'list1', 'hubspot');
      // No email means no dedup search — create directly instead of upsert.
      expect(mockHubSpotServiceInstance.upsertContact).not.toHaveBeenCalled();
      expect(mockHubSpotServiceInstance.createContact).toHaveBeenCalledTimes(1);
      expect(result.successCount).toBe(1);
      expect(result.newCount).toBe(1);
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
      mockListWithConfig(config);
      mockHubSpotCreate.mockResolvedValue(mockHubSpotServiceInstance);
      mockCrmDb.getLeadsByListId.mockResolvedValue({
        items: [{ leadId: 'l1', email: 'test@test.com', phone: '1234' }],
        lastEvaluatedKey: null,
        hasMore: false,
      });
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
      mockListWithConfig(config);
      mockHubSpotCreate.mockResolvedValue(mockHubSpotServiceInstance);
      mockCrmDb.getLeadsByListId.mockResolvedValue({
        items: [{ leadId: 'l1', email: 'test@test.com', customFields: { source: 'web', userId: 'u1' } }],
        lastEvaluatedKey: null,
        hasMore: false,
      });
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

    it('pre-creates a non-standard property even when it lives in contactFieldMapping (legacy "notes" config)', async () => {
      // Legacy configs placed "notes" in contactFieldMapping. Since "notes" is not
      // a native HubSpot contact property, it must still be ensured before push,
      // otherwise HubSpot rejects the upsert with PROPERTY_DOESNT_EXIST.
      const config = makeConfig({
        contactFieldMapping: [
          { agentwebField: 'email', crmProperty: 'email', direction: 'both', enabled: true },
          { agentwebField: 'notes', crmProperty: 'notes', direction: 'both', enabled: true },
        ],
        dealFieldMapping: [],
        customFieldMapping: [],
      });
      mockListWithConfig(config);
      mockHubSpotCreate.mockResolvedValue(mockHubSpotServiceInstance);
      mockCrmDb.getLeadsByListId.mockResolvedValue({
        items: [{ leadId: 'l1', email: 'test@test.com', notes: 'hello' }],
        lastEvaluatedKey: null,
        hasMore: false,
      });
      mockCrmDb.updateLead.mockResolvedValue(undefined as any);

      const result = await service.pushAllLeads('user1', 'list1', 'hubspot');

      expect(result.errorCount).toBe(0);
      expect(mockHubSpotServiceInstance.ensureContactProperty).toHaveBeenCalledWith('notes', 'Notes');
    });

    it('does NOT pre-create standard contact properties', async () => {
      const config = makeConfig({
        contactFieldMapping: [
          { agentwebField: 'email', crmProperty: 'email', direction: 'both', enabled: true },
          { agentwebField: 'firstName', crmProperty: 'firstname', direction: 'both', enabled: true },
          { agentwebField: 'company', crmProperty: 'company', direction: 'both', enabled: true },
          { agentwebField: 'linkedin', crmProperty: 'hs_linkedin_url', direction: 'push', enabled: true },
        ],
        dealFieldMapping: [],
        customFieldMapping: [],
      });
      mockListWithConfig(config);
      mockHubSpotCreate.mockResolvedValue(mockHubSpotServiceInstance);
      mockCrmDb.getLeadsByListId.mockResolvedValue({
        items: [{ leadId: 'l1', email: 'test@test.com', firstName: 'A', company: 'Acme', linkedin: 'x' }],
        lastEvaluatedKey: null,
        hasMore: false,
      });
      mockCrmDb.updateLead.mockResolvedValue(undefined as any);

      await service.pushAllLeads('user1', 'list1', 'hubspot');

      // Standard contact properties are never pre-created. (The system
      // list-identity properties are injected + ensured separately — see the
      // hubspotAdapter.pushLeads tests — so we assert on the specific props here.)
      const ensuredProps = mockHubSpotServiceInstance.ensureContactProperty.mock.calls.map(c => c[0]);
      for (const standard of ['email', 'firstname', 'company', 'hs_linkedin_url']) {
        expect(ensuredProps).not.toContain(standard);
      }
    });

    it('ensures each non-standard property only once across contact and custom mappings', async () => {
      // Same crmProperty appearing in both lists should be ensured a single time.
      const config = makeConfig({
        contactFieldMapping: [
          { agentwebField: 'email', crmProperty: 'email', direction: 'both', enabled: true },
          { agentwebField: 'notes', crmProperty: 'notes', direction: 'both', enabled: true },
        ],
        dealFieldMapping: [],
        customFieldMapping: [
          { agentwebField: 'notes', crmProperty: 'notes', direction: 'both', enabled: true },
          { agentwebField: 'icpSegment', crmProperty: 'icpsegment', direction: 'push', enabled: true },
        ],
      });
      mockListWithConfig(config);
      mockHubSpotCreate.mockResolvedValue(mockHubSpotServiceInstance);
      mockCrmDb.getLeadsByListId.mockResolvedValue({
        items: [{ leadId: 'l1', email: 'test@test.com', notes: 'hi', customFields: { icpSegment: 'smb' } }],
        lastEvaluatedKey: null,
        hasMore: false,
      });
      mockCrmDb.updateLead.mockResolvedValue(undefined as any);

      await service.pushAllLeads('user1', 'list1', 'hubspot');

      const notesCalls = mockHubSpotServiceInstance.ensureContactProperty.mock.calls
        .filter(c => c[0] === 'notes');
      expect(notesCalls).toHaveLength(1);
      expect(mockHubSpotServiceInstance.ensureContactProperty).toHaveBeenCalledWith('icpsegment', 'Icpsegment');
    });

    it('does NOT pre-create pull-only non-standard mappings', async () => {
      const config = makeConfig({
        contactFieldMapping: [
          { agentwebField: 'email', crmProperty: 'email', direction: 'both', enabled: true },
          { agentwebField: 'notes', crmProperty: 'notes', direction: 'pull', enabled: true },
        ],
        dealFieldMapping: [],
        customFieldMapping: [],
      });
      mockListWithConfig(config);
      mockHubSpotCreate.mockResolvedValue(mockHubSpotServiceInstance);
      mockCrmDb.getLeadsByListId.mockResolvedValue({
        items: [{ leadId: 'l1', email: 'test@test.com', notes: 'hi' }],
        lastEvaluatedKey: null,
        hasMore: false,
      });
      mockCrmDb.updateLead.mockResolvedValue(undefined as any);

      await service.pushAllLeads('user1', 'list1', 'hubspot');

      // The pull-only 'notes' property is not pre-created. (System list-identity
      // properties are injected + ensured regardless — assert on 'notes' here.)
      const ensuredProps = mockHubSpotServiceInstance.ensureContactProperty.mock.calls.map(c => c[0]);
      expect(ensuredProps).not.toContain('notes');
    });
  });

  // ─── startPushJob / getPushJob (async push) ───────────────────────────────

  describe('startPushJob / getPushJob', () => {
    it('throws when no config found (validated synchronously)', async () => {
      mockCrmDb.getLeadListById.mockResolvedValue(null);
      await expect(service.startPushJob('user1', 'list1', 'hubspot'))
        .rejects.toThrow(/no.*config/i);
    });

    it('throws when no token or accountId configured (validated synchronously)', async () => {
      mockListWithConfig(makeConfig({ accountId: undefined, apiKeyEncrypted: undefined }));
      await expect(service.startPushJob('user1', 'list1', 'hubspot'))
        .rejects.toThrow(/no.*auth/i);
    });

    it('returns a running job immediately and marks it completed in the background', async () => {
      mockListWithConfig(makeConfig());
      mockHubSpotCreate.mockResolvedValue(mockHubSpotServiceInstance);
      mockCrmDb.getLeadsByListId.mockResolvedValue({ items: [], lastEvaluatedKey: null, hasMore: false });

      const { job, completion } = await service.startPushJob('user1', 'list1', 'hubspot');
      expect(job.status).toBe('running');
      expect(typeof job.jobId).toBe('string');
      expect(job.jobId.length).toBeGreaterThan(0);

      await completion;

      const pushJobStates = mockCrmDb.setLeadListCrmSyncConfig.mock.calls
        .map(c => (c[2] as any)?.pushJob)
        .filter(Boolean);
      const finalState = pushJobStates[pushJobStates.length - 1];
      expect(finalState.status).toBe('completed');
      expect(finalState.jobId).toBe(job.jobId);
      expect(finalState.result).toMatchObject({ errorCount: 0 });
      expect(finalState.finishedAt).toBeDefined();
    });

    it('marks the job as error when the push throws', async () => {
      mockListWithConfig(makeConfig());
      mockHubSpotCreate.mockResolvedValue(mockHubSpotServiceInstance);
      mockCrmDb.getLeadsByListId.mockRejectedValue(new Error('boom'));

      const { completion } = await service.startPushJob('user1', 'list1', 'hubspot');
      await completion;

      const pushJobStates = mockCrmDb.setLeadListCrmSyncConfig.mock.calls
        .map(c => (c[2] as any)?.pushJob)
        .filter(Boolean);
      const finalState = pushJobStates[pushJobStates.length - 1];
      expect(finalState.status).toBe('error');
      expect(finalState.error).toMatch(/boom/);
    });

    it('reuses an in-flight fresh job instead of starting a second push', async () => {
      const running = { jobId: 'job-existing', status: 'running', startedAt: new Date().toISOString() };
      mockListWithConfig(makeConfig({ pushJob: running as any }));

      const { job, completion } = await service.startPushJob('user1', 'list1', 'hubspot');
      await completion;

      expect(job.jobId).toBe('job-existing');
      expect(job.status).toBe('running');
      // No new push should have been kicked off.
      expect(mockCrmDb.getLeadsByListId).not.toHaveBeenCalled();
    });

    it('starts a fresh push when the existing running job is stale', async () => {
      const stale = {
        jobId: 'job-stale',
        status: 'running',
        startedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(), // 1h ago
      };
      mockListWithConfig(makeConfig({ pushJob: stale as any }));
      mockHubSpotCreate.mockResolvedValue(mockHubSpotServiceInstance);
      mockCrmDb.getLeadsByListId.mockResolvedValue({ items: [], lastEvaluatedKey: null, hasMore: false });

      const { job, completion } = await service.startPushJob('user1', 'list1', 'hubspot');
      await completion;

      expect(job.jobId).not.toBe('job-stale');
      expect(mockCrmDb.getLeadsByListId).toHaveBeenCalled();
    });

    it('does not throw when persisting the job state fails (non-critical)', async () => {
      mockListWithConfig(makeConfig());
      mockHubSpotCreate.mockResolvedValue(mockHubSpotServiceInstance);
      mockCrmDb.getLeadsByListId.mockResolvedValue({ items: [], lastEvaluatedKey: null, hasMore: false });
      mockCrmDb.setLeadListCrmSyncConfig.mockRejectedValue(new Error('ddb down'));

      const { completion } = await service.startPushJob('user1', 'list1', 'hubspot');
      await expect(completion).resolves.toBeUndefined();
    });

    it('getPushJob returns the persisted job state', async () => {
      const running = { jobId: 'job-x', status: 'running', startedAt: new Date().toISOString() };
      mockListWithConfig(makeConfig({ pushJob: running as any }));

      const job = await service.getPushJob('user1', 'list1', 'hubspot');
      expect(job?.jobId).toBe('job-x');
      expect(job?.status).toBe('running');
    });

    it('getPushJob returns null when no job has run', async () => {
      mockListWithConfig(makeConfig());
      const job = await service.getPushJob('user1', 'list1', 'hubspot');
      expect(job).toBeNull();
    });

    it('getPushJob returns null when the requester cannot access the config', async () => {
      const { userDb } = require('../services/db');
      userDb.getUserById.mockImplementation((id: string) =>
        Promise.resolve(id === 'other-user' ? { userId: 'other-user', orgId: 'org-B' } : { userId: 'user1', orgId: 'org-A' })
      );
      const running = { jobId: 'job-x', status: 'running', startedAt: new Date().toISOString() };
      mockListWithConfig(makeConfig({ userId: 'other-user', pushJob: running as any }));

      const job = await service.getPushJob('user1', 'list1', 'hubspot');
      expect(job).toBeNull();
    });
  });

  // ─── pushAllLeads (Attio) ─────────────────────────────────────────────────

  describe('pushAllLeads - Attio', () => {
    it('throws when no config found for attio', async () => {
      mockCrmDb.getLeadListById.mockResolvedValue(null);
      await expect(service.pushAllLeads('user1', 'list1', 'attio'))
        .rejects.toThrow(/no.*config/i);
    });

    it('returns success result with zero errors for empty lead list (Attio)', async () => {
      const config = makeConfig({ provider: 'attio', accountId: 'attio-acct' });
      mockListWithConfig(config, 'attio');
      mockAttioCreate.mockResolvedValue({ testConnection: jest.fn().mockResolvedValue({ valid: true }) });
      mockCrmDb.getLeadsByListId.mockResolvedValue({ items: [], lastEvaluatedKey: null, hasMore: false });

      const result = await service.pushAllLeads('user1', 'list1', 'attio');
      expect(result.errorCount).toBe(0);
      expect(result.successCount).toBe(0);
    });
  });

  // ─── autoSyncLead ─────────────────────────────────────────────────────────

  describe('autoSyncLead', () => {
    it('does nothing when auto-sync is disabled', async () => {
      const config = makeConfig({ autoSyncEnabled: false });
      mockListWithConfig(config);

      await service.autoSyncLead('user1', 'list1', { leadId: 'l1', email: 'a@b.com' }, 'hubspot', 'created');

      expect(mockHubSpotCreate).not.toHaveBeenCalled();
    });

    it('does nothing when no config exists', async () => {
      mockCrmDb.getLeadListById.mockResolvedValue(null);

      await service.autoSyncLead('user1', 'list1', { leadId: 'l1', email: 'a@b.com' }, 'hubspot', 'created');

      expect(mockHubSpotCreate).not.toHaveBeenCalled();
    });

    it('does not throw on sync failure (fire-and-forget)', async () => {
      const config = makeConfig({ autoSyncEnabled: true });
      mockListWithConfig(config);
      mockHubSpotCreate.mockRejectedValue(new Error('token error'));

      await expect(
        service.autoSyncLead('user1', 'list1', { leadId: 'l1', email: 'a@b.com' }, 'hubspot', 'created')
      ).resolves.not.toThrow();
    });

    it('persists lastSyncStatus=error and lastSyncError when the push throws (e.g. revoked token)', async () => {
      const config = makeConfig({ autoSyncEnabled: true });
      mockListWithConfig(config);
      // A revoked token throws out of pushLeads via the token resolution / first call.
      mockHubSpotServiceInstance.ensureContactProperty.mockRejectedValue(
        new Error('Authentication credentials not found')
      );

      await service.autoSyncLead('user1', 'list1', { leadId: 'l1', email: 'a@b.com', notes: 'x' }, 'hubspot', 'created');

      const call = mockCrmDb.setLeadListCrmSyncConfig.mock.calls.at(-1);
      expect(call).toBeDefined();
      const saved = call![2] as Record<string, any>;
      expect(saved.lastSyncStatus).toBe('error');
      expect(saved.lastSyncError).toContain('Authentication credentials not found');
    });

    it('persists lastSyncStatus=error when the adapter reports a per-lead error (errorCount>0)', async () => {
      const config = makeConfig({ autoSyncEnabled: true });
      mockListWithConfig(config);
      // An invalid email is caught per-lead into result.errors (no throw), errorCount=1.
      await service.autoSyncLead('user1', 'list1', { leadId: 'l1', email: 'not-an-email' }, 'hubspot', 'created');

      const call = mockCrmDb.setLeadListCrmSyncConfig.mock.calls.at(-1);
      expect(call).toBeDefined();
      const saved = call![2] as Record<string, any>;
      expect(saved.lastSyncStatus).toBe('error');
      expect(saved.lastSyncError).toBeTruthy();
    });

    it('persists lastSyncStatus=success and clears lastSyncError on a healthy sync', async () => {
      // Start from a previously-errored config to prove the error banner clears.
      const config = makeConfig({ autoSyncEnabled: true, lastSyncStatus: 'error', lastSyncError: 'old failure' });
      mockListWithConfig(config);

      await service.autoSyncLead('user1', 'list1', { leadId: 'l1', email: 'a@b.com', firstName: 'Ada' }, 'hubspot', 'created');

      const call = mockCrmDb.setLeadListCrmSyncConfig.mock.calls.at(-1);
      expect(call).toBeDefined();
      const saved = call![2] as Record<string, any>;
      expect(saved.lastSyncStatus).toBe('success');
      expect(saved.lastSyncError).toBeUndefined();
      expect(saved.lastPushSyncAt).toBeTruthy();
    });
  });

  // ─── getExternalProperties ─────────────────────────────────────────────────

  describe('getExternalProperties', () => {
    const contactProps = [
      { name: 'email', label: 'Email', type: 'string' },
      { name: 'firstname', label: 'First Name', type: 'string' },
      { name: 'custom_field', label: 'Custom Field', type: 'string' },
    ];
    const dealProps = [
      { name: 'amount', label: 'Amount', type: 'number' },
      { name: 'dealstage', label: 'Deal Stage', type: 'enumeration' },
    ];
    const attioAttrs = [
      { api_slug: 'email_addresses', title: 'Email', type: 'email-address' },
      { api_slug: 'first_name', title: 'First Name', type: 'personal-name' },
      { api_slug: 'deal_value', title: 'Deal Value', type: 'currency' },
    ];

    beforeEach(() => {
      (mockHubSpotServiceInstance as any).listContactProperties = jest.fn().mockResolvedValue(contactProps);
      (mockHubSpotServiceInstance as any).listDealProperties = jest.fn().mockResolvedValue(dealProps);
      (mockAttioServiceInstance as any).getAllPeopleAttributes = jest.fn().mockResolvedValue(attioAttrs);
    });

    it('throws for an unsupported provider', async () => {
      await expect(
        service.getExternalProperties('user1', 'list1', 'salesforce', {})
      ).rejects.toThrow(/unsupported provider/i);
    });

    it('throws when no config and no credentials provided', async () => {
      mockCrmDb.getLeadListById.mockResolvedValue(null);
      await expect(
        service.getExternalProperties('user1', 'list1', 'hubspot', {})
      ).rejects.toThrow();
    });

    it('returns HubSpot contact properties when objectType=contact', async () => {
      const config = makeConfig();
      mockListWithConfig(config);

      const result = await service.getExternalProperties('user1', 'list1', 'hubspot', { objectType: 'contact' });

      expect((mockHubSpotServiceInstance as any).listContactProperties).toHaveBeenCalled();
      expect((mockHubSpotServiceInstance as any).listDealProperties).not.toHaveBeenCalled();
      expect(result.properties).toHaveLength(contactProps.length);
      expect(result.properties[0]).toMatchObject({ name: 'email', label: 'Email' });
    });

    it('returns HubSpot deal properties when objectType=deal', async () => {
      const config = makeConfig();
      mockListWithConfig(config);

      const result = await service.getExternalProperties('user1', 'list1', 'hubspot', { objectType: 'deal' });

      expect((mockHubSpotServiceInstance as any).listDealProperties).toHaveBeenCalled();
      expect((mockHubSpotServiceInstance as any).listContactProperties).not.toHaveBeenCalled();
      expect(result.properties).toHaveLength(dealProps.length);
      expect(result.properties[0]).toMatchObject({ name: 'amount', label: 'Amount' });
    });

    it('returns Attio people attributes for any objectType', async () => {
      const config = makeConfig({ provider: 'attio' });
      mockListWithConfig(config, 'attio');

      const result = await service.getExternalProperties('user1', 'list1', 'attio', {});

      expect((mockAttioServiceInstance as any).getAllPeopleAttributes).toHaveBeenCalled();
      // The personal-name attribute expands into first_name:text, last_name:text, plus the original —
      // so 3 input attrs → 5 output properties (email-address + 3 for personal-name + currency)
      expect(result.properties).toHaveLength(5);
      expect(result.properties).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: 'email_addresses', type: 'email-address' }),
        expect.objectContaining({ name: 'first_name', type: 'text' }),
        expect.objectContaining({ name: 'last_name', type: 'text' }),
        expect.objectContaining({ name: 'deal_value', type: 'currency' }),
      ]));
    });

    it('accepts inline accountId/apiKey without a saved config', async () => {
      mockCrmDb.getLeadListById.mockResolvedValue(null);

      const result = await service.getExternalProperties('user1', 'list1', 'hubspot', {
        accountId: 'inline-acct',
        objectType: 'contact',
      });

      expect(result.properties).toHaveLength(contactProps.length);
    });
  });

  // ─── deleteLeadFromCrm ─────────────────────────────────────────────────────

  describe('deleteLeadFromCrm', () => {
    beforeEach(() => {
      (mockHubSpotServiceInstance as any).deleteContact = jest.fn().mockResolvedValue(undefined);
      (mockHubSpotServiceInstance as any).deleteDeal = jest.fn().mockResolvedValue(undefined);
    });

    it('throws when no config exists', async () => {
      mockCrmDb.getLeadListById.mockResolvedValue(null);
      await expect(
        service.deleteLeadFromCrm('user1', 'list1', 'hubspot', { leadId: 'l1', email: 'a@b.com' })
      ).rejects.toThrow(/no sync configuration/i);
    });

    it('no-ops when deleteOnPush is false', async () => {
      const config = makeConfig({ deleteOnPush: false });
      mockListWithConfig(config);

      await service.deleteLeadFromCrm('user1', 'list1', 'hubspot', { leadId: 'l1', email: 'a@b.com' });

      expect((mockHubSpotServiceInstance as any).deleteContact).not.toHaveBeenCalled();
    });

    it('no-ops when lead has no external CRM ID', async () => {
      const config = makeConfig({ deleteOnPush: true });
      mockListWithConfig(config);

      await service.deleteLeadFromCrm('user1', 'list1', 'hubspot', {
        leadId: 'l1', email: 'a@b.com', syncMetadata: {},
      });

      expect((mockHubSpotServiceInstance as any).deleteContact).not.toHaveBeenCalled();
    });

    it('calls HubSpot deleteContact when deleteOnPush=true and contactId exists', async () => {
      const config = makeConfig({ deleteOnPush: true });
      mockListWithConfig(config);

      await service.deleteLeadFromCrm('user1', 'list1', 'hubspot', {
        leadId: 'l1', email: 'a@b.com',
        syncMetadata: { hubspot_contact_id: 'c123' },
      });

      expect((mockHubSpotServiceInstance as any).deleteContact).toHaveBeenCalledWith('c123');
    });
  });
});
