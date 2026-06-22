import { ExternalCrmSyncService, ExternalCrmSyncConfig } from '../services/externalCrmSyncService';

// ─── Mock dependencies ────────────────────────────────────────────────────────
//
// Mirrors the mock surface of externalCrmSync.service.test.ts (crmDb/userDb on
// ../services/db, decryptPassword on ../utils/crypto, HubSpotService factory on
// ../services/hubspotService). The HubSpot instance's upsertContact doubles as a
// CONCURRENCY RECORDER so we can observe whether two pushes for the same list
// overlapped (the duplicate-deal race) or were serialized by the per-list lock.

jest.mock('../services/db', () => ({
  crmDb: {
    getLeadListById: jest.fn(),
    getLeadsByListId: jest.fn(),
    getLeadById: jest.fn(),
    updateLead: jest.fn().mockResolvedValue(undefined),
    batchCreateLeads: jest.fn(),
    setLeadListCrmSyncConfig: jest.fn().mockResolvedValue(undefined),
  },
  userDb: {
    getUserById: jest.fn().mockResolvedValue(null),
  },
}));

jest.mock('../utils/crypto', () => ({
  encryptPassword: jest.fn((pw: string) => `enc:${pw}`),
  decryptPassword: jest.fn(() => ({ password: 'pat', userId: 'user1' })),
}));

// Shared concurrency state — reset per test.
let active = 0;
let maxActive = 0;

const mockHubSpotServiceInstance = {
  testConnection: jest.fn().mockResolvedValue({ valid: true }),
  ensureContactProperty: jest.fn().mockResolvedValue('aw_notes'),
  ensureDealProperty: jest.fn().mockResolvedValue('amount'),
  // Concurrency recorder: tracks the peak number of simultaneously in-flight
  // pushes. If two same-list pushes overlap, maxActive reaches 2.
  upsertContact: jest.fn(async () => {
    active++;
    maxActive = Math.max(maxActive, active);
    await new Promise((r) => setTimeout(r, 20));
    active--;
    return { contactId: 'c1', isNew: false };
  }),
  createContact: jest.fn().mockResolvedValue({ contactId: 'c1' }),
  updateContact: jest.fn().mockResolvedValue({ contactId: 'c1' }),
  createDeal: jest.fn().mockResolvedValue('d1'),
  updateDeal: jest.fn().mockResolvedValue(undefined),
  associateContactToDeal: jest.fn().mockResolvedValue(undefined),
  getContactDealAssociations: jest.fn().mockResolvedValue([]),
  getDeal: jest.fn().mockResolvedValue(null),
  getDealPipelineStages: jest.fn().mockResolvedValue([]),
  createDealStage: jest.fn().mockResolvedValue({ id: 'stage_1', label: 'Stage 1', displayOrder: 0, metadata: { probability: 0.1 } }),
  listDealPipelines: jest.fn().mockResolvedValue([]),
  listContactProperties: jest.fn().mockResolvedValue([]),
  listDealProperties: jest.fn().mockResolvedValue([]),
};

jest.mock('../services/hubspotService', () => ({
  HubSpotService: {
    create: jest.fn(),
    fromToken: jest.fn(),
  },
}));

import { crmDb } from '../services/db';
import { HubSpotService } from '../services/hubspotService';

const mockCrmDb = crmDb as jest.Mocked<typeof crmDb>;
const mockHubSpotCreate = HubSpotService.create as jest.Mock;
const mockHubSpotFromToken = HubSpotService.fromToken as jest.Mock;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeConfig(overrides: Partial<ExternalCrmSyncConfig> = {}): ExternalCrmSyncConfig {
  return {
    provider: 'hubspot',
    listId: 'listA',
    userId: 'user1',
    apiKeyEncrypted: 'enc:pat',
    autoSyncEnabled: true,
    contactFieldMapping: [
      { agentwebField: 'email', crmProperty: 'email', direction: 'both', enabled: true },
    ],
    dealFieldMapping: [],
    customFieldMapping: [],
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
    ...overrides,
  };
}

// Configure getLeadListById so a given listId resolves to a list whose
// hubspot config is valid (apiKeyEncrypted set, autoSyncEnabled true).
function mockListsWithConfigs(listIds: string[]) {
  mockCrmDb.getLeadListById.mockImplementation(((listId: string) =>
    Promise.resolve({
      listId,
      userId: 'user1',
      name: `List ${listId}`,
      externalCrmSyncConfigs: {
        hubspot: makeConfig({ listId }),
      },
    } as any)) as any);
}

// ─── Tests ────────────────────────────────────────────────────────────────────

// Batch push is ON by default; pin the kill switch off so the per-lead path
// (which calls upsertContact, our concurrency recorder) runs.
beforeAll(() => { process.env.HUBSPOT_BATCH_PUSH_ENABLED = 'false'; });
afterAll(() => { delete process.env.HUBSPOT_BATCH_PUSH_ENABLED; });

describe('ExternalCrmSyncService per-list push serialization lock', () => {
  let service: ExternalCrmSyncService;
  const lead = { leadId: 'lead1', email: 'a@b.com' };

  beforeEach(() => {
    jest.clearAllMocks();
    active = 0;
    maxActive = 0;
    mockHubSpotCreate.mockResolvedValue(mockHubSpotServiceInstance);
    mockHubSpotFromToken.mockReturnValue(mockHubSpotServiceInstance);
    mockHubSpotServiceInstance.upsertContact.mockImplementation(async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 20));
      active--;
      return { contactId: 'c1', isNew: false };
    });
    mockCrmDb.getLeadById.mockResolvedValue(lead as any);
    mockCrmDb.updateLead.mockResolvedValue(undefined as any);
    mockCrmDb.setLeadListCrmSyncConfig.mockResolvedValue(undefined as any);
    service = new ExternalCrmSyncService();
  });

  it('serializes two concurrent auto-syncs for the SAME list (no overlap)', async () => {
    mockListsWithConfigs(['listA']);

    await Promise.all([
      service.autoSyncLead('user1', 'listA', lead, 'hubspot', 'updated'),
      service.autoSyncLead('user1', 'listA', lead, 'hubspot', 'updated'),
    ]);

    // With the lock, only one push touches HubSpot at a time → peak concurrency 1.
    // Without the lock, both overlap → peak concurrency 2 (the duplicate-deal race).
    expect(maxActive).toBe(1);
  });

  it('runs auto-syncs for DIFFERENT lists concurrently (not serialized across lists)', async () => {
    mockListsWithConfigs(['listA', 'listB']);

    await Promise.all([
      service.autoSyncLead('user1', 'listA', { leadId: 'lead1', email: 'a@b.com' }, 'hubspot', 'updated'),
      service.autoSyncLead('user1', 'listB', { leadId: 'lead2', email: 'c@d.com' }, 'hubspot', 'updated'),
    ]);

    // Different lists hold different locks → both push in parallel → peak 2.
    expect(maxActive).toBe(2);
  });

  it('re-reads the lead inside the lock before pushing (sees a just-written deal id)', async () => {
    mockListsWithConfigs(['listA']);

    await service.autoSyncLead('user1', 'listA', lead, 'hubspot', 'updated');

    expect(mockCrmDb.getLeadById).toHaveBeenCalledWith('listA', 'lead1');
  });
});
