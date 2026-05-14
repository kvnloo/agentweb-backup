import request from 'supertest';
import express from 'express';
import linkedInOutreachAuthRouter from '../routes/linkedInOutreachAuth';
import * as connectedAccountsDb from '../services/connectedAccountsDb';
import { linkedInOutreachService } from '../services/linkedInOutreachService';

jest.mock('../services/connectedAccountsDb');
jest.mock('../services/linkedInOutreachService', () => ({
  linkedInOutreachService: {
    getAccount: jest.fn(),
    clearStatusCache: jest.fn(),
    getClient: jest.fn(),
    getApiUrl: jest.fn().mockResolvedValue('https://api.unipile.com'),
  },
}));
jest.mock('../middleware/auth', () => ({
  authenticateToken: (req: any, _res: any, next: any) => {
    req.user = { userId: 'user-123' };
    next();
  },
}));

const app = express();
app.use(express.json());
app.use('/api/oauth/linkedin-outreach', linkedInOutreachAuthRouter);

const mockAccount = {
  account_id: 'acc-new-1',
  account_name: 'Test User',
  platform: 'unipile',
  config: {
    account_type: 'personal',
    unipile_account_id: 'acc-new-1',
    access_token: 'unipile:acc-new-1',
    token_expires_at: Number.MAX_SAFE_INTEGER,
    scopes: [],
  },
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
};

describe('POST /api/oauth/linkedin-outreach/save-account', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('saves account when getAccount succeeds immediately', async () => {
    (linkedInOutreachService.getAccount as jest.Mock).mockResolvedValue({
      type: 'LINKEDIN',
      name: 'Test User',
      connection_params: { im: { username: 'testuser' } },
    });
    (connectedAccountsDb.createAccount as jest.Mock).mockResolvedValue(mockAccount);

    const res = await request(app)
      .post('/api/oauth/linkedin-outreach/save-account')
      .send({ unipileAccountId: 'acc-new-1' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(connectedAccountsDb.createAccount).toHaveBeenCalledWith(
      'user-123',
      'unipile',
      expect.objectContaining({ account_id: 'acc-new-1', account_name: 'Test User' })
    );
  });

  it('saves account with fallback name when getAccount fails on all retries', async () => {
    jest.spyOn(global, 'setTimeout').mockImplementation((fn: any) => { fn(); return 0 as any; });
    (linkedInOutreachService.getAccount as jest.Mock).mockRejectedValue(new Error('Not provisioned yet'));
    (connectedAccountsDb.createAccount as jest.Mock).mockResolvedValue({
      ...mockAccount,
      account_name: 'LinkedIn Account',
    });

    const res = await request(app)
      .post('/api/oauth/linkedin-outreach/save-account')
      .send({ unipileAccountId: 'acc-new-1' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(connectedAccountsDb.createAccount).toHaveBeenCalledWith(
      'user-123',
      'unipile',
      expect.objectContaining({ account_id: 'acc-new-1', account_name: 'LinkedIn Account' })
    );
    // getAccount called 3 times (maxRetries)
    expect(linkedInOutreachService.getAccount).toHaveBeenCalledTimes(3);
    jest.restoreAllMocks();
  }, 10000);

  it('saves account after transient failure on first attempt', async () => {
    jest.spyOn(global, 'setTimeout').mockImplementation((fn: any) => { fn(); return 0 as any; });
    (linkedInOutreachService.getAccount as jest.Mock)
      .mockRejectedValueOnce(new Error('transient'))
      .mockResolvedValue({
        type: 'LINKEDIN',
        name: 'Shawn Zulfiqar',
        connection_params: { im: { username: 'shawnz' } },
      });
    (connectedAccountsDb.createAccount as jest.Mock).mockResolvedValue({
      ...mockAccount,
      account_name: 'Shawn Zulfiqar',
    });

    const res = await request(app)
      .post('/api/oauth/linkedin-outreach/save-account')
      .send({ unipileAccountId: 'acc-new-1' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(connectedAccountsDb.createAccount).toHaveBeenCalledWith(
      'user-123',
      'unipile',
      expect.objectContaining({ account_name: 'Shawn Zulfiqar' })
    );
    expect(linkedInOutreachService.getAccount).toHaveBeenCalledTimes(2);
    jest.restoreAllMocks();
  }, 10000);

  it('retries when getAccount returns wrong type then succeeds', async () => {
    jest.spyOn(global, 'setTimeout').mockImplementation((fn: any) => { fn(); return 0 as any; });
    (linkedInOutreachService.getAccount as jest.Mock)
      .mockResolvedValueOnce({ type: 'CONNECTING', name: '' })
      .mockResolvedValue({ type: 'LINKEDIN', name: 'Jane Doe', connection_params: { im: { username: 'jane' } } });
    (connectedAccountsDb.createAccount as jest.Mock).mockResolvedValue(mockAccount);

    const res = await request(app)
      .post('/api/oauth/linkedin-outreach/save-account')
      .send({ unipileAccountId: 'acc-new-1' });

    expect(res.status).toBe(200);
    expect(connectedAccountsDb.createAccount).toHaveBeenCalledWith(
      'user-123',
      'unipile',
      expect.objectContaining({ account_name: 'Jane Doe' })
    );
    expect(linkedInOutreachService.getAccount).toHaveBeenCalledTimes(2);
    jest.restoreAllMocks();
  }, 10000);

  it('returns 400 for missing unipileAccountId', async () => {
    const res = await request(app)
      .post('/api/oauth/linkedin-outreach/save-account')
      .send({});

    expect(res.status).toBe(400);
    expect(connectedAccountsDb.createAccount).not.toHaveBeenCalled();
  });

  it('returns 500 when createAccount throws', async () => {
    (linkedInOutreachService.getAccount as jest.Mock).mockResolvedValue({
      type: 'LINKEDIN',
      name: 'Test',
      connection_params: {},
    });
    (connectedAccountsDb.createAccount as jest.Mock).mockRejectedValue(new Error('DynamoDB failure'));

    const res = await request(app)
      .post('/api/oauth/linkedin-outreach/save-account')
      .send({ unipileAccountId: 'acc-new-1' });

    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Failed to save LinkedIn Outreach account');
  });

  it('clears status cache after successful save', async () => {
    (linkedInOutreachService.getAccount as jest.Mock).mockResolvedValue({
      type: 'LINKEDIN',
      name: 'Test',
      connection_params: {},
    });
    (connectedAccountsDb.createAccount as jest.Mock).mockResolvedValue(mockAccount);

    await request(app)
      .post('/api/oauth/linkedin-outreach/save-account')
      .send({ unipileAccountId: 'acc-new-1' });

    expect(linkedInOutreachService.clearStatusCache).toHaveBeenCalledWith('acc-new-1');
  });
});
