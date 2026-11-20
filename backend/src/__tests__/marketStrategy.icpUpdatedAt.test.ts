/**
 * ENG-2840 (Opslane P1 on 440bb19): POST /api/market-strategy stamps `icpUpdatedAt` only when the ICP list actually changes.
 *
 * `icpUpdatedAt` is what routes/crm.ts compares with the user's `icpCompletedAt` to choose between the cached ICP search filters and the
 * market-strategy ICPs. The route used to stamp it whenever an `icp` array was present, so a save that sent back the list that is already
 * stored (a portal save of an unedited form, or the MCP tool re-sending the ICPs it had just saved) moved the stamp for nothing.
 *
 * These tests drive the real router, in both its org and solo branches.
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

const STORED_AT = '2026-10-01T09:00:00.000Z';
const ORG_ID = 'org-stamp';
const USER_ID = 'user-stamp';

const storedIcp = [
  { title: 'Founder', description: 'Small team', valueProposition: 'Speed', buyerPersonas: ['CEO', 'CTO'], extractedFilters: { cacheKey: 'k1' } },
  { title: 'Analyst', description: 'Reads reports' },
];

const strategy = (over: Record<string, unknown> = {}) => ({
  businessOverview: 'We sell gadgets',
  competitors: [{ name: 'Rival' }],
  icp: storedIcp,
  createdAt: STORED_AT,
  updatedAt: STORED_AT,
  icpUpdatedAt: STORED_AT,
  ...over,
});

const appFor = () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).user = { userId: USER_ID };
    next();
  });
  app.use('/api/market-strategy', marketStrategyRouter);
  return app;
};

/** Save through the solo branch and return the marketStrategy the route wrote. */
async function soloSave(stored: any, body: any): Promise<any> {
  mockDynamoQuery.mockResolvedValue({ Items: [{ userId: USER_ID, email: 'solo@stamp.test', marketStrategy: stored }] });
  const res = await request(appFor()).post('/api/market-strategy').send(body);
  expect(res.status).toBe(200);
  return mockDynamoUpdate.mock.calls[0][0].ExpressionAttributeValues[':marketStrategy'];
}

/** Save through the org branch (the caller owns the org) and return the marketStrategy the route wrote. */
async function orgSave(stored: any, body: any): Promise<any> {
  mockDynamoQuery.mockResolvedValue({ Items: [{ userId: USER_ID, email: 'owner@stamp.test', orgId: ORG_ID, orgRole: 'owner' }] });
  mockGetOrgById.mockResolvedValue({ orgId: ORG_ID, ownerUserId: USER_ID, name: 'Stamp Org', marketStrategy: stored, shareSettings: { marketingStrategy: { editors: [] } } });
  const res = await request(appFor()).post('/api/market-strategy').send(body);
  expect(res.status).toBe(200);
  return mockUpdateOrg.mock.calls[0][1].marketStrategy;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockDynamoUpdate.mockResolvedValue({ Attributes: {} });
  mockUpdateOrg.mockResolvedValue({});
});

describe.each([
  ['solo', soloSave],
  ['org', orgSave],
] as const)('%s save: when icpUpdatedAt moves', (_name, save) => {
  it('keeps the stamp when the ICP list sent is the list already stored (the Opslane scenario: the tool re-sends the ICPs it just saved)', async () => {
    const written = await save(strategy(), { competitors: [{ name: 'Rival' }, { name: 'Newcomer' }], icp: JSON.parse(JSON.stringify(storedIcp)) });
    expect(written.icpUpdatedAt).toBe(STORED_AT);
    expect(written.icp).toEqual(storedIcp);
    expect(written.competitors.map((c: any) => c.name)).toEqual(['Rival', 'Newcomer']);
  });

  it('moves the stamp when the ICP list changed', async () => {
    const edited = JSON.parse(JSON.stringify(storedIcp));
    edited[0].description = 'Small team, fast';
    const written = await save(strategy(), { icp: edited });
    expect(written.icpUpdatedAt).not.toBe(STORED_AT);
    expect(new Date(written.icpUpdatedAt).getTime()).toBeGreaterThan(new Date(STORED_AT).getTime());
    expect(written.icp[0].description).toBe('Small team, fast');
  });

  it('moves the stamp when only the order of the ICPs changed', async () => {
    const written = await save(strategy(), { icp: [storedIcp[1], storedIcp[0]] });
    expect(written.icpUpdatedAt).not.toBe(STORED_AT);
  });

  it('moves the stamp when an ICP is added or removed', async () => {
    const added = await save(strategy(), { icp: [...storedIcp, { title: 'New' }] });
    expect(added.icpUpdatedAt).not.toBe(STORED_AT);
    jest.clearAllMocks();
    mockDynamoUpdate.mockResolvedValue({ Attributes: {} });
    mockUpdateOrg.mockResolvedValue({});
    const removed = await save(strategy(), { icp: [storedIcp[0]] });
    expect(removed.icpUpdatedAt).not.toBe(STORED_AT);
  });

  it('moves the stamp when the form sends the ICPs back without a field the record holds (the portal dropping the cached filters)', async () => {
    const { extractedFilters: _dropped, ...withoutFilters } = storedIcp[0] as any;
    const written = await save(strategy(), { icp: [withoutFilters, storedIcp[1]] });
    expect(written.icpUpdatedAt).not.toBe(STORED_AT);
  });

  it('keeps the stamp for a save that does not send icp (unchanged behaviour)', async () => {
    const written = await save(strategy(), { competitors: [{ name: 'Only competitors' }] });
    expect(written.icpUpdatedAt).toBe(STORED_AT);
  });

  it('stamps a record that has no stamp yet (saved before the field existed), even when the list is the same: unchanged behaviour', async () => {
    const written = await save(strategy({ icpUpdatedAt: undefined }), { icp: JSON.parse(JSON.stringify(storedIcp)) });
    expect(typeof written.icpUpdatedAt).toBe('string');
    expect(written.icpUpdatedAt).not.toBe(STORED_AT);
  });

  it('stamps the first ICP save of an account that has none stored', async () => {
    const written = await save(strategy({ icp: [], icpUpdatedAt: undefined }), { icp: [{ title: 'First' }] });
    expect(typeof written.icpUpdatedAt).toBe('string');
    expect(written.icp).toEqual([{ title: 'First' }]);
  });
});
