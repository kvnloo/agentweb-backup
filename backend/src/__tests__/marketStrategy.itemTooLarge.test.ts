/**
 * ENG-2840 (Opslane P1 on ef2bc22): POST /api/market-strategy answers an oversized record with a reason, not a bare 500.
 *
 * The strategy sits on a record DynamoDB caps at 400 KB (the user's record, or the organisation's). A save that would push the whole record past
 * it is refused by the service atomically, and the route used to turn that into "Internal server error". These tests drive the real router, in
 * both its org and solo branches.
 */
import express from 'express';
import request from 'supertest';

const mockDynamoQuery = jest.fn();
const mockDynamoUpdate = jest.fn();

jest.mock('aws-sdk', () => ({
  config: { update: jest.fn() },
  DynamoDB: {
    DocumentClient: jest.fn(() => ({
      query: jest.fn((params: any) => ({ promise: () => mockDynamoQuery(params) })),
      get: jest.fn(() => ({ promise: jest.fn().mockResolvedValue({}) })),
      update: jest.fn((params: any) => ({ promise: () => mockDynamoUpdate(params) })),
      put: jest.fn(() => ({ promise: jest.fn().mockResolvedValue({}) })),
      delete: jest.fn(() => ({ promise: jest.fn().mockResolvedValue({}) })),
    })),
  },
}));

const mockGetOrgById = jest.fn();
const mockUpdateOrg = jest.fn();
jest.mock('../services/db', () => ({
  userDb: { getUserById: jest.fn(), updateUser: jest.fn() },
  orgDb: {
    getOrgById: (...a: any[]) => mockGetOrgById(...a),
    updateOrg: (...a: any[]) => mockUpdateOrg(...a),
  },
}));
jest.mock('../middleware/auth', () => ({
  authenticateToken: (_req: any, _res: any, next: any) => next(),
  AuthenticatedRequest: {},
}));

import marketStrategyRouter from '../routes/marketStrategy';

const USER_ID = 'user-big';
const ORG_ID = 'org-big';
const stored = { businessOverview: 'x', competitors: [{ name: 'Rival' }], icp: [], createdAt: '2026-10-01T09:00:00.000Z', updatedAt: '2026-10-01T09:00:00.000Z' };

const app = () => {
  const a = express();
  a.use(express.json());
  a.use((req, _res, next) => {
    (req as any).user = { userId: USER_ID };
    next();
  });
  a.use('/api/market-strategy', marketStrategyRouter);
  return a;
};

const awsError = (code: string, message: string) => Object.assign(new Error(message), { code });
const TOO_LARGE_MESSAGES = ['Item size to update has exceeded the maximum allowed size', 'Item size has exceeded the maximum allowed size'];

function asSolo(): void {
  mockDynamoQuery.mockResolvedValue({ Items: [{ userId: USER_ID, email: 'solo@big.test', marketStrategy: stored }] });
}
function asOrgOwner(): void {
  mockDynamoQuery.mockResolvedValue({ Items: [{ userId: USER_ID, email: 'owner@big.test', orgId: ORG_ID, orgRole: 'owner' }] });
  mockGetOrgById.mockResolvedValue({ orgId: ORG_ID, ownerUserId: USER_ID, name: 'Big Org', marketStrategy: stored, shareSettings: { marketingStrategy: { editors: [] } } });
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, 'error').mockImplementation(() => {});
  mockDynamoUpdate.mockResolvedValue({ Attributes: {} });
  mockUpdateOrg.mockResolvedValue({});
});
afterEach(() => {
  (console.error as jest.Mock).mockRestore?.();
});

describe.each([
  ['solo', asSolo, () => mockDynamoUpdate],
  ['org', asOrgOwner, () => mockUpdateOrg],
] as const)('%s save', (_name, arrange, failingWrite) => {
  it.each(TOO_LARGE_MESSAGES)('a write the service refuses for item size (%s) answers 413 with a reason that names the 400 KB limit', async (message) => {
    arrange();
    failingWrite().mockRejectedValue(awsError('ValidationException', message));
    const res = await request(app()).post('/api/market-strategy').send({ competitors: [{ name: 'New' }] });
    expect(res.status).toBe(413);
    expect(res.body).toMatchObject({ success: false, error: 'market_strategy_too_large' });
    expect(res.body.message).toMatch(/400 KB/);
    expect(res.body.message).toMatch(/Nothing was changed/);
  });

  it('any other failure of the write is still a bare 500 (a different ValidationException, a throttle, a plain error)', async () => {
    arrange();
    for (const error of [
      awsError('ValidationException', 'One or more parameter values were invalid'),
      awsError('ValidationException', 'Item size of a key attribute is invalid'),
      awsError('ProvisionedThroughputExceededException', 'Item size is fine, the table is throttled'),
      new Error('boom'),
    ]) {
      failingWrite().mockRejectedValue(error);
      const res = await request(app()).post('/api/market-strategy').send({ competitors: [{ name: 'New' }] });
      expect(res.status).toBe(500);
      expect(res.body).toEqual({ success: false, error: 'Internal server error' });
    }
  });

  it('a write that succeeds is unchanged (200 with the saved strategy)', async () => {
    arrange();
    const res = await request(app()).post('/api/market-strategy').send({ competitors: [{ name: 'New' }] });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.competitors).toEqual([{ name: 'New' }]);
  });
});
