/**
 * ENG-2171: the BATCHED push path must prefer a contact id we stored over the email.
 *
 * Before: pushLeadsBatched partitioned on email alone, upserted by email and overwrote
 * the stored hubspot_contact_id, so a lead first pushed without an email (contact A)
 * and later given one produced contact B and orphaned A. batchEnabled() defaults true,
 * so this was the production path.
 *
 * HubSpot does not document the response for a missing id on batch update, so the
 * "gone" and failure paths are tested against both plausible shapes and the unknown
 * ones fail closed (lead error, stored id kept, nothing created).
 */

jest.mock('../services/db', () => ({
  crmDb: {
    updateLead: jest.fn().mockResolvedValue(undefined),
    getLeadListById: jest.fn().mockResolvedValue({ listId: 'list_1', name: 'Q1 Outbound' }),
  },
}));

const mockUpsertContact = jest.fn();
const mockCreateContact = jest.fn();
const mockUpdateContact = jest.fn();
const mockBatchUpsertContacts = jest.fn();
const mockBatchUpdateContacts = jest.fn();
const mockBatchCreateDeals = jest.fn();
const mockBatchUpdateDeals = jest.fn();
const mockBatchAssociateContactsToDeals = jest.fn();
const mockGetContactLifecycleStages = jest.fn();

const mockSvc = {
  upsertContact: mockUpsertContact,
  createContact: mockCreateContact,
  updateContact: mockUpdateContact,
  ensureContactProperty: jest.fn().mockResolvedValue('prop'),
  ensureDealProperty: jest.fn().mockResolvedValue('prop'),
  batchUpsertContacts: mockBatchUpsertContacts,
  batchUpdateContacts: mockBatchUpdateContacts,
  batchCreateDeals: mockBatchCreateDeals,
  batchUpdateDeals: mockBatchUpdateDeals,
  batchAssociateContactsToDeals: mockBatchAssociateContactsToDeals,
  getContactLifecycleStages: mockGetContactLifecycleStages,
  getContactById: jest.fn().mockResolvedValue({}),
};
jest.mock('../services/hubspotService', () => ({
  HubSpotService: {
    fromToken: jest.fn(() => mockSvc),
    create: jest.fn(() => Promise.resolve(mockSvc)),
  },
}));

import { HubspotAdapter } from '../services/adapters/hubspotAdapter';
import { ExternalCrmSyncConfig, FieldMapping } from '../services/externalCrmSyncService';
import { CrmAuth } from '../services/adapters/crmAdapterTypes';
import { crmDb } from '../services/db';

const auth: CrmAuth = { type: 'token', apiKey: 'pat-test' };

const contactMapping: FieldMapping[] = [
  { agentwebField: 'email', crmProperty: 'email', direction: 'both', enabled: true },
  { agentwebField: 'firstName', crmProperty: 'firstname', direction: 'both', enabled: true },
];
const dealMapping: FieldMapping[] = [
  { agentwebField: 'dealValue', crmProperty: 'amount', direction: 'both', enabled: true },
];

function makeConfig(overrides: Partial<ExternalCrmSyncConfig> = {}): ExternalCrmSyncConfig {
  return {
    provider: 'hubspot',
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

const lead = (id: string, email: string, storedId?: string, extra: any = {}) => ({
  leadId: id, listId: 'list_1', email, firstName: id,
  ...(storedId ? { syncMetadata: { hubspot_contact_id: storedId } } : {}),
  ...extra,
});

const httpErr = (status: number, data?: any) => {
  const e: any = new Error(`HTTP ${status}`);
  e.response = { status, data };
  return e;
};

/** batchUpdateContacts that throws `err` whenever the batch contains one of `ids`. */
const failWhenContains = (ids: string[], err: any) =>
  mockBatchUpdateContacts.mockImplementation(async (batch: any[]) => {
    if (batch.some((b) => ids.includes(b.id))) throw err;
  });

const persistedMeta = (leadId: string) => {
  const calls = (crmDb.updateLead as jest.Mock).mock.calls.filter((c) => c[1] === leadId);
  return calls[calls.length - 1]?.[2].syncMetadata;
};

describe('HubspotAdapter batched push — stored contact id wins over email (ENG-2171)', () => {
  let adapter: HubspotAdapter;
  const ORIGINAL = { batch: process.env.HUBSPOT_BATCH_PUSH_ENABLED, byId: process.env.HUBSPOT_PUSH_BY_STORED_ID };

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.HUBSPOT_BATCH_PUSH_ENABLED;
    delete process.env.HUBSPOT_PUSH_BY_STORED_ID;
    mockBatchUpsertContacts.mockImplementation(async (inputs: any[]) =>
      inputs.map((i) => ({ email: i.email, contactId: `new_${i.email}`, isNew: true })));
    mockBatchUpdateContacts.mockResolvedValue(undefined);
    mockBatchCreateDeals.mockImplementation(async (inputs: any[]) =>
      inputs.map((i) => ({ traceId: i.traceId, dealId: `deal_${i.traceId}` })));
    mockBatchUpdateDeals.mockResolvedValue(undefined);
    mockBatchAssociateContactsToDeals.mockResolvedValue(undefined);
    mockGetContactLifecycleStages.mockResolvedValue(new Map());
    (crmDb.getLeadListById as jest.Mock).mockResolvedValue({ listId: 'list_1', name: 'Q1 Outbound' });
    adapter = new HubspotAdapter();
  });

  afterEach(() => {
    if (ORIGINAL.batch === undefined) delete process.env.HUBSPOT_BATCH_PUSH_ENABLED;
    else process.env.HUBSPOT_BATCH_PUSH_ENABLED = ORIGINAL.batch;
    if (ORIGINAL.byId === undefined) delete process.env.HUBSPOT_PUSH_BY_STORED_ID;
    else process.env.HUBSPOT_PUSH_BY_STORED_ID = ORIGINAL.byId;
  });

  it('REPRODUCTION: a phone-only lead that later gains an email updates contact A in place — no second contact', async () => {
    const leads = [lead('l1', 'now-has@example.com', 'A')];

    const result = await adapter.pushLeads(auth, leads, makeConfig());

    expect(mockBatchUpdateContacts).toHaveBeenCalledTimes(1);
    expect(mockBatchUpdateContacts.mock.calls[0][0]).toEqual([
      { id: 'A', properties: expect.objectContaining({ email: 'now-has@example.com', firstname: 'l1' }) },
    ]);
    expect(mockBatchUpsertContacts).not.toHaveBeenCalled();
    expect(mockCreateContact).not.toHaveBeenCalled();
    expect(persistedMeta('l1')).toMatchObject({ hubspot_contact_id: 'A', syncStatus: 'synced' });
    expect(result).toMatchObject({ successCount: 1, updatedCount: 1, newCount: 0, errorCount: 0 });
  });

  it('still sends the email when the email mapping is disabled (the per-lead path always does)', async () => {
    const cfg = makeConfig({ contactFieldMapping: [{ ...contactMapping[0], enabled: false }, contactMapping[1]] });

    await adapter.pushLeads(auth, [lead('l1', 'now-has@example.com', 'A')], cfg);

    expect(mockBatchUpdateContacts.mock.calls[0][0][0].properties.email).toBe('now-has@example.com');
  });

  it('also reads the id from customFields.hubspot_contact_id, like the per-lead path', async () => {
    const leads = [lead('l1', 'x@example.com', undefined, { customFields: { hubspot_contact_id: 'CF1' } })];

    await adapter.pushLeads(auth, leads, makeConfig());

    expect(mockBatchUpdateContacts.mock.calls[0][0][0].id).toBe('CF1');
    expect(mockBatchUpsertContacts).not.toHaveBeenCalled();
  });

  it('control: a lead with NO stored id still upserts by email', async () => {
    const result = await adapter.pushLeads(auth, [lead('l1', 'fresh@example.com')], makeConfig());

    expect(mockBatchUpsertContacts).toHaveBeenCalledTimes(1);
    expect(mockBatchUpdateContacts).not.toHaveBeenCalled();
    expect(persistedMeta('l1').hubspot_contact_id).toBe('new_fresh@example.com');
    expect(result).toMatchObject({ successCount: 1, newCount: 1, errorCount: 0 });
  });

  it('kill switch HUBSPOT_PUSH_BY_STORED_ID=off restores upsert-by-email for stored-id leads', async () => {
    process.env.HUBSPOT_PUSH_BY_STORED_ID = 'off';

    await adapter.pushLeads(auth, [lead('l1', 'a@example.com', 'A')], makeConfig());

    expect(mockBatchUpdateContacts).not.toHaveBeenCalled();
    expect(mockBatchUpsertContacts).toHaveBeenCalledTimes(1);
    expect(persistedMeta('l1').hubspot_contact_id).toBe('new_a@example.com');
  });

  it.each(['OFF', ' off ', 'Off'])('kill switch is case- and whitespace-insensitive (%j)', async (value) => {
    process.env.HUBSPOT_PUSH_BY_STORED_ID = value;

    await adapter.pushLeads(auth, [lead('l1', 'a@example.com', 'A')], makeConfig());

    expect(mockBatchUpdateContacts).not.toHaveBeenCalled();
    expect(mockBatchUpsertContacts).toHaveBeenCalledTimes(1);
  });

  describe('a stored contact HubSpot says is gone', () => {
    it.each([
      ['404', httpErr(404)],
      ['410', httpErr(410)],
      ['207 OBJECT_NOT_FOUND', httpErr(207, { numErrors: 1, errors: [{ category: 'OBJECT_NOT_FOUND', message: 'gone' }] })],
    ])('%s: isolates the gone contact, upserts it by email, and leaves the rest of the batch alone', async (_n, err) => {
      failWhenContains(['GONE'], err);
      const leads = [lead('l1', 'ok1@example.com', 'OK1'), lead('l2', 'gone@example.com', 'GONE'), lead('l3', 'ok3@example.com', 'OK3')];

      const result = await adapter.pushLeads(auth, leads, makeConfig());

      expect(persistedMeta('l1').hubspot_contact_id).toBe('OK1');
      expect(persistedMeta('l3').hubspot_contact_id).toBe('OK3');
      // the stale id is replaced by the upsert result — and only for the gone lead
      expect(mockBatchUpsertContacts.mock.calls[0][0].map((i: any) => i.email)).toEqual(['gone@example.com']);
      expect(persistedMeta('l2').hubspot_contact_id).toBe('new_gone@example.com');
      expect(result).toMatchObject({ successCount: 3, updatedCount: 2, newCount: 1, errorCount: 0 });
    });
  });

  describe('failures that are NOT "gone" fail closed — error, stored id kept, nothing created', () => {
    it.each([
      ['409 email collision', httpErr(409, { category: 'CONFLICT' })],
      ['400 validation', httpErr(400, { category: 'VALIDATION_ERROR' })],
      ['207 with a non-not-found category', httpErr(207, { numErrors: 1, errors: [{ category: 'VALIDATION_ERROR', message: 'bad' }] })],
      ['207 with a mixed set of categories', httpErr(207, { numErrors: 2, errors: [{ category: 'OBJECT_NOT_FOUND' }, { category: 'VALIDATION_ERROR' }] })],
    ])('%s', async (_n, err) => {
      failWhenContains(['BAD'], err);
      const leads = [lead('l1', 'ok@example.com', 'OK'), lead('l2', 'bad@example.com', 'BAD')];

      const result = await adapter.pushLeads(auth, leads, makeConfig());

      expect(mockBatchUpsertContacts).not.toHaveBeenCalled();
      expect(mockCreateContact).not.toHaveBeenCalled();
      expect(persistedMeta('l2')).toMatchObject({ hubspot_contact_id: 'BAD', syncStatus: 'sync_failed' });
      expect(persistedMeta('l2').syncError).toContain('BAD');
      expect(persistedMeta('l1')).toMatchObject({ hubspot_contact_id: 'OK', syncStatus: 'synced' });
      expect(result).toMatchObject({ successCount: 1, errorCount: 1 });
      expect(result.errors).toHaveLength(1);
    });

    it.each([['429', 429], ['423', 423], ['503', 503]])(
      '%s fails the chunk ONCE without bisecting (a throttled API must not be hit ~2*log2(n) more times)',
      async (_n, status) => {
        mockBatchUpdateContacts.mockRejectedValue(httpErr(status));
        const leads = Array.from({ length: 6 }, (_, i) => lead(`l${i}`, `u${i}@example.com`, `ID${i}`));

        const result = await adapter.pushLeads(auth, leads, makeConfig());

        expect(mockBatchUpdateContacts).toHaveBeenCalledTimes(1);
        expect(mockBatchUpsertContacts).not.toHaveBeenCalled();
        expect(mockCreateContact).not.toHaveBeenCalled();
        for (let i = 0; i < 6; i++) expect(persistedMeta(`l${i}`)).toMatchObject({ hubspot_contact_id: `ID${i}`, syncStatus: 'sync_failed' });
        expect(result).toMatchObject({ successCount: 0, errorCount: 6 });
      },
    );

    it('a bare 500 IS bisected: one poison record fails alone instead of failing its whole chunk', async () => {
      failWhenContains(['POISON'], httpErr(500));
      const leads = [lead('l1', 'ok1@example.com', 'OK1'), lead('l2', 'p@example.com', 'POISON'), lead('l3', 'ok3@example.com', 'OK3')];

      const result = await adapter.pushLeads(auth, leads, makeConfig());

      expect(persistedMeta('l1')).toMatchObject({ hubspot_contact_id: 'OK1', syncStatus: 'synced' });
      expect(persistedMeta('l3')).toMatchObject({ hubspot_contact_id: 'OK3', syncStatus: 'synced' });
      expect(persistedMeta('l2')).toMatchObject({ hubspot_contact_id: 'POISON', syncStatus: 'sync_failed' });
      expect(mockBatchUpsertContacts).not.toHaveBeenCalled();
      expect(result).toMatchObject({ successCount: 2, errorCount: 1 });
    });

    it('a network error (no HTTP response) is also not bisected', async () => {
      mockBatchUpdateContacts.mockRejectedValue(new Error('socket hang up'));

      const result = await adapter.pushLeads(auth, [lead('l1', 'a@example.com', 'A'), lead('l2', 'b@example.com', 'B')], makeConfig());

      expect(mockBatchUpdateContacts).toHaveBeenCalledTimes(1);
      expect(result.errorCount).toBe(2);
    });
  });

  it('collapses duplicate stored ids to ONE input and succeeds both leads', async () => {
    const leads = [lead('l1', 'same@example.com', 'A'), lead('l2', 'same@example.com', 'A')];

    const result = await adapter.pushLeads(auth, leads, makeConfig());

    expect(mockBatchUpdateContacts.mock.calls[0][0]).toHaveLength(1);
    expect(persistedMeta('l1').hubspot_contact_id).toBe('A');
    expect(persistedMeta('l2').hubspot_contact_id).toBe('A');
    expect(result).toMatchObject({ successCount: 2, errorCount: 0 });
  });

  it('leads that share a stored id but have DIFFERENT emails: the second is not reported synced on the first one\'s data', async () => {
    const leads = [lead('l1', 'a@example.com', 'A'), lead('l2', 'b@example.com', 'A')];

    const result = await adapter.pushLeads(auth, leads, makeConfig());

    // l1 updates contact A; l2 is a different person's email, so it goes the old way (upsert by its OWN email)
    expect(mockBatchUpdateContacts.mock.calls[0][0]).toEqual([
      { id: 'A', properties: expect.objectContaining({ email: 'a@example.com' }) },
    ]);
    expect(mockBatchUpsertContacts.mock.calls[0][0].map((i: any) => i.email)).toEqual(['b@example.com']);
    expect(persistedMeta('l1').hubspot_contact_id).toBe('A');
    expect(persistedMeta('l2').hubspot_contact_id).toBe('new_b@example.com');
    expect(result).toMatchObject({ successCount: 2, errorCount: 0 });
  });

  it('two leads with the SAME email but DIFFERENT stored ids: both are accounted for exactly once', async () => {
    mockBatchUpdateContacts.mockImplementation(async (batch: any[]) => {
      if (batch.some((b) => b.id === 'B')) throw httpErr(409, { category: 'CONFLICT' });
    });
    const leads = [lead('l1', 'same@example.com', 'A'), lead('l2', 'same@example.com', 'B')];

    const result = await adapter.pushLeads(auth, leads, makeConfig());

    expect(mockBatchUpsertContacts).not.toHaveBeenCalled();
    expect(persistedMeta('l1')).toMatchObject({ hubspot_contact_id: 'A', syncStatus: 'synced' });
    expect(persistedMeta('l2')).toMatchObject({ hubspot_contact_id: 'B', syncStatus: 'sync_failed' });
    expect(result.successCount + result.errorCount).toBe(2);
    expect(result).toMatchObject({ successCount: 1, errorCount: 1 });
  });

  it('an error body whose `errors` is not an array cannot break the push (the diagnostic log must not throw)', async () => {
    failWhenContains(['BAD'], httpErr(400, { errors: 'not-an-array' }));
    const leads = [lead('l1', 'ok@example.com', 'OK'), lead('l2', 'bad@example.com', 'BAD')];

    const result = await adapter.pushLeads(auth, leads, makeConfig());

    expect(persistedMeta('l2')).toMatchObject({ hubspot_contact_id: 'BAD', syncStatus: 'sync_failed' });
    expect(persistedMeta('l1')).toMatchObject({ hubspot_contact_id: 'OK', syncStatus: 'synced' });
    expect(result).toMatchObject({ successCount: 1, errorCount: 1 });
  });

  it('shared stored id, different emails, and the first claimer is gone: both upsert by their OWN email', async () => {
    failWhenContains(['A'], httpErr(404));
    const leads = [lead('l1', 'a@example.com', 'A'), lead('l2', 'b@example.com', 'A')];

    const result = await adapter.pushLeads(auth, leads, makeConfig());

    expect(mockBatchUpsertContacts.mock.calls[0][0].map((i: any) => i.email).sort()).toEqual(['a@example.com', 'b@example.com']);
    expect(persistedMeta('l1').hubspot_contact_id).toBe('new_a@example.com');
    expect(persistedMeta('l2').hubspot_contact_id).toBe('new_b@example.com');
    expect(result).toMatchObject({ successCount: 2, errorCount: 0 });
  });

  it('250 stored-id leads are updated in chunks of 100/100/50 and each keeps its own id', async () => {
    const leads = Array.from({ length: 250 }, (_, i) => lead(`l${i}`, `u${i}@example.com`, `ID${i}`));

    const result = await adapter.pushLeads(auth, leads, makeConfig());

    const sizes = mockBatchUpdateContacts.mock.calls.map((c) => c[0].length).sort((a, b) => b - a);
    expect(sizes).toEqual([100, 100, 50]);
    expect(mockBatchUpsertContacts).not.toHaveBeenCalled();
    for (const i of [0, 99, 100, 249]) expect(persistedMeta(`l${i}`).hubspot_contact_id).toBe(`ID${i}`);
    expect(result).toMatchObject({ successCount: 250, updatedCount: 250, errorCount: 0 });
  });

  describe('a lead with no stored id that shares an email with an updated stored-id lead', () => {
    it('adopts that contact instead of upserting (no dependence on HubSpot finding an email just written)', async () => {
      const leads = [lead('l1', 'shared@example.com', 'A'), lead('l2', 'shared@example.com')];

      const result = await adapter.pushLeads(auth, leads, makeConfig());

      expect(mockBatchUpsertContacts).not.toHaveBeenCalled();
      expect(persistedMeta('l1').hubspot_contact_id).toBe('A');
      expect(persistedMeta('l2').hubspot_contact_id).toBe('A');
      expect(result).toMatchObject({ successCount: 2, updatedCount: 2, newCount: 0, errorCount: 0 });
    });

    it('when the stored contact is gone, both leads share ONE upserted contact', async () => {
      failWhenContains(['A'], httpErr(404));
      const leads = [lead('l1', 'shared@example.com', 'A'), lead('l2', 'shared@example.com')];

      const result = await adapter.pushLeads(auth, leads, makeConfig());

      expect(mockBatchUpsertContacts.mock.calls[0][0]).toHaveLength(1);
      expect(persistedMeta('l1').hubspot_contact_id).toBe('new_shared@example.com');
      expect(persistedMeta('l2').hubspot_contact_id).toBe('new_shared@example.com');
      expect(result).toMatchObject({ successCount: 2, errorCount: 0 });
    });
  });

  it('keeps successCount + errorCount equal to the leads attempted across every outcome', async () => {
    failWhenContains(['GONE'], httpErr(404));
    mockBatchUpdateContacts.mockImplementation(async (batch: any[]) => {
      if (batch.some((b) => b.id === 'GONE')) throw httpErr(404);
      if (batch.some((b) => b.id === 'CLASH')) throw httpErr(409);
    });
    const leads = [
      lead('l1', 'ok@example.com', 'OK'),
      lead('l2', 'gone@example.com', 'GONE'),
      lead('l3', 'clash@example.com', 'CLASH'),
      lead('l4', 'fresh@example.com'),
      lead('l5', 'not-an-email', 'X'),
    ];

    const result = await adapter.pushLeads(auth, leads, makeConfig());

    expect(result.successCount + result.errorCount).toBe(leads.length);
    expect(result).toMatchObject({ successCount: 3, errorCount: 2 });
  });

  it('feeds updated stored-id leads into the deal stage under their stored contact id', async () => {
    const leads = [lead('l1', 'deal@example.com', 'A', { dealValue: '100' })];

    const result = await adapter.pushLeads(auth, leads, makeConfig({ dealFieldMapping: dealMapping }));

    expect(mockBatchAssociateContactsToDeals.mock.calls[0][0]).toEqual([
      expect.objectContaining({ contactId: 'A' }),
    ]);
    expect(result.errorCount).toBe(0);
  });

  it('feeds updated stored-id leads into the lifecycle stage under their stored contact id', async () => {
    await adapter.pushLeads(auth, [lead('l1', 'life@example.com', 'A')], makeConfig({ hubspotLifecycleStage: '123' }));

    expect(mockGetContactLifecycleStages).toHaveBeenCalledWith(['A']);
  });

  it('does not change the email-less path: it still goes to the per-lead update-by-id', async () => {
    mockUpdateContact.mockResolvedValue({ contactId: 'A' });
    const leads = [{ leadId: 'l1', listId: 'list_1', phone: '+15550100', firstName: 'P', syncMetadata: { hubspot_contact_id: 'A' } }];

    await adapter.pushLeads(auth, leads, makeConfig({
      contactFieldMapping: [...contactMapping, { agentwebField: 'phone', crmProperty: 'phone', direction: 'both', enabled: true }],
    }));

    expect(mockUpdateContact).toHaveBeenCalledWith('A', expect.anything());
    expect(mockBatchUpdateContacts).not.toHaveBeenCalled();
  });
});
