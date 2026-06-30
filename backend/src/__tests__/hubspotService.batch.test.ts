/**
 * Unit tests for HubSpotService batch API methods.
 * Covers: batchUpsertContacts, batchCreateDeals, batchUpdateDeals,
 * batchAssociateContactsToDeals.
 *
 * Each method processes a SINGLE batch of at most 100 inputs and THROWS on any
 * non-2xx response (whole-batch failure). Chunking/splitting is handled by a
 * caller, so these methods do NOT chunk — they throw when inputs.length > 100.
 */

process.env.JWT_SECRET = 'test-secret';

jest.mock('axios');
jest.mock('../services/connectedAccountsDb', () => ({
  getAccountsByUserId: jest.fn(),
  getAccountById: jest.fn(),
  updateAccountTokens: jest.fn(),
}));
jest.mock('../config/integrations', () => ({
  getHubSpotConfig: jest.fn().mockResolvedValue({
    clientId: 'test-client-id',
    clientSecret: 'test-client-secret',
    tokenUrl: 'https://api.hubapi.com/oauth/v1/token',
    redirectUri: 'http://localhost:3001/api/oauth/hubspot/callback',
    scopes: ['crm.objects.contacts.read', 'crm.objects.contacts.write'],
    authorizationUrl: 'https://app.hubspot.com/oauth/authorize',
    tokenInfoUrl: 'https://api.hubapi.com/oauth/v1/access-tokens',
  }),
}));

import axios from 'axios';
import { HubSpotService } from '../services/hubspotService';

const mockAxiosPost = axios.post as jest.Mock;
const mockAxiosPatch = axios.patch as jest.Mock;

// ─── batchUpsertContacts ──────────────────────────────────────────────────────

describe('HubSpotService — batchUpsertContacts', () => {
  let svc: HubSpotService;
  beforeEach(() => {
    jest.clearAllMocks();
    svc = HubSpotService.fromToken('valid-token');
  });

  it('maps results back by email and sets isNew from the new flag', async () => {
    mockAxiosPost.mockResolvedValue({
      data: {
        results: [
          { id: 'c-new', properties: { email: 'new@acme.com' }, new: true },
          { id: 'c-old', properties: { email: 'old@acme.com' }, new: false },
        ],
      },
    });

    const result = await svc.batchUpsertContacts([
      { email: 'new@acme.com', properties: { firstname: 'New' } },
      { email: 'old@acme.com', properties: { firstname: 'Old' } },
    ]);

    expect(result).toEqual([
      { email: 'new@acme.com', contactId: 'c-new', isNew: true },
      { email: 'old@acme.com', contactId: 'c-old', isNew: false },
    ]);
  });

  it('treats a missing/false new flag as isNew:false', async () => {
    mockAxiosPost.mockResolvedValue({
      data: {
        results: [
          { id: 'c-1', properties: { email: 'a@acme.com' } }, // no `new` flag
        ],
      },
    });

    const result = await svc.batchUpsertContacts([
      { email: 'a@acme.com', properties: {} },
    ]);
    expect(result).toEqual([{ email: 'a@acme.com', contactId: 'c-1', isNew: false }]);
  });

  it('POSTs to the batch/upsert endpoint with idProperty=email and lowercased emails', async () => {
    mockAxiosPost.mockResolvedValue({
      data: { results: [{ id: 'c-1', properties: { email: 'mixed@acme.com' }, new: true }] },
    });

    await svc.batchUpsertContacts([
      { email: 'MiXeD@Acme.com', properties: { firstname: 'M' } },
    ]);

    expect(mockAxiosPost).toHaveBeenCalledWith(
      expect.stringContaining('crm/v3/objects/contacts/batch/upsert'),
      expect.objectContaining({
        inputs: [
          {
            idProperty: 'email',
            id: 'mixed@acme.com',
            properties: { firstname: 'M' },
          },
        ],
      }),
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer valid-token' }) })
    );
  });

  it('throws when inputs.length > 100 (does not call the API)', async () => {
    const inputs = Array.from({ length: 101 }, (_, i) => ({
      email: `c${i}@acme.com`,
      properties: {},
    }));
    await expect(svc.batchUpsertContacts(inputs)).rejects.toThrow(/100/);
    expect(mockAxiosPost).not.toHaveBeenCalled();
  });

  it('propagates a non-2xx error from the API', async () => {
    mockAxiosPost.mockRejectedValue({ response: { status: 400, data: { message: 'bad request' } } });
    await expect(
      svc.batchUpsertContacts([{ email: 'x@acme.com', properties: {} }])
    ).rejects.toBeDefined();
  });

  it('THROWS on a 207 Multi-Status partial-failure response (does not silently drop failed upserts)', async () => {
    mockAxiosPost.mockResolvedValue({
      status: 207,
      data: {
        status: 'COMPLETE',
        numErrors: 1,
        results: [{ id: 'c-ok', properties: { email: 'ok@acme.com' }, new: true }],
        errors: [{ status: 'error', category: 'VALIDATION_ERROR', message: 'bad email' }],
      },
    });
    await expect(
      svc.batchUpsertContacts([
        { email: 'ok@acme.com', properties: {} },
        { email: 'bad@acme.com', properties: {} },
      ])
    ).rejects.toThrow(/207|partial|VALIDATION_ERROR/i);
  });
});

// ─── batchCreateDeals ─────────────────────────────────────────────────────────

describe('HubSpotService — batchCreateDeals', () => {
  let svc: HubSpotService;
  beforeEach(() => {
    jest.clearAllMocks();
    svc = HubSpotService.fromToken('valid-token');
  });

  it('sends objectWriteTraceId per input to the deals batch/create endpoint', async () => {
    mockAxiosPost.mockResolvedValue({
      data: {
        results: [
          { id: 'd-1', objectWriteTraceId: 'lead-1', properties: {} },
          { id: 'd-2', objectWriteTraceId: 'lead-2', properties: {} },
        ],
      },
    });

    await svc.batchCreateDeals([
      { traceId: 'lead-1', properties: { dealname: 'Deal 1' } },
      { traceId: 'lead-2', properties: { dealname: 'Deal 2' } },
    ]);

    expect(mockAxiosPost).toHaveBeenCalledWith(
      expect.stringContaining('crm/v3/objects/deals/batch/create'),
      expect.objectContaining({
        inputs: [
          { properties: { dealname: 'Deal 1' }, objectWriteTraceId: 'lead-1' },
          { properties: { dealname: 'Deal 2' }, objectWriteTraceId: 'lead-2' },
        ],
      }),
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer valid-token' }) })
    );
  });

  it('maps dealId back by echoed objectWriteTraceId even when response order differs', async () => {
    // Response is in REVERSE order vs inputs — must still map correctly.
    mockAxiosPost.mockResolvedValue({
      data: {
        results: [
          { id: 'd-2', objectWriteTraceId: 'lead-2', properties: {} },
          { id: 'd-1', objectWriteTraceId: 'lead-1', properties: {} },
        ],
      },
    });

    const result = await svc.batchCreateDeals([
      { traceId: 'lead-1', properties: { dealname: 'Deal 1' } },
      { traceId: 'lead-2', properties: { dealname: 'Deal 2' } },
    ]);

    expect(result).toEqual([
      { traceId: 'lead-1', dealId: 'd-1' },
      { traceId: 'lead-2', dealId: 'd-2' },
    ]);
  });

  it('THROWS for a multi-item batch when results have no echoed objectWriteTraceId (ambiguous)', async () => {
    // Positional mapping across a multi-item batch is unsafe (HubSpot does not
    // guarantee order). The method must throw so splitAndRetry isolates to size 1.
    mockAxiosPost.mockResolvedValue({
      data: {
        results: [
          { id: 'd-1', properties: {} }, // no objectWriteTraceId
          { id: 'd-2', properties: {} },
        ],
      },
    });

    await expect(
      svc.batchCreateDeals([
        { traceId: 'lead-1', properties: { dealname: 'Deal 1' } },
        { traceId: 'lead-2', properties: { dealname: 'Deal 2' } },
      ])
    ).rejects.toThrow(/cannot map results to inputs/i);
  });

  it('maps positionally for a SINGLE-item batch with no echo but a real id (unambiguous)', async () => {
    mockAxiosPost.mockResolvedValue({
      data: { results: [{ id: 'd-99', properties: {} }] }, // no objectWriteTraceId
    });

    const result = await svc.batchCreateDeals([
      { traceId: 'lead-1', properties: { dealname: 'Deal 1' } },
    ]);

    expect(result).toEqual([{ traceId: 'lead-1', dealId: 'd-99' }]);
  });

  it('THROWS rather than emit the string "undefined" on an incomplete response', async () => {
    // Two inputs, only one result echoes nothing usable → must NOT yield dealId:"undefined".
    mockAxiosPost.mockResolvedValue({
      data: { results: [{ id: 'd-1', properties: {} }] }, // short response
    });

    await expect(
      svc.batchCreateDeals([
        { traceId: 'lead-1', properties: { dealname: 'Deal 1' } },
        { traceId: 'lead-2', properties: { dealname: 'Deal 2' } },
      ])
    ).rejects.toThrow(/cannot map results to inputs/i);
  });

  it('throws when inputs.length > 100 (does not call the API)', async () => {
    const inputs = Array.from({ length: 101 }, (_, i) => ({
      traceId: `lead-${i}`,
      properties: {},
    }));
    await expect(svc.batchCreateDeals(inputs)).rejects.toThrow(/100/);
    expect(mockAxiosPost).not.toHaveBeenCalled();
  });

  it('propagates a non-2xx error from the API', async () => {
    mockAxiosPost.mockRejectedValue({ response: { status: 500, data: { message: 'boom' } } });
    await expect(
      svc.batchCreateDeals([{ traceId: 'lead-1', properties: {} }])
    ).rejects.toBeDefined();
  });

  it('THROWS on a 207 Multi-Status partial-failure response (does not silently drop failed creates)', async () => {
    mockAxiosPost.mockResolvedValue({
      status: 207,
      data: {
        status: 'COMPLETE',
        numErrors: 1,
        results: [{ id: 'd-ok', objectWriteTraceId: 'lead-ok' }],
        errors: [{ status: 'error', category: 'VALIDATION_ERROR', message: 'bad deal', context: { objectWriteTraceId: ['lead-bad'] } }],
      },
    });
    await expect(
      svc.batchCreateDeals([
        { traceId: 'lead-ok', properties: {} },
        { traceId: 'lead-bad', properties: {} },
      ])
    ).rejects.toThrow(/207|partial|VALIDATION_ERROR/i);
  });

  it('attaches the 207 response to the thrown error so callers can inspect per-record errors', async () => {
    mockAxiosPost.mockResolvedValue({
      status: 207,
      data: { numErrors: 1, results: [], errors: [{ category: 'VALIDATION_ERROR', message: 'bad' }] },
    });
    await svc.batchCreateDeals([{ traceId: 'lead-bad', properties: {} }]).then(
      () => { throw new Error('expected rejection'); },
      (err: any) => {
        expect(err.response?.status).toBe(207);
        expect(err.response?.data?.errors?.[0]?.category).toBe('VALIDATION_ERROR');
      }
    );
  });
});

// ─── batchUpdateDeals ─────────────────────────────────────────────────────────

describe('HubSpotService — batchUpdateDeals', () => {
  let svc: HubSpotService;
  beforeEach(() => {
    jest.clearAllMocks();
    svc = HubSpotService.fromToken('valid-token');
  });

  it('POSTs {id, properties} inputs to the deals batch/update endpoint', async () => {
    mockAxiosPost.mockResolvedValue({ data: { results: [] } });

    await svc.batchUpdateDeals([
      { dealId: 'd-1', properties: { amount: '100' } },
      { dealId: 'd-2', properties: { amount: '200' } },
    ]);

    expect(mockAxiosPost).toHaveBeenCalledWith(
      expect.stringContaining('crm/v3/objects/deals/batch/update'),
      expect.objectContaining({
        inputs: [
          { id: 'd-1', properties: { amount: '100' } },
          { id: 'd-2', properties: { amount: '200' } },
        ],
      }),
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer valid-token' }) })
    );
    // does not use patch
    expect(mockAxiosPatch).not.toHaveBeenCalled();
  });

  it('throws when inputs.length > 100 (does not call the API)', async () => {
    const inputs = Array.from({ length: 101 }, (_, i) => ({
      dealId: `d-${i}`,
      properties: {},
    }));
    await expect(svc.batchUpdateDeals(inputs)).rejects.toThrow(/100/);
    expect(mockAxiosPost).not.toHaveBeenCalled();
  });

  it('propagates a non-2xx error from the API', async () => {
    mockAxiosPost.mockRejectedValue({ response: { status: 502, data: { message: 'gateway' } } });
    await expect(
      svc.batchUpdateDeals([{ dealId: 'd-1', properties: { amount: '1' } }])
    ).rejects.toBeDefined();
  });

  it('THROWS on a 207 Multi-Status partial-failure response (does not silently count failures as success)', async () => {
    mockAxiosPost.mockResolvedValue({
      status: 207,
      data: {
        status: 'COMPLETE',
        numErrors: 1,
        results: [{ id: 'd-1' }],
        errors: [{ status: 'error', category: 'OBJECT_NOT_FOUND', message: 'deal gone', context: { ids: ['d-2'] } }],
      },
    });
    await expect(
      svc.batchUpdateDeals([
        { dealId: 'd-1', properties: { amount: '1' } },
        { dealId: 'd-2', properties: { amount: '2' } },
      ])
    ).rejects.toThrow(/207|partial|OBJECT_NOT_FOUND/i);
  });
});

// ─── batchAssociateContactsToDeals ────────────────────────────────────────────

describe('HubSpotService — batchAssociateContactsToDeals', () => {
  let svc: HubSpotService;
  beforeEach(() => {
    jest.clearAllMocks();
    svc = HubSpotService.fromToken('valid-token');
  });

  it('POSTs the v4 default-batch body shape', async () => {
    mockAxiosPost.mockResolvedValue({ data: { results: [] } });

    await svc.batchAssociateContactsToDeals([
      { contactId: 'c-1', dealId: 'd-1' },
      { contactId: 'c-2', dealId: 'd-2' },
    ]);

    expect(mockAxiosPost).toHaveBeenCalledWith(
      expect.stringContaining('crm/v4/associations/contact/deal/batch/create/default'),
      expect.objectContaining({
        inputs: [
          { from: { id: 'c-1' }, to: { id: 'd-1' } },
          { from: { id: 'c-2' }, to: { id: 'd-2' } },
        ],
      }),
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer valid-token' }) })
    );
  });

  it('throws when pairs.length > 100 (does not call the API)', async () => {
    const pairs = Array.from({ length: 101 }, (_, i) => ({
      contactId: `c-${i}`,
      dealId: `d-${i}`,
    }));
    await expect(svc.batchAssociateContactsToDeals(pairs)).rejects.toThrow(/100/);
    expect(mockAxiosPost).not.toHaveBeenCalled();
  });

  it('propagates a non-2xx error from the API', async () => {
    mockAxiosPost.mockRejectedValue({ response: { status: 400, data: { message: 'bad assoc' } } });
    await expect(
      svc.batchAssociateContactsToDeals([{ contactId: 'c-1', dealId: 'd-1' }])
    ).rejects.toBeDefined();
  });

  it('THROWS on a 207 Multi-Status partial-failure response (does not silently count failures as success)', async () => {
    mockAxiosPost.mockResolvedValue({
      status: 207,
      data: {
        status: 'COMPLETE',
        numErrors: 1,
        results: [],
        errors: [{ status: 'error', category: 'VALIDATION_ERROR', message: 'bad assoc' }],
      },
    });
    await expect(
      svc.batchAssociateContactsToDeals([
        { contactId: 'c-1', dealId: 'd-1' },
        { contactId: 'c-2', dealId: 'd-2' },
      ])
    ).rejects.toThrow(/207|partial|VALIDATION_ERROR/i);
  });
});

// ─── batchUpdateContacts ──────────────────────────────────────────────────────

describe('HubSpotService — batchUpdateContacts', () => {
  let svc: HubSpotService;
  beforeEach(() => {
    jest.clearAllMocks();
    svc = HubSpotService.fromToken('valid-token');
  });

  it('POSTs {id, properties} inputs to the contacts batch/update endpoint', async () => {
    mockAxiosPost.mockResolvedValue({ data: { results: [] } });

    await svc.batchUpdateContacts([
      { id: 'c-1', properties: { lifecyclestage: '' } },
      { id: 'c-2', properties: { lifecyclestage: '12345678' } },
    ]);

    expect(mockAxiosPost).toHaveBeenCalledWith(
      expect.stringContaining('crm/v3/objects/contacts/batch/update'),
      expect.objectContaining({
        inputs: [
          { id: 'c-1', properties: { lifecyclestage: '' } },
          { id: 'c-2', properties: { lifecyclestage: '12345678' } },
        ],
      }),
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer valid-token' }) })
    );
  });

  it('throws when inputs.length > 100 (does not call the API)', async () => {
    const inputs = Array.from({ length: 101 }, (_, i) => ({ id: `c-${i}`, properties: {} }));
    await expect(svc.batchUpdateContacts(inputs)).rejects.toThrow(/100/);
    expect(mockAxiosPost).not.toHaveBeenCalled();
  });

  it('THROWS on a 207 Multi-Status partial-failure response', async () => {
    mockAxiosPost.mockResolvedValue({
      status: 207,
      data: {
        status: 'COMPLETE',
        numErrors: 1,
        results: [{ id: 'c-1' }],
        errors: [{ status: 'error', category: 'VALIDATION_ERROR', message: 'bad stage' }],
      },
    });
    await expect(
      svc.batchUpdateContacts([
        { id: 'c-1', properties: { lifecyclestage: 'x' } },
        { id: 'c-2', properties: { lifecyclestage: 'y' } },
      ])
    ).rejects.toThrow(/207|partial|VALIDATION_ERROR/i);
  });
});

// ─── getContactLifecycleStages ────────────────────────────────────────────────

describe('HubSpotService — getContactLifecycleStages', () => {
  let svc: HubSpotService;
  beforeEach(() => {
    jest.clearAllMocks();
    svc = HubSpotService.fromToken('valid-token');
  });

  it('reads lifecyclestage for a chunk and returns an id → stage map', async () => {
    mockAxiosPost.mockResolvedValue({
      data: { results: [
        { id: 'c-1', properties: { lifecyclestage: 'customer' } },
        { id: 'c-2', properties: { lifecyclestage: '12345678' } },
      ] },
    });

    const map = await svc.getContactLifecycleStages(['c-1', 'c-2']);

    expect(mockAxiosPost).toHaveBeenCalledWith(
      expect.stringContaining('crm/v3/objects/contacts/batch/read'),
      expect.objectContaining({
        properties: ['lifecyclestage'],
        inputs: [{ id: 'c-1' }, { id: 'c-2' }],
      }),
      expect.any(Object),
    );
    expect(map.get('c-1')).toBe('customer');
    expect(map.get('c-2')).toBe('12345678');
  });

  it('maps a contact with no stage to an empty string', async () => {
    mockAxiosPost.mockResolvedValue({ data: { results: [{ id: 'c-1', properties: {} }] } });
    const map = await svc.getContactLifecycleStages(['c-1']);
    expect(map.get('c-1')).toBe('');
  });

  it('chunks into batches of 100', async () => {
    mockAxiosPost.mockResolvedValue({ data: { results: [] } });
    const ids = Array.from({ length: 250 }, (_, i) => `c-${i}`);
    await svc.getContactLifecycleStages(ids);
    expect(mockAxiosPost).toHaveBeenCalledTimes(3); // 100 + 100 + 50
  });

  it('skips (does not throw) a chunk whose read fails, resolving the rest', async () => {
    mockAxiosPost
      .mockRejectedValueOnce(new Error('500 boom'))
      .mockResolvedValueOnce({ data: { results: [{ id: 'c-150', properties: { lifecyclestage: 'lead' } }] } });
    const ids = Array.from({ length: 150 }, (_, i) => `c-${i}`).concat(['c-150']);
    // 150 ids → chunk1 (100, fails) + chunk2 (51, ok)
    const map = await svc.getContactLifecycleStages(ids);
    expect(map.get('c-150')).toBe('lead');
  });
});
