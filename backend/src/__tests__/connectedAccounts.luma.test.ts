/**
 * ENG-2338: how GET /connected-accounts presents a Luma API-key account.
 * Harness copied from connectedAccounts.hubspotRevoked.test.ts for the same module-load reasons.
 */
const mockAssertOwnedMetaPixel = jest.fn();
jest.mock('../services/metaAccountCredentials', () => ({
  assertOwnedMetaPixel: (...a: any[]) => mockAssertOwnedMetaPixel(...a),
}));

const mockOrphanTableMethods = {
  put: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
  get: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
  delete: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
};
jest.mock('aws-sdk', () => ({
  config: { update: jest.fn() },
  DynamoDB: {
    DocumentClient: jest.fn(() => mockOrphanTableMethods),
  },
}));

import request from 'supertest';
import express from 'express';
import connectedAccountsRouter from '../routes/connectedAccounts';
import * as connectedAccountsDb from '../services/connectedAccountsDb';
import { META_ADS_RECONSENT_MESSAGE } from '../utils/metaAdsScope';

jest.mock('axios');
jest.mock('../services/connectedAccountsDb');
jest.mock('../services/db', () => ({
  userDb: { getUserById: jest.fn() },
  orgDb: { getOrgById: jest.fn() },
  crmDb: { getLeadListById: jest.fn() },
}));
jest.mock('../middleware/auth', () => ({
  authenticateToken: (req: any, _res: any, next: any) => {
    req.user = { userId: 'test_user_id' };
    next();
  },
}));
jest.mock('../services/linkedInOutreachService', () => ({
  linkedInOutreachService: {
    getStatusesForAccounts: jest.fn().mockResolvedValue(new Map()),
    deleteAccount: jest.fn().mockResolvedValue(undefined),
  },
}));
jest.mock('../services/fathomApiService', () => ({
  FathomApiService: jest.fn().mockImplementation(() => ({
    validateApiKey: jest.fn().mockResolvedValue(true),
    deleteWebhook: jest.fn().mockResolvedValue(undefined),
  })),
}));
jest.mock('../services/subscriptionService', () => ({
  getAllowedConnectedAccounts: jest.fn().mockResolvedValue([]),
}));
jest.mock('../routes/calendlyAuth', () => ({ refreshCalendlyAccessToken: jest.fn() }));
jest.mock('../services/asyncJobQueue', () => ({
  enqueueJob: jest.fn(),
  updateJobPayload: jest.fn(),
  registerProcessor: jest.fn(),
}));

const app = express();
app.use(express.json());
app.use('/api/oauth', connectedAccountsRouter);

const lumaAccount = (config: Record<string, unknown>) => ({
  platform: 'luma',
  account_id: 'cal-1',
  account_name: 'ThinkingAI',
  userId: 'test_user_id',
  created_at: '2026-10-12T00:00:00.000Z',
  updated_at: '2026-10-12T00:00:00.000Z',
  config: {
    account_type: 'api_key',
    access_token: 'ciphertext-never-returned',
    token_expires_at: 9999999999999,
    ...config,
  },
});

const listAccounts = async () => {
  const response = await request(app).get('/api/oauth/connected-accounts');
  expect(response.status).toBe(200);
  return response.body.accounts[0];
};

describe('GET /connected-accounts — Luma API key (ENG-2338)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('reports a key Luma rejected as disconnected with a reconnect instruction', async () => {
    (connectedAccountsDb.getAccountsWithOwnerIncludingOrgShared as jest.Mock).mockResolvedValue([
      lumaAccount({ needs_reconnect: true }),
    ]);
    const account = await listAccounts();
    expect(account.status).toBe('disconnected');
    expect(account.expiry_message).toMatch(/reconnect/i);
    expect(account.expiry_message).toMatch(/luma/i);
  });

  it('reports a healthy key as connected (real token utils: the non-expiring sentinel must read as active, not expired)', async () => {
    (connectedAccountsDb.getAccountsWithOwnerIncludingOrgShared as jest.Mock).mockResolvedValue([lumaAccount({})]);
    const account = await listAccounts();
    expect(account.status).toBe('active');
    expect(account.expiry_message).toBe('Connected');
  });

  it('never puts the stored key in the response', async () => {
    (connectedAccountsDb.getAccountsWithOwnerIncludingOrgShared as jest.Mock).mockResolvedValue([lumaAccount({})]);
    const response = await request(app).get('/api/oauth/connected-accounts');
    expect(JSON.stringify(response.body)).not.toContain('ciphertext-never-returned');
  });
});
