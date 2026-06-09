/**
 * Tests for HubspotAdapter.pullContacts — regression coverage for the fix that
 * ensures customFields is always set on pulled leads (even as {}) so that
 * batchCreateLeads never receives undefined and triggers the customFieldsGuard warning.
 */

jest.mock('../services/db', () => ({
  crmDb: {
    batchCreateLeads: jest.fn(),
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
