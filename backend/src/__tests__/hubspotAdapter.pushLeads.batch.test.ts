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
import { HubSpotService } from '../services/hubspotService';

const mockFromToken = HubSpotService.fromToken as jest.Mock;

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

  // ── 2a. concurrency: the 3 upsert batches overlap end-to-end ───────────────
  it('runs the contact-upsert batches concurrently through the real push path', async () => {
    enableBatch();
    const leads = Array.from({ length: 250 }, (_, i) => ({
      leadId: `l${i}`,
      listId: 'list_1',
      email: `user${i}@example.com`,
      firstName: `User${i}`,
    }));
    // Track how many upsert calls are in flight at once. With default
    // concurrency (6) and 3 batches, all 3 should overlap → peak 3.
    let inFlight = 0;
    let maxInFlight = 0;
    mockBatchUpsertContacts.mockImplementation(async (inputs: any[]) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 15));
      inFlight -= 1;
      return inputs.map((i) => ({ email: i.email, contactId: `c_${i.email}`, isNew: true }));
    });

    const result = await adapter.pushLeads(auth, leads, makeConfig());

    expect(mockBatchUpsertContacts).toHaveBeenCalledTimes(3);
    expect(maxInFlight).toBe(3); // all three batches in flight at once (was 1 before)
    expect(result.successCount).toBe(250);
    expect(result.errorCount).toBe(0);
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

  // ── 6b. 400 INVALID_EMAIL → parse + drop + single retry (NOT bisection) ─────
  function invalidEmail400(...emails: string[]) {
    const arr = emails.map((e) => ({ isValid: false, message: `Email address ${e} is invalid`, error: 'INVALID_EMAIL', name: 'email' }));
    const err: any = new Error('Property values were not valid');
    err.response = { status: 400, data: { message: `Property values were not valid: ${JSON.stringify(arr)}` } };
    return err;
  }

  it('drops a HubSpot-rejected invalid email and retries the rest in ONE call (no bisection)', async () => {
    enableBatch();
    const leads = [
      { leadId: 'l1', listId: 'list_1', email: 'good1@b.com', firstName: 'A' },
      { leadId: 'l2', listId: 'list_1', email: 'bad@x.yc', firstName: 'B' },
      { leadId: 'l3', listId: 'list_1', email: 'good2@b.com', firstName: 'C' },
    ];
    mockBatchUpsertContacts.mockImplementation(async (inputs: any[]) => {
      if (inputs.some((i) => i.email === 'bad@x.yc')) throw invalidEmail400('bad@x.yc');
      return inputs.map((i) => ({ email: i.email, contactId: `c_${i.email}`, isNew: true }));
    });

    const result = await adapter.pushLeads(auth, leads, makeConfig());

    // Original (400) + ONE cleaned retry = 2. Bisection would be 5+.
    expect(mockBatchUpsertContacts).toHaveBeenCalledTimes(2);
    expect(result.successCount).toBe(2);
    expect(result.errorCount).toBe(1);
    expect(result.errors.join(' ')).toMatch(/bad@x\.yc/);
  });

  it('drops ALL invalid emails named in a single 400 in one retry', async () => {
    enableBatch();
    const leads = Array.from({ length: 5 }, (_, i) => ({
      leadId: `l${i}`, listId: 'list_1', email: i < 3 ? `bad${i}@x.yc` : `good${i}@b.com`, firstName: 'A',
    }));
    mockBatchUpsertContacts.mockImplementation(async (inputs: any[]) => {
      const bad = inputs.filter((i) => i.email.endsWith('.yc')).map((i) => i.email);
      if (bad.length) throw invalidEmail400(...bad);
      return inputs.map((i) => ({ email: i.email, contactId: `c_${i.email}`, isNew: true }));
    });

    const result = await adapter.pushLeads(auth, leads, makeConfig());

    expect(mockBatchUpsertContacts).toHaveBeenCalledTimes(2); // one 400 listing all 3 + one cleaned retry
    expect(result.successCount).toBe(2);
    expect(result.errorCount).toBe(3);
  });

  it('counts BOTH leads sharing an invalid email as errors (per-lead tally)', async () => {
    enableBatch();
    const leads = [
      { leadId: 'l1', listId: 'list_1', email: 'dup@x.yc', firstName: 'A' },
      { leadId: 'l2', listId: 'list_1', email: 'dup@x.yc', firstName: 'B' },
      { leadId: 'l3', listId: 'list_1', email: 'good@b.com', firstName: 'C' },
    ];
    mockBatchUpsertContacts.mockImplementation(async (inputs: any[]) => {
      if (inputs.some((i) => i.email === 'dup@x.yc')) throw invalidEmail400('dup@x.yc');
      return inputs.map((i) => ({ email: i.email, contactId: `c_${i.email}`, isNew: true }));
    });

    const result = await adapter.pushLeads(auth, leads, makeConfig());

    expect(result.successCount).toBe(1);          // good@b.com
    expect(result.errorCount).toBe(2);            // BOTH l1 and l2, not 1
    expect(result.successCount + result.errorCount).toBe(3); // == leads attempted
  });

  it('keeps successCount + errorCount equal to leads attempted (mixed valid/invalid/dup)', async () => {
    enableBatch();
    const leads = [
      { leadId: 'l1', listId: 'list_1', email: 'a@b.com', firstName: 'A' },
      { leadId: 'l2', listId: 'list_1', email: 'bad1@x.yc', firstName: 'B' },
      { leadId: 'l3', listId: 'list_1', email: 'a@b.com', firstName: 'A2' },   // dup valid
      { leadId: 'l4', listId: 'list_1', email: 'bad1@x.yc', firstName: 'B2' }, // dup invalid
      { leadId: 'l5', listId: 'list_1', email: 'c@b.com', firstName: 'C' },
    ];
    mockBatchUpsertContacts.mockImplementation(async (inputs: any[]) => {
      const bad = inputs.filter((i) => i.email.endsWith('.yc')).map((i) => i.email);
      if (bad.length) throw invalidEmail400(...bad);
      return inputs.map((i) => ({ email: i.email, contactId: `c_${i.email}`, isNew: true }));
    });

    const result = await adapter.pushLeads(auth, leads, makeConfig());

    expect(result.successCount).toBe(3);  // a@b.com x2 + c@b.com
    expect(result.errorCount).toBe(2);    // bad1@x.yc x2
    expect(result.successCount + result.errorCount).toBe(5);
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

  // ── 7b. dealstage omitted when status has no valid mapping (no INVALID_OPTION) ─
  it('omits dealstage when the AgentWeb status has no mapping (avoids invalid stage)', async () => {
    enableBatch();
    const leads = [
      { leadId: 'l1', listId: 'list_1', email: 'a@b.com', firstName: 'A', status: 'prospect', dealValue: '100' },
    ];
    const stageDealMapping: FieldMapping[] = [
      { agentwebField: 'dealValue', crmProperty: 'amount', direction: 'both', enabled: true },
      { agentwebField: 'status', crmProperty: 'dealstage', direction: 'both', enabled: true },
    ];

    const result = await adapter.pushLeads(auth, leads, makeConfig({ dealFieldMapping: stageDealMapping }));

    expect(mockBatchCreateDeals).toHaveBeenCalledTimes(1);
    const props = mockBatchCreateDeals.mock.calls[0][0][0].properties;
    expect(props.dealstage).toBeUndefined(); // 'prospect' was unmapped → omitted, not sent raw
    expect(props.amount).toBe('100');
    expect(result.errorCount).toBe(0);
  });

  // ── 7c. tally: contact OK + deal fails → ONE error, not success+error ───────
  it('counts a lead as a single error (not success+error) when its deal create fails', async () => {
    enableBatch();
    const leads = [
      { leadId: 'l1', listId: 'list_1', email: 'a@b.com', firstName: 'A', dealValue: '100' },
    ];
    mockBatchCreateDeals.mockRejectedValue(
      Object.assign(new Error('deal boom'), { response: { status: 400, data: { message: 'bad deal' } } })
    );

    const result = await adapter.pushLeads(auth, leads, makeConfig({ dealFieldMapping: dealMapping }));

    expect(result.successCount).toBe(0);                       // contact ok but deal failed → demoted
    expect(result.errorCount).toBe(1);
    expect(result.successCount + result.errorCount).toBe(1);   // counted once
    expect(result.newCount).toBe(0);
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

    // The deal stage (Stage 4) runs AFTER the Stage 3 synced writeback, so the
    // LAST writeback for the lead is authoritative. It must carry the NEW
    // recreated dealId — never the stale (deleted) one. With the in-memory
    // syncMetadata propagation, that final writeback also preserves the fresh
    // upsert contact id (c_a@b.com) + synced status — confirming the clobber fix.
    const allWritebacks = (crmDb.updateLead as jest.Mock).mock.calls.filter((c) => c[1] === 'l1');
    const finalMeta = allWritebacks[allWritebacks.length - 1][2].syncMetadata;
    expect(finalMeta.hubspot_deal_id).toBe('deal_recreated_l1');
    expect(finalMeta.hubspot_contact_id).toBe('c_a@b.com');
    expect(finalMeta.syncStatus).toBe('synced');
    // The recreated dealId is the authoritative final value — the stale id is
    // never the lead's final persisted deal id.
    expect(finalMeta.hubspot_deal_id).not.toBe('deal_stale');
    // And the dedicated deal-stage writeback (the recreated branch) carries the
    // new id, not the stale one.
    const dealStageWriteback = allWritebacks.find(
      (c) => c[2].syncMetadata?.hubspot_deal_id === 'deal_recreated_l1'
    );
    expect(dealStageWriteback).toBeDefined();
    expect(result.errorCount).toBe(0);
  });

  // ── 9c. 207 OBJECT_NOT_FOUND update → reclassified into create ──────────────
  it('reclassifies a 207 OBJECT_NOT_FOUND deal-update into a create', async () => {
    enableBatch();
    const leads = [
      {
        leadId: 'l1', listId: 'list_1', email: 'a@b.com', firstName: 'A', dealValue: '100',
        syncMetadata: { hubspot_contact_id: 'c1', hubspot_deal_id: 'deal_gone' },
      },
    ];
    // A deleted deal surfaces as a 207 per-record OBJECT_NOT_FOUND, NOT a top-level 404.
    const err207: any = new Error('partial');
    err207.response = { status: 207, data: { numErrors: 1, errors: [{ category: 'OBJECT_NOT_FOUND', message: 'gone' }] } };
    mockBatchUpdateDeals.mockRejectedValue(err207);

    const result = await adapter.pushLeads(auth, leads, makeConfig({ dealFieldMapping: dealMapping }));

    // The deleted deal is recreated and associated — same as the 404 path.
    expect(mockBatchCreateDeals).toHaveBeenCalledTimes(1);
    expect(mockBatchCreateDeals.mock.calls[0][0][0].traceId).toBe('l1');
    expect(mockBatchAssociateContactsToDeals).toHaveBeenCalledTimes(1);
    expect(result.errorCount).toBe(0);
  });

  // ── 9d. 207 partial CREATE failure → reported, never silently dropped ───────
  it('records a 207 partial deal-create failure as an error and skips its association', async () => {
    enableBatch();
    const leads = [
      { leadId: 'l1', listId: 'list_1', email: 'a@b.com', firstName: 'A', dealValue: '100' },
    ];
    const err207: any = new Error('partial');
    err207.response = { status: 207, data: { numErrors: 1, errors: [{ category: 'VALIDATION_ERROR', message: 'bad deal' }] } };
    mockBatchCreateDeals.mockRejectedValue(err207);

    const result = await adapter.pushLeads(auth, leads, makeConfig({ dealFieldMapping: dealMapping }));

    expect(result.errorCount).toBeGreaterThan(0);
    expect(result.errors.join(' ')).toMatch(/a@b\.com/);
    // A deal that never got created must not be associated.
    expect(mockBatchAssociateContactsToDeals).not.toHaveBeenCalled();
  });

  // ── 9e. 207 partial ASSOCIATION failure → reported ─────────────────────────
  it('records a 207 partial association failure as an error', async () => {
    enableBatch();
    const leads = [
      { leadId: 'l1', listId: 'list_1', email: 'a@b.com', firstName: 'A', dealValue: '100' },
    ];
    const err207: any = new Error('partial');
    err207.response = { status: 207, data: { numErrors: 1, errors: [{ category: 'VALIDATION_ERROR', message: 'bad assoc' }] } };
    mockBatchAssociateContactsToDeals.mockRejectedValue(err207);

    const result = await adapter.pushLeads(auth, leads, makeConfig({ dealFieldMapping: dealMapping }));

    expect(result.errorCount).toBeGreaterThan(0);
    expect(result.errors.join(' ')).toMatch(/deal/i);
  });

  // ── 9f. ctx reuses one service across chunks (perf: ensure props once) ─────
  it('reuses a single HubSpotService across calls that share one ctx', async () => {
    enableBatch();
    const ctx: Record<string, any> = {};
    await adapter.pushLeads(auth, [{ leadId: 'l1', listId: 'list_1', email: 'a@b.com', firstName: 'A' }], makeConfig(), ctx);
    await adapter.pushLeads(auth, [{ leadId: 'l2', listId: 'list_1', email: 'c@d.com', firstName: 'C' }], makeConfig(), ctx);
    expect(mockFromToken).toHaveBeenCalledTimes(1);
  });

  it('resolves a fresh HubSpotService per call when no ctx is supplied', async () => {
    enableBatch();
    await adapter.pushLeads(auth, [{ leadId: 'l1', listId: 'list_1', email: 'a@b.com', firstName: 'A' }], makeConfig());
    await adapter.pushLeads(auth, [{ leadId: 'l2', listId: 'list_1', email: 'c@d.com', firstName: 'C' }], makeConfig());
    expect(mockFromToken).toHaveBeenCalledTimes(2);
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

  // ── 11. per-lead sync status writeback (synced / sync_failed) ───────────────
  describe('pushLeads — per-lead sync status', () => {
    let adapter: HubspotAdapter;
    const ORIGINAL_FLAG = process.env.HUBSPOT_BATCH_PUSH_ENABLED;

    beforeEach(() => {
      jest.clearAllMocks();
      mockBatchUpsertContacts.mockImplementation(async (inputs: any[]) =>
        inputs.map((i) => ({ email: i.email, contactId: `c_${i.email}`, isNew: true }))
      );
      mockBatchCreateDeals.mockImplementation(async (inputs: any[]) =>
        inputs.map((i) => ({ traceId: i.traceId, dealId: `deal_${i.traceId}` }))
      );
      mockBatchUpdateDeals.mockResolvedValue(undefined);
      mockBatchAssociateContactsToDeals.mockResolvedValue(undefined);
      mockUpsertContact.mockResolvedValue({ contactId: 'c1', isNew: true });
      mockCreateContact.mockResolvedValue({ contactId: 'c_created' });
      mockUpdateContact.mockResolvedValue({ contactId: 'c_updated' });
      (crmDb.getLeadListById as jest.Mock).mockResolvedValue({ listId: 'list_1', name: 'Q1 Outbound' });
      process.env.HUBSPOT_BATCH_PUSH_ENABLED = 'true';
      adapter = new HubspotAdapter();
    });

    afterEach(() => {
      if (ORIGINAL_FLAG === undefined) delete process.env.HUBSPOT_BATCH_PUSH_ENABLED;
      else process.env.HUBSPOT_BATCH_PUSH_ENABLED = ORIGINAL_FLAG;
    });

    it('marks a successfully upserted lead synced with lastSyncedAt and clears prior error', async () => {
      const lead = {
        leadId: 'l1', listId: 'list_1', email: 'good@example.com', firstName: 'Good',
        syncMetadata: { syncError: 'old failure' },
      };

      await adapter.pushLeads(auth, [lead], makeConfig());

      const calls = (crmDb.updateLead as jest.Mock).mock.calls;
      const meta = calls.find((c) => c[1] === lead.leadId)?.[2]?.syncMetadata;
      expect(meta).toBeDefined();
      expect(meta.syncStatus).toBe('synced');
      expect(meta.hubspot_contact_id).toBeTruthy();
      expect(typeof meta.lastSyncedAt).toBe('string');
      expect('syncError' in meta).toBe(false);
    });

    it('marks exactly the failing lead sync_failed when its email is rejected', async () => {
      const goodLead = { leadId: 'l1', listId: 'list_1', email: 'good@x.com', firstName: 'Good' };
      const badLead = { leadId: 'l2', listId: 'list_1', email: 'bad@x.yc', firstName: 'Bad' };
      // HubSpot rejects bad@x.yc as invalid; good@x.com resolves.
      mockBatchUpsertContacts.mockImplementation(async (inputs: any[]) => {
        if (inputs.some((i) => i.email === 'bad@x.yc')) throw invalidEmail400('bad@x.yc');
        return inputs.map((i) => ({ email: i.email, contactId: `c_${i.email}`, isNew: true }));
      });

      await adapter.pushLeads(auth, [goodLead, badLead], makeConfig());

      const calls = (crmDb.updateLead as jest.Mock).mock.calls;
      const goodMeta = calls.find((c) => c[1] === goodLead.leadId)?.[2]?.syncMetadata;
      const badMeta = calls.find((c) => c[1] === badLead.leadId)?.[2]?.syncMetadata;
      expect(goodMeta.syncStatus).toBe('synced');
      expect(badMeta.syncStatus).toBe('sync_failed');
      expect(typeof badMeta.syncError).toBe('string');
    });

    it('marks an invalid-email lead sync_failed (local format check, before HubSpot)', async () => {
      const goodLead = { leadId: 'l1', listId: 'list_1', email: 'good@example.com', firstName: 'Good' };
      const badLead = { leadId: 'l2', listId: 'list_1', email: 'https://superdm.me/x', firstName: 'Bad' };

      await adapter.pushLeads(auth, [goodLead, badLead], makeConfig());

      const calls = (crmDb.updateLead as jest.Mock).mock.calls;
      const goodMeta = calls.find((c) => c[1] === goodLead.leadId)?.[2]?.syncMetadata;
      const badMeta = calls.find((c) => c[1] === badLead.leadId)?.[2]?.syncMetadata;
      expect(goodMeta.syncStatus).toBe('synced');
      expect(badMeta.syncStatus).toBe('sync_failed');
      expect(typeof badMeta.syncError).toBe('string');
    });

    it('preserves hubspot_contact_id AND syncStatus after the deal writeback', async () => {
      const lead = {
        leadId: 'l1', listId: 'list_1', email: 'a@b.com', firstName: 'A', dealValue: '100',
      };

      await adapter.pushLeads(auth, [lead], makeConfig({ dealFieldMapping: dealMapping }));

      const calls = (crmDb.updateLead as jest.Mock).mock.calls.filter((c) => c[1] === lead.leadId);
      const last = calls[calls.length - 1][2].syncMetadata;
      expect(last.hubspot_contact_id).toBeTruthy();
      expect(last.hubspot_deal_id).toBeTruthy();
      expect(last.syncStatus).toBe('synced');
    });

    it('marks a lead sync_failed via the per-lead path when its upsert throws (flag off)', async () => {
      process.env.HUBSPOT_BATCH_PUSH_ENABLED = 'false';
      const lead = { leadId: 'l1', listId: 'list_1', email: 'a@b.com', firstName: 'A' };
      mockUpsertContact.mockRejectedValue(new Error('boom'));

      await adapter.pushLeads(auth, [lead], makeConfig());

      const calls = (crmDb.updateLead as jest.Mock).mock.calls;
      const meta = calls.find((c) => c[1] === lead.leadId)?.[2]?.syncMetadata;
      expect(meta.syncStatus).toBe('sync_failed');
      expect(typeof meta.syncError).toBe('string');
    });
  });

  // ── Contact push constants (hs_marketable_status / lifecyclestage) ─────────
  describe('list-level contact constants', () => {
    function upsertProps(): Record<string, string> {
      // The single upsert input's properties (batched path always sends 1 here).
      return mockBatchUpsertContacts.mock.calls[0][0][0].properties;
    }

    it('stamps hs_marketable_status=false on every contact when configured (batched)', async () => {
      enableBatch();
      const leads = [{ leadId: 'l1', listId: 'list_1', email: 'a@b.com', firstName: 'A' }];

      await adapter.pushLeads(auth, leads, makeConfig({ hubspotMarketableStatus: false }));

      expect(upsertProps().hs_marketable_status).toBe('false');
    });

    it('stamps hs_marketable_status=true when configured true (batched)', async () => {
      enableBatch();
      const leads = [{ leadId: 'l1', listId: 'list_1', email: 'a@b.com', firstName: 'A' }];

      await adapter.pushLeads(auth, leads, makeConfig({ hubspotMarketableStatus: true }));

      expect(upsertProps().hs_marketable_status).toBe('true');
    });

    it('stamps the configured lifecyclestage internal value on every contact (batched)', async () => {
      enableBatch();
      const leads = [{ leadId: 'l1', listId: 'list_1', email: 'a@b.com', firstName: 'A' }];

      await adapter.pushLeads(auth, leads, makeConfig({ hubspotLifecycleStage: '12345678' }));

      expect(upsertProps().lifecyclestage).toBe('12345678');
    });

    it('omits both constants when neither is configured (batched)', async () => {
      enableBatch();
      const leads = [{ leadId: 'l1', listId: 'list_1', email: 'a@b.com', firstName: 'A' }];

      await adapter.pushLeads(auth, leads, makeConfig());

      const props = upsertProps();
      expect(props.hs_marketable_status).toBeUndefined();
      expect(props.lifecyclestage).toBeUndefined();
    });

    it('does NOT resurrect an empty (content-less) lead into a junk contact (batched)', async () => {
      enableBatch();
      // Email-less, no real props — only the constants would apply. The skip-empty
      // guard must drop it BEFORE constants are stamped, so nothing is pushed.
      const leads = [{ leadId: 'l1', listId: 'list_1' }];

      const result = await adapter.pushLeads(
        auth, leads,
        makeConfig({ hubspotMarketableStatus: false, hubspotLifecycleStage: '12345678' }),
      );

      expect(mockBatchUpsertContacts).not.toHaveBeenCalled();
      expect(mockCreateContact).not.toHaveBeenCalled();
      expect(result.successCount).toBe(0);
    });

    it('stamps the constants via the per-lead path too (flag off)', async () => {
      process.env.HUBSPOT_BATCH_PUSH_ENABLED = 'false';
      const leads = [{ leadId: 'l1', listId: 'list_1', email: 'a@b.com', firstName: 'A' }];

      await adapter.pushLeads(
        auth, leads,
        makeConfig({ hubspotMarketableStatus: false, hubspotLifecycleStage: '99' }),
      );

      const data = mockUpsertContact.mock.calls[0][0];
      expect(data.customFields.hs_marketable_status).toBe('false');
      expect(data.customFields.lifecyclestage).toBe('99');
    });

    it('does not clobber an explicit per-lead mapping to the same property', async () => {
      enableBatch();
      // An explicit contact mapping sets lifecyclestage per-lead → constant must yield.
      const mappingWithLifecycle: FieldMapping[] = [
        ...contactMapping,
        { agentwebField: 'stage', crmProperty: 'lifecyclestage', direction: 'push', enabled: true },
      ];
      const leads = [{ leadId: 'l1', listId: 'list_1', email: 'a@b.com', firstName: 'A', stage: 'customer' }];

      await adapter.pushLeads(
        auth, leads,
        makeConfig({ contactFieldMapping: mappingWithLifecycle, hubspotLifecycleStage: '12345678' }),
      );

      expect(upsertProps().lifecyclestage).toBe('customer');
    });
  });
});
