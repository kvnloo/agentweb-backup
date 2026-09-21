/**
 * ENG-1388 — Enigma card-revenue adapter invariants.
 *
 * Only billing and data-integrity invariants are covered (CLAUDE.md Rule 2):
 *   - a revenue value is returned only for a brand whose own website confirms
 *     our domain, and is never repaired or guessed (fail closed)
 *   - unsafe domains never reach the vendor
 *   - vendor errors are never cached (a 402 must not read as "no data")
 *   - the $ ledger records exactly the values Enigma bills for, and nothing on
 *     an empty result
 */

jest.mock('../services/db', () => ({
  crmDb: {
    getEnrichmentCacheItem: jest.fn().mockResolvedValue(null),
    putEnrichmentCacheItem: jest.fn().mockResolvedValue(undefined),
  },
}));
jest.mock('../services/crmEnrichmentService', () => ({
  CrmEnrichmentService: { isPersonalDomain: (d: string) => d === 'gmail.com' },
}));
jest.mock('../utils/secretsManager', () => ({
  getEnigmaApiKey: jest.fn().mockResolvedValue('enigma-test-key'),
}));
const mockRecordVendorUsage = jest.fn().mockResolvedValue(undefined);
jest.mock('../services/usageRecorderService', () => ({
  recordVendorUsage: (...a: any[]) => mockRecordVendorUsage(...a),
}));

import {
  EnigmaApiError,
  EnigmaAuthError,
  EnigmaCreditsExhaustedError,
  EnigmaRateLimitedError,
  EnigmaService,
  type EnigmaCacheRow,
  type EnigmaCacheStore,
  type EnigmaHttpClient,
} from '../services/enigmaService';
import { buildEnigmaHttpClient } from '../services/enigmaServiceFactory';
import { getAllocatedRate } from '../utils/vendorRateCard';

// ─── Fixtures ────────────────────────────────────────────────────────────────

function txn(quantityType: string, projectedQuantity: number | null, extra: Record<string, unknown> = {}) {
  return {
    node: {
      quantityType,
      period: '12m',
      projectedQuantity,
      periodStartDate: '2025-06-01',
      periodEndDate: '2026-05-31',
      platformBrandId: null,
      ...extra,
    },
  };
}

function brand(opts: { websites?: Array<{ website: string; domain: string; topLevelDomain: string }>; txns?: any[] } = {}) {
  return {
    id: 'brand-123',
    names: { edges: [{ node: { name: 'Popup Bagels' } }] },
    websites: {
      edges: (opts.websites ?? [{ website: 'https://www.popupbagels.com', domain: 'popupbagels', topLevelDomain: 'com' }])
        .map((node) => ({ node })),
    },
    cardTransactions: {
      edges: opts.txns ?? [txn('card_revenue_amount', 4_250_000), txn('card_revenue_yoy_growth', 0.32)],
    },
  };
}

function memoryStore() {
  const rows = new Map<string, EnigmaCacheRow>();
  const store: EnigmaCacheStore & { puts: any[] } = {
    puts: [],
    async get(id, sk) {
      return rows.get(`${id}|${sk}`) ?? null;
    },
    async put(row, opts) {
      store.puts.push({ row, opts });
      rows.set(`${row.canonicalId}|${row.fieldGroup}`, row);
    },
  };
  return store;
}

function service(searchBrand: jest.Mock, store = memoryStore()) {
  const http: EnigmaHttpClient = { searchBrand };
  const svc = new EnigmaService({
    http,
    store,
    isPersonalDomain: (d) => d === 'gmail.com',
    now: () => new Date('2026-09-14T00:00:00Z'),
  });
  return { svc, store };
}

// ─── Service: fail-closed matching ───────────────────────────────────────────

describe('EnigmaService.lookupBrandCardRevenue', () => {
  it('returns 12m card revenue with its period when the brand website confirms the domain', async () => {
    const search = jest.fn().mockResolvedValue([brand()]);
    const { svc } = service(search);

    const result = await svc.lookupBrandCardRevenue({ website: 'https://popupbagels.com/menu', companyName: ' Popup Bagels ' });

    expect(search).toHaveBeenCalledWith({ website: 'popupbagels.com', name: 'Popup Bagels' }, undefined);
    expect(result).toMatchObject({
      status: 'found',
      brandId: 'brand-123',
      matchedWebsite: 'popupbagels.com',
      fromCache: false,
      cardRevenue12m: {
        amountUsd: 4_250_000,
        yoyGrowth: 0.32,
        periodStartDate: '2025-06-01',
        periodEndDate: '2026-05-31',
      },
    });
  });

  it('matches a brand whose only website is a subdomain of the lead domain, but never a site-builder apex', async () => {
    const subdomainOnly = [brand({ websites: [{ website: 'https://shop.acme.com', domain: '', topLevelDomain: '' }] })];
    const { svc } = service(jest.fn().mockResolvedValue(subdomainOnly));
    expect((await svc.lookupBrandCardRevenue({ website: 'acme.com' })).status).toBe('found');

    const hostedShop = [brand({ websites: [{ website: 'https://acme.squarespace.com', domain: '', topLevelDomain: '' }] })];
    const { svc: svc2 } = service(jest.fn().mockResolvedValue(hostedShop));
    expect((await svc2.lookupBrandCardRevenue({ website: 'squarespace.com' })).status).toBe('not_found');
  });

  it('never serves one user\'s cached lookup to another user', async () => {
    const search = jest.fn().mockResolvedValue([brand()]);
    const { svc } = service(search);

    await svc.lookupBrandCardRevenue({ website: 'popupbagels.com' }, { userId: 'user-a' });
    const otherUser = await svc.lookupBrandCardRevenue({ website: 'popupbagels.com' }, { userId: 'user-b' });
    const sameUser = await svc.lookupBrandCardRevenue({ website: 'popupbagels.com' }, { userId: 'user-a' });

    expect(search).toHaveBeenCalledTimes(2);
    expect(otherUser.fromCache).toBe(false);
    expect(sameUser.fromCache).toBe(true);
  });

  it('treats a brand on a different TLD as not found and discards its values', async () => {
    const search = jest.fn().mockResolvedValue([
      brand({ websites: [{ website: 'https://acme.com', domain: 'acme', topLevelDomain: 'com' }] }),
    ]);
    const { svc } = service(search);

    const result = await svc.lookupBrandCardRevenue({ website: 'acme.io' });

    expect(result.status).toBe('not_found');
    expect(result.cardRevenue12m).toBeNull();
    expect(result.brandId).toBeUndefined();
  });

  it.each([
    ['null amount', [txn('card_revenue_amount', null)]],
    ['negative amount', [txn('card_revenue_amount', -5)]],
    ['missing period end date', [txn('card_revenue_amount', 1000, { periodEndDate: null })]],
    ['platform-attributed slice only', [txn('card_revenue_amount', 1000, { platformBrandId: 'uber-eats' })]],
    ['impossible period end date', [txn('card_revenue_amount', 1000, { periodEndDate: '2026-02-30' })]],
    ['out-of-range period date', [txn('card_revenue_amount', 1000, { periodStartDate: '2026-99-99' })]],
    ['date with trailing junk', [txn('card_revenue_amount', 1000, { periodEndDate: '2026-05-31-invalid' })]],
  ])('never fabricates a revenue value (%s)', async (_label, txns) => {
    const search = jest.fn().mockResolvedValue([brand({ txns })]);
    const { svc } = service(search);

    const result = await svc.lookupBrandCardRevenue({ website: 'popupbagels.com' });

    expect(result.status).toBe('found');
    expect(result.cardRevenue12m).toBeNull();
  });

  it.each([
    ['social profile', 'https://www.facebook.com/popupbagels'],
    ['site-builder subdomain', 'popupbagels.myshopify.com'],
    ['AgentWeb form host', 'https://everyio.agentwebforms.com/contact'],
    ['personal email domain', 'gmail.com'],
    ['unparseable input', 'not a domain'],
    ['empty input', ''],
  ])('skips %s without calling Enigma or caching', async (_label, website) => {
    const search = jest.fn();
    const { svc, store } = service(search);

    const result = await svc.lookupBrandCardRevenue({ website });

    expect(result.status).toBe('skipped');
    expect(search).not.toHaveBeenCalled();
    expect(store.puts).toHaveLength(0);
  });

  // Shapes from live responses (ENG-1933): YoY is a signed change, and a brand can
  // carry extra YoY rows attributed to individual payment platforms.
  it('keeps a falling YoY, ignores platform-attributed YoY rows, and drops impossible values', async () => {
    const lookup = async (txns: any[]) =>
      (await service(jest.fn().mockResolvedValue([brand({ txns })])).svc.lookupBrandCardRevenue({ website: 'popupbagels.com' }))
        .cardRevenue12m?.yoyGrowth;
    const amount = txn('card_revenue_amount', 401_164);

    expect(await lookup([amount, txn('card_revenue_yoy_growth', -0.6069)])).toBe(-0.6069);
    expect(await lookup([
      amount,
      txn('card_revenue_yoy_growth', 0.2392, { platformBrandId: 'platform-a' }),
      txn('card_revenue_yoy_growth', 0.0739),
    ])).toBe(0.0739);
    expect(await lookup([amount, txn('card_revenue_yoy_growth', -1.5)])).toBeNull();
  });

  it('serves a repeat lookup from cache, and forceRefresh bypasses and overwrites it', async () => {
    const search = jest.fn().mockResolvedValue([brand()]);
    const { svc, store } = service(search);

    await svc.lookupBrandCardRevenue({ website: 'popupbagels.com' });
    const cached = await svc.lookupBrandCardRevenue({ website: 'https://www.popupbagels.com' });
    expect(search).toHaveBeenCalledTimes(1);
    expect(cached.fromCache).toBe(true);
    expect(cached.cardRevenue12m?.amountUsd).toBe(4_250_000);

    await svc.lookupBrandCardRevenue({ website: 'popupbagels.com' }, { forceRefresh: true });
    expect(search).toHaveBeenCalledTimes(2);
    expect(store.puts[1].opts).toEqual({ force: true });
  });

  it.each([
    ['402 out of credits', new EnigmaCreditsExhaustedError()],
    ['401 bad key', new EnigmaAuthError(401)],
    ['429 rate limited', new EnigmaRateLimitedError(30)],
  ])('does not cache a vendor error (%s) — the next lookup calls Enigma again', async (_label, error) => {
    const search = jest.fn().mockRejectedValueOnce(error).mockResolvedValueOnce([brand()]);
    const { svc, store } = service(search);

    await expect(svc.lookupBrandCardRevenue({ website: 'popupbagels.com' })).rejects.toBe(error);
    expect(store.puts).toHaveLength(0);

    const retry = await svc.lookupBrandCardRevenue({ website: 'popupbagels.com' });
    expect(search).toHaveBeenCalledTimes(2);
    expect(retry.status).toBe('found');
  });
});

// ─── Factory HTTP client: ledger + error mapping ─────────────────────────────

describe('buildEnigmaHttpClient', () => {
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    originalFetch = global.fetch;
    mockRecordVendorUsage.mockClear();
  });
  afterEach(() => {
    global.fetch = originalFetch;
  });

  function respond(status: number, body: unknown, headers: Record<string, string> = {}) {
    global.fetch = jest.fn().mockResolvedValue({
      status,
      ok: status >= 200 && status < 300,
      headers: { get: (h: string) => headers[h.toLowerCase()] ?? null },
      json: async () => body,
    }) as any;
  }

  it('records each billed value against its rate key and sends the key header', async () => {
    respond(200, { data: { search: [brand()] } });

    const brands = await buildEnigmaHttpClient('k').searchBrand({ website: 'popupbagels.com' }, 'user-1');

    expect(brands).toHaveLength(1);
    const [url, init] = (global.fetch as jest.Mock).mock.calls[0];
    expect(url).toBe('https://api.enigma.com/graphql');
    expect(init.headers['x-api-key']).toBe('k');
    expect(JSON.parse(init.body).variables.searchInput).toMatchObject({ entityType: 'BRAND', website: 'popupbagels.com' });

    const byOp = Object.fromEntries(mockRecordVendorUsage.mock.calls.map(([ctx]) => [ctx.operation, ctx]));
    expect(mockRecordVendorUsage).toHaveBeenCalledTimes(3);
    // ENG-1929: the recorder prices quantity × card rate from rateKey; the
    // adapter must name a priced key and the billed quantity, never a cost.
    const priced = (ctx: any) => getAllocatedRate('enigma', ctx.rateKey)! * ctx.quantity;
    expect(byOp.card_revenue_12m).toMatchObject({ provider: 'enigma', userId: 'user-1', rateKey: 'card_revenue_12m', quantity: 1, unit: 'fill' });
    expect(byOp.card_revenue_12m.costUsd).toBeUndefined();
    expect(priced(byOp.card_revenue_12m)).toBeCloseTo(0.1, 6);
    expect(byOp.card_revenue_yoy_growth_12m).toMatchObject({ rateKey: 'card_revenue_yoy_growth_12m', quantity: 1 });
    expect(priced(byOp.card_revenue_yoy_growth_12m)).toBeCloseTo(0.1, 6);
    // one name + one website
    expect(byOp.brand_attribute).toMatchObject({ rateKey: 'brand_attribute', quantity: 2 });
    expect(priced(byOp.brand_attribute)).toBeCloseTo(0.04, 6);
  });

  it('records nothing when the search returns no brand (Enigma bills $0)', async () => {
    respond(200, { data: { search: [] } });

    await expect(buildEnigmaHttpClient('k').searchBrand({ website: 'nobody.com' })).resolves.toEqual([]);
    expect(mockRecordVendorUsage).not.toHaveBeenCalled();
  });

  it('does not bill null values', async () => {
    respond(200, { data: { search: [brand({ txns: [txn('card_revenue_amount', null)] })] } });

    await buildEnigmaHttpClient('k').searchBrand({ website: 'popupbagels.com' });
    expect(mockRecordVendorUsage.mock.calls.map(([ctx]) => ctx.operation)).toEqual(['brand_attribute']);
  });

  it.each([
    [402, EnigmaCreditsExhaustedError],
    [401, EnigmaAuthError],
    [403, EnigmaAuthError],
    [429, EnigmaRateLimitedError],
    [503, EnigmaApiError],
  ])('maps HTTP %i to a typed error and records no usage', async (status, ErrorType) => {
    respond(status, {}, { 'retry-after': '30' });

    const err = await buildEnigmaHttpClient('k').searchBrand({ website: 'popupbagels.com' }).catch((e) => e);
    expect(err).toBeInstanceOf(ErrorType);
    if (status === 429) expect((err as EnigmaRateLimitedError).retryAfterSec).toBe(30);
    expect(mockRecordVendorUsage).not.toHaveBeenCalled();
  });

  it.each([
    ['missing data', {}],
    ['null search', { data: { search: null } }],
    ['non-array search', { data: { search: { id: 'b1' } } }],
  ])('treats a malformed HTTP 200 (%s) as a failure, never an empty result', async (_label, body) => {
    respond(200, body);

    await expect(buildEnigmaHttpClient('k').searchBrand({ website: 'popupbagels.com' }))
      .rejects.toThrow('Enigma response missing data.search array');
    expect(mockRecordVendorUsage).not.toHaveBeenCalled();
  });

  it('treats GraphQL errors on HTTP 200 as a failure, not an empty result', async () => {
    respond(200, { data: { search: null }, errors: [{ message: 'Invalid filter field' }] });

    await expect(buildEnigmaHttpClient('k').searchBrand({ website: 'popupbagels.com' }))
      .rejects.toThrow('Enigma GraphQL error: Invalid filter field');
  });
});
