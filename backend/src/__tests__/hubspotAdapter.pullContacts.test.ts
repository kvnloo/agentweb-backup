/**
 * Tests for HubspotAdapter.pullContacts — regression coverage for the fix that
 * ensures customFields is always set on pulled leads (even as {}) so that
 * batchCreateLeads never receives undefined and triggers the customFieldsGuard warning.
 */

jest.mock('../services/db', () => ({
  crmDb: {
    batchCreateLeads: jest.fn(),
    getAllLeadsByListId: jest.fn(),
    updateLead: jest.fn(),
  },
}));

const mockListContactsPage = jest.fn();
const mockGetContactDealAssociations = jest.fn();

jest.mock('../services/hubspotService', () => ({
  HubSpotService: {
    fromToken: jest.fn(() => ({
      listContactsPage: mockListContactsPage,
      getContactDealAssociations: mockGetContactDealAssociations,
    })),
    create: jest.fn(),
  },
}));

import { HubspotAdapter } from '../services/adapters/hubspotAdapter';
import { crmDb } from '../services/db';
import { ExternalCrmSyncConfig } from '../services/externalCrmSyncService';

const auth = { type: 'token' as const, apiKey: 'pat-test' };

function makeConfig(overrides?: Partial<ExternalCrmSyncConfig>): ExternalCrmSyncConfig {
  return {
    provider: 'hubspot',
    listId: 'list-1',
    userId: 'user-1',
    apiKeyEncrypted: 'enc',
    autoSyncEnabled: false,
    contactFieldMapping: [
      { agentwebField: 'email', crmProperty: 'email', direction: 'both', enabled: true },
      { agentwebField: 'firstName', crmProperty: 'firstname', direction: 'both', enabled: true },
    ],
    dealFieldMapping: [],
    customFieldMapping: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('HubspotAdapter.pullContacts — customFields always set', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (crmDb.batchCreateLeads as jest.Mock).mockResolvedValue({
      successCount: 1,
      newCount: 1,
      mergedCount: 0,
      errorCount: 0,
      errors: [],
    });
    mockGetContactDealAssociations.mockResolvedValue([]);
    (crmDb.getAllLeadsByListId as jest.Mock).mockResolvedValue([]);
    (crmDb.updateLead as jest.Mock).mockResolvedValue(undefined);
  });

  it('sets customFields to {} when no custom mappings configured (no undefined)', async () => {
    mockListContactsPage.mockResolvedValueOnce({
      results: [{ id: 'hs-1', properties: { email: 'alice@test.com', firstname: 'Alice' } }],
      nextCursor: undefined,
    });

    const adapter = new HubspotAdapter();
    await adapter.pullContacts(auth, 'list-1', makeConfig());

    const batchCall = (crmDb.batchCreateLeads as jest.Mock).mock.calls[0];
    const leads: any[] = batchCall[1];
    expect(leads[0].customFields).toBeDefined();
    expect(leads[0].customFields).toEqual({});
  });

  it('sets customFields with values when custom mappings have matching contact properties', async () => {
    mockListContactsPage.mockResolvedValueOnce({
      results: [{ id: 'hs-2', properties: { email: 'bob@test.com', my_custom_prop: 'hello' } }],
      nextCursor: undefined,
    });

    const config = makeConfig({
      customFieldMapping: [
        { agentwebField: 'myCustomProp', crmProperty: 'my_custom_prop', direction: 'both', enabled: true },
      ],
    });

    const adapter = new HubspotAdapter();
    await adapter.pullContacts(auth, 'list-1', config);

    const batchCall = (crmDb.batchCreateLeads as jest.Mock).mock.calls[0];
    const leads: any[] = batchCall[1];
    expect(leads[0].customFields).toBeDefined();
    expect(leads[0].customFields).toEqual({ myCustomProp: 'hello' });
  });

  it('sets customFields to {} for multiple contacts when no custom mappings', async () => {
    mockListContactsPage.mockResolvedValueOnce({
      results: [
        { id: 'hs-3', properties: { email: 'a@test.com' } },
        { id: 'hs-4', properties: { email: 'b@test.com' } },
      ],
      nextCursor: undefined,
    });

    const adapter = new HubspotAdapter();
    await adapter.pullContacts(auth, 'list-1', makeConfig());

    const batchCall = (crmDb.batchCreateLeads as jest.Mock).mock.calls[0];
    const leads: any[] = batchCall[1];
    for (const lead of leads) {
      expect(lead.customFields).toBeDefined();
    }
  });
});

/**
 * The email-less pull branch. batchCreateLeads dedupes on email then LinkedIn, so a contact
 * with neither matched nothing and was recreated on every pull. Resolving it by the stored
 * hubspot_contact_id fixes that — but crmDb.updateLead does `SET customFields = :customFields`
 * and `SET syncMetadata = :syncMetadata`, i.e. WHOLESALE MAP REPLACEMENT, where the
 * batchCreateLeads path it bypasses merges both on purpose.
 */
describe('HubspotAdapter.pullContacts — email-less contacts resolved by stored contact id', () => {
  const existingLead = {
    leadId: 'lead-existing',
    listId: 'list-1',
    phone: '2125559876',
    firstName: 'Cal',
    customFields: { lead_score: '90', internal_note: 'VIP — do not lose me' },
    syncMetadata: { hubspot_contact_id: 'hs-9', attio_record_id: 'attio-abc', syncStatus: 'synced' },
  };

  beforeEach(() => {
    (crmDb.getAllLeadsByListId as jest.Mock).mockResolvedValue([existingLead]);
    mockListContactsPage.mockResolvedValueOnce({
      results: [{ id: 'hs-9', properties: { firstname: 'Calvin' } }],
      nextCursor: undefined,
    });
  });

  it('updates the existing lead instead of creating a duplicate', async () => {
    const adapter = new HubspotAdapter();
    await adapter.pullContacts(auth, 'list-1', makeConfig());

    const created = (crmDb.batchCreateLeads as jest.Mock).mock.calls[0]?.[1] ?? [];
    expect(created).toHaveLength(0);
    expect(crmDb.updateLead).toHaveBeenCalledWith('list-1', 'lead-existing', expect.anything());
  });

  it('MERGES customFields rather than replacing them', async () => {
    const adapter = new HubspotAdapter();
    await adapter.pullContacts(auth, 'list-1', makeConfig());

    const [, , updates] = (crmDb.updateLead as jest.Mock).mock.calls[0];
    // The customer's own fields must survive a pull. Replacing the map deletes them all.
    expect(updates.customFields).toMatchObject({
      lead_score: '90',
      internal_note: 'VIP — do not lose me',
    });
  });

  it("MERGES syncMetadata, so another provider's record id is not destroyed", async () => {
    const adapter = new HubspotAdapter();
    await adapter.pullContacts(auth, 'list-1', makeConfig());

    const [, , updates] = (crmDb.updateLead as jest.Mock).mock.calls[0];
    expect(updates.syncMetadata.attio_record_id).toBe('attio-abc');
    expect(updates.syncMetadata.hubspot_contact_id).toBe('hs-9');
  });

  it('does not write at all when nothing changed', async () => {
    mockListContactsPage.mockReset();
    mockListContactsPage.mockResolvedValueOnce({
      results: [{ id: 'hs-9', properties: { firstname: 'Cal' } }],
      nextCursor: undefined,
    });

    const adapter = new HubspotAdapter();
    await adapter.pullContacts(auth, 'list-1', makeConfig());

    expect(crmDb.updateLead).not.toHaveBeenCalled();
  });
});

