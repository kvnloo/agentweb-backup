import express from 'express';
import request from 'supertest';
import routes from '../routes/meta';
import { fetchWithRetryAndPaging } from '../utils/metaApiFetch';
jest.mock('../middleware/auth', () => ({ authenticateToken: (req: any, _res: any, next: any) => { req.user = { userId: 'eval_regression' }; next(); } }));
jest.mock('../services/db', () => ({ userDb: { getUserById: jest.fn(async () => ({ connected_accounts: [{ platform: 'meta', account_id: '990001', config: { account_type: 'ad_account', access_token: 'simulated-test' } }] })) }, taskDb: {} }));
jest.mock('../utils/metaApiFetch', () => ({ fetchWithRetryAndPaging: jest.fn() }));
jest.mock('../utils/secretsManager', () => ({ getMetaAccessToken: jest.fn() }));
const app = express(); app.use('/api/meta', routes);
const rows = [
  [{ id: 'c', name: 'No delivery', status: 'ACTIVE', effective_status: 'WITH_ISSUES', objective: 'OUTCOME_LEADS' }],
  [{ id: 's', campaign_id: 'c', name: 'Set', status: 'ACTIVE', effective_status: 'PENDING_REVIEW' }],
  [{ id: 'a', campaign_id: 'c', adset_id: 's', name: 'Ad', status: 'ACTIVE', effective_status: 'DISAPPROVED' }], [{ ad_id: 'a', adset_id: 's', campaign_id: 'c', impressions: '1', reach: '1', clicks: '1', spend: '0.02' }], [{ adset_id: 's', campaign_id: 'c', impressions: '1', reach: '1', spend: '0.02' }], [{ campaign_id: 'c', impressions: '1', reach: '1', spend: '0.02' }],
];
beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(global, 'fetch').mockResolvedValue({ json: async () => ({ id: 'me' }) } as any);
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());
function replies(values = rows) { for (const data of values) (fetchWithRetryAndPaging as jest.Mock).mockResolvedValueOnce({ data }); }
it('ENG-2026 exposes effective status for every reporting level, preserving configured status separately', async () => {
  replies(); const { body } = await request(app).get('/api/meta/ad-performance?timeframe=30d').expect(200);
  expect(body.adPerformance[0]).toMatchObject({ status: 'WITH_ISSUES', configuredStatus: 'ACTIVE', spend: 0.02 });
  expect(body.adSetsData[0].status).toBe('PENDING_REVIEW');
  expect(body.adsData[0]).toMatchObject({ status: 'DISAPPROVED', reach: 1, frequency: 1, impressions: 1 });
  expect((fetchWithRetryAndPaging as jest.Mock).mock.calls.slice(0, 3).every(([url]) => url.includes('effective_status'))).toBe(true);
});
it.each([0,1,2,3,4,5])('rejects malformed row at sibling external boundary %i instead of reporting zero', async index => {
  replies(rows.map((r, i) => i === index ? [null] as any : r));
  await request(app).get('/api/meta/ad-performance?timeframe=30d').expect(500);
});
