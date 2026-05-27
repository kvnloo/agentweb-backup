import request from 'supertest';
import express, { Application } from 'express';

process.env.JWT_SECRET = 'test-jwt-secret-for-testing';

const mockGetLandingPageById = jest.fn();
const mockUpdateLeadList = jest.fn();
const mockGetLeadListById = jest.fn();
const mockGetUserById = jest.fn();
const mockGetOrgById = jest.fn();
const mockCanEditItem = jest.fn();

jest.mock('../services/v0Service', () => {
  const actual = jest.requireActual('../services/v0Service');
  return {
    ...actual,
    getLandingPageById: (...a: any[]) => mockGetLandingPageById(...a),
    updateLandingPageLeadList: (...a: any[]) => mockUpdateLeadList(...a),
  };
});

jest.mock('../services/db', () => ({
  userDb: { getUserById: (...a: any[]) => mockGetUserById(...a) },
  orgDb: { getOrgById: (...a: any[]) => mockGetOrgById(...a) },
  crmDb: { getLeadListById: (...a: any[]) => mockGetLeadListById(...a) },
}));

jest.mock('../services/orgShareService', () => ({
  canEditItem: (...a: any[]) => mockCanEditItem(...a),
  canViewItem: (...a: any[]) => mockCanEditItem(...a),
  canManageOrgFeature: jest.fn().mockReturnValue(false),
  isFeatureEffectivelyEnabled: jest.fn().mockReturnValue(true),
}));

jest.mock('../middleware/auth', () => ({
  authenticateToken: (req: any, _r: any, n: any) => { req.user = { userId: 'u1' }; n(); },
}));

jest.mock('../utils/secretsManager', () => ({
  getGitHubOrgToken: jest.fn().mockResolvedValue({ token: 'gh-test-token' }),
}));

import router from '../routes/landingPageGeneration';
const app: Application = express();
app.use(express.json());
app.use('/api/landing-pages/v0', router);

const ownedPage = { id: 'p1', userId: 'u1' };

describe('PATCH /generated/:id/lead-list', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetLandingPageById.mockResolvedValue(ownedPage);
    mockGetUserById.mockResolvedValue({ userId: 'u1' });
    mockUpdateLeadList.mockResolvedValue(undefined);
  });

  it('happy path: sets leadListId', async () => {
    mockGetLeadListById.mockResolvedValue({ listId: 'l1', userId: 'u1' });
    const res = await request(app).patch('/api/landing-pages/v0/generated/p1/lead-list').send({ leadListId: 'l1' });
    expect(res.status).toBe(200);
    expect(mockUpdateLeadList).toHaveBeenCalledWith('p1', 'u1', 'l1');
  });

  it('happy path: detach (leadListId: null)', async () => {
    const res = await request(app).patch('/api/landing-pages/v0/generated/p1/lead-list').send({ leadListId: null });
    expect(res.status).toBe(200);
    expect(mockUpdateLeadList).toHaveBeenCalledWith('p1', 'u1', null);
  });

  it('400 when body missing leadListId', async () => {
    const res = await request(app).patch('/api/landing-pages/v0/generated/p1/lead-list').send({});
    expect(res.status).toBe(400);
  });

  it('403 when caller cannot edit page', async () => {
    mockGetLandingPageById.mockResolvedValue({ id: 'p1', userId: 'u2' });
    mockGetUserById
      .mockResolvedValueOnce({ userId: 'u1' })
      .mockResolvedValueOnce({ userId: 'u2' });
    mockCanEditItem.mockReturnValue(false);
    const res = await request(app).patch('/api/landing-pages/v0/generated/p1/lead-list').send({ leadListId: 'l1' });
    expect(res.status).toBe(403);
  });

  it('403 when lead list belongs to someone else', async () => {
    mockGetLeadListById.mockResolvedValue({ listId: 'l1', userId: 'u99' });
    mockGetUserById
      .mockResolvedValueOnce({ userId: 'u1' })
      .mockResolvedValueOnce({ userId: 'u99' });
    mockCanEditItem.mockReturnValue(false);
    const res = await request(app).patch('/api/landing-pages/v0/generated/p1/lead-list').send({ leadListId: 'l1' });
    expect(res.status).toBe(403);
  });

  it('404 when page not found', async () => {
    mockGetLandingPageById.mockResolvedValue(null);
    const res = await request(app).patch('/api/landing-pages/v0/generated/p1/lead-list').send({ leadListId: 'l1' });
    expect(res.status).toBe(404);
  });

  it('409 on ConditionalCheckFailedException', async () => {
    mockGetLeadListById.mockResolvedValue({ listId: 'l1', userId: 'u1' });
    mockUpdateLeadList.mockRejectedValue(Object.assign(new Error('cond fail'), { code: 'ConditionalCheckFailedException' }));
    const res = await request(app).patch('/api/landing-pages/v0/generated/p1/lead-list').send({ leadListId: 'l1' });
    expect(res.status).toBe(409);
  });
});
