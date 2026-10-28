import express from 'express';
import request from 'supertest';
import connectedAccountsRouter from '../connectedAccounts';
import * as connectedAccountsDb from '../../services/connectedAccountsDb';
import { NON_EXPIRING_TOKEN_TIMESTAMP } from '../../utils/tokenUtils';

jest.mock('../../middleware/auth', () => ({
  authenticateToken: jest.fn((req: any, _res: any, next: any) => {
    req.user = { userId: 'user-123' };
    next();
  }),
}));

jest.mock('../../services/connectedAccountsDb', () => ({
  createAccount: jest.fn(),
  deleteAccount: jest.fn(),
  deleteAccountById: jest.fn(),
  getAccountsByUserId: jest.fn(),
  getAccountsWithOwnerIncludingOrgShared: jest.fn(),
  getAccountByPlatform: jest.fn(),
  updateAccountConfig: jest.fn(),
}));

jest.mock('../../services/fathomApiService', () => ({ FathomApiService: jest.fn() }));
jest.mock('../../services/linkedInOutreachService', () => ({
  linkedInOutreachService: { deleteAccount: jest.fn(), getStatusesForAccounts: jest.fn().mockResolvedValue(new Map()) },
}));

const smartleadRow = (config: Record<string, any> = {}) => ({
  platform: 'smartlead',
  account_id: 'smartlead-user-123',
  account_name: 'Smartlead',
  userId: 'user-123',
  config: { account_type: 'api_key', access_token: 'ciphertext', token_expires_at: NON_EXPIRING_TOKEN_TIMESTAMP, mailbox_count: 2, ...config },
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
});

describe('GET /api/oauth/connected-accounts for Smartlead (ENG-673)', () => {
  let app: express.Application;
  beforeEach(() => {
    jest.clearAllMocks();
    app = express();
    app.use(express.json());
    app.use('/api/oauth', connectedAccountsRouter);
  });

  it('shows a working key as connected, with no secret in the row', async () => {
    (connectedAccountsDb.getAccountsWithOwnerIncludingOrgShared as jest.Mock).mockResolvedValue([smartleadRow()]);
    const res = await request(app).get('/api/oauth/connected-accounts');
    expect(res.status).toBe(200);
    const row = res.body.accounts.find((a: any) => a.platform === 'smartlead');
    expect(row).toMatchObject({ status: 'active', owned: true });
    expect(JSON.stringify(res.body)).not.toContain('ciphertext');
  });

  it('shows a key Smartlead rejected as needing reconnect, never as connected', async () => {
    (connectedAccountsDb.getAccountsWithOwnerIncludingOrgShared as jest.Mock).mockResolvedValue([smartleadRow({ needs_reconnect: true })]);
    const res = await request(app).get('/api/oauth/connected-accounts');
    const row = res.body.accounts.find((a: any) => a.platform === 'smartlead');
    expect(row.status).toBe('disconnected');
    expect(JSON.stringify(row)).toMatch(/Reconnect required/);
  });
});
