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

const payload = (message: string, accountId = 'acc_1', accountType: string | undefined = 'LINKEDIN') => ({
  AccountStatus: { account_id: accountId, account_type: accountType, message },
});

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
