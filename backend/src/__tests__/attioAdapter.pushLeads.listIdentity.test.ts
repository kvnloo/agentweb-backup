/**
 * Unit tests for AttioAdapter.pushLeads — list-identity stamping.
 *
 * Live-caught gap: HubSpot always tags every synced contact with which Emma
 * list it came from (lead_list_name/lead_list_id custom properties, injected
 * automatically). Attio had no equivalent — a pushed Person carried no trace
 * of which AgentWeb list synced it. Mirrors hubspotAdapter.ts's
 * HUBSPOT_LIST_IDENTITY_MAPPING / withListIdentityMappings pattern exactly.
 */

jest.mock('../services/db', () => ({
  crmDb: {
    updateLead: jest.fn().mockResolvedValue(undefined),
    getLeadListById: jest.fn().mockResolvedValue({ name: 'Resolved List Name' }),
  },
}));

const mockLoadAttributeTypes = jest.fn();
const mockEnsurePersonAttribute = jest.fn();
const mockUpsertPersonByValues = jest.fn();

const mockSvc = {
  loadAttributeTypes: mockLoadAttributeTypes,
  ensurePersonAttribute: mockEnsurePersonAttribute,
  upsertPersonByValues: mockUpsertPersonByValues,
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
    listName: 'My Lead List',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeLead(overrides: Record<string, any> = {}) {
  return { leadId: 'l1', listId: 'list_1', email: 'jane@acme.com', ...overrides };
}

describe('AttioAdapter.pushLeads — list-identity stamping', () => {
  let adapter: AttioAdapter;

  beforeEach(() => {
    jest.clearAllMocks();
    adapter = new AttioAdapter();
    mockLoadAttributeTypes.mockResolvedValue(new Map());
    mockEnsurePersonAttribute.mockImplementation((rawSlug: string) => Promise.resolve(rawSlug));
    mockUpsertPersonByValues.mockResolvedValue({ recordId: 'person_1', isNew: true });
    (crmDb.getLeadListById as jest.Mock).mockResolvedValue({ name: 'Resolved List Name' });
  });

  it('ensures lead_list_name and lead_list_id as Attio attributes even when customFieldMapping is empty', async () => {
    await adapter.pushLeads(auth, [makeLead()], makeConfig({ customFieldMapping: [] }));

    expect(mockEnsurePersonAttribute).toHaveBeenCalledWith('lead_list_name', expect.any(String), expect.any(String));
    expect(mockEnsurePersonAttribute).toHaveBeenCalledWith('lead_list_id', expect.any(String), expect.any(String));
  });

  it('stamps the resolved list name (from crmDb, not the stale config.listName) and listId onto every pushed Person', async () => {
    await adapter.pushLeads(auth, [makeLead()], makeConfig({ customFieldMapping: [] }));

    const personValues = mockUpsertPersonByValues.mock.calls[0][0];
    expect(personValues.lead_list_name[0].value).toBe('Resolved List Name');
    expect(personValues.lead_list_id[0].value).toBe('list_1');
  });

  it('falls back to config.listName when the list-name lookup fails', async () => {
    (crmDb.getLeadListById as jest.Mock).mockRejectedValue(new Error('not found'));

    await adapter.pushLeads(auth, [makeLead()], makeConfig({ customFieldMapping: [] }));

    const personValues = mockUpsertPersonByValues.mock.calls[0][0];
    expect(personValues.lead_list_name[0].value).toBe('My Lead List');
  });

  it('an explicit user mapping for listName wins over the injected default', async () => {
    const explicitMapping: FieldMapping[] = [
      { agentwebField: 'listName', crmProperty: 'my_custom_list_slug', direction: 'push', enabled: true },
    ];

    await adapter.pushLeads(auth, [makeLead()], makeConfig({ customFieldMapping: explicitMapping }));

    expect(mockEnsurePersonAttribute).toHaveBeenCalledWith('my_custom_list_slug', expect.any(String), expect.any(String));
    expect(mockEnsurePersonAttribute).not.toHaveBeenCalledWith('lead_list_name', expect.any(String), expect.any(String));
    // listId still gets the injected default since it wasn't re-mapped.
    expect(mockEnsurePersonAttribute).toHaveBeenCalledWith('lead_list_id', expect.any(String), expect.any(String));
  });

  it('a disabled explicit listId mapping also wins — the injected default is not re-added', async () => {
    const disabledMapping: FieldMapping[] = [
      { agentwebField: 'listId', crmProperty: 'lead_list_id', direction: 'push', enabled: false },
    ];

    await adapter.pushLeads(auth, [makeLead()], makeConfig({ customFieldMapping: disabledMapping }));

    // Only ensured once (from the disabled entry's presence check, not called since disabled) —
    // the point is no *second* lead_list_id ensure call happens for a duplicate injected row.
    const listIdCalls = mockEnsurePersonAttribute.mock.calls.filter(c => c[0] === 'lead_list_id');
    expect(listIdCalls.length).toBe(0);
  });

  it('skips pushing a lead whose only content is the injected list identity (hasRealProps guard)', async () => {
    const result = await adapter.pushLeads(
      auth,
      [makeLead({ email: undefined })],
      makeConfig({ contactFieldMapping: [], customFieldMapping: [] })
    );

    expect(mockUpsertPersonByValues).not.toHaveBeenCalled();
    expect(result.successCount).toBe(0);
    expect(result.errorCount).toBe(0);
  });
});
