jest.mock('../services/agentApiKeyService', () => ({ agentApiKeyService: { validateKey: jest.fn().mockResolvedValue({ userId: 'smoke', keyId: 'fixture', scopes: ['tools:read'] }) } }));
jest.mock('../mcp/oauth/oauthService', () => ({ mcpOAuthService: {} }));
jest.mock('../services/connectedAccountsDb', () => ({ getAccountsByUserIdIncludingOrgShared: jest.fn().mockResolvedValue([{ platform: 'meta', account_id: '123', config: { account_type: 'ad_account', ad_account_id: '123', access_token: 'fixture-token' } }]) }));
jest.mock('../services/mcpUsageEventsService', () => ({ recordMcpToolUse: jest.fn(), recordMcpWriteExecuted: jest.fn() }));
// Keep the HTTP route, gateway, signals executor and HTTP client real. Only replace
// the heavyweight service's credential lookup with a deterministic fixture seam.
jest.mock('../services/agentModeService', () => ({ agentModeService: { readToolkitMetaSignals: (_user: string, name: string, args: any) => require('../mcp/metaToolkitSignals').executeSignalsRead(name, args, { accountId: '123', accessToken: 'fixture-token' }) } }));
import express from 'express';
import request from 'supertest';
import axios from 'axios';
import http from 'http';
import router from '../routes/metaToolkit';
import { executeSignalsRead } from '../mcp/metaToolkitSignals';

const app = express();
app.use(express.json(), router);
const credentials = { accountId: '123', accessToken: 'fixture-token' };

describe('ENG-2917 HTTP signals recorder and local-error boundary', () => {
  let server: http.Server;
  let originalAdapter: typeof axios.defaults.adapter;
  const paths: string[] = [];
  beforeAll(async () => {
    server = http.createServer((req, res) => {
      paths.push(req.url!);
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(req.url!.includes('/456?') ? { id: '456', name: 'fixture' } : { data: [{ id: '456' }] }));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as any).port;
    originalAdapter = axios.defaults.adapter;
    const adapter = axios.getAdapter('http');
    axios.defaults.adapter = config => {
      const url = new URL(config.url!);
      // Recorder transport substitution only: production code still constructs
      // the complete Graph URL and query; no live credentials or API traffic.
      expect(url.hostname).toBe('graph.facebook.com');
      return adapter({ ...config, url: `http://127.0.0.1:${port}${url.pathname}`, proxy: false });
    };
  });
  afterAll(async () => {
    axios.defaults.adapter = originalAdapter;
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  });
  beforeEach(() => { paths.length = 0; });

  it.each([
    ['ads_get_datasets', {}, ['/act_123/adspixels']],
    ['ads_get_dataset_details', { pixel_id: '456' }, ['/act_123/adspixels', '/456']],
    ['ads_get_dataset_stats', { pixel_id: '456', aggregation: 'event' }, ['/act_123/adspixels', '/456/stats']],
    ['ads_pixel_event_read', { pixel_id: '456' }, ['/act_123/adspixels', '/456/event_rules']],
    ['ads_get_customconversions', {}, ['/act_123/customconversions']],
  ])('%s reaches the request recorder through the HTTP route', async (name, args, expected) => {
    const response = await request(app).post(`/tools/${name}/call`).set('Authorization', 'Bearer aw_fixture').send({ args: { account_id: '123', ...args } });
    expect(response.status).toBe(200);
    expect(response.body.result.success).not.toBe(false);
    expect(paths.map(p => new URL(p, 'http://recorder').pathname.replace(/^\/v\d+\.\d+/, ''))).toEqual(expected);
    expect(paths.every(p => new URL(p, 'http://recorder').searchParams.get('access_token') === 'fixture-token')).toBe(true);
    expect(JSON.stringify(response.body)).not.toContain('fixture-token');
  });

  it.each([
    new TypeError('local implementation defect'),
    Object.assign(new Error('local defect with arbitrary code'), { code: 'LOCAL_BUG' }),
    new Error('socket hang up in local parser, no transport error'),
  ])('does not disguise a local exception as a Meta result: %s', async error => {
    const get = jest.fn().mockRejectedValue(error);
    await expect(executeSignalsRead('ads_get_datasets', {}, credentials, { get } as any)).rejects.toBe(error);
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('returns HTTP 500 for a local error, not HTTP 200 success:false', async () => {
    const spy = jest.spyOn(axios, 'get').mockRejectedValueOnce(new TypeError('local implementation defect'));
    const log = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const response = await request(app).post('/tools/ads_get_datasets/call').set('Authorization', 'Bearer aw_fixture').send({ args: { account_id: '123' } });
      expect(response.status).toBe(500);
      expect(paths).toHaveLength(0);
      expect(response.body.error).toMatch(/^Meta Toolkit call failed: internal error \(TypeError\)/);
      expect(response.body.error).not.toMatch(/local implementation defect/);
    } finally { spy.mockRestore(); log.mockRestore(); }
  });

  it.each(['ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'ECONNABORTED'])('still returns a safe result for transport code %s', async code => {
    const error = Object.assign(new Error('network failure'), { code });
    const result = await executeSignalsRead('ads_get_datasets', {}, credentials, { get: jest.fn().mockRejectedValue(error) } as any);
    expect(result).toMatchObject({ success: false });
  });
});
