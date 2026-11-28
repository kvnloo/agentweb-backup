import express from 'express';
import request from 'supertest';
import { createOAuthSessionDbMock } from './fixtures/oauthSessionDb';

const mockDb = createOAuthSessionDbMock();
jest.mock('../services/db', () => ({
  oauthSessionDb: mockDb,
  userDb: { getUserById: jest.fn(async () => ({ userId: 'user-123' })), updateUser: jest.fn() },
  orgDb: { getOrgById: jest.fn(), setOrgSecret: jest.fn() },
}));
jest.mock('../services/clickupService', () => ({ getAccessToken: jest.fn(), getWorkspaces: jest.fn(async () => []), listDocs: jest.fn(), listTasks: jest.fn() }));
jest.mock('../utils/crypto', () => ({ encryptPassword: jest.fn(() => 'encrypted'), decryptPassword: jest.fn() }));
jest.mock('../middleware/auth', () => ({
  authenticateToken: (req: any, _res: any, next: any) => {
    req.user = { userId: req.headers['x-user'] || 'user-123' }; next();
  },
}));
jest.mock('../config/integrations', () => {
  const config = { clientId: 'client', clientSecret: 'secret', redirectUri: 'https://example.com/callback',
    authorizationUrl: 'https://example.com/auth', tokenUrl: 'https://example.com/token',
    tokenInfoUrl: 'https://example.com/info', selfUrl: 'https://example.com/self', scopes: ['crm'], marketingScopes: ['crm'], marketingOnlyScopes: [] };
  return { getHubSpotConfig: async () => config, getFathomConfig: async () => config,
    getAttioConfig: async () => config, getClickUpConfig: async () => config };
});
jest.mock('axios', () => ({
  post: jest.fn(async () => ({ data: { access_token: 'access', refresh_token: 'refresh', expires_in: 3600 } })),
  get: jest.fn(async () => ({ data: { hub_id: 123, hub_domain: 'example.com', user: 'user', scopes: ['crm'],
    workspace_id: 'ws-1', workspace_name: 'Workspace' } })),
}));
jest.mock('../services/connectedAccountsDb', () => ({ createAccount: jest.fn(async () => ({ account_id: 'account' })), updateAccountConfig: jest.fn() }));
jest.mock('../services/fathomApiService', () => ({ FathomApiService: jest.fn(() => ({ registerWebhook: async () => ({ id: 'webhook' }) })) }));

function instance(provider: string) {
  const app = express();
  jest.isolateModules(() => {
    app.use(express.json(), require(`../routes/${provider}Auth`).default);
  });
  return app;
}
async function finalize(app: express.Express) {
  const init = await request(app).get('/init');
  const state = new URL(init.body.url).searchParams.get('state');
  return request(app).post('/finalize').send({ code: 'code', state });
}

describe.each(['hubspot', 'fathom', 'attio', 'clickup'])('%s shared OAuth sessions', provider => {
  beforeEach(() => { mockDb.rows.clear(); jest.clearAllMocks(); });
  afterEach(() => jest.restoreAllMocks());

  it('connects on a fresh instance and cannot replay on either instance', async () => {
    const a = instance(provider);
    const b = instance(provider);
    const result = await finalize(a);
    expect(result.status).toBe(200);
    expect(result.body.tokenSessionId).toMatch(/^[a-f0-9]{64}$/);
    const body = { tokenSessionId: result.body.tokenSessionId };
    expect((await request(b).post('/connect').send(body)).status).toBe(200);
    expect((await request(b).post('/connect').send(body)).status).toBe(401);
    expect((await request(a).post('/connect').send(body)).status).toBe(401);
  });

  it('rejects expired sessions even while the originating Map still holds them', async () => {
    const a = instance(provider);
    const result = await finalize(a);
    jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 600001);
    expect((await request(a).post('/connect').send({ tokenSessionId: result.body.tokenSessionId })).status).toBe(401);
  });

  it('rejects a different user without consuming the rightful user session', async () => {
    const a = instance(provider);
    const result = await finalize(a);
    const body = { tokenSessionId: result.body.tokenSessionId };
    expect((await request(a).post('/connect').set('x-user', 'other').send(body)).status).toBe(401);
    expect((await request(a).post('/connect').send(body)).status).toBe(200);
  });

  it.each([{}, [], 12, true, '   ', ''])('rejects malformed session IDs: %p', async tokenSessionId => {
    expect((await request(instance(provider)).post('/connect').send({ tokenSessionId })).status).toBe(400);
    expect(mockDb.consume).not.toHaveBeenCalled();
  });

  it.each([null, 'wrong-type', { tokens: true }, { tokens: { access_token: [] } }])('rejects malformed stored payloads: %p', async payload => {
    const a = instance(provider);
    const result = await finalize(a);
    mockDb.rows.get(result.body.tokenSessionId).payload = payload;
    expect((await request(a).post('/connect').send({ tokenSessionId: result.body.tokenSessionId })).status).toBe(401);
  });

  it('returns 500 on write errors without returning a bearer session', async () => {
    mockDb.save.mockRejectedValueOnce(new Error('Dynamo unavailable'));
    const result = await finalize(instance(provider));
    expect(result.status).toBe(500);
    expect(result.body.tokenSessionId).toBeUndefined();
  });

  it('returns 500 on consume errors instead of using its local shadow', async () => {
    const a = instance(provider);
    const result = await finalize(a);
    mockDb.consume.mockRejectedValueOnce(new Error('Dynamo unavailable'));
    expect((await request(a).post('/connect').send({ tokenSessionId: result.body.tokenSessionId })).status).toBe(500);
  });
});
