import express from 'express';
import request from 'supertest';

jest.mock('../../middleware/auth', () => ({
  authenticateToken: jest.fn((req: any, _res: any, next: any) => {
    req.user = { userId: 'user-123' };
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
import { SmartleadApiError } from '../../services/smartleadService';

const KEY = 'sl_live_supersecret_key_123';

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/oauth/smartlead', smartleadAuthRouter);
  return a;
}

const connect = (body: unknown) => request(app()).post('/api/oauth/smartlead/connect').send(body as object);

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

  it('answers 502 when Smartlead cannot be reached, without leaking the key', async () => {
    mockListEmailAccounts.mockRejectedValue(new Error(`ECONNRESET ?api_key=${KEY}`));
    const res = await connect({ api_key: KEY });
    expect(res.status).toBe(502);
    expect(JSON.stringify(res.body)).not.toContain(KEY);
  });

  it('stores the key encrypted and never returns it', async () => {
    mockListEmailAccounts.mockResolvedValue([{ id: 1, email: 'a@x.com' }, { id: 2, email: 'b@x.com' }]);
    const res = await connect({ api_key: `  ${KEY}  ` });
    expect(res.status).toBe(200);
    expect(mockListEmailAccounts).toHaveBeenCalledWith(KEY);

    const [userId, platform, input] = mockCreateAccount.mock.calls[0];
    expect(userId).toBe('user-123');
    expect(platform).toBe('smartlead');
    expect(input.account_id).toBe('smartlead');
    expect(input.config.account_type).toBe('api_key');
    expect(input.config.mailbox_count).toBe(2);
    expect(input.config.access_token).toBeTruthy();
    expect(input.config.access_token).not.toContain(KEY);

    expect(JSON.stringify(res.body)).not.toContain(KEY);
    expect(res.body.account.config.access_token).toBeUndefined();
    expect(res.body.warning).toBeUndefined();
  });

  it('connects a valid key with no mailboxes and warns', async () => {
    mockListEmailAccounts.mockResolvedValue([]);
    const res = await connect({ api_key: KEY });
    expect(res.status).toBe(200);
    expect(res.body.warning).toMatch(/no email accounts/i);
    expect(mockCreateAccount).toHaveBeenCalledTimes(1);
  });
});
