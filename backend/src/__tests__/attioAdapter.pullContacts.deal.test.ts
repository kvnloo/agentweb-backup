/**
 * Unit tests for AttioAdapter.pullContacts — deal-entry pull (Gap 2).
 *
 * Attio has no native Deal object. AgentWeb represents "a deal" as an entry
 * in a dedicated Attio List (see attioAdapter.ts pushLeads / ENG-1380 gap 2
 * plan). This file covers reading that back: bulk-prefetching the deal
 * list's entries once per pull run, then merging dealFieldMapping-mapped
 * fields into each pulled lead — mirroring HubSpot's pull-side deal merge
 * (hubspotAdapter.ts pullContacts), but via a bulk prefetch instead of a
 * per-contact API round trip, since Attio's List Entries are bulk-queryable.
 */

jest.mock('../services/db', () => ({
  crmDb: {
    batchCreateLeads: jest.fn().mockResolvedValue({ successCount: 0, newCount: 0, mergedCount: 0, errorCount: 0, errors: [] }),
  },
}));

const mockListPeople = jest.fn();
const mockGetPersonValues = jest.fn();
const mockLoadAttributeTypes = jest.fn();
const mockListListEntriesDetailed = jest.fn();

const mockSvc = {
  listPeople: mockListPeople,
  getPersonValues: mockGetPersonValues,
  loadAttributeTypes: mockLoadAttributeTypes,
  listListEntriesDetailed: mockListListEntriesDetailed,
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

function makePerson(recordId = 'person_1') {
  return { recordId };
}

describe('AttioAdapter.pullContacts — deal entry pull', () => {
  let adapter: AttioAdapter;

  beforeEach(() => {
    jest.clearAllMocks();
    adapter = new AttioAdapter();
    mockListPeople.mockResolvedValue({ people: [makePerson()], nextOffset: undefined });
    mockGetPersonValues.mockResolvedValue({ email_addresses: [{ email_address: 'jane@acme.com' }] });
    // Person-level call (no listId) needs email_addresses typed correctly for
    // extraction; deal-list-scoped calls (listId present) default empty unless
    // a specific test overrides it.
    mockLoadAttributeTypes.mockImplementation((_objectSlug: string, listId?: string) =>
      Promise.resolve(listId ? new Map() : new Map([['object:people:email_addresses', 'email_address']]))
    );
    mockListListEntriesDetailed.mockResolvedValue({ entries: [], nextOffset: undefined });
  });

  // ─── Gate ──────────────────────────────────────────────────────────────────

  it('never prefetches the deal list when no deal mapping is enabled', async () => {
    await adapter.pullContacts(auth, 'list_1', makeConfig({ dealFieldMapping: [], attioDealListId: 'deallist_1' }));
    expect(mockListListEntriesDetailed).not.toHaveBeenCalled();
  });

  it('never prefetches the deal list when no attioDealListId is cached yet (never pushed)', async () => {
    await adapter.pullContacts(auth, 'list_1', makeConfig({ dealFieldMapping: dealMapping, attioDealListId: undefined }));
    expect(mockListListEntriesDetailed).not.toHaveBeenCalled();
  });

  // ─── Graceful degrade ──────────────────────────────────────────────────────

  it('degrades to contact-only pull when the deal-list prefetch throws', async () => {
    mockListListEntriesDetailed.mockRejectedValue(new Error('quota exceeded'));

    const result = await adapter.pullContacts(auth, 'list_1', makeConfig({ dealFieldMapping: dealMapping, attioDealListId: 'deallist_1' }));

    expect(result.errorCount).toBe(0);
    const call = (crmDb.batchCreateLeads as jest.Mock).mock.calls[0];
    expect(call[1][0].email).toBe('jane@acme.com'); // contact pull still succeeded
    expect(call[1][0].dealValue).toBeUndefined();
  });

  it('stops prefetching after 200 pages of deal entries instead of paging forever', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    // Always a "full" 50-entry page (limit/offset contract), so nextOffset is
    // always defined and the loop would page forever without the cap.
    const fullPage = Array.from({ length: 50 }, (_, i) => ({ entryId: `e${i}`, personRecordId: `person_${i}`, values: {} }));
    mockListListEntriesDetailed.mockImplementation((_listId: string, offset: number) =>
      Promise.resolve({ entries: fullPage, nextOffset: offset + 50 })
    );

    await adapter.pullContacts(auth, 'list_1', makeConfig({ dealFieldMapping: dealMapping, attioDealListId: 'deallist_1' }));

    expect(mockListListEntriesDetailed).toHaveBeenCalledTimes(200);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/more than 200 pages/i));
    warnSpy.mockRestore();
  });

  it('does not merge deal fields for a person with no matching list entry', async () => {
    mockListListEntriesDetailed.mockResolvedValue({
      entries: [{ entryId: 'entry_other', personRecordId: 'person_other', values: { deal_value: [{ value: '999' }] } }],
      nextOffset: undefined,
    });

    await adapter.pullContacts(auth, 'list_1', makeConfig({ dealFieldMapping: dealMapping, attioDealListId: 'deallist_1' }));

    const call = (crmDb.batchCreateLeads as jest.Mock).mock.calls[0];
    expect(call[1][0].dealValue).toBeUndefined();
    expect(call[1][0].syncMetadata.attio_list_entry_id).toBeUndefined();
  });

  // ─── Success path ──────────────────────────────────────────────────────────

  it('merges matched deal-entry fields into the lead, routing native vs custom, and stamps attio_list_entry_id', async () => {
    mockListListEntriesDetailed.mockResolvedValue({
      entries: [{
        entryId: 'entry_1',
        personRecordId: 'person_1',
        values: { deal_value: [{ value: 5000 }], deal_status: [{ status: { title: 'open' } }] },
      }],
      nextOffset: undefined,
    });
    mockLoadAttributeTypes.mockImplementation((_objectSlug: string, listId?: string) => {
      if (listId) {
        return Promise.resolve(new Map([
          ['list:deallist_1:deal_value', 'number'],
          ['list:deallist_1:deal_status', 'status'],
        ]));
      }
      return Promise.resolve(new Map([['object:people:email_addresses', 'email_address']]));
    });

    await adapter.pullContacts(auth, 'list_1', makeConfig({ dealFieldMapping: dealMapping, attioDealListId: 'deallist_1' }));

    const call = (crmDb.batchCreateLeads as jest.Mock).mock.calls[0];
    const leadData = call[1][0];
    expect(leadData.dealValue).toBe(5000); // native field -> top-level
    expect(leadData.status).toBe('open'); // native field -> top-level
    expect(leadData.syncMetadata.attio_list_entry_id).toBe('entry_1');
    // Stamped alongside the entry id so a later delete targets the list this
    // entry actually lives in, not whatever attioDealListId the config might
    // point at after a later changePipeline re-point.
    expect(leadData.syncMetadata.attio_deal_list_id).toBe('deallist_1');
  });

  it('routes a non-native deal field into customFields', async () => {
    const customDealMapping: FieldMapping[] = [
      { agentwebField: 'dealNotes', crmProperty: 'deal_notes', direction: 'both', enabled: true },
    ];
    mockListListEntriesDetailed.mockResolvedValue({
      entries: [{ entryId: 'entry_1', personRecordId: 'person_1', values: { deal_notes: [{ value: 'hot lead' }] } }],
      nextOffset: undefined,
    });

    await adapter.pullContacts(auth, 'list_1', makeConfig({ dealFieldMapping: customDealMapping, attioDealListId: 'deallist_1' }));

    const call = (crmDb.batchCreateLeads as jest.Mock).mock.calls[0];
    expect(call[1][0].customFields.dealNotes).toBe('hot lead');
  });

  it('prefetches the deal list only once across multiple people/pages', async () => {
    mockListPeople.mockResolvedValue({ people: [makePerson('p1'), makePerson('p2')], nextOffset: undefined });
    mockGetPersonValues.mockResolvedValue({ email_addresses: [{ email_address: 'x@acme.com' }] });

    await adapter.pullContacts(auth, 'list_1', makeConfig({ dealFieldMapping: dealMapping, attioDealListId: 'deallist_1' }));

    expect(mockListListEntriesDetailed).toHaveBeenCalledTimes(1);
  });
});
