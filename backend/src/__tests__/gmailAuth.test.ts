import request from 'supertest';
import express from 'express';
import jwt from 'jsonwebtoken';

// ── Mocks ──────────────────────────────────────────────────────────────────
jest.mock('../config/integrations', () => ({
  getGmailConfig: jest.fn().mockResolvedValue({
    clientId: 'test-client-id',
    clientSecret: 'test-client-secret',
    redirectUri: 'http://localhost:3001/api/oauth/gmail/callback',
    scopes: [
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/gmail.send',
      'https://www.googleapis.com/auth/userinfo.email',
      'https://www.googleapis.com/auth/userinfo.profile',
    ],
    authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    revokeUrl: 'https://oauth2.googleapis.com/revoke',
    profileUrl: 'https://www.googleapis.com/oauth2/v2/userinfo',
  }),
}));

jest.mock('../services/connectedAccountsDb', () => ({
  createAccount: jest.fn(async (_userId, platform, input) => ({
    platform,
    account_id: input.account_id,
    account_name: input.account_name,
    config: input.config,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  })),
}));

jest.mock('../middleware/auth', () => ({
  authenticateToken: (req: any, _res: any, next: any) => {
    req.user = { userId: 'user-123', email: 'user@example.com' };
    next();
  },
}));

// OAuth token sessions are no longer held in process memory — they round-trip
// through the settings table so /finalize and /connect can land on different
// instances (ENG-301). Back it with an in-memory map for this route test.
jest.mock('../services/settingsService', () => {
  const store = new Map<string, string>();
  const conditionalCheckFailed = () => {
    const err: any = new Error('The conditional request failed');
    err.code = 'ConditionalCheckFailedException';
    return err;
  };
  return {
    settingsService: {
      setSetting: jest.fn(async (settingName: string, settingValue: string) => {
        store.set(settingName, settingValue);
      }),
      getSetting: jest.fn(async (settingName: string) => {
        const settingValue = store.get(settingName);
        return settingValue ? { settingName, settingValue } : null;
      }),
      deleteSetting: jest.fn(async (settingName: string) => {
        store.delete(settingName);
      }),
      // Conditional (compare-and-swap) primitives the store's one-time-use consume path
      // uses (ENG-965) — real DynamoDB semantics: the write only applies if the row's
      // current raw value still equals what the caller read.
      setSettingIfValueMatches: jest.fn(async (settingName: string, settingValue: string, expectedValue: string) => {
        if (store.get(settingName) !== expectedValue) throw conditionalCheckFailed();
        store.set(settingName, settingValue);
      }),
      deleteSettingIfValueMatches: jest.fn(async (settingName: string, expectedValue: string) => {
        if (store.get(settingName) !== expectedValue) throw conditionalCheckFailed();
        store.delete(settingName);
      }),
    },
  };
});

jest.mock('axios');
const axios = require('axios');

// ── App setup ──────────────────────────────────────────────────────────────
process.env.JWT_SECRET = 'test-jwt-secret';
process.env.CUSTOMER_FRONTEND_URL = 'http://localhost:5174';
process.env.GOOGLE_GMAIL_CLIENT_ID = 'test-client-id';
process.env.GOOGLE_GMAIL_CLIENT_SECRET = 'test-client-secret';

import gmailAuthRouter from '../routes/gmailAuth';

const app = express();
app.use(express.json());
app.use('/api/oauth/gmail', gmailAuthRouter);

// ── Helpers ────────────────────────────────────────────────────────────────
const generateValidState = (userId: string) =>
  jwt.sign({ userId, nonce: 'testnonce' }, 'test-jwt-secret', { expiresIn: '15m' });

// ── Tests ──────────────────────────────────────────────────────────────────
describe('Gmail OAuth Routes', () => {

  beforeEach(() => jest.clearAllMocks());

  // ── GET /init ────────────────────────────────────────────────────────────
  describe('GET /init', () => {
    it('returns an authorization URL', async () => {
      const res = await request(app).get('/api/oauth/gmail/init');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.url).toMatch(/accounts\.google\.com/);
    });

    it('URL contains required OAuth params', async () => {
      const res = await request(app).get('/api/oauth/gmail/init');
      const url = new URL(res.body.url);
      expect(url.searchParams.get('response_type')).toBe('code');
      expect(url.searchParams.get('access_type')).toBe('offline');
      expect(url.searchParams.get('prompt')).toBe('consent');
      expect(url.searchParams.get('client_id')).toBe('test-client-id');
      expect(url.searchParams.get('redirect_uri')).toBeTruthy();
    });

    it('URL includes required scopes', async () => {
      const res = await request(app).get('/api/oauth/gmail/init');
      const url = new URL(res.body.url);
      const scope = url.searchParams.get('scope') || '';
      expect(scope).toContain('gmail.readonly');
      expect(scope).toContain('userinfo.email');
    });

    it('does not request include_granted_scopes, so Google does not fold in scopes granted to other integrations sharing this OAuth client (e.g. Google Drive)', async () => {
      const res = await request(app).get('/api/oauth/gmail/init');
      const url = new URL(res.body.url);
      expect(url.searchParams.get('include_granted_scopes')).not.toBe('true');
    });
  });

  // ── GET /callback ────────────────────────────────────────────────────────
  describe('GET /callback', () => {
    it('redirects with code and state to frontend on success', async () => {
      const res = await request(app)
        .get('/api/oauth/gmail/callback?code=authcode123&state=somestate');
      expect(res.status).toBe(302);
      expect(res.headers.location).toContain('localhost:5174');
      expect(res.headers.location).toContain('code=authcode123');
      expect(res.headers.location).toContain('state=somestate');
    });

    it('redirects with error when Google returns error', async () => {
      const res = await request(app)
        .get('/api/oauth/gmail/callback?error=access_denied');
      expect(res.status).toBe(302);
      expect(res.headers.location).toContain('error=gmail_access_denied');
    });

    it('redirects with error when code is missing', async () => {
      const res = await request(app)
        .get('/api/oauth/gmail/callback?state=somestate');
      expect(res.status).toBe(302);
      expect(res.headers.location).toContain('error=no_code_provided');
    });
  });

  // ── POST /finalize ───────────────────────────────────────────────────────
  describe('POST /finalize', () => {
    const mockTokenResponse = {
      data: {
        access_token: 'google-access-token',
        refresh_token: 'google-refresh-token',
        expires_in: 3600,
        scope: 'https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile',
        token_type: 'Bearer',
      },
    };
    const mockProfileResponse = {
      data: {
        id: '12345',
        email: 'test@gmail.com',
        name: 'Test User',
        picture: 'https://example.com/photo.jpg',
        verified_email: true,
      },
    };

    it('exchanges code for tokens and returns profile + tokenSessionId', async () => {
      axios.post.mockResolvedValueOnce(mockTokenResponse);
      axios.get.mockResolvedValueOnce(mockProfileResponse);

      const state = generateValidState('user-123');
      const res = await request(app)
        .post('/api/oauth/gmail/finalize')
        .send({ code: 'valid-code', state });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.profile.email).toBe('test@gmail.com');
      expect(res.body.tokenSessionId).toBeDefined();
    });

    it('returns 400 when code is missing', async () => {
      const state = generateValidState('user-123');
      const res = await request(app)
        .post('/api/oauth/gmail/finalize')
        .send({ state });
      expect(res.status).toBe(400);
    });

    it('returns 400 when state is missing', async () => {
      const res = await request(app)
        .post('/api/oauth/gmail/finalize')
        .send({ code: 'some-code' });
      expect(res.status).toBe(400);
    });

    it('returns 403 when state JWT is invalid (CSRF)', async () => {
      const res = await request(app)
        .post('/api/oauth/gmail/finalize')
        .send({ code: 'some-code', state: 'invalid-state-token' });
      expect(res.status).toBe(403);
    });

    it('returns 403 when state userId does not match authenticated user', async () => {
      const state = generateValidState('different-user-456');
      const res = await request(app)
        .post('/api/oauth/gmail/finalize')
        .send({ code: 'some-code', state });
      expect(res.status).toBe(403);
    });

    it('returns 422 when required gmail scopes were not granted', async () => {
      axios.post.mockResolvedValueOnce({
        data: {
          ...mockTokenResponse.data,
          scope: 'https://www.googleapis.com/auth/userinfo.email', // missing gmail.readonly and gmail.send
        },
      });
      axios.get.mockResolvedValueOnce(mockProfileResponse);

      const state = generateValidState('user-123');
      const res = await request(app)
        .post('/api/oauth/gmail/finalize')
        .send({ code: 'valid-code', state });

      expect(res.status).toBe(422);
      expect(res.body.error).toContain('insufficient_scopes');
    });

    it('returns 500 when Google token exchange fails', async () => {
      axios.post.mockRejectedValueOnce(new Error('Google API error'));

      const state = generateValidState('user-123');
      const res = await request(app)
        .post('/api/oauth/gmail/finalize')
        .send({ code: 'bad-code', state });
      expect(res.status).toBe(500);
    });
  });

  // ── POST /connect ────────────────────────────────────────────────────────
  describe('POST /connect', () => {
    it('returns 400 when tokenSessionId is missing', async () => {
      const res = await request(app)
        .post('/api/oauth/gmail/connect')
        .send({});
      expect(res.status).toBe(400);
    });

    // ENG-965: a genuine store failure while consuming the one-time-use session must
    // surface as the route's own deliberate JSON error, not an unhandled rejection /
    // generic 500 — and must never leak the tokens it failed to safely consume.
    it('returns a deliberate error (not a generic 500) when the one-time-use delete fails, and never leaks tokens', async () => {
      axios.post.mockResolvedValueOnce({
        data: {
          access_token: 'google-access-token',
          refresh_token: 'google-refresh-token',
          expires_in: 3600,
          scope: 'https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile',
          token_type: 'Bearer',
        },
      });
      axios.get.mockResolvedValueOnce({
        data: { id: '12345', email: 'test@gmail.com', name: 'Test User', verified_email: true },
      });

      const { settingsService } = require('../services/settingsService');
      // Drain any stray session an earlier /finalize-only test in this file left behind
      // under the same fixed userId+provider key — otherwise this test's session would
      // land as a SIBLING (not the last one), taking the setSettingIfValueMatches branch
      // instead of the deleteSettingIfValueMatches branch this test targets.
      await settingsService.deleteSetting('oauth_token_session_gmail_user-123');

      const state = generateValidState('user-123');
      const finalizeRes = await request(app)
        .post('/api/oauth/gmail/finalize')
        .send({ code: 'valid-code', state });
      const { tokenSessionId } = finalizeRes.body;
      expect(tokenSessionId).toBeDefined();

      (settingsService.deleteSettingIfValueMatches as jest.Mock).mockRejectedValueOnce(
        Object.assign(new Error('ProvisionedThroughputExceededException'), {
          code: 'ProvisionedThroughputExceededException',
        }),
      );

      const connectRes = await request(app)
        .post('/api/oauth/gmail/connect')
        .send({ tokenSessionId });

      // Exact status, not a range (CodeRabbit, PR #2500 review): a >=400 range also passes
      // for 401, which is the "invalid/expired session" response — a regression that
      // misclassified this as an ordinary invalid session would slip through a range check.
      expect(connectRes.status).toBe(503);
      expect(connectRes.body.error).toBeDefined();
      expect(JSON.stringify(connectRes.body)).not.toMatch(/google-access-token|google-refresh-token/);
    });

    it('returns 401 when tokenSessionId is invalid or expired', async () => {
      const res = await request(app)
        .post('/api/oauth/gmail/connect')
        .send({ tokenSessionId: 'nonexistent-session' });
      expect(res.status).toBe(401);
    });

    it('persists granted scopes to BOTH config.scopes AND config.granted_scopes', async () => {
      // Regression test for the silent-scopes-drop bug: gmail /connect
      // previously populated `granted_scopes` but left the generic
      // `BaseOAuthConfig.scopes` field as `[]`, which made every downstream
      // reader that looked at `.scopes` think calendar wasn't granted.
      const scope = [
        'https://www.googleapis.com/auth/gmail.readonly',
        'https://www.googleapis.com/auth/gmail.send',
        'https://www.googleapis.com/auth/calendar.readonly',
        'https://www.googleapis.com/auth/userinfo.email',
        'https://www.googleapis.com/auth/userinfo.profile',
      ].join(' ');

      axios.post.mockResolvedValueOnce({
        data: {
          access_token: 'google-access-token',
          refresh_token: 'google-refresh-token',
          expires_in: 3600,
          scope,
          token_type: 'Bearer',
        },
      });
      axios.get.mockResolvedValueOnce({
        data: {
          id: '12345',
          email: 'test@gmail.com',
          name: 'Test User',
          picture: 'https://example.com/photo.jpg',
          verified_email: true,
        },
      });

      // Drive /finalize to prime a real tokenSession.
      const state = generateValidState('user-123');
      const finalizeRes = await request(app)
        .post('/api/oauth/gmail/finalize')
        .send({ code: 'valid-code', state });
      expect(finalizeRes.status).toBe(200);
      const { tokenSessionId } = finalizeRes.body;
      expect(tokenSessionId).toBeDefined();

      // Now hit /connect — the mock createAccount echoes the input config back
      // so we can assert on exactly what got persisted.
      const connectRes = await request(app)
        .post('/api/oauth/gmail/connect')
        .send({ tokenSessionId });

      expect(connectRes.status).toBe(200);
      const savedConfig = connectRes.body.account.config;
      expect(savedConfig.granted_scopes).toEqual(
        expect.arrayContaining([
          'https://www.googleapis.com/auth/gmail.readonly',
          'https://www.googleapis.com/auth/calendar.readonly',
        ]),
      );
      // The critical assertion: BaseOAuthConfig.scopes must also be populated,
      // not left empty as it was before the fix.
      expect(savedConfig.scopes).toEqual(savedConfig.granted_scopes);
      expect(Array.isArray(savedConfig.scopes)).toBe(true);
      expect(savedConfig.scopes.length).toBeGreaterThan(0);
    });
  });
});
