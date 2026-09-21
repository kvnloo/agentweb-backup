/**
 * ENG-926 §C follow-up — the conversion-relay settings endpoint.
 *
 * Two things become reachable here that previously required editing a customer's
 * production DynamoDB record by hand: the relay's opt-in, and the per-account Meta event
 * names. Hand-editing production to activate a feature is not a mechanism, it is a hazard,
 * and §C shipped with exactly that as the only route.
 *
 * Harness copied from connectedAccounts.metaAdsCapability.test.ts, including its
 * metaAccountCredentials mock — without it this router pulls a chain that constructs a
 * real AWS.SecretsManager at module load and throws under ts-jest.
 */
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

const { userDb } = jest.requireMock('../services/db');
const mockUpdateAccountConfig = connectedAccountsDb.updateAccountConfig as jest.Mock;

const adAccount = (accountId: string, platform = 'meta', config: Record<string, any> = {}) => ({
  platform,
  account_id: accountId,
  config: { account_type: 'ad_account', access_token: 'tok', ...config },
});

const PATH = '/api/oauth/connected-accounts/meta/acct1/conversion-relay';

beforeEach(() => {
  jest.clearAllMocks();
  userDb.getUserById.mockResolvedValue({
    userId: 'test_user_id',
    connected_accounts: [adAccount('acct1')],
  });
  mockUpdateAccountConfig.mockResolvedValue(undefined);
});

describe('PATCH conversion-relay — the opt-in', () => {
  it('turns the relay on for one ad account', async () => {
    const res = await request(app).patch(PATH).send({ enabled: true });

    expect(res.status).toBe(200);
    expect(mockUpdateAccountConfig).toHaveBeenCalledWith(
      'test_user_id',
      'meta',
      'acct1',
      { crmConversionRelayEnabled: true },
      undefined,
    );
  });

  it('turns it back off again', async () => {
    await request(app).patch(PATH).send({ enabled: false });
    expect(mockUpdateAccountConfig.mock.calls[0][3]).toEqual({ crmConversionRelayEnabled: false });
  });

  it('rejects a non-boolean rather than storing a truthy string', async () => {
    // 'false' is truthy, and isConversionRelayEnabled compares === true — so a string
    // would silently mean "off" while reading as configured on.
    const res = await request(app).patch(PATH).send({ enabled: 'true' });
    expect(res.status).toBe(400);
    expect(mockUpdateAccountConfig).not.toHaveBeenCalled();
  });

  it('rejects a request that asks for nothing', async () => {
    const res = await request(app).patch(PATH).send({});
    expect(res.status).toBe(400);
    expect(mockUpdateAccountConfig).not.toHaveBeenCalled();
  });
});

describe('PATCH conversion-relay — event names', () => {
  it('stores a valid override', async () => {
    const res = await request(app).patch(PATH).send({ eventNames: { won: 'CRMPurchase' } });

    expect(res.status).toBe(200);
    expect(mockUpdateAccountConfig.mock.calls[0][3]).toEqual({
      crmConversionEventNames: { won: 'CRMPurchase' },
    });
  });

  it('clears the override with null, as an unset rather than a stored null', async () => {
    const res = await request(app).patch(PATH).send({ eventNames: null });

    expect(res.status).toBe(200);
    expect(mockUpdateAccountConfig.mock.calls[0][3]).toEqual({});
    expect(mockUpdateAccountConfig.mock.calls[0][4]).toEqual({ unset: ['crmConversionEventNames'] });
  });

  it('refuses a name Meta would reject at send time', async () => {
    const res = await request(app).patch(PATH).send({ eventNames: { won: 'CRM Purchase' } });
    expect(res.status).toBe(400);
    expect(mockUpdateAccountConfig).not.toHaveBeenCalled();
  });

  it('refuses Purchase on a slot that carries no value', async () => {
    // Meta requires value and currency on a Purchase (verified live in §C). This slot is
    // used precisely when no value can be stated, so it would drop every such conversion.
    const res = await request(app).patch(PATH).send({ eventNames: { wonNoValue: 'Purchase' } });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/currency/i);
  });

  it('sets both settings in one call', async () => {
    await request(app).patch(PATH).send({ enabled: true, eventNames: { qualified: 'CRM_MQL' } });
    expect(mockUpdateAccountConfig.mock.calls[0][3]).toEqual({
      crmConversionRelayEnabled: true,
      crmConversionEventNames: { qualified: 'CRM_MQL' },
    });
  });
});

describe('PATCH conversion-relay — ownership', () => {
  it('refuses an ad account the caller does not hold', async () => {
    userDb.getUserById.mockResolvedValue({ userId: 'test_user_id', connected_accounts: [] });

    const res = await request(app).patch(PATH).send({ enabled: true });

    expect(res.status).toBe(404);
    expect(mockUpdateAccountConfig).not.toHaveBeenCalled();
  });

  it('refuses a Meta connection that is not an ad account', async () => {
    userDb.getUserById.mockResolvedValue({
      userId: 'test_user_id',
      connected_accounts: [{ platform: 'meta', account_id: 'acct1', config: { account_type: 'page' } }],
    });

    const res = await request(app).patch(PATH).send({ enabled: true });
    expect(res.status).toBe(404);
  });

  it('uses the stored platform value verbatim for a legacy facebook row', async () => {
    // updateAccountConfig matches on platform AND id, so passing a hardcoded 'meta' would
    // throw for any record still stored as 'facebook'. Production carries none today, but
    // three other modules still accept both spellings.
    userDb.getUserById.mockResolvedValue({
      userId: 'test_user_id',
      connected_accounts: [adAccount('acct1', 'facebook')],
    });

    await request(app).patch(PATH).send({ enabled: true });

    expect(mockUpdateAccountConfig.mock.calls[0][1]).toBe('facebook');
  });

  it('returns 500 rather than a stack trace when the write fails', async () => {
    mockUpdateAccountConfig.mockRejectedValue(new Error('dynamo exploded'));
    const res = await request(app).patch(PATH).send({ enabled: true });
    expect(res.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toContain('dynamo exploded');
  });
});
