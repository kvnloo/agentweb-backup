/**
 * A HubSpot connection whose refresh token HubSpot has revoked must not render as
 * "Connected".
 *
 * Production shape (portal 245815183, argusoft.com): access token issued 2026-06-23
 * with a 30-minute life, never refreshed since, and the stored grant still carries a
 * refresh_token. The generic branch of this handler treats "has a refresh_token" as
 * proof of health — correctly for Gmail-style auto-renewal, wrongly here — so the
 * Settings page read "Active · Connected" for 97 days while every CRM sync against
 * that portal returned 401 and the last successful pull stayed 2026-06-16.
 *
 * Exactly the failure ENG-1158 describes one branch above for Meta Ads. Harness copied
 * from connectedAccounts.metaAdsCapability.test.ts for the same module-load reasons
 * documented there.
 */
// metaAccountCredentials is mocked below, before any import that would trigger
// it (jest.mock is hoisted above imports). Without this, routes/connectedAccounts.ts
// pulls in the real chain — metaAccountCredentials -> metaTokenRefresh -> metaService
// -> config/integrations -> utils/secretsManager — whose module body constructs a real
// `new AWS.SecretsManager()` at load time. That throws under this project's
// jest/ts-jest combination regardless of whether a test exercises Meta credentials at
// all (same test-harness-only artifact as the @slack/web-api mock in jest.config.js;
// see the identical fix already applied in connectedAccounts.test.ts).
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

const hubspotAccount = (config: Record<string, unknown>) => ({
  platform: 'hubspot',
  account_id: '245815183',
  account_name: 'argusoft.com',
  userId: 'test_user_id',
  created_at: '2026-06-23T14:04:54.476Z',
  updated_at: '2026-06-23T14:04:54.476Z',
  config: {
    account_type: 'oauth',
    access_token: 'stale',
    // Present and non-empty — this is what the generic branch mistakes for health.
    refresh_token: 'revoked-but-still-stored',
    // Long past. Normal for an auto-renewing account, so it is NOT the signal.
    token_expires_at: Date.parse('2026-06-23T14:34:54.453Z'),
    hub_id: 245815183,
    ...config,
  },
});

const listAccounts = async () => {
  const response = await request(app).get('/api/oauth/connected-accounts');
  expect(response.status).toBe(200);
  return response.body.accounts[0];
};

describe('GET /connected-accounts — HubSpot revoked refresh token', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('reports a flagged HubSpot grant as disconnected with a reconnect instruction', async () => {
    (connectedAccountsDb.getAccountsWithOwnerIncludingOrgShared as jest.Mock).mockResolvedValue([
      hubspotAccount({ needs_reconnect: true }),
    ]);

    const account = await listAccounts();

    expect(account.status).toBe('disconnected');
    expect(account.expiry_message).toMatch(/reconnect/i);
    expect(account.expiry_message).toMatch(/hubspot/i);
  });

  // The regression this whole change exists for. Before the fix this account reported
  // active/"Connected" purely because refresh_token was a non-empty string.
  it('does not let a stored refresh_token alone keep a revoked grant looking healthy', async () => {
    (connectedAccountsDb.getAccountsWithOwnerIncludingOrgShared as jest.Mock).mockResolvedValue([
      hubspotAccount({ needs_reconnect: true }),
    ]);

    const account = await listAccounts();

    expect(account.expiry_message).not.toBe('Connected');
    expect(account.status).not.toBe('active');
  });

  it('leaves a healthy HubSpot connection active despite a long-past access-token expiry', async () => {
    (connectedAccountsDb.getAccountsWithOwnerIncludingOrgShared as jest.Mock).mockResolvedValue([
      hubspotAccount({}),
    ]);

    const account = await listAccounts();

    expect(account.status).toBe('active');
    expect(account.expiry_message).toBe('Connected');
  });

  it('does not disconnect a HubSpot account flagged false', async () => {
    (connectedAccountsDb.getAccountsWithOwnerIncludingOrgShared as jest.Mock).mockResolvedValue([
      hubspotAccount({ needs_reconnect: false }),
    ]);

    expect((await listAccounts()).status).toBe('active');
  });

  // Scope guard: the flag is read per-platform, so it must not leak onto other
  // providers that happen to carry the same key.
  it('does not apply the HubSpot branch to a different platform', async () => {
    (connectedAccountsDb.getAccountsWithOwnerIncludingOrgShared as jest.Mock).mockResolvedValue([
      { ...hubspotAccount({ needs_reconnect: true }), platform: 'attio' },
    ]);

    expect((await listAccounts()).status).toBe('active');
  });
});
