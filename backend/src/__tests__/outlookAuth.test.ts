import request from 'supertest';
import express from 'express';
import jwt from 'jsonwebtoken';

// ── Mocks ──────────────────────────────────────────────────────────────────
jest.mock('../config/integrations', () => ({
  getOutlookConfig: jest.fn().mockResolvedValue({
    clientId: 'test-client-id',
    clientSecret: 'test-client-secret',
    redirectUri: 'http://localhost:3001/api/oauth/outlook/callback',
    scopes: [
      'https://graph.microsoft.com/Mail.Send',
      'https://graph.microsoft.com/Mail.Read',
      'https://graph.microsoft.com/User.Read',
      'offline_access',
    ],
    authorizationUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    tokenUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    profileUrl: 'https://graph.microsoft.com/v1.0/me',
    sendMailUrl: 'https://graph.microsoft.com/v1.0/me/sendMail',
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

// The token store round-trips through the settings table (ENG-301). Back it with an
// in-memory map so /finalize -> /connect works across the request boundary.
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

jest.mock('../services/db', () => ({ oauthSessionDb: {} }));

jest.mock('axios');
const axios = require('axios');

process.env.JWT_SECRET = 'test-jwt-secret';
process.env.CUSTOMER_FRONTEND_URL = 'http://localhost:5174';

import outlookAuthRouter from '../routes/outlookAuth';

const app = express();
app.use(express.json());
app.use('/api/oauth/outlook', outlookAuthRouter);

const validState = (userId: string) =>
  jwt.sign({ userId, nonce: 'testnonce' }, 'test-jwt-secret', { expiresIn: '15m' });

/** A well-formed Microsoft token response. */
const tokenResponse = (over: any = {}) => ({
  data: {
    access_token: 'access-1',
    refresh_token: 'refresh-1',
    expires_in: 3600,
    scope:
      'https://graph.microsoft.com/Mail.Send https://graph.microsoft.com/Mail.Read ' +
      'https://graph.microsoft.com/User.Read offline_access',
    ...over,
  },
});

/** Graph /me for a work/school account. */
const profileResponse = (over: any = {}) => ({
  data: { mail: 'habeb@baldwin.com', userPrincipalName: 'habeb@baldwin.com', displayName: 'Habeb', ...over },
});

/** Walk the full flow and return the tokenSessionId minted by /finalize. */
const finalize = async (over: { token?: any; profile?: any } = {}) => {
  axios.post.mockResolvedValueOnce(over.token ?? tokenResponse());
  axios.get.mockResolvedValueOnce(over.profile ?? profileResponse());
  return request(app)
    .post('/api/oauth/outlook/finalize')
    .send({ code: 'auth-code', state: validState('user-123') });
};

beforeEach(() => {
  jest.clearAllMocks();
  // The refusal tests return BEFORE the profile fetch, leaving their queued axios.get
  // mockResolvedValueOnce unconsumed. clearAllMocks() does not drain that queue, so it
  // would leak into the next test and silently serve it the wrong profile. Reset, don't clear.
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
  it('returns a Microsoft authorization URL', async () => {
    const res = await request(app).get('/api/oauth/outlook/init');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.url).toMatch(/login\.microsoftonline\.com/);
  });

  // The app registration must be multitenant, or only OUR tenant can ever consent and no
  // customer can connect a mailbox. /common/ is what makes that true.
  it('uses the multitenant /common/ endpoint, not a tenant-specific one', async () => {
    const res = await request(app).get('/api/oauth/outlook/init');
    expect(res.body.url).toContain('/common/');
  });

  it('requests offline_access — without it there is no refresh token', async () => {
    const res = await request(app).get('/api/oauth/outlook/init');
    const scope = new URL(res.body.url).searchParams.get('scope') || '';
    expect(scope).toContain('offline_access');
    expect(scope).toContain('Mail.Send');
    expect(scope).toContain('Mail.Read');
  });

  it('carries the required OAuth params', async () => {
    const res = await request(app).get('/api/oauth/outlook/init');
    const url = new URL(res.body.url);
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('client_id')).toBe('test-client-id');
    expect(url.searchParams.get('prompt')).toBe('consent');
    expect(url.searchParams.get('redirect_uri')).toBeTruthy();
    expect(url.searchParams.get('state')).toBeTruthy();
  });

  it('500s when the Outlook config cannot be loaded', async () => {
    const { getOutlookConfig } = require('../config/integrations');
    getOutlookConfig.mockRejectedValueOnce(new Error('no secret'));
    const res = await request(app).get('/api/oauth/outlook/init');
    expect(res.status).toBe(500);
  });
});

describe('GET /callback', () => {
  it('forwards the code and state to the frontend', async () => {
    const res = await request(app).get('/api/oauth/outlook/callback?code=abc&state=xyz');
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('/oauth/outlook/callback');
    expect(res.headers.location).toContain('code=abc');
  });

  it('forwards a denial as an error', async () => {
    const res = await request(app).get('/api/oauth/outlook/callback?error=access_denied');
    expect(res.headers.location).toContain('error=outlook_access_denied');
  });

  it('forwards a missing code as an error', async () => {
    const res = await request(app).get('/api/oauth/outlook/callback');
    expect(res.headers.location).toContain('error=no_code_provided');
  });
});

describe('POST /finalize — CSRF and input validation', () => {
  it('rejects a missing code', async () => {
    const res = await request(app).post('/api/oauth/outlook/finalize').send({ state: validState('user-123') });
    expect(res.status).toBe(400);
  });

  it('rejects a missing state', async () => {
    const res = await request(app).post('/api/oauth/outlook/finalize').send({ code: 'abc' });
    expect(res.status).toBe(400);
  });

  it('rejects a state signed for a DIFFERENT user (CSRF)', async () => {
    const res = await request(app)
      .post('/api/oauth/outlook/finalize')
      .send({ code: 'abc', state: validState('someone-else') });
    expect(res.status).toBe(403);
  });

  it('rejects a garbage state', async () => {
    const res = await request(app)
      .post('/api/oauth/outlook/finalize')
      .send({ code: 'abc', state: 'not-a-jwt' });
    expect(res.status).toBe(403);
  });
});

describe('POST /finalize — Microsoft-specific refusals', () => {
  // Mail.Send is the entire point. Storing a mailbox that cannot send is worse than
  // refusing, because the failure surfaces later, at send time, as something opaque.
  it('refuses the connection when Mail.Send was not granted', async () => {
    const res = await finalize({
      token: tokenResponse({ scope: 'https://graph.microsoft.com/Mail.Read offline_access' }),
    });
    expect(res.status).toBe(422);
    expect(res.body.error).toBe('insufficient_scopes');
    expect(res.body.missingScopes).toContain('https://graph.microsoft.com/Mail.Send');
  });

  // Microsoft ROTATES refresh tokens. An account stored WITHOUT one can never refresh: it
  // works for about an hour and then dies silently, looking like a Microsoft outage.
  it('refuses the connection when Microsoft returns no refresh token', async () => {
    const res = await finalize({ token: tokenResponse({ refresh_token: undefined }) });
    expect(res.status).toBe(422);
    expect(res.body.error).toBe('missing_refresh_token');
  });

  it('refuses an account with no mailbox address', async () => {
    const res = await finalize({
      profile: { data: { displayName: 'No Mailbox' } }, // neither mail nor userPrincipalName
    });
    expect(res.status).toBe(422);
    expect(res.body.error).toBe('no_mailbox');
  });

  it('500s when the token exchange itself fails', async () => {
    axios.post.mockRejectedValueOnce(new Error('token endpoint down'));
    const res = await request(app)
      .post('/api/oauth/outlook/finalize')
      .send({ code: 'abc', state: validState('user-123') });
    expect(res.status).toBe(500);
  });
});

describe('POST /finalize — success', () => {
  it('returns a profile and a token session id, and NEVER the tokens', async () => {
    const res = await finalize();

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.profile.email).toBe('habeb@baldwin.com');
    expect(res.body.tokenSessionId).toEqual(expect.any(String));

    // Tokens are held server-side. Leaking them to the browser would defeat the whole flow.
    const body = JSON.stringify(res.body);
    expect(body).not.toContain('access-1');
    expect(body).not.toContain('refresh-1');
  });

  it('falls back to userPrincipalName when the account has no `mail` (personal accounts)', async () => {
    const res = await finalize({
      profile: { data: { userPrincipalName: 'habeb@outlook.com', displayName: 'Habeb' } },
    });
    expect(res.status).toBe(200);
    expect(res.body.profile.email).toBe('habeb@outlook.com');
  });
});

describe('POST /connect', () => {
  it('rejects a missing tokenSessionId', async () => {
    const res = await request(app).post('/api/oauth/outlook/connect').send({});
    expect(res.status).toBe(400);
  });

  it('rejects an unknown tokenSessionId', async () => {
    const res = await request(app).post('/api/oauth/outlook/connect').send({ tokenSessionId: 'nope' });
    expect(res.status).toBe(401);
  });

  it('persists the account, with the refresh token and BOTH scope fields', async () => {
    const fin = await finalize();
    const res = await request(app)
      .post('/api/oauth/outlook/connect')
      .send({ tokenSessionId: fin.body.tokenSessionId });

    expect(res.status).toBe(200);
    expect(createAccount).toHaveBeenCalledTimes(1);

    const [userId, platform, input] = createAccount.mock.calls[0];
    expect(userId).toBe('user-123');
    expect(platform).toBe('outlook');
    expect(input.account_id).toBe('habeb@baldwin.com');
    expect(input.config.account_type).toBe('outlook');
    expect(input.config.refresh_token).toBe('refresh-1');
    expect(input.config.token_expires_at).toBeGreaterThan(Date.now());

    // Populating only granted_scopes and leaving `scopes` empty was a real bug on the Gmail
    // side — code that read config.scopes concluded nothing had been granted.
    expect(input.config.scopes).toEqual(expect.arrayContaining(['https://graph.microsoft.com/Mail.Send']));
    expect(input.config.granted_scopes).toEqual(expect.arrayContaining(['https://graph.microsoft.com/Mail.Send']));
  });

  it('is one-time use: the same session cannot be replayed', async () => {
    const fin = await finalize();
    const id = fin.body.tokenSessionId;

    const first = await request(app).post('/api/oauth/outlook/connect').send({ tokenSessionId: id });
    expect(first.status).toBe(200);

    const replay = await request(app).post('/api/oauth/outlook/connect').send({ tokenSessionId: id });
    expect(replay.status).toBe(401);
    expect(createAccount).toHaveBeenCalledTimes(1);
  });

  it('500s when persisting the account fails', async () => {
    const fin = await finalize();
    createAccount.mockRejectedValueOnce(new Error('dynamo down'));
    const res = await request(app)
      .post('/api/oauth/outlook/connect')
      .send({ tokenSessionId: fin.body.tokenSessionId });
    expect(res.status).toBe(500);
  });
});
