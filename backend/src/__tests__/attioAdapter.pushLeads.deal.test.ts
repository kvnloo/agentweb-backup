/**
 * Unit tests for AttioAdapter.pushLeads — deal-list sync.
 *
 * Attio has no native Deal/Opportunity object. AgentWeb represents "a lead/deal
 * record" as an entry in a dedicated Attio List, with deal-shaped fields
 * (value, stage, etc.) stored as list-entry attributes and linked to the synced
 * Person record. This is gated on `config.dealFieldMapping` having at least one
 * enabled, non-pull-only entry — mirroring HubspotAdapter's deal-sync gate.
 */

jest.mock('../services/db', () => ({
  crmDb: {
    updateLead: jest.fn().mockResolvedValue(undefined),
  },
}));

const mockLoadAttributeTypes = jest.fn();
const mockEnsurePersonAttribute = jest.fn();
const mockUpsertPersonByValues = jest.fn();
const mockFindOrCreateList = jest.fn();
const mockEnsureListAttribute = jest.fn();
const mockFindListEntry = jest.fn();
const mockUpdateListEntry = jest.fn();
const mockAddPersonToList = jest.fn();
const mockFindCompanyByName = jest.fn();
const mockCreateCompany = jest.fn();

const mockSvc = {
  loadAttributeTypes: mockLoadAttributeTypes,
  ensurePersonAttribute: mockEnsurePersonAttribute,
  upsertPersonByValues: mockUpsertPersonByValues,
  findOrCreateList: mockFindOrCreateList,
  ensureListAttribute: mockEnsureListAttribute,
  findListEntry: mockFindListEntry,
  updateListEntry: mockUpdateListEntry,
  addPersonToList: mockAddPersonToList,
  findCompanyByName: mockFindCompanyByName,
  createCompany: mockCreateCompany,
};

jest.mock('../services/attioService', () => ({
  AttioService: {
    fromToken: jest.fn(() => mockSvc),
    create: jest.fn(() => Promise.resolve(mockSvc)),
  },
}));

import { AttioAdapter } from '../services/adapters/attioAdapter';
import { ExternalCrmSyncConfig, FieldMapping } from '../services/externalCrmSyncService';
import { CrmAuth } from '../services/adapters/crmAdapterTypes';
import { crmDb } from '../services/db';

const auth: CrmAuth = { type: 'token', apiKey: 'attio-test-key' };

const contactMapping: FieldMapping[] = [
  { agentwebField: 'email', crmProperty: 'email_addresses', direction: 'both', enabled: true },
];

const dealMapping: FieldMapping[] = [
  { agentwebField: 'dealValue', crmProperty: 'deal_value', direction: 'both', enabled: true },
  { agentwebField: 'status', crmProperty: 'deal_status', direction: 'both', enabled: true },
];

function makeConfig(overrides: Partial<ExternalCrmSyncConfig> = {}): ExternalCrmSyncConfig {
  return {
    provider: 'attio',
    listId: 'list_1',
    userId: 'user_1',
    apiKeyEncrypted: 'enc',
    autoSyncEnabled: false,
    contactFieldMapping: contactMapping,
    dealFieldMapping: [],
    customFieldMapping: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeLead(overrides: Record<string, any> = {}) {
  return {
    leadId: 'l1',
    listId: 'list_1',
    email: 'jane@acme.com',
    dealValue: '5000',
    status: 'open',
    ...overrides,
  };
}

describe('AttioAdapter.pushLeads — deal list sync', () => {
  let adapter: AttioAdapter;

  beforeEach(() => {
    jest.clearAllMocks();
    adapter = new AttioAdapter();
    mockLoadAttributeTypes.mockResolvedValue(new Map());
    mockEnsurePersonAttribute.mockResolvedValue('some_slug');
    mockUpsertPersonByValues.mockResolvedValue({ recordId: 'person_1', isNew: true });
    mockFindOrCreateList.mockResolvedValue('deallist_1');
    mockEnsureListAttribute.mockImplementation((_listId: string, key: string) => Promise.resolve(key));
    mockFindListEntry.mockResolvedValue(null);
    mockUpdateListEntry.mockResolvedValue(undefined);
    mockAddPersonToList.mockResolvedValue('entry_1');
    mockFindCompanyByName.mockResolvedValue(null);
    mockCreateCompany.mockResolvedValue({ recordId: 'company_1' });
  });

  // ─── Gate ──────────────────────────────────────────────────────────────────

  it('never touches the deal list when no deal mapping is enabled', async () => {
    const result = await adapter.pushLeads(auth, [makeLead()], makeConfig({ dealFieldMapping: [] }));

    expect(mockFindOrCreateList).not.toHaveBeenCalled();
    expect(mockEnsureListAttribute).not.toHaveBeenCalled();
    expect(mockAddPersonToList).not.toHaveBeenCalled();
    expect(result.successCount).toBe(1);
    expect(result.errorCount).toBe(0);
  });

  it('never touches the deal list when every deal mapping row is disabled', async () => {
    const disabledMapping: FieldMapping[] = dealMapping.map(m => ({ ...m, enabled: false }));
    await adapter.pushLeads(auth, [makeLead()], makeConfig({ dealFieldMapping: disabledMapping }));

    expect(mockFindOrCreateList).not.toHaveBeenCalled();
  });

  // ─── Graceful degrade ──────────────────────────────────────────────────────

  it('degrades to person-only sync when resolving the deal list throws', async () => {
    mockFindOrCreateList.mockRejectedValue(new Error('quota exceeded'));

    const result = await adapter.pushLeads(auth, [makeLead()], makeConfig({ dealFieldMapping: dealMapping }));

    expect(result.successCount).toBe(1);
    expect(result.errorCount).toBe(0);
    expect(mockAddPersonToList).not.toHaveBeenCalled();
  });

  // Live-caught gap: a deal-entry failure used to be swallowed with just a
  // console.error, leaving the lead reported as a clean success even though
  // its deal never landed. Now demotes it to an error (mirrors
  // hubspotAdapter.ts's demote() pattern for its own deal-sync stage).
  it('demotes a lead to an error when its deal-entry push throws, even though its Person record synced fine', async () => {
    mockAddPersonToList.mockRejectedValue(new Error('list entry rejected'));

    const result = await adapter.pushLeads(auth, [makeLead()], makeConfig({ dealFieldMapping: dealMapping }));

    expect(result.successCount).toBe(0);
    expect(result.errorCount).toBe(1);
    expect(result.newCount).toBe(0); // the person-creation increment is rolled back
    expect(result.errors[0]).toMatch(/deal sync failed/);
  });

  it('stamps failed sync metadata (not synced) when the deal-entry push throws', async () => {
    mockAddPersonToList.mockRejectedValue(new Error('list entry rejected'));

    await adapter.pushLeads(auth, [makeLead()], makeConfig({ dealFieldMapping: dealMapping }));

    const failedCall = (crmDb.updateLead as jest.Mock).mock.calls.find(
      call => call[2]?.syncMetadata?.syncStatus === 'sync_failed'
    );
    expect(failedCall).toBeDefined();
  });

  it('demotes an updated (not new) lead correctly — decrements updatedCount, not newCount', async () => {
    mockUpsertPersonByValues.mockResolvedValue({ recordId: 'person_1', isNew: false });
    mockAddPersonToList.mockRejectedValue(new Error('list entry rejected'));

    const result = await adapter.pushLeads(auth, [makeLead()], makeConfig({ dealFieldMapping: dealMapping }));

    expect(result.errorCount).toBe(1);
    expect(result.newCount).toBe(0);
    expect(result.updatedCount).toBe(0);
  });

  // ─── Idempotency ───────────────────────────────────────────────────────────

  it('updates the existing list entry (via cached syncMetadata) instead of creating a duplicate', async () => {
    const lead = makeLead({ syncMetadata: { attio_record_id: 'person_1', attio_list_entry_id: 'entry_existing' } });
    mockUpdateLeadNoOldRecordId();

    await adapter.pushLeads(auth, [lead], makeConfig({ dealFieldMapping: dealMapping }));

    expect(mockUpdateListEntry).toHaveBeenCalledWith('deallist_1', 'entry_existing', expect.any(Object));
    expect(mockAddPersonToList).not.toHaveBeenCalled();
    expect(mockFindListEntry).not.toHaveBeenCalled();
  });

  it('looks up an existing entry by person id when no cached entry id is present, and updates it', async () => {
    mockFindListEntry.mockResolvedValue('entry_found');

    await adapter.pushLeads(auth, [makeLead()], makeConfig({ dealFieldMapping: dealMapping }));

    expect(mockFindListEntry).toHaveBeenCalledWith('deallist_1', 'person_1');
    expect(mockUpdateListEntry).toHaveBeenCalledWith('deallist_1', 'entry_found', expect.any(Object));
    expect(mockAddPersonToList).not.toHaveBeenCalled();
  });

  // ─── Success path ──────────────────────────────────────────────────────────

  it('creates the deal list, ensures its attributes, and adds the person with typed entry values', async () => {
    const result = await adapter.pushLeads(auth, [makeLead()], makeConfig({ dealFieldMapping: dealMapping, listName: 'Q1 Outbound' }));

    expect(mockFindOrCreateList).toHaveBeenCalledWith('Q1 Outbound', 'people');
    expect(mockEnsureListAttribute).toHaveBeenCalledWith('deallist_1', 'deal_value', expect.any(String), 'number');
    expect(mockEnsureListAttribute).toHaveBeenCalledWith('deallist_1', 'deal_status', expect.any(String), 'text');
    expect(mockAddPersonToList).toHaveBeenCalledWith(
      'deallist_1',
      'person_1',
      expect.objectContaining({ deal_value: expect.any(Array), deal_status: expect.any(Array) })
    );
    expect(result.successCount).toBe(1);
    expect(result.errorCount).toBe(0);
  });

  it('falls back to a default list name when the config has none', async () => {
    await adapter.pushLeads(auth, [makeLead()], makeConfig({ dealFieldMapping: dealMapping, listName: undefined }));

    expect(mockFindOrCreateList).toHaveBeenCalledWith('AgentWeb Deals', 'people');
  });

  it('reuses a cached config.attioDealListId instead of re-resolving the list', async () => {
    await adapter.pushLeads(auth, [makeLead()], makeConfig({ dealFieldMapping: dealMapping, attioDealListId: 'cached_list_1' }));

    expect(mockFindOrCreateList).not.toHaveBeenCalled();
    expect(mockAddPersonToList).toHaveBeenCalledWith('cached_list_1', 'person_1', expect.any(Object));
  });

  it('persists the new list-entry id onto the lead syncMetadata', async () => {
    await adapter.pushLeads(auth, [makeLead()], makeConfig({ dealFieldMapping: dealMapping }));

    expect(crmDb.updateLead).toHaveBeenCalledWith(
      'list_1',
      'l1',
      expect.objectContaining({ syncMetadata: expect.objectContaining({ attio_list_entry_id: 'entry_1' }) })
    );
  });

  it('stamps syncStatus=synced + lastSyncedAt on a successful push (Gap 1 closure)', async () => {
    await adapter.pushLeads(auth, [makeLead()], makeConfig({ dealFieldMapping: [] }));

    const calls = (crmDb.updateLead as jest.Mock).mock.calls;
    const syncStatusCall = calls.find(c => c[2]?.syncMetadata?.syncStatus === 'synced');
    expect(syncStatusCall).toBeTruthy();
    expect(syncStatusCall![2].syncMetadata.lastSyncedAt).toEqual(expect.any(String));
    expect(syncStatusCall![2].syncMetadata.attio_record_id).toBe('person_1');
  });

  it('stamps syncStatus=sync_failed + syncError when the push throws (Gap 1 closure)', async () => {
    mockUpsertPersonByValues.mockRejectedValue(new Error('boom'));

    const result = await adapter.pushLeads(auth, [makeLead()], makeConfig({ dealFieldMapping: [] }));

    expect(result.errorCount).toBe(1);
    const calls = (crmDb.updateLead as jest.Mock).mock.calls;
    const failedCall = calls.find(c => c[2]?.syncMetadata?.syncStatus === 'sync_failed');
    expect(failedCall).toBeTruthy();
    expect(failedCall![2].syncMetadata.syncError).toMatch(/boom/);
  });

  it('resolves and ensures the deal list only once across multiple leads in one call', async () => {
    const leads = [makeLead({ leadId: 'l1', email: 'a@acme.com' }), makeLead({ leadId: 'l2', email: 'b@acme.com' })];
    mockUpsertPersonByValues
      .mockResolvedValueOnce({ recordId: 'person_1', isNew: true })
      .mockResolvedValueOnce({ recordId: 'person_2', isNew: true });

    const result = await adapter.pushLeads(auth, leads, makeConfig({ dealFieldMapping: dealMapping }));

    expect(mockFindOrCreateList).toHaveBeenCalledTimes(1);
    expect(mockEnsureListAttribute).toHaveBeenCalledTimes(dealMapping.length);
    expect(mockAddPersonToList).toHaveBeenCalledTimes(2);
    expect(result.successCount).toBe(2);
  });
});

// crmDb.updateLead is mocked to resolve — this helper just documents intent at
// call sites where the person-record-id writeback must not interfere with
// asserting on the deal-entry path (both use the same mock).
function mockUpdateLeadNoOldRecordId() {
  (crmDb.updateLead as jest.Mock).mockResolvedValue(undefined);
}
