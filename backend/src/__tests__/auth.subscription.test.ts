import request from 'supertest';
import express from 'express';
import authRoutes from '../routes/auth';
import { authenticateToken } from '../middleware/auth';
import { userDb, orgDb } from '../services/db';

jest.mock('../middleware/auth');
const mockedAuthenticate = authenticateToken as jest.MockedFunction<typeof authenticateToken>;

jest.mock('../services/db', () => ({
  userDb: {
    getUserById: jest.fn(),
  },
  taskDb: {},
  subscriberDb: {},
  orgDb: {
    getOrgById: jest.fn(),
  },
}));

jest.mock('../services/subscriptionService', () => ({
  getUserSubscriptionType: jest.fn(async () => 'Pro'),
  getAllowedPages: jest.fn(async () => ['/tasks', '/seo']),
  getAllowedSkills: jest.fn(async () => ['skill-1', 'skill-2']),
  getHiddenPages: jest.fn(async () => []),
}));

jest.mock('../services/skillService', () => ({
  skillService: {
    getPublishedSkills: jest.fn(async () => [
      { skillId: 'skill-1', name: 'Web Search', description: 'Search the web' },
      { skillId: 'skill-2', name: 'Image Gen', description: 'Generate images' },
      { skillId: 'skill-3', name: 'SEO Tools', description: 'SEO analysis' },
    ]),
  },
}));

import { getUserSubscriptionType, getAllowedPages, getAllowedSkills } from '../services/subscriptionService';

const mockedUserDb = userDb as jest.Mocked<typeof userDb>;
const mockedOrgDb = orgDb as jest.Mocked<typeof orgDb>;
const mockedGetUserSubscriptionType = getUserSubscriptionType as jest.MockedFunction<typeof getUserSubscriptionType>;
const mockedGetAllowedPages = getAllowedPages as jest.MockedFunction<typeof getAllowedPages>;
const mockedGetAllowedSkills = getAllowedSkills as jest.MockedFunction<typeof getAllowedSkills>;

let app: express.Application;

describe('GET /api/auth/me subscription fields', () => {
  beforeEach(() => {
    jest.clearAllMocks();

    app = express();
    app.use(express.json());

    mockedAuthenticate.mockImplementation(async (req: any, _res: any, next: any) => {
      req.user = { userId: 'user-1' };
      next();
      return undefined;
    });

    app.use('/api/auth', authRoutes);
  });

  it('includes subscriptionType, allowedPages and allowedSkills for customer users', async () => {
    mockedUserDb.getUserById.mockResolvedValueOnce({
      userId: 'user-1',
      email: 'customer@example.com',
      roles: ['customer'],
      password: 'secret',
    } as any);

    const res = await request(app)
      .get('/api/auth/me')
      .set('Authorization', 'Bearer test-token')
      .expect(200);

    expect(res.body.password).toBeUndefined();
    expect(res.body.subscriptionType).toBe('Pro');
    expect(res.body.allowedPages).toEqual(['/tasks', '/seo']);
    expect(res.body.allowedSkills).toEqual([
      { skillId: 'skill-1', name: 'Web Search' },
      { skillId: 'skill-2', name: 'Image Gen' },
    ]);

    expect(mockedGetUserSubscriptionType).toHaveBeenCalledWith('user-1');
    expect(mockedGetAllowedPages).toHaveBeenCalledWith('user-1');
    expect(mockedGetAllowedSkills).toHaveBeenCalledWith('user-1');
  });

  it('does not call subscriptionService for non-customer users', async () => {
    mockedUserDb.getUserById.mockResolvedValueOnce({
      userId: 'user-2',
      email: 'partner@example.com',
      roles: ['partner'],
    } as any);

    const res = await request(app)
      .get('/api/auth/me')
      .set('Authorization', 'Bearer test-token')
      .expect(200);

    expect(res.body.subscriptionType).toBeUndefined();
    expect(res.body.allowedPages).toBeUndefined();
    expect(res.body.allowedSkills).toBeUndefined();

    expect(mockedGetUserSubscriptionType).not.toHaveBeenCalled();
    expect(mockedGetAllowedPages).not.toHaveBeenCalled();
    expect(mockedGetAllowedSkills).not.toHaveBeenCalled();
  });

  it('resolves subscription from org owner for org member', async () => {
    mockedAuthenticate.mockImplementationOnce(async (req: any, _res: any, next: any) => {
      req.user = { userId: 'member-1' };
      next();
      return undefined;
    });

    mockedUserDb.getUserById
      // member user
      .mockResolvedValueOnce({
        userId: 'member-1',
        email: 'member@example.com',
        roles: ['customer'],
        orgId: 'org-1',
        orgRole: 'member',
        password: 'secret',
      } as any)
      // owner user (fetched to overlay Stripe fields)
      .mockResolvedValueOnce({
        userId: 'owner-1',
        email: 'owner@example.com',
        subscription_status: 'active',
        current_period_end: '2026-06-01T00:00:00.000Z',
        has_payment_method: true,
        scheduledChange: null,
      } as any);

    mockedOrgDb.getOrgById.mockResolvedValue({
      orgId: 'org-1',
      ownerUserId: 'owner-1',
      name: 'Test Org',
    } as any);

    mockedGetUserSubscriptionType.mockResolvedValueOnce('Pro');
    mockedGetAllowedPages.mockResolvedValueOnce(['/tasks']);
    mockedGetAllowedSkills.mockResolvedValueOnce(['skill-1']);

    const res = await request(app)
      .get('/api/auth/me')
      .set('Authorization', 'Bearer test-token')
      .expect(200);

    // Subscription fields come from owner
    expect(res.body.subscriptionType).toBe('Pro');
    expect(res.body.subscription_status).toBe('active');
    expect(res.body.current_period_end).toBe('2026-06-01T00:00:00.000Z');
    expect(res.body.has_payment_method).toBe(true);
    expect(res.body.orgManagedSubscription).toBe(true);

    // Subscription service called with owner's userId
    expect(mockedGetUserSubscriptionType).toHaveBeenCalledWith('owner-1');
    expect(mockedGetAllowedPages).toHaveBeenCalledWith('owner-1');
    expect(mockedGetAllowedSkills).toHaveBeenCalledWith('owner-1');
  });

  it('does not set orgManagedSubscription for org owner', async () => {
    mockedAuthenticate.mockImplementationOnce(async (req: any, _res: any, next: any) => {
      req.user = { userId: 'owner-1' };
      next();
      return undefined;
    });

    mockedUserDb.getUserById.mockResolvedValueOnce({
      userId: 'owner-1',
      email: 'owner@example.com',
      roles: ['customer'],
      orgId: 'org-1',
      orgRole: 'owner',
      subscription_status: 'active',
      password: 'secret',
    } as any);

    mockedOrgDb.getOrgById.mockResolvedValue({
      orgId: 'org-1',
      ownerUserId: 'owner-1',
      name: 'Test Org',
    } as any);

    const res = await request(app)
      .get('/api/auth/me')
      .set('Authorization', 'Bearer test-token')
      .expect(200);

    expect(res.body.orgManagedSubscription).toBeUndefined();
    expect(mockedGetUserSubscriptionType).toHaveBeenCalledWith('owner-1');
  });

  it('falls back to member userId when org lookup returns null', async () => {
    // Override auth middleware to inject member's userId for this test
    mockedAuthenticate.mockImplementationOnce(async (req: any, _res: any, next: any) => {
      req.user = { userId: 'member-1' };
      next();
      return undefined;
    });

    mockedUserDb.getUserById.mockResolvedValueOnce({
      userId: 'member-1',
      email: 'member@example.com',
      roles: ['customer'],
      orgId: 'org-missing',
      orgRole: 'member',
      password: 'secret',
    } as any);

    mockedOrgDb.getOrgById.mockResolvedValue(null as any);

    const res = await request(app)
      .get('/api/auth/me')
      .set('Authorization', 'Bearer test-token')
      .expect(200);

    // Falls back to member's own userId for subscription resolution
    expect(mockedGetUserSubscriptionType).toHaveBeenCalledWith('member-1');
    expect(res.body.orgManagedSubscription).toBeUndefined();
  });
});
