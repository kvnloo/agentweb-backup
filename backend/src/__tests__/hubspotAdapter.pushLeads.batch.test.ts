/**
 * Unit tests for HubspotAdapter.pushLeads — BATCHED push path (flag-gated).
 *
 * Covers the new HUBSPOT_BATCH_PUSH_ENABLED='true' code path which upserts
 * contacts / creates / updates / associates deals in batches via the HubSpot
 * batch APIs, isolating bad items through splitAndRetry. The per-lead path
 * (flag off) must remain the default and untouched.
 */

// Mock crmDb so persistence calls are no-ops we can assert on.
jest.mock('../services/db', () => ({
  crmDb: {
    updateLead: jest.fn().mockResolvedValue(undefined),
    getLeadListById: jest.fn().mockResolvedValue({ listId: 'list_1', name: 'Q1 Outbound' }),
  },
}));

// Mock HubSpotService — fromToken/create return a stub service we can assert on.
const mockUpsertContact = jest.fn();
const mockCreateContact = jest.fn();
const mockUpdateContact = jest.fn();
const mockEnsureContactProperty = jest.fn().mockResolvedValue('prop');
const mockEnsureDealProperty = jest.fn().mockResolvedValue('prop');
const mockCreateDeal = jest.fn();
const mockUpdateDeal = jest.fn();
const mockAssociateContactToDeal = jest.fn();

// New batch methods
const mockBatchUpsertContacts = jest.fn();
const mockBatchCreateDeals = jest.fn();
const mockBatchUpdateDeals = jest.fn();
const mockBatchAssociateContactsToDeals = jest.fn();

const mockSvc = {
  upsertContact: mockUpsertContact,
  createContact: mockCreateContact,
  updateContact: mockUpdateContact,
  ensureContactProperty: mockEnsureContactProperty,
  ensureDealProperty: mockEnsureDealProperty,
  createDeal: mockCreateDeal,
  updateDeal: mockUpdateDeal,
  associateContactToDeal: mockAssociateContactToDeal,
  batchUpsertContacts: mockBatchUpsertContacts,
  batchCreateDeals: mockBatchCreateDeals,
  batchUpdateDeals: mockBatchUpdateDeals,
  batchAssociateContactsToDeals: mockBatchAssociateContactsToDeals,
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

const dealMapping: FieldMapping[] = [
  { agentwebField: 'dealValue', crmProperty: 'amount', direction: 'both', enabled: true },
];

describe('HubspotAdapter.pushLeads — batched push path', () => {
  let adapter: HubspotAdapter;
  const ORIGINAL_FLAG = process.env.HUBSPOT_BATCH_PUSH_ENABLED;

  beforeEach(() => {
    jest.clearAllMocks();
    // Default batch behaviors: echo back contacts as new, deals get ids.
    mockBatchUpsertContacts.mockImplementation(async (inputs: any[]) =>
      inputs.map((i, idx) => ({ email: i.email, contactId: `c_${i.email}`, isNew: true }))
    );
    mockBatchCreateDeals.mockImplementation(async (inputs: any[]) =>
      inputs.map((i) => ({ traceId: i.traceId, dealId: `deal_${i.traceId}` }))
    );
    mockBatchUpdateDeals.mockResolvedValue(undefined);
    mockBatchAssociateContactsToDeals.mockResolvedValue(undefined);
    // Per-lead fallbacks (used by emailless leads + flag-off test)
    mockUpsertContact.mockResolvedValue({ contactId: 'c1', isNew: true });
    mockCreateContact.mockResolvedValue({ contactId: 'c_created' });
    mockUpdateContact.mockResolvedValue({ contactId: 'c_updated' });
    mockCreateDeal.mockResolvedValue('deal_new');
    mockUpdateDeal.mockResolvedValue(undefined);
    mockAssociateContactToDeal.mockResolvedValue(undefined);
    (crmDb.getLeadListById as jest.Mock).mockResolvedValue({ listId: 'list_1', name: 'Q1 Outbound' });
    adapter = new HubspotAdapter();
  });

  afterEach(() => {
    if (ORIGINAL_FLAG === undefined) delete process.env.HUBSPOT_BATCH_PUSH_ENABLED;
    else process.env.HUBSPOT_BATCH_PUSH_ENABLED = ORIGINAL_FLAG;
  });

  function enableBatch() {
    process.env.HUBSPOT_BATCH_PUSH_ENABLED = 'true';
  }

  // ── 1. Flag OFF → per-lead path ────────────────────────────────────────────
  it('falls back to the per-lead path when the flag is off (batch methods NOT called)', async () => {
    process.env.HUBSPOT_BATCH_PUSH_ENABLED = 'false';
    const leads = [{ leadId: 'l1', listId: 'list_1', email: 'real@example.com', firstName: 'Real' }];

    const result = await adapter.pushLeads(auth, leads, makeConfig());

    expect(mockUpsertContact).toHaveBeenCalledTimes(1);
    expect(mockBatchUpsertContacts).not.toHaveBeenCalled();
    expect(mockBatchCreateDeals).not.toHaveBeenCalled();
    expect(result.successCount).toBe(1);
    expect(result.newCount).toBe(1);
  });

  // ── 2. 250 email leads → chunked 100/100/50 ────────────────────────────────
  it('batch-upserts 250 email leads in chunks of 100/100/50 and writes back contact ids', async () => {
    enableBatch();
    const leads = Array.from({ length: 250 }, (_, i) => ({
      leadId: `l${i}`,
      listId: 'list_1',
      email: `user${i}@example.com`,
      firstName: `User${i}`,
    }));
    // Make every 5th lead an "update" (isNew=false) to test newCount/updatedCount split.
    mockBatchUpsertContacts.mockImplementation(async (inputs: any[]) =>
      inputs.map((i) => {
        const n = Number(i.email.replace(/[^0-9]/g, ''));
        return { email: i.email, contactId: `c_${i.email}`, isNew: n % 5 !== 0 };
      })
    );

    const result = await adapter.pushLeads(auth, leads, makeConfig());

    expect(mockBatchUpsertContacts).toHaveBeenCalledTimes(3);
    expect(mockBatchUpsertContacts.mock.calls[0][0]).toHaveLength(100);
    expect(mockBatchUpsertContacts.mock.calls[1][0]).toHaveLength(100);
    expect(mockBatchUpsertContacts.mock.calls[2][0]).toHaveLength(50);
    // 250 / 5 = 50 updates, 200 new.
    expect(result.successCount).toBe(250);
    expect(result.newCount).toBe(200);
    expect(result.updatedCount).toBe(50);
    expect(result.errorCount).toBe(0);
    // hubspot_contact_id written back for every lead.
    expect((crmDb.updateLead as jest.Mock)).toHaveBeenCalledTimes(250);
    const sample = (crmDb.updateLead as jest.Mock).mock.calls[0];
    expect(sample[2].syncMetadata.hubspot_contact_id).toMatch(/^c_/);
  });

  // ── 2b. BUG 2: two leads sharing one email → one upsert input, both counted ─
  it('dedups same-email leads to ONE upsert input but counts/writes-back BOTH leads', async () => {
    enableBatch();
    const leads = [
      { leadId: 'l1', listId: 'list_1', email: 'dup@example.com', firstName: 'First' },
      { leadId: 'l2', listId: 'list_1', email: 'DUP@example.com', firstName: 'Second' },
    ];

    const result = await adapter.pushLeads(auth, leads, makeConfig());

    // HubSpot receives ONE input for the shared (lowercased) email — no 409.
    expect(mockBatchUpsertContacts).toHaveBeenCalledTimes(1);
    expect(mockBatchUpsertContacts.mock.calls[0][0]).toHaveLength(1);
    expect(mockBatchUpsertContacts.mock.calls[0][0][0].email).toBe('dup@example.com');

    // BOTH leads counted exactly once (no double-count, no dropped lead).
    expect(result.successCount).toBe(2);
    expect(result.newCount).toBe(2);
    expect(result.errorCount).toBe(0);

    // BOTH leads get hubspot_contact_id written back.
    const contactWritebacks = (crmDb.updateLead as jest.Mock).mock.calls.filter(
      (c) => c[2].syncMetadata?.hubspot_contact_id
    );
    const writtenLeadIds = contactWritebacks.map((c) => c[1]).sort();
    expect(writtenLeadIds).toEqual(['l1', 'l2']);
    for (const c of contactWritebacks) {
      expect(c[2].syncMetadata.hubspot_contact_id).toBe('c_dup@example.com');
    }
  });

  // ── 2c. BUG 2: both same-email leads get a deal ────────────────────────────
  it('creates a deal for BOTH same-email leads (neither is silently dropped)', async () => {
    enableBatch();
    const leads = [
      { leadId: 'l1', listId: 'list_1', email: 'dup@example.com', firstName: 'First', dealValue: '10' },
      { leadId: 'l2', listId: 'list_1', email: 'dup@example.com', firstName: 'Second', dealValue: '20' },
    ];

    await adapter.pushLeads(auth, leads, makeConfig({ dealFieldMapping: dealMapping }));

    const createdTraces = mockBatchCreateDeals.mock.calls.flatMap((c) => c[0].map((x: any) => x.traceId)).sort();
    expect(createdTraces).toEqual(['l1', 'l2']);
  });

  // ── 3. Invalid email excluded ──────────────────────────────────────────────
  it('records an invalid-email lead as an error and excludes it from the batch', async () => {
    enableBatch();
    const leads = [
      { leadId: 'l1', listId: 'list_1', email: 'good@example.com', firstName: 'A' },
      { leadId: 'l2', listId: 'list_1', email: 'https://superdm.me/x', firstName: 'B' },
    ];

    const result = await adapter.pushLeads(auth, leads, makeConfig());

    expect(mockBatchUpsertContacts).toHaveBeenCalledTimes(1);
    expect(mockBatchUpsertContacts.mock.calls[0][0]).toHaveLength(1);
    expect(mockBatchUpsertContacts.mock.calls[0][0][0].email).toBe('good@example.com');
    expect(result.successCount).toBe(1);
    expect(result.errorCount).toBe(1);
    expect(result.errors[0]).toContain('https://superdm.me/x');
    expect(result.errors[0]).toMatch(/invalid email/i);
  });

  // ── 4. Skip-empty (list-identity only) ─────────────────────────────────────
  it('excludes a lead carrying only list-identity props (nothing to sync)', async () => {
    enableBatch();
    const listConfig = makeConfig({
      contactFieldMapping: [{ agentwebField: 'email', crmProperty: 'email', direction: 'both', enabled: true }],
      customFieldMapping: [
        { agentwebField: 'listName', crmProperty: 'lead_list_name', direction: 'push', enabled: true },
        { agentwebField: 'listId', crmProperty: 'lead_list_id', direction: 'push', enabled: true },
      ],
    });
    // Email-less lead with no other content → only list-identity props → skipped.
    const leads = [{ leadId: 'l1', listId: 'list_1' }];

    const result = await adapter.pushLeads(auth, leads, listConfig);

    expect(mockBatchUpsertContacts).not.toHaveBeenCalled();
    expect(mockCreateContact).not.toHaveBeenCalled();
    expect(mockUpdateContact).not.toHaveBeenCalled();
    expect(result.successCount).toBe(0);
    expect(result.errorCount).toBe(0);
  });

  // ── 5. Emailless lead → per-lead path ──────────────────────────────────────
  it('routes an email-less lead to the per-lead path, not the batch upsert', async () => {
    enableBatch();
    const leads = [
      { leadId: 'l1', listId: 'list_1', email: 'with@example.com', firstName: 'Has' },
      { leadId: 'l2', listId: 'list_1', firstName: 'NoEmail' },
    ];

    const result = await adapter.pushLeads(auth, leads, makeConfig());

    // Email lead goes through batch.
    expect(mockBatchUpsertContacts).toHaveBeenCalledTimes(1);
    expect(mockBatchUpsertContacts.mock.calls[0][0]).toHaveLength(1);
    // Email-less lead goes through per-lead create (no email → can't upsert).
    expect(mockCreateContact).toHaveBeenCalledTimes(1);
    expect(mockCreateContact).toHaveBeenCalledWith(expect.objectContaining({ firstName: 'NoEmail' }));
    expect(mockBatchUpsertContacts.mock.calls[0][0][0].email).toBe('with@example.com');
    expect(result.successCount).toBe(2);
  });

  // ── 6. Contact batch throws → splitAndRetry isolates the bad lead ──────────
  it('isolates a failing contact via splitAndRetry: bad lead errored + excluded from deals, rest succeed', async () => {
    enableBatch();
    const leads = [
      { leadId: 'l1', listId: 'list_1', email: 'good1@example.com', firstName: 'A', dealValue: '10' },
      { leadId: 'l2', listId: 'list_1', email: 'bad@example.com', firstName: 'B', dealValue: '20' },
      { leadId: 'l3', listId: 'list_1', email: 'good2@example.com', firstName: 'C', dealValue: '30' },
    ];
    // Throw when the batch contains the bad email; succeed otherwise.
    mockBatchUpsertContacts.mockImplementation(async (inputs: any[]) => {
      if (inputs.some((i) => i.email === 'bad@example.com')) {
        throw new Error('boom on bad lead');
      }
      return inputs.map((i) => ({ email: i.email, contactId: `c_${i.email}`, isNew: true }));
    });

    const result = await adapter.pushLeads(auth, leads, makeConfig({ dealFieldMapping: dealMapping }));

    // Two good contacts succeed, one fails.
    expect(result.successCount).toBe(2);
    expect(result.errorCount).toBe(1);
    expect(result.errors.some((e) => e.includes('bad@example.com'))).toBe(true);
    // Deals only created for the two good leads (bad one excluded).
    const createdTraces = mockBatchCreateDeals.mock.calls.flatMap((c) => c[0].map((x: any) => x.traceId));
    expect(createdTraces).toContain('l1');
    expect(createdTraces).toContain('l3');
    expect(createdTraces).not.toContain('l2');
  });

  // ── 7. New deals → create + associate + writeback ──────────────────────────
  it('creates new deals via batchCreateDeals, associates them, and writes back hubspot_deal_id', async () => {
    enableBatch();
    const leads = [
      { leadId: 'l1', listId: 'list_1', email: 'a@b.com', firstName: 'A', dealValue: '100' },
      { leadId: 'l2', listId: 'list_1', email: 'c@d.com', firstName: 'C', dealValue: '200' },
    ];

    const result = await adapter.pushLeads(auth, leads, makeConfig({ dealFieldMapping: dealMapping }));

    expect(mockBatchCreateDeals).toHaveBeenCalledTimes(1);
    expect(mockBatchCreateDeals.mock.calls[0][0]).toHaveLength(2);
    expect(mockBatchUpdateDeals).not.toHaveBeenCalled();
    expect(mockBatchAssociateContactsToDeals).toHaveBeenCalledTimes(1);
    // Association pairs carry both contactId and dealId.
    const pairs = mockBatchAssociateContactsToDeals.mock.calls[0][0];
    expect(pairs).toHaveLength(2);
    expect(pairs[0]).toEqual(expect.objectContaining({ contactId: expect.any(String), dealId: expect.any(String) }));
    // hubspot_deal_id written back (by trace=leadId).
    const dealWritebacks = (crmDb.updateLead as jest.Mock).mock.calls.filter(
      (c) => c[2].syncMetadata?.hubspot_deal_id
    );
    expect(dealWritebacks).toHaveLength(2);
    expect(dealWritebacks[0][2].syncMetadata.hubspot_deal_id).toMatch(/^deal_/);
    expect(result.errorCount).toBe(0);
  });

  // ── 8. Existing deal → update (not create) ─────────────────────────────────
  it('updates an existing deal via batchUpdateDeals instead of creating', async () => {
    enableBatch();
    const leads = [
      {
        leadId: 'l1', listId: 'list_1', email: 'a@b.com', firstName: 'A', dealValue: '100',
        syncMetadata: { hubspot_contact_id: 'c1', hubspot_deal_id: 'deal_existing' },
      },
    ];

    const result = await adapter.pushLeads(auth, leads, makeConfig({ dealFieldMapping: dealMapping }));

    expect(mockBatchUpdateDeals).toHaveBeenCalledTimes(1);
    expect(mockBatchUpdateDeals.mock.calls[0][0]).toEqual([
      expect.objectContaining({ dealId: 'deal_existing', properties: expect.objectContaining({ amount: '100' }) }),
    ]);
    expect(mockBatchCreateDeals).not.toHaveBeenCalled();
    expect(result.errorCount).toBe(0);
  });

  // ── 9. Deal update 404 → reclassified into create ──────────────────────────
  it('reclassifies a 404 deal-update into a create', async () => {
    enableBatch();
    const leads = [
      {
        leadId: 'l1', listId: 'list_1', email: 'a@b.com', firstName: 'A', dealValue: '100',
        syncMetadata: { hubspot_contact_id: 'c1', hubspot_deal_id: 'deal_gone' },
      },
    ];
    // batchUpdateDeals throws a 404 (whole-batch) → splitAndRetry isolates → adapter reclassifies.
    const err404: any = new Error('not found');
    err404.response = { status: 404 };
    mockBatchUpdateDeals.mockRejectedValue(err404);

    const result = await adapter.pushLeads(auth, leads, makeConfig({ dealFieldMapping: dealMapping }));

    // The deleted deal is recreated.
    expect(mockBatchCreateDeals).toHaveBeenCalledTimes(1);
    const created = mockBatchCreateDeals.mock.calls[0][0];
    expect(created).toHaveLength(1);
    expect(created[0].traceId).toBe('l1');
    // And the replacement deal is associated.
    expect(mockBatchAssociateContactsToDeals).toHaveBeenCalledTimes(1);
    // No spurious error recorded for the 404 (it's a normal recreate path).
    expect(result.errorCount).toBe(0);
  });

  // ── 9b. BUG 1: 404 recreate must NOT write back the stale (deleted) dealId ──
  it('writes back the NEW dealId after a 404 recreate and never the stale one', async () => {
    enableBatch();
    const leads = [
      {
        leadId: 'l1', listId: 'list_1', email: 'a@b.com', firstName: 'A', dealValue: '100',
        syncMetadata: { hubspot_contact_id: 'c1', hubspot_deal_id: 'deal_stale' },
      },
    ];
    const err404: any = new Error('not found');
    err404.response = { status: 404 };
    mockBatchUpdateDeals.mockRejectedValue(err404);
    // Recreated deal gets a brand-new id keyed by trace (leadId).
    mockBatchCreateDeals.mockImplementation(async (inputs: any[]) =>
      inputs.map((i) => ({ traceId: i.traceId, dealId: `deal_recreated_${i.traceId}` }))
    );

    const result = await adapter.pushLeads(auth, leads, makeConfig({ dealFieldMapping: dealMapping }));

    // Deal-stage writebacks are those persisting hubspot_deal_id WITHOUT the fresh
    // upsert contact id (Stage 3's contact-id writeback carries c_a@b.com and merely
    // preserves pre-existing metadata; the deal stage carries the lead's own c1).
    const dealWritebacks = (crmDb.updateLead as jest.Mock).mock.calls.filter(
      (c) =>
        c[2].syncMetadata?.hubspot_deal_id !== undefined &&
        c[2].syncMetadata?.hubspot_contact_id !== 'c_a@b.com'
    );
    // Exactly one deal-stage writeback for l1, carrying the NEW recreated id.
    expect(dealWritebacks).toHaveLength(1);
    expect(dealWritebacks[0][2].syncMetadata.hubspot_deal_id).toBe('deal_recreated_l1');
    // The deal stage must never write back the stale (deleted) dealId.
    const wroteStaleInDealStage = dealWritebacks.some(
      (c) => c[2].syncMetadata?.hubspot_deal_id === 'deal_stale'
    );
    expect(wroteStaleInDealStage).toBe(false);
    expect(result.errorCount).toBe(0);
  });

  // ── 10. Completion log ─────────────────────────────────────────────────────
  it('emits a completion log with counts and durationMs', async () => {
    enableBatch();
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const leads = [{ leadId: 'l1', listId: 'list_1', email: 'a@b.com', firstName: 'A' }];

    await adapter.pushLeads(auth, leads, makeConfig());

    const completion = logSpy.mock.calls.find(
      (c) => typeof c[0] === 'string' && c[0].includes('batch push complete')
    );
    expect(completion).toBeDefined();
    expect(completion![1]).toEqual(
      expect.objectContaining({
        listId: 'list_1',
        leads: 1,
        newCount: expect.any(Number),
        updatedCount: expect.any(Number),
        errorCount: expect.any(Number),
        durationMs: expect.any(Number),
      })
    );
    logSpy.mockRestore();
  });
});
