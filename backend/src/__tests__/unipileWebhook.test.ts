/**
 * Tests for the Unipile account_status webhook receiver
 * POST /api/webhooks/unipile/account-status (ENG-1197 fast-follow)
 *
 * Covers:
 *  - mapAccountStatusMessage: exhaustive over every documented Unipile status
 *    plus an unrecognized value (this is the only thing standing between a
 *    delivery and a false "your account is broken" customer email)
 *  - Auth boundary: missing/wrong header, and fail-closed when the secret is unset
 *  - Route wiring: CREDENTIALS reaches recordUnipileAccountHealth with the
 *    resolved owner; ignore-messages and non-LinkedIn deliveries never do;
 *    a thrown error surfaces as non-200 so Unipile's own retry engages
 */

import request from 'supertest';
import express from 'express';
import * as crypto from 'crypto';

import { mapAccountStatusMessage } from '../routes/unipileWebhook';

// ─── Mocks ───────────────────────────────────────────────────────────────────

const mockGetAllUnipileAccountIds = jest.fn();
jest.mock('../cron/linkedInConnectionSyncCron', () => ({
  getAllUnipileAccountIds: (...a: any[]) => mockGetAllUnipileAccountIds(...a),
}));

const mockRecordUnipileAccountHealth = jest.fn();
jest.mock('../services/linkedInConnectionHealth', () => ({
  recordUnipileAccountHealth: (...a: any[]) => mockRecordUnipileAccountHealth(...a),
}));

const mockSendAgentModeOncallAlert = jest.fn();
jest.mock('../utils/agentModeAlerts', () => ({
  sendAgentModeOncallAlert: (...a: any[]) => mockSendAgentModeOncallAlert(...a),
}));

// Imported after mocks so the router picks up the mocked modules.
import unipileWebhookRouter from '../routes/unipileWebhook';

const SECRET = 'test-unipile-secret';
const PATH = '/api/webhooks/unipile/account-status';

const app = express();
app.use(PATH, express.json());
app.use('/api/webhooks/unipile', unipileWebhookRouter);

function post(body: any, headers: Record<string, string> = {}) {
  let req = request(app).post(PATH);
  for (const [k, v] of Object.entries(headers)) req = req.set(k, v);
  return req.send(body);
}

// Mirrors app.ts's REAL global body-parser stack (express.json() matching only
// "application/json", falling back to express.urlencoded()) rather than the
// hand-picked express.json() the `app` above mounts for every request regardless
// of content-type. That mismatch is exactly why ENG-2180's bug shipped unnoticed:
// every test here used a parser more forgiving than production's.
const prodLikeAppWithoutFix = express();
prodLikeAppWithoutFix.use(express.json({ limit: '50mb' }));
prodLikeAppWithoutFix.use(express.urlencoded({ limit: '50mb', extended: true }));
prodLikeAppWithoutFix.use('/api/webhooks/unipile', unipileWebhookRouter);

// app.ts's actual fix: a path-scoped express.json({ type: () => true }) mounted
// before the global parsers, so this route parses JSON regardless of the
// declared content-type.
const prodLikeAppWithFix = express();
prodLikeAppWithFix.use('/api/webhooks/unipile', express.json({ type: () => true, limit: '1mb' }));
prodLikeAppWithFix.use(express.json({ limit: '50mb' }));
prodLikeAppWithFix.use(express.urlencoded({ limit: '50mb', extended: true }));
prodLikeAppWithFix.use('/api/webhooks/unipile', unipileWebhookRouter);

const payload = (message: string, accountId = 'acc_1', accountType: string | undefined = 'LINKEDIN') => ({
  AccountStatus: { account_id: accountId, account_type: accountType, message },
});

function postTo(
  targetApp: express.Express,
  body: ReturnType<typeof payload>,
  headers: Record<string, string> = {},
  contentType?: string,
) {
  let req = request(targetApp).post(PATH);
  for (const [k, v] of Object.entries(headers)) req = req.set(k, v);
  if (contentType) req = req.type(contentType);
  return req.send(JSON.stringify(body));
}

describe('mapAccountStatusMessage', () => {
  it.each([
    ['OK', { kind: 'health', state: 'connected' }],
    ['SYNC_SUCCESS', { kind: 'health', state: 'connected' }],
    ['RECONNECTED', { kind: 'health', state: 'connected' }],
    ['CREDENTIALS', { kind: 'health', state: 'disconnected' }],
    ['CONNECTING', { kind: 'ignore' }],
    ['CREATION_SUCCESS', { kind: 'ignore' }],
    ['DELETED', { kind: 'ignore' }],
    ['ERROR', { kind: 'investigate' }],
    ['STOPPED', { kind: 'investigate' }],
    ['SOME_FUTURE_STATUS', { kind: 'ignore' }],
  ])('maps "%s" to %j', (message, expected) => {
    expect(mapAccountStatusMessage(message)).toEqual(expected);
  });
});

describe('POST /api/webhooks/unipile/account-status', () => {
  const originalSecret = process.env.UNIPILE_WEBHOOK_SECRET;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.UNIPILE_WEBHOOK_SECRET = SECRET;
    mockGetAllUnipileAccountIds.mockResolvedValue({
      ids: ['acc_1'],
      ownerByAccountId: new Map([['acc_1', 'user_1']]),
    });
    mockRecordUnipileAccountHealth.mockResolvedValue('marked-disconnected');
    mockSendAgentModeOncallAlert.mockResolvedValue(true);
  });

  afterAll(() => {
    process.env.UNIPILE_WEBHOOK_SECRET = originalSecret;
  });

  describe('auth', () => {
    it('rejects with 401 when the auth header is missing', async () => {
      const res = await post(payload('CREDENTIALS'));
      expect(res.status).toBe(401);
      expect(mockRecordUnipileAccountHealth).not.toHaveBeenCalled();
    });

    it('rejects with 401 when the auth header value is wrong', async () => {
      const res = await post(payload('CREDENTIALS'), { 'unipile-auth': 'wrong-secret' });
      expect(res.status).toBe(401);
      expect(mockRecordUnipileAccountHealth).not.toHaveBeenCalled();
    });

    it('fails closed with 401 when UNIPILE_WEBHOOK_SECRET is unset, even with a header presented', async () => {
      delete process.env.UNIPILE_WEBHOOK_SECRET;
      const res = await post(payload('CREDENTIALS'), { 'unipile-auth': SECRET });
      expect(res.status).toBe(401);
      expect(mockRecordUnipileAccountHealth).not.toHaveBeenCalled();
    });

    it('accepts a correct header', async () => {
      const res = await post(payload('CREDENTIALS'), { 'unipile-auth': SECRET });
      expect(res.status).toBe(200);
    });
  });

  describe('with valid auth', () => {
    const headers = { 'unipile-auth': SECRET };

    it('CREDENTIALS resolves the owner and calls recordUnipileAccountHealth with state: disconnected', async () => {
      const res = await post(payload('CREDENTIALS', 'acc_1'), headers);
      expect(res.status).toBe(200);
      expect(mockRecordUnipileAccountHealth).toHaveBeenCalledWith({
        accountId: 'acc_1',
        ownerUserId: 'user_1',
        state: 'disconnected',
      });
    });

    it('OK calls recordUnipileAccountHealth with state: connected', async () => {
      const res = await post(payload('OK', 'acc_1'), headers);
      expect(res.status).toBe(200);
      expect(mockRecordUnipileAccountHealth).toHaveBeenCalledWith({
        accountId: 'acc_1',
        ownerUserId: 'user_1',
        state: 'connected',
      });
    });

    it('an ignore-message never calls recordUnipileAccountHealth', async () => {
      const res = await post(payload('CONNECTING', 'acc_1'), headers);
      expect(res.status).toBe(200);
      expect(mockRecordUnipileAccountHealth).not.toHaveBeenCalled();
      expect(mockGetAllUnipileAccountIds).not.toHaveBeenCalled();
    });

    it('ERROR fires an internal-only deduped oncall alert, never recordUnipileAccountHealth', async () => {
      const res = await post(payload('ERROR', 'acc_1'), headers);
      expect(res.status).toBe(200);
      expect(mockRecordUnipileAccountHealth).not.toHaveBeenCalled();
      expect(mockSendAgentModeOncallAlert).toHaveBeenCalledWith(
        expect.objectContaining({ dedupeKey: 'unipile-account-status-investigate:acc_1' }),
      );
    });

    it('a non-LinkedIn account_type is acknowledged but never reaches recordUnipileAccountHealth', async () => {
      const res = await post(payload('CREDENTIALS', 'acc_1', 'WHATSAPP'), headers);
      expect(res.status).toBe(200);
      expect(mockRecordUnipileAccountHealth).not.toHaveBeenCalled();
    });

    it('a missing account_type is ignored (fails closed), not defaulted to LinkedIn', async () => {
      // Built directly, not via payload() — its default parameter would silently
      // resupply 'LINKEDIN' if passed `undefined`, defeating the point of this test.
      const res = await post({ AccountStatus: { account_id: 'acc_1', message: 'CREDENTIALS' } }, headers);
      expect(res.status).toBe(200);
      expect(mockRecordUnipileAccountHealth).not.toHaveBeenCalled();
    });

    it('returns 500 (not a false 200/no-owner alert) when owner resolution itself fails, so Unipile retries', async () => {
      mockGetAllUnipileAccountIds.mockRejectedValue(new Error('DynamoDB scan failed'));
      const res = await post(payload('CREDENTIALS', 'acc_1'), headers);
      expect(res.status).toBe(500);
      expect(mockRecordUnipileAccountHealth).not.toHaveBeenCalled();
      expect(mockSendAgentModeOncallAlert).not.toHaveBeenCalled();
    });

    it('resolves to no owner when the account is unowned (site-wide), and still calls through with ownerUserId undefined', async () => {
      mockGetAllUnipileAccountIds.mockResolvedValue({ ids: ['acc_unowned'], ownerByAccountId: new Map() });
      const res = await post(payload('CREDENTIALS', 'acc_unowned'), headers);
      expect(res.status).toBe(200);
      expect(mockRecordUnipileAccountHealth).toHaveBeenCalledWith({
        accountId: 'acc_unowned',
        ownerUserId: undefined,
        state: 'disconnected',
      });
    });

    it('returns 400 on a malformed payload (missing account_id)', async () => {
      const res = await post({ AccountStatus: { message: 'CREDENTIALS' } }, headers);
      expect(res.status).toBe(400);
      expect(mockRecordUnipileAccountHealth).not.toHaveBeenCalled();
    });

    it('returns non-200 (not a false 200) when recordUnipileAccountHealth throws, so Unipile retries', async () => {
      mockRecordUnipileAccountHealth.mockRejectedValue(new Error('DynamoDB write failed'));
      const res = await post(payload('CREDENTIALS', 'acc_1'), headers);
      expect(res.status).toBe(500);
    });
  });
});

describe('body parsing against the real production middleware chain (ENG-2180)', () => {
  const headers = { 'unipile-auth': SECRET };

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.UNIPILE_WEBHOOK_SECRET = SECRET;
    mockGetAllUnipileAccountIds.mockResolvedValue({
      ids: ['acc_1'],
      ownerByAccountId: new Map([['acc_1', 'user_1']]),
    });
    mockRecordUnipileAccountHealth.mockResolvedValue('marked-disconnected');
    mockSendAgentModeOncallAlert.mockResolvedValue(true);
  });

  // Confirmed in prod (2026-09-28): every Unipile account_status delivery in the
  // last 5 days — 127 events across 10+ distinct accounts, 0 successful parses —
  // logged "[Unipile Webhook] Malformed payload" with the entire raw JSON body
  // turned into a single object key with an empty string value. That shape is the
  // unmistakable signature of express.urlencoded() parsing a JSON string it was
  // never meant to see: Unipile's delivery does not carry a Content-Type of
  // exactly "application/json", so app.ts's global express.json() (type-matched)
  // silently skips it and express.urlencoded() parses the raw text as a single
  // key. Every delivery was silently dropped and returned 400 — Unipile retries
  // up to 5x/30s then gives up, so the account_status fast-path (ENG-1197) has
  // never actually delivered a single event to recordUnipileAccountHealth.
  it('without the fix: a real-shaped delivery with a non-application/json content-type is silently dropped', async () => {
    const res = await postTo(prodLikeAppWithoutFix, payload('CREDENTIALS', 'acc_1'), headers, 'text/plain');
    expect(res.status).toBe(400);
    expect(mockRecordUnipileAccountHealth).not.toHaveBeenCalled();
  });

  it('with the fix: the same delivery is parsed and reaches recordUnipileAccountHealth', async () => {
    const res = await postTo(prodLikeAppWithFix, payload('CREDENTIALS', 'acc_1'), headers, 'text/plain');
    expect(res.status).toBe(200);
    expect(mockRecordUnipileAccountHealth).toHaveBeenCalledWith({
      accountId: 'acc_1',
      ownerUserId: 'user_1',
      state: 'disconnected',
    });
  });

  it('with the fix: a delivery whose content-type defaults to application/x-www-form-urlencoded is still parsed as JSON', async () => {
    // Clearing the Content-Type override doesn't make superagent send no header —
    // empirically verified it falls back to superagent's own default of
    // "application/x-www-form-urlencoded" for a raw string body. That default is
    // worth its own case: it's the exact content-type express.urlencoded() would
    // otherwise claim, i.e. precisely the pre-fix failure mode, reached here via a
    // client that never sets Content-Type at all rather than one that explicitly
    // (and wrongly) declares text/plain.
    const res = await request(prodLikeAppWithFix)
      .post(PATH)
      .set('unipile-auth', SECRET)
      .set('Content-Type', '')
      .send(JSON.stringify(payload('OK', 'acc_1')));
    expect(res.status).toBe(200);
    expect(mockRecordUnipileAccountHealth).toHaveBeenCalledWith({
      accountId: 'acc_1',
      ownerUserId: 'user_1',
      state: 'connected',
    });
  });

  it('with the fix: auth is still enforced before the body is ever trusted', async () => {
    const res = await postTo(prodLikeAppWithFix, payload('CREDENTIALS', 'acc_1'), { 'unipile-auth': 'wrong' }, 'text/plain');
    expect(res.status).toBe(401);
    expect(mockRecordUnipileAccountHealth).not.toHaveBeenCalled();
  });
});
