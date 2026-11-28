/**
 * Characterization of the Attio OAuth routes (ENG-3044): pins the callback
 * redirects and the connected-account write so moving pending sessions onto
 * the shared AW-OAuthSessions store does not change observable behaviour.
 */
import express from 'express';
import request from 'supertest';

process.env.JWT_SECRET = 'test-jwt-secret-for-testing';

const mockCreateAccount = jest.fn(async (_userId: string, _provider: string, data: any) => ({ account_id: data.account_id, config: data.config }));
jest.mock('../services/db', () => ({ oauthSessionDb: require('./fixtures/oauthSessionDb').createOAuthSessionDbMock() }));
jest.mock('../services/connectedAccountsDb', () => ({ createAccount: (...args: any[]) => (mockCreateAccount as any)(...args) }));
jest.mock('../middleware/auth', () => ({
  authenticateToken: (req: any, _res: any, next: any) => { req.user = { userId: 'user-123' }; next(); },
}));
jest.mock('../config/integrations', () => ({
  getAttioConfig: async () => ({
    clientId: 'attio-client', clientSecret: 'attio-secret', redirectUri: 'https://api.example.com/attio/callback',
    authorizationUrl: 'https://app.attio.com/authorize', tokenUrl: 'https://app.attio.com/oauth/token',
    selfUrl: 'https://api.attio.com/v2/self', scopes: ['record_permission:read', 'object_configuration:read'],
  }),
}));
jest.mock('axios', () => ({
  post: jest.fn(async () => ({ data: { access_token: 'attio-access' } })),
  get: jest.fn(async () => ({ data: { workspace_id: 'ws-1', workspace_name: 'Acme' } })),
}));

import attioRouter from '../routes/attioAuth';
import { NON_EXPIRING_TOKEN_TIMESTAMP } from '../utils/tokenUtils';

const app = express();
app.use(express.json(), attioRouter);

async function finalize() {
  const init = await request(app).get('/init');
  const url = new URL(init.body.url);
  return { url, res: await request(app).post('/finalize').send({ code: 'code', state: url.searchParams.get('state') }) };
}

describe('Attio OAuth routes', () => {
  beforeEach(() => mockCreateAccount.mockClear());

  it('builds the authorization URL with the configured client, redirect URI and scopes', async () => {
    const { url } = await finalize();
    expect(url.origin + url.pathname).toBe('https://app.attio.com/authorize');
    expect(url.searchParams.get('client_id')).toBe('attio-client');
    expect(url.searchParams.get('redirect_uri')).toBe('https://api.example.com/attio/callback');
    expect(url.searchParams.get('scope')).toBe('record_permission:read object_configuration:read');
    expect(url.searchParams.get('response_type')).toBe('code');
  });

  it('redirects the provider callback to the frontend callback page', async () => {
    const res = await request(app).get('/callback').query({ code: 'abc', state: 's' });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('http://localhost:5174/oauth/attio/callback?code=abc&state=s');
    const denied = await request(app).get('/callback').query({ error: 'access_denied' });
    expect(denied.headers.location).toBe('http://localhost:5174/oauth/attio/callback?error=attio_access_denied&details=access_denied');
  });

  it('rejects a forged state', async () => {
    expect((await request(app).post('/finalize').send({ code: 'c', state: 'bad' })).status).toBe(403);
  });

  it('connects the workspace with the unchanged account shape and redacts the token', async () => {
    const { res } = await finalize();
    expect(res.status).toBe(200);
    const connect = await request(app).post('/connect').send({ tokenSessionId: res.body.tokenSessionId });
    expect(connect.status).toBe(200);
    expect(mockCreateAccount).toHaveBeenCalledWith('user-123', 'attio', {
      account_id: 'ws-1',
      account_name: 'Acme',
      config: {
        account_type: 'oauth', access_token: 'attio-access', token_expires_at: NON_EXPIRING_TOKEN_TIMESTAMP,
        workspace_id: 'ws-1', workspace_name: 'Acme',
      },
    });
    expect(JSON.stringify(connect.body)).not.toContain('attio-access');
  });

  it('returns 400 without a session id and 401 for an unknown one', async () => {
    expect((await request(app).post('/connect').send({})).status).toBe(400);
    const res = await request(app).post('/connect').send({ tokenSessionId: 'nope' });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Invalid or expired token session. Please reconnect.');
  });
});
