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
const getAccountsByUserId = jest.fn(async (): Promise<any[]> => []);
jest.mock('../services/connectedAccountsDb', () => ({ createAccount, getAccountsByUserId }));

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

const queueCalendlyWebhookCleanup = jest.fn();
const getOrphanedCalendlyWebhook = jest.fn((..._a: any[]): Promise<{ webhookId: string; refreshToken?: string } | null> => Promise.resolve(null));
const clearOrphanedCalendlyWebhook = jest.fn((..._a: any[]) => Promise.resolve(undefined));
jest.mock('../services/calendlyWebhookCleanupQueue', () => ({
  queueCalendlyWebhookCleanup: (...a: any[]) => queueCalendlyWebhookCleanup(...a),
  getOrphanedCalendlyWebhook: (...a: any[]) => getOrphanedCalendlyWebhook(...a),
  clearOrphanedCalendlyWebhook: (...a: any[]) => clearOrphanedCalendlyWebhook(...a),
}));

process.env.JWT_SECRET = 'test-jwt-secret';
process.env.CUSTOMER_FRONTEND_URL = 'http://localhost:5174';

import calendlyAuthRouter, { refreshCalendlyAccessToken } from '../routes/calendlyAuth';

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
  getAccountsByUserId.mockResolvedValue([]);
  queueCalendlyWebhookCleanup.mockResolvedValue(undefined);
  getOrphanedCalendlyWebhook.mockResolvedValue(null);
  clearOrphanedCalendlyWebhook.mockResolvedValue(undefined);
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

  // Greptile P1 on #2291 (round 13): the webhook is already live on Calendly's side by
  // the time createAccount runs — if persisting the local record then fails, nothing
  // anywhere records that webhook_id, so it can never be identified for cleanup and a
  // later connect attempt just gets Calendly's "Already Exists". Roll it back
  // immediately (we still have a fresh access_token in hand from this same request)
  // rather than needing a separate durable-recovery path for a webhook that never
  // finished connecting in the first place.
  it('rolls back the newly-created webhook when persisting the account fails, so the subscription isn\'t orphaned', async () => {
    const fin = await initAndFinalize();
    axios.post.mockResolvedValueOnce(webhookCreatedResponse());
    createAccount.mockRejectedValueOnce(new Error('dynamo down'));
    axios.delete = jest.fn().mockResolvedValueOnce({ data: {} });

    const res = await request(app)
      .post('/api/oauth/calendly/connect')
      .send({ tokenSessionId: fin.body.tokenSessionId });

    expect(res.status).toBe(500);
    expect(axios.delete).toHaveBeenCalledWith(
      'https://api.calendly.com/webhook_subscriptions/CCCCCCCCCCCCCCCC',
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer access-1' }) }),
    );
  });

  it('still 500s (does not throw) when the rollback delete itself fails after persisting the account fails', async () => {
    const fin = await initAndFinalize();
    axios.post.mockResolvedValueOnce(webhookCreatedResponse());
    createAccount.mockRejectedValueOnce(new Error('dynamo down'));
    axios.delete = jest.fn().mockRejectedValueOnce(new Error('calendly down too'));

    const res = await request(app)
      .post('/api/oauth/calendly/connect')
      .send({ tokenSessionId: fin.body.tokenSessionId });

    expect(res.status).toBe(500);
    expect(axios.delete).toHaveBeenCalledTimes(1);
  });

  // Greptile P1 on #2291 (round 14): the immediate rollback delete is best-effort —
  // if IT also fails (Calendly outage, or the very DynamoDB issue that just failed
  // createAccount also disrupting connectivity generally), the previous version just
  // logged and gave up, discarding the webhook_id with no durable record anywhere.
  // Exactly the same shape as the disconnect-side gap fixed in round 9 (issue 3) —
  // fall back to the same durable, unlimited-retry cleanup queue rather than
  // inventing a second recovery mechanism.
  it('falls back to the durable cleanup queue when the rollback delete itself fails', async () => {
    const fin = await initAndFinalize();
    axios.post.mockResolvedValueOnce(webhookCreatedResponse());
    createAccount.mockRejectedValueOnce(new Error('dynamo down'));
    axios.delete = jest.fn().mockRejectedValueOnce(new Error('calendly down too'));

    const res = await request(app)
      .post('/api/oauth/calendly/connect')
      .send({ tokenSessionId: fin.body.tokenSessionId });

    expect(res.status).toBe(500);
    expect(queueCalendlyWebhookCleanup).toHaveBeenCalledWith(
      'user-123',
      expect.objectContaining({
        webhook_id: 'https://api.calendly.com/webhook_subscriptions/CCCCCCCCCCCCCCCC',
        refresh_token: 'refresh-1',
      }),
    );
  });

  it('does not queue a durable cleanup when the immediate rollback delete succeeds', async () => {
    const fin = await initAndFinalize();
    axios.post.mockResolvedValueOnce(webhookCreatedResponse());
    createAccount.mockRejectedValueOnce(new Error('dynamo down'));
    axios.delete = jest.fn().mockResolvedValueOnce({ data: {} });

    const res = await request(app)
      .post('/api/oauth/calendly/connect')
      .send({ tokenSessionId: fin.body.tokenSessionId });

    expect(res.status).toBe(500);
    expect(queueCalendlyWebhookCleanup).not.toHaveBeenCalled();
  });

  it('does not attempt a rollback delete when createAccount fails but booking tracking was never active (no webhook was ever created)', async () => {
    const fin = await initAndFinalize();
    axios.post.mockRejectedValueOnce({
      response: { status: 403, data: { message: 'You must be on a paid plan to use this feature.' } },
    });
    createAccount.mockRejectedValueOnce(new Error('dynamo down'));
    axios.delete = jest.fn();

    const res = await request(app)
      .post('/api/oauth/calendly/connect')
      .send({ tokenSessionId: fin.body.tokenSessionId });

    expect(res.status).toBe(500);
    expect(axios.delete).not.toHaveBeenCalled();
  });

  // A reconnect (disconnect then re-connect) always attempts to create a fresh webhook
  // subscription. If a previous connect's subscription is still alive at the same
  // callback URL, Calendly rejects the create with { title: 'Already Exists' } — a real
  // incident, previously mislabeled as the plan-tier gate (wrong "upgrade your plan"
  // message shown to a customer who did nothing wrong).
  describe('duplicate webhook subscription (reconnect case)', () => {
    const duplicateError = {
      response: { status: 409, data: { title: 'Already Exists', message: 'Hook with this url already exists' } },
    };
    // Matches meResponse()'s default resource.uri — the user_uri a genuine reconnect
    // of the SAME Calendly identity would carry.
    const SAME_USER_URI = 'https://api.calendly.com/users/AAAAAAAAAAAAAAAA';
    const existingAccountFor = (webhookId: string, userUri: string = SAME_USER_URI) => ({
      platform: 'calendly',
      account_id: 'jane@customer.com',
      account_name: 'Jane Customer',
      config: { account_type: 'calendly', user_uri: userUri, webhook_id: webhookId },
    });

    it('deletes our own previously-recorded subscription and retries, succeeding with the new one', async () => {
      getAccountsByUserId.mockResolvedValueOnce([existingAccountFor('https://api.calendly.com/webhook_subscriptions/STALE111111111')]);
      const fin = await initAndFinalize();
      axios.post.mockRejectedValueOnce(duplicateError); // initial create: rejected as duplicate
      axios.delete = jest.fn().mockResolvedValueOnce({ data: {} }); // delete: succeeds
      axios.post.mockResolvedValueOnce(webhookCreatedResponse({ uri: 'https://api.calendly.com/webhook_subscriptions/FRESH2222222222' })); // retry create: succeeds

      const res = await request(app)
        .post('/api/oauth/calendly/connect')
        .send({ tokenSessionId: fin.body.tokenSessionId });

      expect(res.status).toBe(200);
      expect(res.body.upgradeRequired).toBeUndefined();
      expect(res.body.account.config.booking_tracking_active).toBe(true);
      expect(res.body.account.config.webhook_id).toBe('https://api.calendly.com/webhook_subscriptions/FRESH2222222222');
      expect(axios.delete).toHaveBeenCalledWith(
        'https://api.calendly.com/webhook_subscriptions/STALE111111111',
        expect.objectContaining({ headers: expect.objectContaining({ Authorization: expect.stringContaining('Bearer') }) }),
      );
    });

    // Greptile P1 (agentweb#2291): every AgentWeb tenant shares the identical callback
    // URL, so a prior version of this listed Calendly's webhook_subscriptions and matched
    // by callback_url — tenant-ambiguous, since two different AgentWeb accounts connecting
    // the SAME Calendly identity would both appear with that identical callback_url, and a
    // match could delete the OTHER tenant's live subscription. Fixed by never listing
    // Calendly's subscriptions at all — only ever deleting a webhook_id THIS account itself
    // recorded. No prior record for this account/user_uri means we cannot safely identify
    // anything to delete, so nothing is deleted, and no list call is ever made.
    it('does not call Calendly to list subscriptions, and does not delete anything, when this account has no prior webhook_id on record', async () => {
      getAccountsByUserId.mockResolvedValueOnce([]); // e.g. first-ever connect racing a duplicate, or a genuinely different tenant's conflict
      const fin = await initAndFinalize();
      axios.post.mockRejectedValueOnce(duplicateError);
      axios.delete = jest.fn();

      const res = await request(app)
        .post('/api/oauth/calendly/connect')
        .send({ tokenSessionId: fin.body.tokenSessionId });

      expect(res.status).toBe(200);
      expect(res.body.upgradeRequired).toBe(true);
      expect(res.body.account.config.booking_tracking_active).toBe(false);
      expect(axios.delete).not.toHaveBeenCalled();
      expect(axios.get).not.toHaveBeenCalledWith(
        expect.stringContaining('webhook_subscriptions'),
        expect.objectContaining({ params: expect.anything() }),
      );
    });

    // Greptile P1 on #2291 (round 16): the local account record isn't the only place a
    // prior webhook_id can live — if a previous disconnect/rollback's durable-queue
    // enqueue was ALSO unavailable at that moment, the identifier was recorded in the
    // orphan-webhook fallback table instead (calendlyWebhookCleanupQueue.ts). Reconnect
    // must be able to self-heal from THAT too, not just a local record, while still
    // never listing Calendly's shared webhook_subscriptions.
    it('falls back to the orphan-webhook table to identify and delete a stale subscription when there is no local record for this identity', async () => {
      getAccountsByUserId.mockResolvedValueOnce([]); // no local record — e.g. the account row was already deleted
      getOrphanedCalendlyWebhook.mockResolvedValueOnce({ webhookId: 'https://api.calendly.com/webhook_subscriptions/ORPHAN9999999999' });
      const fin = await initAndFinalize();
      axios.post.mockRejectedValueOnce(duplicateError);
      axios.delete = jest.fn().mockResolvedValueOnce({ data: {} });
      axios.post.mockResolvedValueOnce(webhookCreatedResponse({ uri: 'https://api.calendly.com/webhook_subscriptions/FRESH3333333333' }));

      const res = await request(app)
        .post('/api/oauth/calendly/connect')
        .send({ tokenSessionId: fin.body.tokenSessionId });

      expect(res.status).toBe(200);
      expect(res.body.account.config.booking_tracking_active).toBe(true);
      expect(res.body.account.config.webhook_id).toBe('https://api.calendly.com/webhook_subscriptions/FRESH3333333333');
      expect(getOrphanedCalendlyWebhook).toHaveBeenCalledWith('user-123', SAME_USER_URI);
      expect(axios.delete).toHaveBeenCalledWith(
        'https://api.calendly.com/webhook_subscriptions/ORPHAN9999999999',
        expect.objectContaining({ headers: expect.objectContaining({ Authorization: expect.stringContaining('Bearer') }) }),
      );
      // Consumed — cleared so a future connect doesn't try to re-identify an already
      // resolved orphan.
      expect(clearOrphanedCalendlyWebhook).toHaveBeenCalledWith('user-123', SAME_USER_URI);
    });

    it('prefers the local account record over the orphan-webhook table when both exist', async () => {
      // Deliberately does NOT seed getOrphanedCalendlyWebhook with a distinct value —
      // the `??` in provisionCalendlyWebhook's caller short-circuits on the local
      // record, so the orphan lookup must never even run (asserted below). If it
      // incorrectly did run, its default (null) return would surface as a DIFFERENT
      // bug (falling through with no webhookId at all), not a false pass here.
      getAccountsByUserId.mockResolvedValueOnce([existingAccountFor('https://api.calendly.com/webhook_subscriptions/LOCAL4444444444')]);
      const fin = await initAndFinalize();
      axios.post.mockRejectedValueOnce(duplicateError);
      axios.delete = jest.fn().mockResolvedValueOnce({ data: {} });
      axios.post.mockResolvedValueOnce(webhookCreatedResponse());

      await request(app)
        .post('/api/oauth/calendly/connect')
        .send({ tokenSessionId: fin.body.tokenSessionId });

      expect(axios.delete).toHaveBeenCalledWith(
        'https://api.calendly.com/webhook_subscriptions/LOCAL4444444444',
        expect.anything(),
      );
      // Short-circuits on the local record — the orphan-table lookup is never even made.
      expect(getOrphanedCalendlyWebhook).not.toHaveBeenCalled();
    });

    // The core tenant-isolation guarantee: a webhook_id recorded for a DIFFERENT Calendly
    // identity than the one currently reconnecting must never be reused as a delete target,
    // even though it belongs to this same AgentWeb account — it isn't the thing Calendly is
    // reporting as a duplicate right now, and using it either does nothing useful or, worse,
    // deletes an unrelated live subscription of this account's own.
    it('does not reuse a previously-recorded webhook_id that belongs to a DIFFERENT Calendly user_uri', async () => {
      getAccountsByUserId.mockResolvedValueOnce([
        existingAccountFor('https://api.calendly.com/webhook_subscriptions/OTHER_IDENTITY', 'https://api.calendly.com/users/SOME_OTHER_USER'),
      ]);
      const fin = await initAndFinalize();
      axios.post.mockRejectedValueOnce(duplicateError);
      axios.delete = jest.fn();

      const res = await request(app)
        .post('/api/oauth/calendly/connect')
        .send({ tokenSessionId: fin.body.tokenSessionId });

      expect(res.status).toBe(200);
      expect(res.body.upgradeRequired).toBe(true);
      expect(res.body.account.config.booking_tracking_active).toBe(false);
      expect(axios.delete).not.toHaveBeenCalled();
    });

    // Greptile P1 on #2291 (round 7): getAccountByPlatform only ever returns the
    // FIRST Calendly account for this AgentWeb user — if they have more than one
    // connected and are reconnecting one that isn't first in the list, it never
    // found that identity's own record even though one genuinely exists. Must
    // search every one of this user's Calendly accounts for the matching identity,
    // not just the first.
    it('finds and deletes its own stale subscription when reconnecting a Calendly identity that is NOT the first account in the list', async () => {
      getAccountsByUserId.mockResolvedValueOnce([
        existingAccountFor('https://api.calendly.com/webhook_subscriptions/OTHER_ACCOUNT_FIRST', 'https://api.calendly.com/users/A_DIFFERENT_USER'),
        existingAccountFor('https://api.calendly.com/webhook_subscriptions/STALE111111111'), // matches SAME_USER_URI, second in the list
      ]);
      const fin = await initAndFinalize();
      axios.post.mockRejectedValueOnce(duplicateError);
      axios.delete = jest.fn().mockResolvedValueOnce({ data: {} });
      axios.post.mockResolvedValueOnce(webhookCreatedResponse({ uri: 'https://api.calendly.com/webhook_subscriptions/FRESH2222222222' }));

      const res = await request(app)
        .post('/api/oauth/calendly/connect')
        .send({ tokenSessionId: fin.body.tokenSessionId });

      expect(res.status).toBe(200);
      expect(res.body.account.config.booking_tracking_active).toBe(true);
      expect(axios.delete).toHaveBeenCalledWith(
        'https://api.calendly.com/webhook_subscriptions/STALE111111111',
        expect.anything(),
      );
      expect(axios.delete).not.toHaveBeenCalledWith(
        'https://api.calendly.com/webhook_subscriptions/OTHER_ACCOUNT_FIRST',
        expect.anything(),
      );
    });

    it('falls back to the upgrade-required message when the retry after cleanup also fails', async () => {
      getAccountsByUserId.mockResolvedValueOnce([existingAccountFor('https://api.calendly.com/webhook_subscriptions/STALE111111111')]);
      const fin = await initAndFinalize();
      axios.post.mockRejectedValueOnce(duplicateError); // initial create
      axios.delete = jest.fn().mockResolvedValueOnce({ data: {} }); // delete succeeds
      axios.post.mockRejectedValueOnce(new Error('still failing')); // retry create fails

      const res = await request(app)
        .post('/api/oauth/calendly/connect')
        .send({ tokenSessionId: fin.body.tokenSessionId });

      expect(res.status).toBe(200);
      expect(res.body.upgradeRequired).toBe(true);
      expect(res.body.account.config.booking_tracking_active).toBe(false);
    });

    // Regression guard: a genuine plan-tier rejection (no `title: 'Already Exists'`) must
    // NOT be routed through the duplicate-cleanup path — it should hit the original,
    // simple fallback exactly like the "plan does not support webhooks" test above.
    it('does not attempt duplicate cleanup for a non-duplicate failure', async () => {
      getAccountsByUserId.mockResolvedValueOnce([existingAccountFor('https://api.calendly.com/webhook_subscriptions/STALE111111111')]);
      const fin = await initAndFinalize();
      axios.post.mockRejectedValueOnce({
        response: { status: 403, data: { message: 'You must be on a paid plan to use this feature.' } },
      });
      axios.delete = jest.fn();

      const res = await request(app)
        .post('/api/oauth/calendly/connect')
        .send({ tokenSessionId: fin.body.tokenSessionId });

      expect(res.status).toBe(200);
      expect(res.body.upgradeRequired).toBe(true);
      expect(axios.delete).not.toHaveBeenCalled();
    });
  });
});

describe('refreshCalendlyAccessToken', () => {
  const refreshTokenResponse = (over: any = {}) => ({
    data: {
      access_token: 'new-access-token',
      refresh_token: 'new-refresh-token',
      ...over,
    },
  });

  it('succeeds on the first attempt without retrying', async () => {
    axios.post.mockResolvedValueOnce(refreshTokenResponse());

    const result = await refreshCalendlyAccessToken('old-refresh-token');

    expect(result).toEqual({ access_token: 'new-access-token', refresh_token: 'new-refresh-token' });
    expect(axios.post).toHaveBeenCalledTimes(1);
  });

  it('keeps the original refresh_token when Calendly does not rotate it', async () => {
    axios.post.mockResolvedValueOnce(refreshTokenResponse({ refresh_token: undefined }));

    const result = await refreshCalendlyAccessToken('old-refresh-token');

    expect(result).toEqual({ access_token: 'new-access-token', refresh_token: 'old-refresh-token' });
  });

  it('retries once after a transient failure with no HTTP response, then succeeds', async () => {
    axios.post.mockRejectedValueOnce(new Error('socket hang up'));
    axios.post.mockResolvedValueOnce(refreshTokenResponse());

    const result = await refreshCalendlyAccessToken('old-refresh-token');

    expect(result).toEqual({ access_token: 'new-access-token', refresh_token: 'new-refresh-token' });
    expect(axios.post).toHaveBeenCalledTimes(2);
  });

  it('retries once after a 5xx from Calendly, then succeeds', async () => {
    axios.post.mockRejectedValueOnce({ response: { status: 503, data: { error: 'service_unavailable' } } });
    axios.post.mockResolvedValueOnce(refreshTokenResponse());

    const result = await refreshCalendlyAccessToken('old-refresh-token');

    expect(result).toEqual({ access_token: 'new-access-token', refresh_token: 'new-refresh-token' });
    expect(axios.post).toHaveBeenCalledTimes(2);
  });

  it('does not retry a genuine 4xx auth failure and returns null', async () => {
    axios.post.mockRejectedValueOnce({ response: { status: 400, data: { error: 'invalid_grant' } } });

    const result = await refreshCalendlyAccessToken('revoked-refresh-token');

    expect(result).toBeNull();
    expect(axios.post).toHaveBeenCalledTimes(1);
  });

  it('returns null without throwing when both the initial attempt and the retry fail', async () => {
    axios.post.mockRejectedValueOnce(new Error('socket hang up'));
    axios.post.mockRejectedValueOnce({ response: { status: 502, data: { error: 'bad_gateway' } } });

    const result = await refreshCalendlyAccessToken('old-refresh-token');

    expect(result).toBeNull();
    expect(axios.post).toHaveBeenCalledTimes(2);
  });
});
