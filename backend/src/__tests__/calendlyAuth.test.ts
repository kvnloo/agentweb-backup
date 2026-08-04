import request from 'supertest';
import express from 'express';
import jwt from 'jsonwebtoken';

// ── Mocks ──────────────────────────────────────────────────────────────────
jest.mock('../config/integrations', () => ({
  getCalendlyConfig: jest.fn().mockResolvedValue({
    clientId: 'test-client-id',
    clientSecret: 'test-client-secret',
    redirectUri: 'http://localhost:3001/api/oauth/calendly/callback',
    authorizationUrl: 'https://auth.calendly.com/oauth/authorize',
    tokenUrl: 'https://auth.calendly.com/oauth/token',
    meUrl: 'https://api.calendly.com/users/me',
    webhookSubscriptionsUrl: 'https://api.calendly.com/webhook_subscriptions',
  }),
}));

const createAccount = jest.fn(async (_userId: string, platform: string, input: any) => ({
  platform,
  account_id: input.account_id,
  account_name: input.account_name,
  config: input.config,
}));
jest.mock('../services/connectedAccountsDb', () => ({ createAccount }));

jest.mock('../middleware/auth', () => ({
  authenticateToken: (req: any, _res: any, next: any) => {
    req.user = { userId: 'user-123', email: 'user@example.com' };
    next();
  },
}));

// Same in-memory settingsService backing used by outlookAuth.test.ts — the token store
// round-trips through it (ENG-301), so /finalize -> /connect must share state across the
// request boundary.
jest.mock('../services/settingsService', () => {
  const store = new Map<string, string>();
  return {
    settingsService: {
      setSetting: jest.fn(async (name: string, value: string) => { store.set(name, value); }),
      getSetting: jest.fn(async (name: string) => {
        const settingValue = store.get(name);
        return settingValue ? { settingName: name, settingValue } : null;
      }),
      deleteSetting: jest.fn(async (name: string) => { store.delete(name); }),
    },
  };
});

jest.mock('axios');
const axios = require('axios');

process.env.JWT_SECRET = 'test-jwt-secret';
process.env.CUSTOMER_FRONTEND_URL = 'http://localhost:5174';

import calendlyAuthRouter from '../routes/calendlyAuth';

const app = express();
app.use(express.json());
app.use('/api/oauth/calendly', calendlyAuthRouter);

/** A well-formed Calendly token response. */
const tokenResponse = (over: any = {}) => ({
  data: {
    access_token: 'access-1',
    refresh_token: 'refresh-1',
    expires_in: 7200,
    ...over,
  },
});

/** GET /users/me for a connected account. */
const meResponse = (over: any = {}) => ({
  data: {
    resource: {
      uri: 'https://api.calendly.com/users/AAAAAAAAAAAAAAAA',
      name: 'Jane Customer',
      email: 'jane@customer.com',
      current_organization: 'https://api.calendly.com/organizations/BBBBBBBBBBBBBBBB',
      ...over,
    },
  },
});

/** A successful webhook_subscriptions create response. */
const webhookCreatedResponse = (over: any = {}) => ({
  data: {
    resource: {
      uri: 'https://api.calendly.com/webhook_subscriptions/CCCCCCCCCCCCCCCC',
      ...over,
    },
  },
});

/** Walk /init to capture the code_verifier embedded in the signed state, then /finalize. */
const initAndFinalize = async (over: { token?: any; me?: any } = {}) => {
  const initRes = await request(app).get('/api/oauth/calendly/init');
  const state = new URL(initRes.body.url).searchParams.get('state')!;

  axios.post.mockResolvedValueOnce(over.token ?? tokenResponse());
  axios.get.mockResolvedValueOnce(over.me ?? meResponse());

  return request(app)
    .post('/api/oauth/calendly/finalize')
    .send({ code: 'auth-code', state });
};

beforeEach(() => {
  jest.clearAllMocks();
  axios.post.mockReset();
  axios.get.mockReset();
  createAccount.mockImplementation(async (_userId: string, platform: string, input: any) => ({
    platform,
    account_id: input.account_id,
    account_name: input.account_name,
    config: input.config,
  }));
});

describe('GET /init', () => {
  it('returns a Calendly authorization URL', async () => {
    const res = await request(app).get('/api/oauth/calendly/init');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.url).toMatch(/auth\.calendly\.com\/oauth\/authorize/);
  });

  // Calendly requires PKCE (S256) on every OAuth app, confidential client or not.
  it('includes a PKCE code_challenge using the S256 method', async () => {
    const res = await request(app).get('/api/oauth/calendly/init');
    const url = new URL(res.body.url);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')).toBeTruthy();
  });

  it('carries the required OAuth params', async () => {
    const res = await request(app).get('/api/oauth/calendly/init');
    const url = new URL(res.body.url);
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('client_id')).toBe('test-client-id');
    expect(url.searchParams.get('redirect_uri')).toBeTruthy();
    expect(url.searchParams.get('state')).toBeTruthy();
  });

  it('500s when the Calendly config cannot be loaded', async () => {
    const { getCalendlyConfig } = require('../config/integrations');
    getCalendlyConfig.mockRejectedValueOnce(new Error('no secret'));
    const res = await request(app).get('/api/oauth/calendly/init');
    expect(res.status).toBe(500);
  });
});

describe('GET /callback', () => {
  it('forwards the code and state to the frontend', async () => {
    const res = await request(app).get('/api/oauth/calendly/callback?code=abc&state=xyz');
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('/oauth/calendly/callback');
    expect(res.headers.location).toContain('code=abc');
  });

  it('forwards a denial as an error', async () => {
    const res = await request(app).get('/api/oauth/calendly/callback?error=access_denied');
    expect(res.headers.location).toContain('error=calendly_access_denied');
  });

  it('forwards a missing code as an error', async () => {
    const res = await request(app).get('/api/oauth/calendly/callback');
    expect(res.headers.location).toContain('error=no_code_provided');
  });
});

describe('POST /finalize — CSRF and input validation', () => {
  it('rejects a missing code', async () => {
    const initRes = await request(app).get('/api/oauth/calendly/init');
    const state = new URL(initRes.body.url).searchParams.get('state')!;
    const res = await request(app).post('/api/oauth/calendly/finalize').send({ state });
    expect(res.status).toBe(400);
  });

  it('rejects a missing state', async () => {
    const res = await request(app).post('/api/oauth/calendly/finalize').send({ code: 'abc' });
    expect(res.status).toBe(400);
  });

  it('rejects a state signed for a DIFFERENT user (CSRF)', async () => {
    const forgedState = jwt.sign(
      { userId: 'someone-else', nonce: 'n', codeVerifier: 'x'.repeat(43) },
      'test-jwt-secret',
      { expiresIn: '15m' },
    );
    const res = await request(app)
      .post('/api/oauth/calendly/finalize')
      .send({ code: 'abc', state: forgedState });
    expect(res.status).toBe(403);
  });

  it('rejects a garbage state', async () => {
    const res = await request(app)
      .post('/api/oauth/calendly/finalize')
      .send({ code: 'abc', state: 'not-a-jwt' });
    expect(res.status).toBe(403);
  });
});

describe('POST /finalize — Calendly-specific refusals', () => {
  it('refuses the connection when Calendly returns no refresh token', async () => {
    const res = await initAndFinalize({ token: tokenResponse({ refresh_token: undefined }) });
    expect(res.status).toBe(422);
    expect(res.body.error).toBe('missing_refresh_token');
  });

  it('500s when the token exchange itself fails', async () => {
    const initRes = await request(app).get('/api/oauth/calendly/init');
    const state = new URL(initRes.body.url).searchParams.get('state')!;
    axios.post.mockRejectedValueOnce(new Error('token endpoint down'));
    const res = await request(app)
      .post('/api/oauth/calendly/finalize')
      .send({ code: 'abc', state });
    expect(res.status).toBe(500);
  });
});

describe('POST /finalize — success', () => {
  it('returns a profile and a token session id, and NEVER the tokens', async () => {
    const res = await initAndFinalize();

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.profile.email).toBe('jane@customer.com');
    expect(res.body.tokenSessionId).toEqual(expect.any(String));

    const body = JSON.stringify(res.body);
    expect(body).not.toContain('access-1');
    expect(body).not.toContain('refresh-1');
  });

  it('sends the code_verifier from state in the token exchange (PKCE)', async () => {
    await initAndFinalize();
    const [, body] = axios.post.mock.calls[0];
    const params = new URLSearchParams(body);
    expect(params.get('code_verifier')).toBeTruthy();
    expect(params.get('code_verifier')!.length).toBeGreaterThanOrEqual(43);
  });
});

describe('POST /connect', () => {
  it('rejects a missing tokenSessionId', async () => {
    const res = await request(app).post('/api/oauth/calendly/connect').send({});
    expect(res.status).toBe(400);
  });

  it('rejects an unknown tokenSessionId', async () => {
    const res = await request(app).post('/api/oauth/calendly/connect').send({ tokenSessionId: 'nope' });
    expect(res.status).toBe(401);
  });

  it('persists the account and provisions a webhook when the plan qualifies', async () => {
    const fin = await initAndFinalize();
    axios.post.mockResolvedValueOnce(webhookCreatedResponse());

    const res = await request(app)
      .post('/api/oauth/calendly/connect')
      .send({ tokenSessionId: fin.body.tokenSessionId });

    expect(res.status).toBe(200);
    expect(res.body.account.config.booking_tracking_active).toBe(true);

    const [userId, platform, input] = createAccount.mock.calls[0];
    expect(userId).toBe('user-123');
    expect(platform).toBe('calendly');
    expect(input.account_id).toBe('jane@customer.com');
    expect(input.config.account_type).toBe('calendly');
    expect(input.config.refresh_token).toBe('refresh-1');
    expect(input.config.user_uri).toBe('https://api.calendly.com/users/AAAAAAAAAAAAAAAA');
    expect(input.config.organization_uri).toBe('https://api.calendly.com/organizations/BBBBBBBBBBBBBBBB');
    expect(input.config.webhook_id).toBe('https://api.calendly.com/webhook_subscriptions/CCCCCCCCCCCCCCCC');
    expect(input.config.webhook_signing_key).toEqual(expect.any(String));
  });

  // The real gate (verified against Calendly's own FAQ): webhook access requires the
  // CONNECTING account to be on Standard/Teams/Enterprise, not a developer-app-level
  // setting. OAuth succeeding does not guarantee the webhook call succeeds.
  it('still connects the account, marked inactive, when the plan does not support webhooks', async () => {
    const fin = await initAndFinalize();
    axios.post.mockRejectedValueOnce({
      response: { status: 403, data: { message: 'You must be on a paid plan to use this feature.' } },
    });

    const res = await request(app)
      .post('/api/oauth/calendly/connect')
      .send({ tokenSessionId: fin.body.tokenSessionId });

    expect(res.status).toBe(200);
    expect(res.body.account.config.booking_tracking_active).toBe(false);
    expect(res.body.upgradeRequired).toBe(true);

    const [, , input] = createAccount.mock.calls[0];
    expect(input.config.booking_tracking_active).toBe(false);
    expect(input.config.webhook_id).toBeUndefined();
  });

  it('is one-time use: the same session cannot be replayed', async () => {
    const fin = await initAndFinalize();
    axios.post.mockResolvedValueOnce(webhookCreatedResponse());

    const first = await request(app).post('/api/oauth/calendly/connect').send({ tokenSessionId: fin.body.tokenSessionId });
    expect(first.status).toBe(200);

    const replay = await request(app).post('/api/oauth/calendly/connect').send({ tokenSessionId: fin.body.tokenSessionId });
    expect(replay.status).toBe(401);
    expect(createAccount).toHaveBeenCalledTimes(1);
  });

  it('500s when persisting the account fails', async () => {
    const fin = await initAndFinalize();
    axios.post.mockResolvedValueOnce(webhookCreatedResponse());
    createAccount.mockRejectedValueOnce(new Error('dynamo down'));
    const res = await request(app)
      .post('/api/oauth/calendly/connect')
      .send({ tokenSessionId: fin.body.tokenSessionId });
    expect(res.status).toBe(500);
  });
});
