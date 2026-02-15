import request from 'supertest';
import express from 'express';
import authRoutes from '../routes/auth';
import { authenticateToken } from '../middleware/auth';
import { userDb } from '../services/db';

jest.mock('../middleware/auth');
const mockedAuthenticate = authenticateToken as jest.MockedFunction<typeof authenticateToken>;

jest.mock('../services/db', () => ({
  userDb: {
    getUserById: jest.fn(),
  },
  taskDb: {},
  subscriberDb: {},
}));

jest.mock('../services/subscriptionService', () => ({
  getUserSubscriptionType: jest.fn(async () => 'Pro'),
  getAllowedPages: jest.fn(async () => ['/tasks', '/seo']),
  getAllowedSkills: jest.fn(async () => ['skill-1', 'skill-2']),
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
});
