/**
 * Unit tests for AttioAdapter.pullContacts — Company field mapping.
 *
 * A Person's linked Attio Company record's own attributes (industry, employee
 * range, ARR, custom company attributes) aren't part of the Person's own
 * attribute set — they live on a separate Company record, referenced via
 * personValues.company[0].target_record_id. This mapping is pull-only by
 * design: it's not wired into the real-time webhook auto-sync, since a
 * Company record change never fires an event on the linked Person, so there's
 * no reliable real-time trigger (see companyFieldMapping's doc comment in
 * externalCrmSyncService.ts). It rides on the same manual/periodic Pull that
 * already re-resolves each person's company name fresh on every run.
 */

jest.mock('../services/db', () => ({
  crmDb: {
    batchCreateLeads: jest.fn().mockResolvedValue({ successCount: 0, newCount: 0, mergedCount: 0, errorCount: 0, errors: [] }),
  },
}));

const mockListPeople = jest.fn();
const mockGetPersonValues = jest.fn();
const mockLoadAttributeTypes = jest.fn();
const mockGetCompanyValues = jest.fn();
const mockGetCompanyById = jest.fn();

const mockSvc = {
  listPeople: mockListPeople,
  getPersonValues: mockGetPersonValues,
  loadAttributeTypes: mockLoadAttributeTypes,
  getCompanyValues: mockGetCompanyValues,
  getCompanyById: mockGetCompanyById,
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

const companyMapping: FieldMapping[] = [
  { agentwebField: 'industry', crmProperty: 'industry', direction: 'both', enabled: true },
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
    companyFieldMapping: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function makePerson(recordId = 'person_1') {
  return { recordId };
}

describe('AttioAdapter.pullContacts — company field mapping', () => {
  let adapter: AttioAdapter;

  beforeEach(() => {
    jest.clearAllMocks();
    adapter = new AttioAdapter();
    mockListPeople.mockResolvedValue({ people: [makePerson()], nextCursor: undefined });
    mockGetPersonValues.mockResolvedValue({
      email_addresses: [{ email_address: 'jane@acme.com' }],
      company: [{ target_record_id: 'company_1' }],
    });
    mockLoadAttributeTypes.mockImplementation((objectSlug: string) =>
      Promise.resolve(objectSlug === 'companies'
        ? new Map([['object:companies:industry', 'text']])
        : new Map([['object:people:email_addresses', 'email_address']]))
    );
    mockGetCompanyValues.mockResolvedValue({ industry: [{ value: 'Software' }] });
    mockGetCompanyById.mockResolvedValue({ recordId: 'company_1', name: 'Acme Corp' });
  });

  // ─── Gate ──────────────────────────────────────────────────────────────────

  it('never loads company attribute types or fetches company values when no company mapping is enabled', async () => {
    await adapter.pullContacts(auth, 'list_1', makeConfig({ companyFieldMapping: [] }));
    expect(mockLoadAttributeTypes).not.toHaveBeenCalledWith('companies');
    expect(mockGetCompanyValues).not.toHaveBeenCalled();
  });

  it('treats a missing companyFieldMapping (pre-existing config) the same as an empty one', async () => {
    const config = makeConfig();
    delete (config as any).companyFieldMapping;
    await adapter.pullContacts(auth, 'list_1', config);
    expect(mockGetCompanyValues).not.toHaveBeenCalled();
  });

  it('does not fetch company values for a person with no linked company', async () => {
    mockGetPersonValues.mockResolvedValue({ email_addresses: [{ email_address: 'jane@acme.com' }] }); // no company ref
    await adapter.pullContacts(auth, 'list_1', makeConfig({ companyFieldMapping: companyMapping }));
    expect(mockGetCompanyValues).not.toHaveBeenCalled();
  });

  // ─── Graceful degrade ──────────────────────────────────────────────────────

  it('degrades to no company custom fields (not a pull failure) when getCompanyValues throws', async () => {
    mockGetCompanyValues.mockRejectedValue(new Error('rate limited'));

    const result = await adapter.pullContacts(auth, 'list_1', makeConfig({ companyFieldMapping: companyMapping }));

    expect(result.errorCount).toBe(0);
    const call = (crmDb.batchCreateLeads as jest.Mock).mock.calls[0];
    expect(call[1][0].email).toBe('jane@acme.com'); // contact pull still succeeded
    expect(call[1][0].customFields?.industry).toBeUndefined();
  });

  // ─── Success path ──────────────────────────────────────────────────────────

  it('maps a Company attribute into the lead\'s customFields', async () => {
    await adapter.pullContacts(auth, 'list_1', makeConfig({ companyFieldMapping: companyMapping }));

    const call = (crmDb.batchCreateLeads as jest.Mock).mock.calls[0];
    expect(mockGetCompanyValues).toHaveBeenCalledWith('company_1');
    expect(call[1][0].customFields.industry).toBe('Software');
  });

  it('fetches a shared company only once per pull run, not once per person', async () => {
    mockListPeople.mockResolvedValue({
      people: [makePerson('person_1'), makePerson('person_2')],
      nextCursor: undefined,
    });
    mockGetPersonValues.mockImplementation((recordId: string) => Promise.resolve({
      email_addresses: [{ email_address: `${recordId}@acme.com` }],
      company: [{ target_record_id: 'company_1' }], // both people share the same company
    }));

    await adapter.pullContacts(auth, 'list_1', makeConfig({ companyFieldMapping: companyMapping }));

    expect(mockGetCompanyValues).toHaveBeenCalledTimes(1);
    const call = (crmDb.batchCreateLeads as jest.Mock).mock.calls[0];
    expect(call[1][0].customFields.industry).toBe('Software');
    expect(call[1][1].customFields.industry).toBe('Software');
  });

  it('respects the enabled flag — a disabled company mapping is not synced', async () => {
    const disabled: FieldMapping[] = [{ ...companyMapping[0], enabled: false }];
    await adapter.pullContacts(auth, 'list_1', makeConfig({ companyFieldMapping: disabled }));

    const call = (crmDb.batchCreateLeads as jest.Mock).mock.calls[0];
    expect(call[1][0].customFields?.industry).toBeUndefined();
  });

  it('respects a push-only direction — not synced on pull', async () => {
    const pushOnly: FieldMapping[] = [{ ...companyMapping[0], direction: 'push' }];
    await adapter.pullContacts(auth, 'list_1', makeConfig({ companyFieldMapping: pushOnly }));

    const call = (crmDb.batchCreateLeads as jest.Mock).mock.calls[0];
    expect(call[1][0].customFields?.industry).toBeUndefined();
  });

  it('leaves the existing company-name resolution (contactFieldMapping) unaffected — still uses getCompanyById, not getCompanyValues', async () => {
    const withNameMapping = [
      ...contactMapping,
      { agentwebField: 'company', crmProperty: 'company', direction: 'both' as const, enabled: true },
    ];
    await adapter.pullContacts(auth, 'list_1', makeConfig({
      contactFieldMapping: withNameMapping,
      companyFieldMapping: companyMapping,
    }));

    const call = (crmDb.batchCreateLeads as jest.Mock).mock.calls[0];
    expect(mockGetCompanyById).toHaveBeenCalledWith('company_1');
    expect(call[1][0].company).toBe('Acme Corp');
    expect(call[1][0].customFields.industry).toBe('Software');
  });

  it('loads companies attribute types only once across multiple people', async () => {
    mockListPeople.mockResolvedValue({ people: [makePerson('p1'), makePerson('p2')], nextCursor: undefined });
    mockGetPersonValues.mockResolvedValue({
      email_addresses: [{ email_address: 'x@acme.com' }],
      company: [{ target_record_id: 'company_1' }],
    });

    await adapter.pullContacts(auth, 'list_1', makeConfig({ companyFieldMapping: companyMapping }));

    const companiesCalls = mockLoadAttributeTypes.mock.calls.filter(c => c[0] === 'companies');
    expect(companiesCalls.length).toBe(1);
  });
});
