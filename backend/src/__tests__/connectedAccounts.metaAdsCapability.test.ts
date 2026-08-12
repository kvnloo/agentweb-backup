/**
 * ENG-1158 — a Meta ad account that cannot read ads data must not be shown to
 * its owner as a healthy "Connected" account.
 *
 * Production shape (account 922903076601160): the OAuth token is unexpired, so
 * every status signal the Settings page had said "active", while every ads read
 * had been failing since the ads grant was recorded as revoked. Scheduled
 * reporting produced zero data for days and the only surface that knew was the
 * run output. These tests pin the Connected Accounts payload: a connection whose
 * ads grant is authoritatively missing reports as needing reconnection, carries
 * the reason, and — critically — an unprovable legacy record does NOT.
 */
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
jest.mock('../utils/tokenUtils', () => ({
  getTokenStatus: jest.fn().mockReturnValue('active'),
  formatExpiryMessage: jest.fn().mockReturnValue('Expires in 30 days'),
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

const metaAdAccount = (config: Record<string, unknown>) => ({
  platform: 'meta',
  account_id: '922903076601160',
  account_name: 'AgentWeb',
  userId: 'test_user_id',
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
  config: {
    account_type: 'ad_account',
    ad_account_id: '922903076601160',
    access_token: 'token',
    // Unexpired — the whole point: token health says nothing about ads capability.
    token_expires_at: Date.now() + 30 * 24 * 60 * 60 * 1000,
    ...config,
  },
});

const listAccounts = async () => {
  const response = await request(app).get('/api/oauth/connected-accounts');
  expect(response.status).toBe(200);
  return response.body.accounts[0];
};

describe('GET /connected-accounts — Meta Ads capability (ENG-1158)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('marks an ad account whose ads grant was recorded as revoked as needing reconnection', async () => {
    (connectedAccountsDb.getAccountsWithOwnerIncludingOrgShared as jest.Mock).mockResolvedValue([
      metaAdAccount({ granted_scopes: [], ads_scope_revoked_at: '2026-07-31T07:00:21.688Z' }),
    ]);

    const account = await listAccounts();

    expect(account.status).toBe('disconnected');
    expect(account.expiry_message).toMatch(/reconnect/i);
    expect(account.expiry_message).toMatch(/ads/i);
  });

  it('carries the actionable reason so the UI can explain what to approve', async () => {
    (connectedAccountsDb.getAccountsWithOwnerIncludingOrgShared as jest.Mock).mockResolvedValue([
      metaAdAccount({ granted_scopes: ['pages_show_list'] }),
    ]);

    const account = await listAccounts();

    expect(account.ads_capable).toBe(false);
    expect(account.capability_warning).toBe(META_ADS_RECONSENT_MESSAGE);
  });

  it('leaves a capable ad account fully active and unannotated by any warning', async () => {
    (connectedAccountsDb.getAccountsWithOwnerIncludingOrgShared as jest.Mock).mockResolvedValue([
      metaAdAccount({ granted_scopes: ['ads_read', 'pages_show_list'] }),
    ]);

    const account = await listAccounts();

    expect(account.status).toBe('active');
    expect(account.ads_capable).toBe(true);
    expect(account.capability_warning).toBeUndefined();
  });

  it('never accuses a legacy record we cannot prove either way', async () => {
    // `scopes` holds what we REQUESTED, not what Meta granted — reading it as a
    // capability signal would flag exactly the connections that work fine.
    (connectedAccountsDb.getAccountsWithOwnerIncludingOrgShared as jest.Mock).mockResolvedValue([
      metaAdAccount({ scopes: ['ads_read', 'ads_management'] }),
    ]);

    const account = await listAccounts();

    expect(account.status).toBe('active');
    expect(account.ads_capable).toBeUndefined();
    expect(account.capability_warning).toBeUndefined();
  });

  it('does not annotate non-ads Meta connections (an Instagram business account)', async () => {
    (connectedAccountsDb.getAccountsWithOwnerIncludingOrgShared as jest.Mock).mockResolvedValue([
      {
        ...metaAdAccount({ granted_scopes: ['pages_show_list'] }),
        config: {
          account_type: 'instagram_business',
          access_token: 'token',
          token_expires_at: Date.now() + 1000000,
          granted_scopes: ['pages_show_list'],
        },
      },
    ]);

    const account = await listAccounts();

    expect(account.status).toBe('active');
    expect(account.ads_capable).toBeUndefined();
    expect(account.capability_warning).toBeUndefined();
  });
});
