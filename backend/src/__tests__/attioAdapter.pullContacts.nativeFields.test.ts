/**
 * Unit tests for AttioAdapter.pullContacts — non-native contactFieldMapping
 * routing (parity fix mirroring hubspotAdapter.ts's pull-side nativeFields
 * allow-list).
 *
 * Live-caught gap: pullContacts wrote every contactFieldMapping match to
 * leadData[agentwebField] regardless of what agentwebField was — but
 * crmDb.batchCreateLeads/createLead/updateLead only accept a fixed whitelist
 * of top-level lead columns and silently drop anything else. A contact
 * mapping targeting a non-native agentwebField (e.g. a custom "jobLevel"
 * field mapped from an Attio attribute) was pulled from Attio, computed
 * correctly, and then silently discarded before it ever reached the lead.
 */

jest.mock('../services/db', () => ({
  crmDb: {
    batchCreateLeads: jest.fn().mockResolvedValue({ successCount: 0, newCount: 0, mergedCount: 0, errorCount: 0, errors: [] }),
  },
}));

const mockListPeople = jest.fn();
const mockGetPersonValues = jest.fn();
const mockLoadAttributeTypes = jest.fn();

const mockSvc = {
  listPeople: mockListPeople,
  getPersonValues: mockGetPersonValues,
  loadAttributeTypes: mockLoadAttributeTypes,
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

function makeConfig(contactFieldMapping: FieldMapping[]): ExternalCrmSyncConfig {
  return {
    provider: 'attio',
    listId: 'list_1',
    userId: 'user_1',
    apiKeyEncrypted: 'enc',
    autoSyncEnabled: false,
    contactFieldMapping,
    dealFieldMapping: [],
    customFieldMapping: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

describe('AttioAdapter.pullContacts — non-native contact mapping routes to customFields', () => {
  let adapter: AttioAdapter;

  beforeEach(() => {
    jest.clearAllMocks();
    adapter = new AttioAdapter();
    mockListPeople.mockResolvedValue({ people: [{ recordId: 'person_1' }], nextCursor: undefined });
    mockLoadAttributeTypes.mockResolvedValue(new Map([
      ['object:people:email_addresses', 'email_address'],
      ['object:people:job_level', 'text'],
    ]));
  });

  it('routes a non-native agentwebField to customFields, not top-level leadData', async () => {
    mockGetPersonValues.mockResolvedValue({
      email_addresses: [{ email_address: 'jane@acme.com' }],
      job_level: [{ value: 'Senior' }],
    });
    const mapping: FieldMapping[] = [
      { agentwebField: 'email', crmProperty: 'email_addresses', direction: 'both', enabled: true },
      { agentwebField: 'jobLevel', crmProperty: 'job_level', direction: 'both', enabled: true },
    ];

    await adapter.pullContacts(auth, 'list_1', makeConfig(mapping));

    const leadData = (crmDb.batchCreateLeads as jest.Mock).mock.calls[0][1][0];
    expect(leadData.jobLevel).toBeUndefined();
    expect(leadData.customFields.jobLevel).toBe('Senior');
  });

  it('still routes a native agentwebField (title) to top-level leadData', async () => {
    mockGetPersonValues.mockResolvedValue({
      email_addresses: [{ email_address: 'jane@acme.com' }],
      job_title: [{ value: 'CTO' }],
    });
    const mapping: FieldMapping[] = [
      { agentwebField: 'email', crmProperty: 'email_addresses', direction: 'both', enabled: true },
      { agentwebField: 'title', crmProperty: 'job_title', direction: 'both', enabled: true },
    ];

    await adapter.pullContacts(auth, 'list_1', makeConfig(mapping));

    const leadData = (crmDb.batchCreateLeads as jest.Mock).mock.calls[0][1][0];
    expect(leadData.title).toBe('CTO');
    expect(leadData.customFields?.title).toBeUndefined();
  });
});
