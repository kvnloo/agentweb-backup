/** ENG-502 human contract: automatic capture, retry identity, scope, safe failure. */
const mockRows = new Map<string, any>();
const mockPut = jest.fn((args: any) => ({ promise: async () => {
  const key = `${args.Item.entityKey}/${args.Item.recommendationId}`;
  if (mockRows.has(key)) throw Object.assign(new Error('duplicate'), { code: 'ConditionalCheckFailedException' });
  mockRows.set(key, args.Item);
}}));
jest.mock('aws-sdk', () => ({ __esModule: true, default: { DynamoDB: { DocumentClient: jest.fn(() => ({
  put: mockPut,
  get: (args: any) => ({ promise: async () => ({ Item: mockRows.get(`${args.Key.entityKey}/${args.Key.recommendationId}`) }) }),
})) } } }));
jest.mock('../services/db', () => ({ userDb: { getUserById: jest.fn(), getUserByEmail: jest.fn() } }));
jest.mock('../services/connectedAccountsDb', () => ({ getAccountsByUserId: jest.fn().mockResolvedValue([]) }));
jest.mock('../services/v0Service', () => ({ getLandingPagesByOwner: jest.fn().mockResolvedValue([]), getLandingPagesByOrg: jest.fn().mockResolvedValue([]) }));
jest.mock('../utils/secretsManager', () => ({ getMetaAccessToken: jest.fn().mockResolvedValue('fixture') }));
jest.mock('../services/adsThresholdsDb', () => ({ getThresholdsForAccount: jest.fn().mockResolvedValue([]) }));
jest.mock('../utils/metaApiFetch', () => ({ fetchWithRetryAndPaging: jest.fn() }));
import { assessClientHealth } from '../services/clientHealthService';
import { userDb } from '../services/db';
import { fetchWithRetryAndPaging } from '../utils/metaApiFetch';
import { getRecommendation, putNewRecommendation } from '../services/outcomeLedgerDb';

function fixture(userId = 'client-a', accountId = '123') {
  (userDb.getUserByEmail as jest.Mock).mockResolvedValue({ userId, email: `${userId}@example.com`, adAccount: accountId });
  (fetchWithRetryAndPaging as jest.Mock).mockImplementation(async (url: string) => url.includes('/campaigns?') ? {
    data: [{ id: 'campaign-1', name: 'Campaign', status: 'ACTIVE' }],
  } : { data: [{ id: 'ad-1', campaign_id: 'campaign-1', name: 'Creative', status: 'ACTIVE', creative: { id: 'creative-1' }, insights: { data: [
    { date_start: '2026-09-02', date_stop: '2026-09-15', ctr: '0.5', frequency: '2', cpm: '10', spend: '50' },
    { date_start: '2026-08-19', date_stop: '2026-09-01', ctr: '1', frequency: '2', cpm: '10', spend: '50' },
  ] } }] });
}
beforeEach(() => {
  jest.useFakeTimers({ now: new Date('2026-09-15T12:00:00.000Z') });
  mockRows.clear(); jest.clearAllMocks(); fixture();
  delete process.env.ADS_LEARNING_MODE;
});
afterEach(() => jest.useRealTimers());
it('automatically persists a complete shadow recommendation from a real fatigue assessment', async () => {
  const result = await assessClientHealth('admin', 'client-a@example.com', true);
  expect(result.success).toBe(true);
  expect(result.health.creative_variety.fatigued_creatives[0].reasons).toContain('ctr_drop');
  expect(mockRows.size).toBe(1);
  const row = [...mockRows.values()][0];
  expect(row).toMatchObject({ entityKey: 'meta#123', predictedMetric: 'ctr', predictedDirection: 'increase',
    predictedMagnitudePct: 100, createdBy: 'emma:creative-fatigue', status: 'pending',
    context: { version: 1, clientUserId: 'client-a', campaignId: 'campaign-1', adId: 'ad-1', mode: 'shadow',
      source: 'assess_client_health', reviewState: 'unreviewed', confidence: 'uncalibrated' } });
  expect(row.context.rationale).toBeTruthy();
  expect(row.context.evidence.length).toBeGreaterThan(0);
  expect(row.context.assumptions.length).toBeGreaterThan(0);
  expect(Date.parse(row.evaluationDate)).toBeGreaterThan(Date.parse(row.createdAt));
  expect(Date.parse(row.context.reviewAfter)).toBeGreaterThan(Date.parse(row.evaluationDate));
  expect(await getRecommendation('meta', '123', row.recommendationId)).toMatchObject({ context: row.context });
});
it('retries concurrently persist exactly one recommendation without changing assessment behavior', async () => {
  const [first, second] = await Promise.all([
    assessClientHealth('admin', 'client-a@example.com', true), assessClientHealth('admin', 'client-a@example.com', true),
  ]);
  expect(first).toEqual(second);
  expect(mockRows.size).toBe(1);
  expect(mockPut).toHaveBeenCalledTimes(2);
});
it('separates client scope even when the platform account and campaign are shared', async () => {
  await assessClientHealth('admin', 'client-a@example.com', true);
  fixture('client-b');
  await assessClientHealth('admin', 'client-b@example.com', true);
  expect(mockRows.size).toBe(2);
  expect(new Set([...mockRows.values()].map(r => r.context.clientUserId))).toEqual(new Set(['client-a', 'client-b']));
});
it('existing passing control: unauthorized assessment performs no reads or writes', async () => {
  const result = await assessClientHealth('customer', 'client-a@example.com', false);
  expect(result.success).toBe(false);
  expect(fetchWithRetryAndPaging).not.toHaveBeenCalled();
  expect(mockPut).not.toHaveBeenCalled();
});

it('storage failure is observable and preserves the exact result of capture-disabled execution', async () => {
  process.env.ADS_LEARNING_MODE = 'off';
  const baseline = await assessClientHealth('admin', 'client-a@example.com', true);
  delete process.env.ADS_LEARNING_MODE;
  const error = jest.spyOn(console, 'error').mockImplementation(() => {});
  const info = jest.spyOn(console, 'info').mockImplementation(() => {});
  mockPut.mockImplementationOnce(() => ({ promise: async () => { throw new Error('storage unavailable'); } }));
  const result = await assessClientHealth('admin', 'client-a@example.com', true);
  expect(result).toEqual(baseline);
  expect(mockRows.size).toBe(0);
  expect(error).toHaveBeenCalledWith('[AdsLearning] capture failed', expect.any(Object));
  expect(info).not.toHaveBeenCalled();
  error.mockRestore(); info.mockRestore();
});
it('successful capture preserves the exact result of capture-disabled execution', async () => {
  process.env.ADS_LEARNING_MODE = 'off';
  const baseline = await assessClientHealth('admin', 'client-a@example.com', true);
  delete process.env.ADS_LEARNING_MODE;
  expect(await assessClientHealth('admin', 'client-a@example.com', true)).toEqual(baseline);
  expect(mockRows.size).toBe(1);
});
it('rollback switch disables writes and keeps the existing assessment usable', async () => {
  process.env.ADS_LEARNING_MODE = 'off';
  expect((await assessClientHealth('admin', 'client-a@example.com', true)).success).toBe(true);
  expect(mockPut).not.toHaveBeenCalled();
});
it.each(['campaign_id', 'date_stop', 'prior_ctr'])('does not fabricate a record when %s attribution/evidence is missing', async missing => {
  const original = (fetchWithRetryAndPaging as jest.Mock).getMockImplementation()!;
  (fetchWithRetryAndPaging as jest.Mock).mockImplementation(async (url: string) => {
    const result = await original(url);
    if (url.includes('/ads?')) {
      if (missing === 'campaign_id') delete result.data[0].campaign_id;
      if (missing === 'date_stop') delete result.data[0].insights.data[0].date_stop;
      if (missing === 'prior_ctr') delete result.data[0].insights.data[1].ctr;
    }
    return result;
  });
  expect((await assessClientHealth('admin', 'client-a@example.com', true)).success).toBe(true);
  expect(mockPut).not.toHaveBeenCalled();
});
it.each(['/campaigns?', '/ads?'])('refuses malformed elements at sibling boundary %s', async edge => {
  const original = (fetchWithRetryAndPaging as jest.Mock).getMockImplementation()!;
  (fetchWithRetryAndPaging as jest.Mock).mockImplementation(async (url: string) => url.includes(edge) ? { data: [null] } : original(url));
  const result = await assessClientHealth('admin', 'client-a@example.com', true);
  expect(result.success).toBe(true);
  expect(result.health.creative_variety.creative_data_complete).toBe(false);
  expect(mockPut).not.toHaveBeenCalled();
});
it.each([null, 'truthy', [null], [{ ctr: {} }]])('refuses malformed insights %p', async data => {
  const original = (fetchWithRetryAndPaging as jest.Mock).getMockImplementation()!;
  (fetchWithRetryAndPaging as jest.Mock).mockImplementation(async (url: string) => {
    const result = await original(url);
    if (url.includes('/ads?')) result.data[0].insights.data = data;
    return result;
  });
  const result = await assessClientHealth('admin', 'client-a@example.com', true);
  expect(result.success).toBe(true);
  expect(result.health.creative_variety.creative_data_complete).toBe(false);
  expect(mockPut).not.toHaveBeenCalled();
});
it('does not capture from truncated platform evidence', async () => {
  const original = (fetchWithRetryAndPaging as jest.Mock).getMockImplementation()!;
  (fetchWithRetryAndPaging as jest.Mock).mockImplementation(async (url: string) => ({ ...await original(url), pagingTruncated: true }));
  await assessClientHealth('admin', 'client-a@example.com', true);
  expect(mockPut).not.toHaveBeenCalled();
});
it('does not claim retry success when the existing row has different client attribution', async () => {
  await assessClientHealth('admin', 'client-a@example.com', true);
  [...mockRows.values()][0].context.clientUserId = 'other-client';
  const error = jest.spyOn(console, 'error').mockImplementation(() => {});
  const info = jest.spyOn(console, 'info').mockImplementation(() => {});
  await assessClientHealth('admin', 'client-a@example.com', true);
  expect(error).toHaveBeenCalledWith('[AdsLearning] capture failed', expect.any(Object));
  expect(info).not.toHaveBeenCalled();
  error.mockRestore(); info.mockRestore();
});

it.each([
  { clientUserId: true }, { campaignId: {} }, { evidence: [null] },
  { evidence: [{ reference: 'source', metric: 'ctr', value: '1' }] },
  { assumptions: [true] }, { sourceWindow: 'truthy' }, { reviewAfter: 'invalid' },
])('rejects corrupted stored context %p instead of exposing cross-client or fabricated evidence', async patch => {
  await assessClientHealth('admin', 'client-a@example.com', true);
  const row = [...mockRows.values()][0];
  Object.assign(row.context, patch);
  await expect(getRecommendation('meta', '123', row.recommendationId)).rejects.toThrow(/context/);
});

it('bounds capture to three proposals while returning every fatigue finding', async () => {
  const original = (fetchWithRetryAndPaging as jest.Mock).getMockImplementation()!;
  (fetchWithRetryAndPaging as jest.Mock).mockImplementation(async (url: string) => {
    const result = await original(url);
    if (url.includes('/ads?')) result.data = [4, 2, 1, 3].map(n => ({ ...result.data[0], id: `ad-${n}` }));
    return result;
  });
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  const result = await assessClientHealth('admin', 'client-a@example.com', true);
  expect(result.health.creative_variety.fatigued_creatives).toHaveLength(4);
  expect([...mockRows.values()].map(r => r.context.adId).sort()).toEqual(['ad-1', 'ad-2', 'ad-3']);
  expect(warn).toHaveBeenCalledWith('[AdsLearning] capture limited', { omitted: 1 });
  warn.mockRestore();
});
it('aborts a timed-out SDK write instead of leaving the request running', async () => {
  await assessClientHealth('admin', 'client-a@example.com', true);
  const row = [...mockRows.values()][0];
  const rec = (await getRecommendation('meta', '123', row.recommendationId))!;
  let reject!: (error: Error) => void;
  const promise = new Promise<never>((_, fail) => { reject = fail; });
  const abort = jest.fn(() => reject(new Error('request aborted')));
  mockPut.mockImplementationOnce(() => ({ promise: () => promise, abort }));
  jest.useFakeTimers();
  try {
    const pending = expect(putNewRecommendation(rec, 25)).rejects.toThrow('request deadline exceeded');
    await jest.advanceTimersByTimeAsync(25);
    await pending;
    expect(abort).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  } finally { jest.useRealTimers(); }
});

it('enforces a 100ms TOTAL capture deadline even when SDK abort settles late', async () => {
  let reject!: (e: Error) => void;
  const slow = new Promise<never>((_, fail) => { reject = fail; });
  const abort = jest.fn();
  mockPut.mockImplementationOnce(() => ({ promise: () => slow, abort }));
  let finished = false;
  const result = assessClientHealth('admin', 'client-a@example.com', true).then(r => { finished = true; return r; });
  await jest.advanceTimersByTimeAsync(100);
  expect(finished).toBe(true);
  expect((await result).success).toBe(true);
  expect(abort).toHaveBeenCalledTimes(1);
  reject(new Error('late SDK rejection'));
  await jest.advanceTimersByTimeAsync(1);
  expect(jest.getTimerCount()).toBe(0);
});
