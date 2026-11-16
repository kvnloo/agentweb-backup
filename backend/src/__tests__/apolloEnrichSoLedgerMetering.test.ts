/**
 * ENG-696 — Apollo and enrich.so calls that reach the vendor are mirrored
 * into the shared $ ledger (usageRecorderService.recordVendorUsage), on top
 * of the pre-existing DynamoDB call-count quota tracker (visibility, not $).
 *
 * Exercises the real HTTP wrapper factories (apolloServiceFactory.ts,
 * enrichSoServiceFactory.ts) since that's where the ledger mirroring lives —
 * one module per vendor, matching vendorMeteringCoverageGuard's per-file
 * model (ENG-701). apolloService.ts / enrichSoService.ts stay ledger-free;
 * they only thread `userId` down to the injected HTTP client.
 *
 * Behavioral assertions verified (ENG-696 acceptance criteria):
 *  1. Every vendor call that reaches the API records exactly once.
 *  2. No userId → recorded (usageRecorderService defaults it to "system").
 *  4. Cache hits never re-enter this file's HTTP client, so no test here
 *     can call the vendor a second time for the same input.
 *  5. Apollo's broker-waterfall email reveal records a distinguishable
 *     endpoint (waterfall_email) from a basic reveal (email_reveal).
 */

const mockAxiosPost = jest.fn();
const mockAxiosGet = jest.fn();
jest.mock('axios', () => ({
  create: () => ({
    post: (...a: any[]) => mockAxiosPost(...a),
    get: (...a: any[]) => mockAxiosGet(...a),
    // The same import chain (see the aws-sdk mock above) also pulls in hubspotService.ts, which
    // registers a response interceptor on its module-level axios instance at load time.
    interceptors: { response: { use: jest.fn() } },
  }),
}));

jest.mock('aws-sdk', () => ({
  DynamoDB: { DocumentClient: jest.fn().mockImplementation(() => ({
    update: () => ({ promise: () => Promise.resolve({}) }),
    put: () => ({ promise: () => Promise.resolve({}) }),
    get: () => ({ promise: () => Promise.resolve({}) }),
  })) },
  // This file's import chain transitively pulls in s3Utils.ts (via chatbotService.ts ->
  // agentModeService.ts -> crmEnrichmentService.ts -> enrichmentIdentityResolver.ts ->
  // routes/crmEnrichSo.ts -> enrichSoServiceFactory.ts), which constructs `new AWS.S3(...)` at
  // module load time. Without this, that throws "AWS.S3 is not a constructor" before any test
  // in this file runs, unrelated to anything this file actually tests. Matches the S3 stub
  // convention already used elsewhere (accountMemory.test.ts, accountSummary.test.ts, etc.).
  S3: jest.fn(() => ({})),
}));

jest.mock('../services/db', () => ({
  crmDb: {
    getEnrichmentCacheItem: jest.fn().mockResolvedValue(null),
    putEnrichmentCacheItem: jest.fn().mockResolvedValue(undefined),
  },
}));
jest.mock('../utils/secretsManager', () => ({
  getApolloApiKey: jest.fn().mockResolvedValue('apollo-key'),
  getApolloWebhookSecret: jest.fn().mockResolvedValue('secret'),
  getEnrichSoApiKey: jest.fn().mockResolvedValue('enrichso-key'),
}));
jest.mock('../routes/crmEnrichSo', () => ({ setQuotaTrackerForLookupRoute: jest.fn() }), { virtual: true });

const mockRecordVendorUsage = jest.fn().mockResolvedValue(undefined);
jest.mock('../services/usageRecorderService', () => ({
  recordVendorUsage: (...a: any[]) => mockRecordVendorUsage(...a),
}));

// Access the internal buildHttpClient by importing the factory module and
// driving it through the (unexported) init flow's build step. Both factories
// only export the init* functions, so we reach the HTTP client the same way
// production code does: build it, call its methods directly.
import type { ApolloHttpClient } from '../services/apolloService';
import type { EnrichSoHttpClient } from '../services/enrichSoService';

// buildHttpClient is not exported — re-require the module and grab it via a
// small reflection shim is fragile, so instead we drive through the public
// init function and capture the constructed service, then call its methods
// (which pass straight through to the HTTP client under test).
import { initApolloServiceFromEnv } from '../services/apolloServiceFactory';
import { initEnrichSoServiceFromEnv } from '../services/enrichSoServiceFactory';
import { getApolloService, __resetApolloServiceForTesting } from '../services/apolloService';
import { getEnrichSoService } from '../services/enrichSoService';
import { getAllocatedRate } from '../utils/vendorRateCard';

const OWNER = 'user-1';

beforeEach(async () => {
  jest.clearAllMocks();
  __resetApolloServiceForTesting();
  mockAxiosPost.mockReset();
  mockAxiosGet.mockReset();
  await initApolloServiceFromEnv();
  await initEnrichSoServiceFromEnv();
});

describe('Apollo $ ledger mirroring (ENG-696)', () => {
  it('records a basic person match with a distinguishable rate key from a reveal', async () => {
    mockAxiosPost.mockResolvedValue({ data: { person: { id: 'p1' } } });
    await getApolloService().matchPerson({ email: 'a@b.com' }, { userId: OWNER });

    expect(mockRecordVendorUsage).toHaveBeenCalledTimes(1);
    const ctx = mockRecordVendorUsage.mock.calls[0][0];
    expect(ctx.provider).toBe('apollo');
    expect(ctx.userId).toBe(OWNER);
    expect(ctx.operation).toBe('person_match');
    // ENG-1929: priced by the recorder from the rate key, never at the call site.
    expect(ctx.rateKey).toBe('person_match');
    expect(ctx).not.toHaveProperty('costUsd');
  });

  it('AC2: records against the platform when no userId is resolvable', async () => {
    mockAxiosGet.mockResolvedValue({ data: { organization: { id: 'o1' } } });
    await getApolloService().matchOrg('example.com');

    expect(mockRecordVendorUsage).toHaveBeenCalledTimes(1);
    expect(mockRecordVendorUsage.mock.calls[0][0].userId).toBeUndefined();
  });

  it('AC5: a waterfall email reveal records waterfall_email, distinct from a basic reveal', async () => {
    mockAxiosPost.mockResolvedValue({ data: { email: 'x@y.com' } });
    process.env.BACKEND_URL = 'https://api.agentweb.pro';

    await getApolloService().findEmail(
      { firstName: 'A', lastName: 'B', domain: 'y.com' },
      { userId: OWNER, runWaterfall: true }
    );

    const ctx = mockRecordVendorUsage.mock.calls[0][0];
    expect(ctx.operation).toBe('waterfall_email');
    // ENG-2720: no phone is requested, so no phone component is ever booked.
    expect(mockRecordVendorUsage.mock.calls.map((c: any[]) => c[0].operation)).not.toContain('waterfall_phone');
    expect(mockAxiosPost.mock.calls[0][1]).not.toHaveProperty('reveal_phone_number');
    expect(mockAxiosPost.mock.calls[0][1]).not.toHaveProperty('run_waterfall_phone');
    delete process.env.BACKEND_URL;
  });

  it('sends a basic match, with no webhook URL, when the webhook secret cannot be resolved (ENG-2803)', async () => {
    const { getApolloWebhookSecret } = jest.requireMock('../utils/secretsManager');
    getApolloWebhookSecret.mockRejectedValueOnce(new Error('APOLLO_WEBHOOK_SECRET is not set'));
    mockAxiosPost.mockResolvedValue({ data: { email: 'x@y.com' } });
    process.env.BACKEND_URL = 'https://api.agentweb.pro';

    await getApolloService().findEmail({ firstName: 'A', lastName: 'B', domain: 'y.com' }, { userId: OWNER, runWaterfall: true });

    const body = mockAxiosPost.mock.calls[0][1];
    expect(body).not.toHaveProperty('run_waterfall_email');
    expect(body).not.toHaveProperty('webhook_url');
    expect(mockRecordVendorUsage.mock.calls[0][0].operation).toBe('email_reveal');
    delete process.env.BACKEND_URL;
  });

  it('a basic (non-waterfall) findEmail records email_reveal', async () => {
    mockAxiosPost.mockResolvedValue({ data: { email: 'x@y.com' } });
    await getApolloService().findEmail({ firstName: 'A', lastName: 'B', domain: 'y.com' }, { userId: OWNER });

    expect(mockRecordVendorUsage.mock.calls[0][0].operation).toBe('email_reveal');
  });

  it.each([404, 422])('a %i on a waterfall request still books waterfall_email, priced on the rate card (ENG-2720)', async (status) => {
    mockAxiosPost.mockRejectedValue({ response: { status } });
    process.env.BACKEND_URL = 'https://api.agentweb.pro';

    await getApolloService().findEmail(
      { firstName: 'A', lastName: 'B', domain: 'y.com' },
      { userId: OWNER, runWaterfall: true }
    );

    expect(mockRecordVendorUsage).toHaveBeenCalledTimes(1);
    const ctx = mockRecordVendorUsage.mock.calls[0][0];
    expect(ctx.operation).toBe('waterfall_email');
    expect(ctx.rateKey).toBe('waterfall_email');
    // The key the factory emits must exist on the card, or the recorder books it `unpriced`.
    expect(getAllocatedRate('apollo', ctx.rateKey)).toBe(0.445);
    delete process.env.BACKEND_URL;
  });

  it('every Apollo ledger key the factory emits is priced on the rate card (ENG-2720)', async () => {
    mockAxiosPost.mockResolvedValue({ data: { email: 'x@y.com' } });
    mockAxiosGet.mockResolvedValue({ data: { organization: { id: 'o1' } } });
    process.env.BACKEND_URL = 'https://api.agentweb.pro';
    const apollo = getApolloService();

    await apollo.findEmail({ firstName: 'A', lastName: 'B', domain: 'y.com' }, { userId: OWNER, runWaterfall: true });
    await apollo.findEmail({ firstName: 'C', lastName: 'D', domain: 'z.com' }, { userId: OWNER });
    await apollo.matchPerson({ email: 'a@y.com' }, { userId: OWNER });
    await apollo.matchOrg('example.com', { userId: OWNER });

    const keys = mockRecordVendorUsage.mock.calls.map((c: any[]) => c[0].rateKey);
    expect(new Set(keys)).toEqual(new Set(['waterfall_email', 'email_reveal', 'person_match', 'org_enrichment']));
    for (const key of keys) expect(getAllocatedRate('apollo', key)).not.toBeNull();
    delete process.env.BACKEND_URL;
  });

  it('a 404 "not found" response still records — it reached and billed the vendor', async () => {
    mockAxiosPost.mockRejectedValue({ response: { status: 404 } });
    const result = await getApolloService().matchPerson({ email: 'nobody@nowhere.com' }, { userId: OWNER });

    expect(result.found).toBe(false);
    expect(mockRecordVendorUsage).toHaveBeenCalledTimes(1);
  });

  it('records org enrichment under its own rate key', async () => {
    mockAxiosGet.mockResolvedValue({ data: { organization: { id: 'o1' } } });
    await getApolloService().matchOrg('example.com', { userId: OWNER });

    expect(mockRecordVendorUsage.mock.calls[0][0].operation).toBe('org_enrichment');
  });

  it('does NOT record when the vendor call itself throws (non-404/422)', async () => {
    mockAxiosPost.mockRejectedValue({ response: { status: 500 } });
    await expect(
      getApolloService().matchPerson({ email: 'a@b.com' }, { userId: OWNER })
    ).rejects.toBeDefined();
    expect(mockRecordVendorUsage).not.toHaveBeenCalled();
  });
});

describe('enrich.so $ ledger mirroring (ENG-696)', () => {
  it('records email validation with its own rate key', async () => {
    mockAxiosPost.mockResolvedValue({ data: { valid: true } });
    await getEnrichSoService().validateEmail('a@b.com', { userId: OWNER });

    expect(mockRecordVendorUsage).toHaveBeenCalledTimes(1);
    const ctx = mockRecordVendorUsage.mock.calls[0][0];
    expect(ctx.provider).toBe('enrich.so');
    expect(ctx.operation).toBe('email_validation');
    expect(ctx.userId).toBe(OWNER);
  });

  it('AC5/AC1: reverse lookup (higher route cap cost) uses a distinct rate key from find', async () => {
    mockAxiosPost.mockResolvedValue({ data: { found: true, email: 'x@y.com' } });
    await getEnrichSoService().reverseLookup('x@y.com', { userId: OWNER });
    expect(mockRecordVendorUsage.mock.calls[0][0].operation).toBe('reverse_lookup');

    mockRecordVendorUsage.mockClear();
    mockAxiosPost.mockResolvedValue({ data: { found: true, email: 'x@y.com' } });
    await getEnrichSoService().findEmail({ firstName: 'A', lastName: 'B', domain: 'y.com' }, { userId: OWNER });
    expect(mockRecordVendorUsage.mock.calls[0][0].operation).toBe('email_lookup');
  });

  it('AC2: records against the platform when no userId is resolvable', async () => {
    mockAxiosPost.mockResolvedValue({ data: { valid: true } });
    await getEnrichSoService().validateEmail('no-user@b.com');
    expect(mockRecordVendorUsage.mock.calls[0][0].userId).toBeUndefined();
  });

  it('a 404 not-found reverse lookup still records — it reached and billed the vendor', async () => {
    mockAxiosPost.mockRejectedValue({ response: { status: 404 } });
    const result = await getEnrichSoService().reverseLookup('nobody@nowhere.com', { userId: OWNER });

    expect(result.found).toBe(false);
    expect(mockRecordVendorUsage).toHaveBeenCalledTimes(1);
  });

  it('does NOT record when the vendor call itself throws (non-404)', async () => {
    mockAxiosPost.mockRejectedValue({ response: { status: 500 } });
    await expect(getEnrichSoService().validateEmail('errors-out@b.com', { userId: OWNER })).rejects.toBeDefined();
    expect(mockRecordVendorUsage).not.toHaveBeenCalled();
  });

  it('AC4: a cached result never re-enters the HTTP client, so no second ledger row', async () => {
    mockAxiosPost.mockResolvedValue({ data: { valid: true } });
    await getEnrichSoService().validateEmail('cache-me@b.com', { userId: OWNER });
    expect(mockRecordVendorUsage).toHaveBeenCalledTimes(1);

    mockRecordVendorUsage.mockClear();
    mockAxiosPost.mockClear();
    await getEnrichSoService().validateEmail('cache-me@b.com', { userId: OWNER });

    // In-memory LRU cache hit → HTTP client never called again → no ledger row.
    expect(mockAxiosPost).not.toHaveBeenCalled();
    expect(mockRecordVendorUsage).not.toHaveBeenCalled();
  });
});
