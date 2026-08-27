/**
 * Unit tests for AttioAdapter.applyListEntryWebhookEvent — the Deal-analog
 * (list-entry.*) side of real-time auto-pull (ENG-1380 webhook follow-up),
 * alongside applyAttioPersonEvent's Person side. Reuses gap 2's
 * field-extraction/routing logic narrowed to one changed entry, via a
 * targeted single-entry fetch instead of re-paginating the whole deal list.
 */

const mockGetLeadByAttioRecordId = jest.fn();
const mockGetLeadByAttioListEntryId = jest.fn();
const mockUpdateLead = jest.fn();
jest.mock('../services/db', () => ({
  crmDb: {
    getLeadByAttioRecordId: (...a: any[]) => mockGetLeadByAttioRecordId(...a),
    getLeadByAttioListEntryId: (...a: any[]) => mockGetLeadByAttioListEntryId(...a),
    updateLead: (...a: any[]) => mockUpdateLead(...a),
  },
}));

import { AttioAdapter } from '../services/adapters/attioAdapter';
import { ExternalCrmSyncConfig, FieldMapping } from '../services/externalCrmSyncService';

const dealMapping: FieldMapping[] = [
  { agentwebField: 'dealValue', crmProperty: 'deal_value', direction: 'both', enabled: true },
  { agentwebField: 'status', crmProperty: 'deal_status', direction: 'both', enabled: true },
  { agentwebField: 'priority', crmProperty: 'deal_priority', direction: 'both', enabled: true }, // routed to customFields — not a native deal field
];

function makeConfig(overrides: Partial<ExternalCrmSyncConfig> = {}): ExternalCrmSyncConfig {
  return {
    provider: 'attio',
    listId: 'list_1',
    userId: 'user_1',
    apiKeyEncrypted: 'enc',
    autoSyncEnabled: false,
    contactFieldMapping: [],
    dealFieldMapping: dealMapping,
    customFieldMapping: [],
    attioDealListId: 'deallist_1',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  } as ExternalCrmSyncConfig;
}

const makeSvc = (overrides: Record<string, any> = {}) => ({
  getListEntry: jest.fn().mockResolvedValue(null),
  loadAttributeTypes: jest.fn().mockResolvedValue(new Map()),
  ...overrides,
});

beforeEach(() => {
  jest.clearAllMocks();
});

describe('AttioAdapter.applyListEntryWebhookEvent', () => {
  let adapter: AttioAdapter;
  beforeEach(() => {
    adapter = new AttioAdapter();
  });

  it('no-ops when the config has no attioDealListId', async () => {
    const svc = makeSvc();
    await adapter.applyListEntryWebhookEvent('list_1', makeConfig({ attioDealListId: undefined }), svc as any, 'entry_1', 'list-entry.updated');
    expect(svc.getListEntry).not.toHaveBeenCalled();
  });

  it('no-ops when no deal mapping is enabled for pull', async () => {
    const svc = makeSvc();
    await adapter.applyListEntryWebhookEvent('list_1', makeConfig({ dealFieldMapping: [] }), svc as any, 'entry_1', 'list-entry.updated');
    expect(svc.getListEntry).not.toHaveBeenCalled();
  });

  it('no-ops when the entry is not found in our deal list (wrong list / already gone)', async () => {
    const svc = makeSvc({ getListEntry: jest.fn().mockResolvedValue(null) });
    await adapter.applyListEntryWebhookEvent('list_1', makeConfig(), svc as any, 'entry_1', 'list-entry.updated');
    expect(mockGetLeadByAttioRecordId).not.toHaveBeenCalled();
    expect(mockUpdateLead).not.toHaveBeenCalled();
  });

  it('no-ops when no lead matches the entry\'s person record (never pulled/pushed)', async () => {
    const svc = makeSvc({
      getListEntry: jest.fn().mockResolvedValue({ entryId: 'entry_1', personRecordId: 'person_1', values: {} }),
    });
    mockGetLeadByAttioRecordId.mockResolvedValue(null);

    await adapter.applyListEntryWebhookEvent('list_1', makeConfig(), svc as any, 'entry_1', 'list-entry.updated');
    expect(mockUpdateLead).not.toHaveBeenCalled();
  });

  it('updates native and custom deal fields on the matching lead, and stamps the entry id', async () => {
    const svc = makeSvc({
      getListEntry: jest.fn().mockResolvedValue({
        entryId: 'entry_1',
        personRecordId: 'person_1',
        values: {
          deal_value: [{ value: 9999 }],
          deal_status: [{ value: 'Won' }],
          deal_priority: [{ value: 'High' }],
        },
      }),
      loadAttributeTypes: jest.fn().mockResolvedValue(new Map([
        ['list:deallist_1:deal_value', 'number'],
        ['list:deallist_1:deal_status', 'text'],
        ['list:deallist_1:deal_priority', 'text'],
      ])),
    });
    mockGetLeadByAttioRecordId.mockResolvedValue({ leadId: 'lead_1', customFields: { existing: 'kept' }, syncMetadata: {} });

    await adapter.applyListEntryWebhookEvent('list_1', makeConfig(), svc as any, 'entry_1', 'list-entry.updated');

    expect(mockUpdateLead).toHaveBeenCalledWith('list_1', 'lead_1', expect.objectContaining({
      dealValue: 9999,
      status: 'Won',
      customFields: { existing: 'kept', priority: 'High' },
      syncMetadata: { attio_list_entry_id: 'entry_1', attio_deal_list_id: 'deallist_1' },
    }));
  });

  // Regression: a raw `{...lead.customFields, ...customFieldUpdates}` spread
  // reproduces the char-indexed corruption pattern customFieldsGuard exists
  // to prevent, if lead.customFields is ever a corrupted string rather than
  // an object.
  it('sanitizes a corrupted (string) existing customFields instead of char-indexing it into the merge', async () => {
    const svc = makeSvc({
      getListEntry: jest.fn().mockResolvedValue({
        entryId: 'entry_1',
        personRecordId: 'person_1',
        values: { deal_priority: [{ value: 'High' }] },
      }),
      loadAttributeTypes: jest.fn().mockResolvedValue(new Map([
        ['list:deallist_1:deal_priority', 'text'],
      ])),
    });
    mockGetLeadByAttioRecordId.mockResolvedValue({ leadId: 'lead_1', customFields: '{"corrupted":true}' as any, syncMetadata: {} });
    jest.spyOn(console, 'error').mockImplementation(() => {});

    await adapter.applyListEntryWebhookEvent('list_1', makeConfig(), svc as any, 'entry_1', 'list-entry.updated');

    expect(mockUpdateLead).toHaveBeenCalledWith('list_1', 'lead_1', expect.objectContaining({
      customFields: { priority: 'High' },
    }));
    (console.error as jest.Mock).mockRestore();
  });

  it('list-entry.deleted clears the deal link on the matching lead without deleting it', async () => {
    mockGetLeadByAttioListEntryId.mockResolvedValue({
      leadId: 'lead_1',
      syncMetadata: { attio_record_id: 'person_1', attio_list_entry_id: 'entry_1', syncStatus: 'synced' },
    });
    const svc = makeSvc();

    await adapter.applyListEntryWebhookEvent('list_1', makeConfig(), svc as any, 'entry_1', 'list-entry.deleted');

    expect(svc.getListEntry).not.toHaveBeenCalled(); // deletion doesn't need a live fetch
    expect(mockUpdateLead).toHaveBeenCalledWith('list_1', 'lead_1', {
      syncMetadata: { attio_record_id: 'person_1', syncStatus: 'synced' }, // attio_list_entry_id genuinely absent, not undefined
    });
  });

  it('list-entry.deleted also clears the stamped deal-list id, not just the entry id', async () => {
    mockGetLeadByAttioListEntryId.mockResolvedValue({
      leadId: 'lead_1',
      syncMetadata: { attio_record_id: 'person_1', attio_list_entry_id: 'entry_1', attio_deal_list_id: 'deallist_1' },
    });
    const svc = makeSvc();

    await adapter.applyListEntryWebhookEvent('list_1', makeConfig(), svc as any, 'entry_1', 'list-entry.deleted');

    expect(mockUpdateLead).toHaveBeenCalledWith('list_1', 'lead_1', {
      syncMetadata: { attio_record_id: 'person_1' },
    });
  });

  it('list-entry.deleted no-ops when no lead has that entry id on record', async () => {
    mockGetLeadByAttioListEntryId.mockResolvedValue(null);
    const svc = makeSvc();

    await adapter.applyListEntryWebhookEvent('list_1', makeConfig(), svc as any, 'entry_1', 'list-entry.deleted');

    expect(mockUpdateLead).not.toHaveBeenCalled();
  });
});
