jest.mock('../services/orgLeadNotificationService', () => ({ dispatchLeadsCreated: jest.fn().mockResolvedValue(undefined) }));
import { dispatchLeadsCreated } from '../services/orgLeadNotificationService';
// Tests that batchCreateLeads sets nameCompanyKey on new leads when
// firstName + lastName + company are all present. This was a bug where the
// field was never written, breaking Tier 0 sibling matching during enrichment.

const queryPromiseMock = jest.fn();
const getPromiseMock = jest.fn();
const batchWritePromiseMock = jest.fn();
const batchWriteSpy: jest.Mock = jest.fn(() => ({ promise: batchWritePromiseMock }));

jest.mock('aws-sdk', () => ({
  config: { update: jest.fn() },
  DynamoDB: {
    DocumentClient: jest.fn(() => ({
      query: jest.fn(() => ({ promise: queryPromiseMock })),
      get: jest.fn(() => ({ promise: getPromiseMock })),
      put: jest.fn(() => ({ promise: jest.fn().mockResolvedValue({}) })),
      update: jest.fn(() => ({ promise: jest.fn().mockResolvedValue({}) })),
      delete: jest.fn(() => ({ promise: jest.fn().mockResolvedValue({}) })),
      scan: jest.fn(() => ({ promise: jest.fn().mockResolvedValue({ Items: [] }) })),
      batchGet: jest.fn(() => ({ promise: jest.fn().mockResolvedValue({}) })),
      batchWrite: batchWriteSpy,
    })),
  },
  S3: jest.fn(() => ({
    upload: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({ Location: '', Key: '' }) }),
    getObject: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
    getSignedUrl: jest.fn(),
  })),
  SecretsManager: jest.fn(() => ({
    getSecretValue: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({ SecretString: '{}' }) }),
  })),
}));

import { crmDb } from '../services/db';

function batchedItems(): any[] {
  const call = batchWriteSpy.mock.calls[batchWriteSpy.mock.calls.length - 1];
  if (!call) throw new Error('batchWrite was not called');
  const requestItems = (call[0] as any).RequestItems as Record<string, any[]>;
  const allItems: any[] = [];
  for (const reqs of Object.values(requestItems)) {
    for (const r of reqs) if (r.PutRequest?.Item) allItems.push(r.PutRequest.Item);
  }
  return allItems;
}

describe('crmDb.batchCreateLeads — nameCompanyKey (new-lead path)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    queryPromiseMock.mockResolvedValue({ Items: [] });
    getPromiseMock.mockResolvedValue({ Item: { listId: 'list-1', userId: 'user-1' } });
    batchWritePromiseMock.mockResolvedValue({});
  });

  it('sets nameCompanyKey when firstName + lastName + company all present', async () => {
    await crmDb.batchCreateLeads('list-1', [
      { email: 'a@example.com', firstName: 'John', lastName: 'Doe', company: 'Acme' },
    ]);

    const items = batchedItems();
    expect(items).toHaveLength(1);
    expect(items[0].nameCompanyKey).toBe('john|doe|acme');
  });

  it('does not set nameCompanyKey when firstName missing', async () => {
    await crmDb.batchCreateLeads('list-1', [
      { email: 'b@example.com', lastName: 'Doe', company: 'Acme' },
    ]);

    const items = batchedItems();
    expect(items[0].nameCompanyKey).toBeUndefined();
  });

  it('does not set nameCompanyKey when lastName missing', async () => {
    await crmDb.batchCreateLeads('list-1', [
      { email: 'c@example.com', firstName: 'John', company: 'Acme' },
    ]);

    const items = batchedItems();
    expect(items[0].nameCompanyKey).toBeUndefined();
  });

  it('does not set nameCompanyKey when company missing', async () => {
    await crmDb.batchCreateLeads('list-1', [
      { email: 'd@example.com', firstName: 'John', lastName: 'Doe' },
    ]);

    const items = batchedItems();
    expect(items[0].nameCompanyKey).toBeUndefined();
  });

  it('lowercases and trims all three fields in the key', async () => {
    await crmDb.batchCreateLeads('list-1', [
      { email: 'e@example.com', firstName: '  YONATAN ', lastName: ' Pesses ', company: ' Tailor Brands ' },
    ]);

    const items = batchedItems();
    expect(items[0].nameCompanyKey).toBe('yonatan|pesses|tailor brands');
  });

  it('sets nameCompanyKey independently per lead in a batch', async () => {
    await crmDb.batchCreateLeads('list-1', [
      { email: 'f@example.com', firstName: 'Alice', lastName: 'Smith', company: 'Corp' },
      { email: 'g@example.com', firstName: 'Bob' }, // missing lastName + company
    ]);

    const items = batchedItems();
    const alice = items.find(i => i.email === 'f@example.com');
    const bob = items.find(i => i.email === 'g@example.com');
    expect(alice?.nameCompanyKey).toBe('alice|smith|corp');
    expect(bob?.nameCompanyKey).toBeUndefined();
  });
});

// ENG-2082 / ENG-2155: the bulk path never called buildLeadCrmFields, so the HubSpot pull,
// the Attio pull and CSV import — the paths that create most leads — produced rows with no
// `domain`.
//
// `domain` is derived here. `lifecycle` deliberately is NOT: askCrmService reads
// `lead.lifecycle ?? computeLifecycle(...)`, nothing in production advances a stored
// value, so stamping it would pin every bulk-imported lead to `inbox` permanently — the
// exact regression updateLead and setLeadFields strip the stamp to avoid. A first version
// of this work stamped it and these tests asserted that; they now assert the opposite,
// because the reasoning three hundred lines up in the same file says so.
describe('crmDb.batchCreateLeads — derives domain, and deliberately does NOT stamp lifecycle', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    queryPromiseMock.mockResolvedValue({ Items: [] });
    getPromiseMock.mockResolvedValue({ Item: { listId: 'list-1', userId: 'user-1' } });
    batchWritePromiseMock.mockResolvedValue({});
  });

  it('derives domain from the email, and stores NO lifecycle', async () => {
    await crmDb.batchCreateLeads('list-1', [
      { email: 'Ada@Example.COM', firstName: 'Ada' },
    ]);

    const items = batchedItems();
    expect(items[0].domain).toBe('example.com');
    // A stored value would freeze askCrmService's computation for the life of the row.
    expect(items[0].lifecycle).toBeUndefined();
    expect('lifecycle' in items[0]).toBe(false);
  });

  // A phone-only capture has no email, so there is no domain to derive — and no lifecycle
  // either, for the reason above. It is still fully contactable; that is computed on read.
  it('stores neither field for a PHONE-ONLY lead', async () => {
    await crmDb.batchCreateLeads('list-1', [
      { phone: '2125559876', firstName: 'Grace' },
    ]);

    const items = batchedItems();
    expect(items[0].domain).toBeUndefined();
    expect(items[0].lifecycle).toBeUndefined();
  });

  it('leaves both off a lead with neither an email nor a phone', async () => {
    await crmDb.batchCreateLeads('list-1', [
      { firstName: 'Nobody', company: 'Ghost Ltd', linkedin: 'https://linkedin.com/in/nobody' },
    ]);

    const items = batchedItems();
    expect(items[0].lifecycle).toBeUndefined();
    expect(items[0].domain).toBeUndefined();
  });

  it('decides per lead across a batch, not once for the batch', async () => {
    await crmDb.batchCreateLeads('list-1', [
      { email: 'a@alpha.io' },
      { phone: '5551234567' },
      { firstName: 'Neither' },
    ]);

    const items = batchedItems();
    const byId = (pred: (i: any) => boolean) => items.find(pred);
    expect(byId((i) => i.email === 'a@alpha.io')?.domain).toBe('alpha.io');
    expect(byId((i) => i.phone === '5551234567')?.domain).toBeUndefined();
    expect(byId((i) => i.firstName === 'Neither')?.domain).toBeUndefined();
    // No row carries a lifecycle, whatever channels it has.
    expect(items.every((i: any) => i.lifecycle === undefined)).toBe(true);
  });

  // Agreement holds for the inputs this path DERIVES from — an email and a phone. It is
  // not a general equivalence: createLead also honours a caller-supplied `domain` and
  // `lifecycle`, and this path deliberately does not (see the test below). An earlier
  // version of this comment claimed the two "cannot drift again", which overstated what
  // is actually pinned here.
  it('agrees with buildLeadCrmFields on the derived inputs (email, phone)', async () => {
    const { buildLeadCrmFields } = require('../utils/leadSchema');
    for (const lead of [
      { email: 'x@y.com' },
      { phone: '2125550000' },
      { firstName: 'None' },
    ]) {
      jest.clearAllMocks();
      queryPromiseMock.mockResolvedValue({ Items: [] });
      getPromiseMock.mockResolvedValue({ Item: { listId: 'list-1', userId: 'user-1' } });
      batchWritePromiseMock.mockResolvedValue({});

      await crmDb.batchCreateLeads('list-1', [lead]);
      const bulk = batchedItems()[0];
      // buildLeadCrmFields takes (email, extensions). DOMAIN must agree — it is derived
      // once and nothing recomputes it. LIFECYCLE deliberately must NOT: the single-create
      // path stamps it (pre-existing), the bulk path refuses to, because freezing it on
      // the highest-volume path is the regression this test file previously encoded.
      const single = buildLeadCrmFields((lead as any).email, { phone: (lead as any).phone });
      expect(bulk.domain).toBe(single.domain);
      expect(bulk.lifecycle).toBeUndefined();
    }
  });

  // crm.ts's bulk-import spreads `...rest` straight from the request body, so these keys
  // reach batchCreateLeads at runtime even though its input type has neither. The derived
  // values must win: `lifecycle` short-circuits askCrmService's computation permanently,
  // and nothing validates a value arriving this way.
  it('ignores a caller-supplied domain and lifecycle, deriving both instead', async () => {
    await crmDb.batchCreateLeads('list-1', [
      { email: 'ada@real-domain.com', domain: 'attacker-supplied.com', lifecycle: 'paying' } as any,
    ]);

    const items = batchedItems();
    expect(items[0].domain).toBe('real-domain.com');
    expect(items[0].lifecycle).toBeUndefined();
  });

  it('refuses to store a junk lifecycle smuggled through the bulk path', async () => {
    await crmDb.batchCreateLeads('list-1', [
      { email: 'grace@example.com', lifecycle: 'super_duper_customer' } as any,
    ]);

    const items = batchedItems();
    // Not stored at all — so a junk value cannot be either.
    expect(items[0].lifecycle).toBeUndefined();
  });
});


it('notifies only persisted batch rows, leaving DynamoDB unprocessed rows resumable', async () => {
  jest.clearAllMocks();
  queryPromiseMock.mockResolvedValue({ Items: [] });
  getPromiseMock.mockResolvedValue({ Item: { listId: 'list-1', userId: 'user-1' } });
  batchWritePromiseMock.mockImplementationOnce(async () => {
    const request = batchWriteSpy.mock.calls[0][0];
    const table = Object.keys(request.RequestItems)[0];
    return { UnprocessedItems: { [table]: [request.RequestItems[table][1]] } };
  });
  const result = await crmDb.batchCreateLeads('list-1', [
    { email: 'saved@example.com', customFields: {} },
    { email: 'pending@example.com', customFields: {} },
  ]);
  expect(result.newCount).toBe(1);
  expect(result.rowOutcomes).toEqual(['created', 'unprocessed']);
  expect(result.created).toHaveLength(1);
  // batchCreateLeads deliberately calls the batch-optimized dispatchLeadsCreated
  // (one shared routing lookup for the whole import), not the per-lead
  // dispatchLeadCreated that createLead's single-insert path uses.
  expect(dispatchLeadsCreated).toHaveBeenCalledTimes(1);
  expect(dispatchLeadsCreated).toHaveBeenCalledWith('list-1', [result.created[0].leadId], undefined);
});
