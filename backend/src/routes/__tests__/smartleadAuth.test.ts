import express from 'express';
import request from 'supertest';

jest.mock('../../middleware/auth', () => ({
  authenticateToken: jest.fn((req: any, _res: any, next: any) => {
    req.user = { userId: req.headers['x-test-user'] || 'user-123' };
    next();
  }),
}));

const mockCreateAccount = jest.fn();
jest.mock('../../services/connectedAccountsDb', () => ({
  createAccount: (...args: any[]) => mockCreateAccount(...args),
}));

const mockListEmailAccounts = jest.fn();
jest.mock('../../services/smartleadService', () => ({
  ...jest.requireActual('../../services/smartleadService'),
  listEmailAccounts: (...args: any[]) => mockListEmailAccounts(...args),
}));

import smartleadAuthRouter from '../smartleadAuth';
import { SmartleadApiError, SmartleadUnexpectedResponseError } from '../../services/smartleadService';
import { decryptPassword } from '../../utils/crypto';

const KEY = 'sl_live_supersecret_key_123';

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/oauth/smartlead', smartleadAuthRouter);
  return a;
}

// The rate limiter is keyed by user and lives for the whole test file, so each call gets its own user unless a test names one.
let nextUser = 0;
const connect = (body: unknown, user = `user-${++nextUser}`) =>
  request(app()).post('/api/oauth/smartlead/connect').set('x-test-user', user).send(body as object);

describe('POST /api/oauth/smartlead/connect (ENG-673)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'error').mockImplementation(() => {});
    mockCreateAccount.mockImplementation(async (userId: string, platform: string, input: any) => ({
      platform,
      account_id: input.account_id,
      account_name: input.account_name,
      config: input.config,
    }));
  });

  it('requires a key', async () => {
    const res = await connect({});
    expect(res.status).toBe(400);
    expect(mockListEmailAccounts).not.toHaveBeenCalled();
    expect(mockCreateAccount).not.toHaveBeenCalled();
  });

  it.each([401, 403])('rejects a key Smartlead answers %i to, and stores nothing', async (status) => {
    mockListEmailAccounts.mockRejectedValue(new SmartleadApiError(`Smartlead GET /email-accounts failed (${status})`, status));
    const res = await connect({ api_key: KEY });
    expect(res.status).toBe(422);
    expect(res.body.error).toMatch(/Pro/);
    expect(mockCreateAccount).not.toHaveBeenCalled();
    expect(JSON.stringify(res.body)).not.toContain(KEY);
  });

  it('passes a Smartlead rate limit through as 429', async () => {
    mockListEmailAccounts.mockRejectedValue(new SmartleadApiError('Smartlead GET /email-accounts failed (429)', 429));
    const res = await connect({ api_key: KEY });
    expect(res.status).toBe(429);
    expect(mockCreateAccount).not.toHaveBeenCalled();
  });

  it('answers 502 when Smartlead cannot be reached, without leaking the key in the response or the log', async () => {
    mockListEmailAccounts.mockRejectedValue(new Error(`ECONNRESET ?api_key=${KEY}`));
    const res = await connect({ api_key: KEY });
    expect(res.status).toBe(502);
    expect(JSON.stringify(res.body)).not.toContain(KEY);
    expect(JSON.stringify((console.error as jest.Mock).mock.calls)).not.toContain(KEY);
  });

  it('answers 502 for a Smartlead server error and for an unexpected response (no status)', async () => {
    mockListEmailAccounts.mockRejectedValueOnce(new SmartleadApiError('Smartlead GET /email-accounts failed (500)', 500));
    expect((await connect({ api_key: KEY })).status).toBe(502);
    mockListEmailAccounts.mockRejectedValueOnce(new SmartleadApiError('unexpected response'));
    expect((await connect({ api_key: KEY })).status).toBe(502);
    expect(mockCreateAccount).not.toHaveBeenCalled();
  });

  it.each([{ api_key: 123 }, { api_key: 'has a space' }, { api_key: 'x'.repeat(201) }])('rejects a malformed key %j without calling Smartlead', async (body) => {
    const res = await connect(body);
    expect(res.status).toBe(400);
    expect(mockListEmailAccounts).not.toHaveBeenCalled();
    expect(mockCreateAccount).not.toHaveBeenCalled();
  });

  it('stores the key encrypted and never returns it', async () => {
    mockListEmailAccounts.mockResolvedValue([{ id: 1, email: 'a@x.com' }, { id: 2, email: 'b@x.com' }]);
    const res = await connect({ api_key: `  ${KEY}  ` }, 'user-123');
    expect(res.status).toBe(200);
    expect(mockListEmailAccounts).toHaveBeenCalledWith(KEY, { maxRetries: 0, maxPages: 1 });

    const [userId, platform, input] = mockCreateAccount.mock.calls[0];
    expect(userId).toBe('user-123');
    expect(platform).toBe('smartlead');
    expect(input.account_id).toBe('smartlead-user-123');
    expect(input.config.account_type).toBe('api_key');
    expect(input.config.mailbox_count).toBe(2);
    expect(input.config.access_token).toBeTruthy();
    expect(input.config.access_token).not.toContain(KEY);
    // The later slices read the key back with decryptPassword, so it must round-trip.
    expect(decryptPassword(input.config.access_token)).toMatchObject({ password: KEY, userId: 'user-123' });

    expect(JSON.stringify(res.body)).not.toContain(KEY);
    expect(res.body.account.config.access_token).toBeUndefined();
    expect(res.body.warning).toBeUndefined();
  });

  it('asks createAccount to make a replaced key private again, in the same write', async () => {
    mockListEmailAccounts.mockResolvedValue([{ id: 1, email: 'a@x.com' }]);
    await connect({ api_key: KEY }, 'user-123');
    expect(mockCreateAccount).toHaveBeenCalledTimes(1);
    expect(mockCreateAccount.mock.calls[0][3]).toEqual({ resetSharing: true });
  });

  it('answers a 200 that is not a list with its own message, not the generic retry-later one', async () => {
    mockListEmailAccounts.mockRejectedValue(new SmartleadUnexpectedResponseError('Smartlead GET /email-accounts returned an unexpected response'));
    const res = await connect({ api_key: KEY });
    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/did not expect/);
    expect(mockCreateAccount).not.toHaveBeenCalled();
  });

  it('connects a valid key with no mailboxes and warns', async () => {
    mockListEmailAccounts.mockResolvedValue([]);
    const res = await connect({ api_key: KEY });
    expect(res.status).toBe(200);
    expect(res.body.warning).toMatch(/no email accounts/i);
    expect(mockCreateAccount).toHaveBeenCalledTimes(1);
  });

  it('limits connect attempts per user, then lets a different user through', async () => {
    mockListEmailAccounts.mockRejectedValue(new SmartleadApiError('Smartlead GET /email-accounts failed (401)', 401));
    for (let i = 0; i < 10; i++) {
      expect((await connect({ api_key: KEY }, 'limited-user')).status).toBe(422);
    }
    const blocked = await connect({ api_key: KEY }, 'limited-user');
    expect(blocked.status).toBe(429);
    expect(mockListEmailAccounts).toHaveBeenCalledTimes(10);
    expect((await connect({ api_key: KEY }, 'someone-else')).status).toBe(422);
  });
});
