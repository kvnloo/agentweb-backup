import { ExternalCrmSyncService, ExternalCrmSyncConfig } from '../services/externalCrmSyncService';

// runPush mutates the SAME config.pushJob object in place across the run, so a
// plain mock that stashes the reference would only ever see the final state.
// Snapshot each persisted pushJob (deep clone) at call time so we can assert on
// the per-chunk progression the service actually wrote.
const persistedPushJobs: any[] = [];

jest.mock('../services/db', () => ({
  crmDb: {
    getLeadListById: jest.fn(),
    getLeadsByListId: jest.fn(),
    getLeadById: jest.fn(),
    updateLead: jest.fn().mockResolvedValue(undefined),
    setLeadListCrmSyncConfig: jest.fn(),
  },
  userDb: { getUserById: jest.fn().mockResolvedValue(null) },
}));
jest.mock('../utils/crypto', () => ({
  encryptPassword: jest.fn((pw: string) => `enc:${pw}`),
  decryptPassword: jest.fn(() => ({ password: 'pat', userId: 'user1' })),
}));
const mockHubSpotServiceInstance = {
  testConnection: jest.fn().mockResolvedValue({ valid: true }),
  ensureContactProperty: jest.fn().mockResolvedValue('aw_notes'),
  ensureDealProperty: jest.fn().mockResolvedValue('amount'),
  upsertContact: jest.fn().mockResolvedValue({ contactId: 'c1', isNew: false }),
  createContact: jest.fn().mockResolvedValue({ contactId: 'c1' }),
  updateContact: jest.fn().mockResolvedValue({ contactId: 'c1' }),
  createDeal: jest.fn().mockResolvedValue('d1'),
  updateDeal: jest.fn().mockResolvedValue(undefined),
  associateContactToDeal: jest.fn().mockResolvedValue(undefined),
  getContactDealAssociations: jest.fn().mockResolvedValue([]),
  getDeal: jest.fn().mockResolvedValue(null),
  getDealPipelineStages: jest.fn().mockResolvedValue([]),
  createDealStage: jest.fn().mockResolvedValue({ id: 'stage_1', label: 'S', displayOrder: 0, metadata: { probability: 0.1 } }),
  listDealPipelines: jest.fn().mockResolvedValue([]),
  listContactProperties: jest.fn().mockResolvedValue([]),
  listDealProperties: jest.fn().mockResolvedValue([]),
};
jest.mock('../services/hubspotService', () => ({
  HubSpotService: { create: jest.fn(), fromToken: jest.fn() },
}));

import { crmDb } from '../services/db';
import { HubSpotService } from '../services/hubspotService';
const mockCrmDb = crmDb as jest.Mocked<typeof crmDb>;

function makeConfig(overrides: Partial<ExternalCrmSyncConfig> = {}): ExternalCrmSyncConfig {
  return {
    provider: 'hubspot', listId: 'listA', userId: 'user1', apiKeyEncrypted: 'enc:pat',
    autoSyncEnabled: false,
    contactFieldMapping: [{ agentwebField: 'email', crmProperty: 'email', direction: 'both', enabled: true }],
    dealFieldMapping: [], customFieldMapping: [],
    createdAt: '2024-01-01T00:00:00.000Z', updatedAt: '2024-01-01T00:00:00.000Z',
    ...overrides,
  };
}

beforeAll(() => { process.env.HUBSPOT_BATCH_PUSH_ENABLED = 'false'; });
afterAll(() => { delete process.env.HUBSPOT_BATCH_PUSH_ENABLED; });

describe('ExternalCrmSyncService push progress', () => {
  let service: ExternalCrmSyncService;
  beforeEach(() => {
    jest.clearAllMocks();
    persistedPushJobs.length = 0;
    (mockCrmDb.setLeadListCrmSyncConfig as jest.Mock).mockImplementation(async (_listId: any, _provider: any, cfg: any) => {
      if (cfg?.pushJob) persistedPushJobs.push(JSON.parse(JSON.stringify(cfg.pushJob)));
    });
    (HubSpotService.create as jest.Mock).mockResolvedValue(mockHubSpotServiceInstance);
    (HubSpotService.fromToken as jest.Mock).mockReturnValue(mockHubSpotServiceInstance);
    // List with leadCount=3 and a hubspot config.
    mockCrmDb.getLeadListById.mockResolvedValue({
      listId: 'listA', userId: 'user1', name: 'List A', leadCount: 3,
      externalCrmSyncConfigs: { hubspot: makeConfig() },
    } as any);
    // Two pages: [lead1, lead2] then [lead3].
    mockCrmDb.getLeadsByListId
      .mockResolvedValueOnce({ items: [{ leadId: 'l1', email: 'a@b.com' }, { leadId: 'l2', email: 'c@d.com' }], lastEvaluatedKey: 'k1' } as any)
      .mockResolvedValueOnce({ items: [{ leadId: 'l3', email: 'e@f.com' }], lastEvaluatedKey: undefined } as any);
    service = new ExternalCrmSyncService();
  });

  it('seeds totalCount from leadCount and writes increasing processedCount', async () => {
    const { completion } = await service.startPushJob('user1', 'listA', 'hubspot');
    await completion;

    // Every pushJob snapshot persisted during the run (deep-cloned at call time).
    const jobs = persistedPushJobs;

    // totalCount seeded from leadCount on the running job.
    const running = jobs.filter((j) => j.status === 'running');
    expect(running.some((j) => j.totalCount === 3)).toBe(true);

    // processedCount advances 2 then 3 (page sizes 2 + 1).
    const processed = running.map((j) => j.processedCount).filter((n) => n !== undefined);
    expect(processed).toContain(2);
    expect(processed).toContain(3);

    // Final job is completed with a result.
    const done = jobs[jobs.length - 1];
    expect(done.status).toBe('completed');
    expect(done.result.successCount).toBeGreaterThanOrEqual(0);
  });

  it('does not throw / writes no progress on the synchronous pushAllLeads path (no job)', async () => {
    await expect(service.pushAllLeads('user1', 'listA', 'hubspot')).resolves.toBeDefined();
    expect(persistedPushJobs.length).toBe(0); // pushAllLeads sets no pushJob, so no progress writes
  });
});
