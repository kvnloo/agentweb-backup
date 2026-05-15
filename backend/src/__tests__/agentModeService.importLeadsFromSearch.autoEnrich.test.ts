/**
 * Tests for AgentModeService.importLeadsFromSearch — auto_enrich behaviour.
 *
 * Verifies that when auto_enrich=true and at least one new lead was created,
 * the helper enqueueFindEmailJobForNewLeads_stub is invoked with the new lead
 * IDs. Subagent A ships the route + service + Emma tool widening; Subagent B
 * later replaces the inline stub with the real implementation, at which point
 * these tests are tightened to assert the full job-creation flow.
 *
 * For now the stub returns null by default, so no autoEnrichJobId is surfaced
 * — but the spy still proves the call happens with the right shape.
 */

jest.mock('unipile-node-sdk', () => ({
  UnipileClient: jest.fn().mockImplementation(() => ({})),
}), { virtual: true });

jest.mock('../utils/secretsManager', () => ({
  getUnipileCredentials: jest.fn().mockResolvedValue({ dsn: 'https://api.unipile.com', apiKey: 'test-key' }),
  getJwtSecret: jest.fn().mockResolvedValue('test-jwt-secret'),
}));

const mockSearchPeople = jest.fn();
const mockResolveAccountId = jest.fn();
jest.mock('../services/linkedInOutreachService', () => ({
  linkedInOutreachService: {
    searchPeople: (...args: any[]) => mockSearchPeople(...args),
    resolveAccountId: (...args: any[]) => mockResolveAccountId(...args),
  },
}));

const mockBatchCreateLeads = jest.fn();
const mockGetLeadListById = jest.fn();
jest.mock('../services/db', () => ({
  crmDb: {
    batchCreateLeads: (...args: any[]) => mockBatchCreateLeads(...args),
    getLeadListById: (...args: any[]) => mockGetLeadListById(...args),
  },
  userDb: {
    getUserById: jest.fn().mockResolvedValue(null),
  },
}));

jest.mock('../services/connectedAccountsDb', () => ({
  getAccountsByUserId: jest.fn().mockResolvedValue([]),
}));

import {
  AgentModeService,
  __testHooks as agentModeServiceTestHooks,
} from '../services/agentModeService';

describe('AgentModeService.importLeadsFromSearch — auto_enrich', () => {
  let service: AgentModeService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new AgentModeService();
    mockResolveAccountId.mockResolvedValue('test-account-id');
    mockSearchPeople.mockResolvedValue({ items: [{ name: 'A B', public_identifier: 'a-b' }], cursor: null });
    mockBatchCreateLeads.mockResolvedValue({
      newCount: 1, mergedCount: 0, errors: [],
      created: [{ leadId: 'lead-new-1' }],
    });
    mockGetLeadListById.mockResolvedValue({ leadCount: 1 });
  });

  it('auto_enrich=false: response has no autoEnrichJobId', async () => {
    const stubSpy = jest.spyOn(agentModeServiceTestHooks, 'enqueueFindEmailJobForNewLeads')
      .mockResolvedValue(null);

    const result = await service.importLeadsFromSearch('user-1', {
      listId: 'list-1',
      title: 'CTO',
      auto_enrich: false,
    });

    expect(result.autoEnrichJobId).toBeUndefined();
    expect(stubSpy).not.toHaveBeenCalled();
    stubSpy.mockRestore();
  });

  it('auto_enrich=true with newCount=0: stub not invoked, no autoEnrichJobId', async () => {
    mockBatchCreateLeads.mockResolvedValueOnce({
      newCount: 0, mergedCount: 0, errors: [], created: [],
    });
    const stubSpy = jest.spyOn(agentModeServiceTestHooks, 'enqueueFindEmailJobForNewLeads')
      .mockResolvedValue({ jobId: 'job-1', queued: 1 });

    const result = await service.importLeadsFromSearch('user-1', {
      listId: 'list-1',
      title: 'CTO',
      auto_enrich: true,
    });

    expect(stubSpy).not.toHaveBeenCalled();
    expect(result.autoEnrichJobId).toBeUndefined();
    stubSpy.mockRestore();
  });

  it('auto_enrich=true with newCount>0 but stub returns null: response has no autoEnrichJobId (graceful fallback)', async () => {
    const stubSpy = jest.spyOn(agentModeServiceTestHooks, 'enqueueFindEmailJobForNewLeads')
      .mockResolvedValue(null);

    const result = await service.importLeadsFromSearch('user-1', {
      listId: 'list-1',
      title: 'CTO',
      auto_enrich: true,
    });

    expect(stubSpy).toHaveBeenCalled();
    expect(result.autoEnrichJobId).toBeUndefined();
    expect(result.success).toBe(true);
    stubSpy.mockRestore();
  });

  it('auto_enrich=true: passes the created lead IDs to the stub', async () => {
    mockBatchCreateLeads.mockResolvedValueOnce({
      newCount: 2, mergedCount: 0, errors: [],
      created: [{ leadId: 'lead-A' }, { leadId: 'lead-B' }],
    });
    const stubSpy = jest.spyOn(agentModeServiceTestHooks, 'enqueueFindEmailJobForNewLeads')
      .mockResolvedValue({ jobId: 'job-xyz', queued: 2 });

    const result = await service.importLeadsFromSearch('user-1', {
      listId: 'list-1',
      title: 'CTO',
      auto_enrich: true,
    });

    expect(stubSpy).toHaveBeenCalledWith('user-1', 'list-1', ['lead-A', 'lead-B']);
    expect(result.autoEnrichJobId).toBe('job-xyz');
    stubSpy.mockRestore();
  });

  it('does NOT surface autoEnrichJobId when autoEnrich glue returns the quota-exhausted sentinel', async () => {
    mockBatchCreateLeads.mockResolvedValueOnce({
      newCount: 1, mergedCount: 0, errors: [],
      created: [{ leadId: 'lead-quota-1' }],
    });
    const stubSpy = jest.spyOn(agentModeServiceTestHooks, 'enqueueFindEmailJobForNewLeads')
      .mockResolvedValue({ jobId: '', queued: 0, reason: 'quota-exhausted' } as any);

    const result = await service.importLeadsFromSearch('user-1', {
      listId: 'list-1',
      title: 'CTO',
      auto_enrich: true,
    });

    expect(stubSpy).toHaveBeenCalled();
    expect(result).not.toHaveProperty('autoEnrichJobId');
    expect(result.success).toBe(true);
    stubSpy.mockRestore();
  });

  describe('response shape compatibility (regression)', () => {
    it('preserves all existing response keys', async () => {
      const result = await service.importLeadsFromSearch('user-1', {
        listId: 'list-1',
        title: 'CTO',
      });

      // toMatchObject ensures new fields like importedLeads/autoEnrichJobId
      // can be added without breaking this assertion.
      expect(result).toMatchObject({
        success: true,
        imported: 1,
        skipped: 0,
        list_total_after_import: 1,
        errors: [],
        total: 1,
      });
      // cursor key present (null is fine)
      expect(result).toHaveProperty('cursor');
    });
  });
});
