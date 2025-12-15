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
  getAllowedFunctionCalls: jest.fn(async () => ['generate_image', 'generate_video']),
}));

import { getUserSubscriptionType, getAllowedPages, getAllowedFunctionCalls } from '../services/subscriptionService';

const mockedUserDb = userDb as jest.Mocked<typeof userDb>;
const mockedGetUserSubscriptionType = getUserSubscriptionType as jest.MockedFunction<typeof getUserSubscriptionType>;
const mockedGetAllowedPages = getAllowedPages as jest.MockedFunction<typeof getAllowedPages>;
const mockedGetAllowedFunctionCalls = getAllowedFunctionCalls as jest.MockedFunction<typeof getAllowedFunctionCalls>;

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

  it('includes subscriptionType, allowedPages and allowedFunctionCalls for customer users', async () => {
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
    expect(res.body.allowedFunctionCalls).toEqual(['generate_image', 'generate_video']);

    expect(mockedGetUserSubscriptionType).toHaveBeenCalledWith('user-1');
    expect(mockedGetAllowedPages).toHaveBeenCalledWith('user-1');
    expect(mockedGetAllowedFunctionCalls).toHaveBeenCalledWith('user-1');
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
    expect(res.body.allowedFunctionCalls).toBeUndefined();

    expect(mockedGetUserSubscriptionType).not.toHaveBeenCalled();
    expect(mockedGetAllowedPages).not.toHaveBeenCalled();
    expect(mockedGetAllowedFunctionCalls).not.toHaveBeenCalled();
  });
});
