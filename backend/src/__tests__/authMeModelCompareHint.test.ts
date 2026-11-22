/**
 * GET /api/auth/me — additive `modelCompareEntitled` hint for the portal (never persisted).
 * Same function as the server-side enforcement, so the button and the 403 agree.
 */
import request from 'supertest';
import express from 'express';
import authRoutes from '../routes/auth';
import { authenticateToken } from '../middleware/auth';
import { userDb, orgDb } from '../services/db';

const mockIsEntitled = jest.fn();
jest.mock('../services/agentMode/modelCompareEntitlement', () => ({
  modelCompareEntitlement: { isEntitled: (...a: unknown[]) => mockIsEntitled(...a) },
}));
jest.mock('../middleware/auth');
const mockedAuthenticate = authenticateToken as jest.MockedFunction<typeof authenticateToken>;
jest.mock('../services/db', () => ({
  userDb: { getUserById: jest.fn() },
  taskDb: {},
  subscriberDb: {},
  orgDb: { getOrgById: jest.fn() },
}));
jest.mock('../services/subscriptionService', () => ({
  getUserSubscriptionType: jest.fn(async () => 'Pro'),
  getAllowedPages: jest.fn(async () => []),
  getAllowedSkills: jest.fn(async () => []),
  getHiddenPages: jest.fn(async () => []),
}));
jest.mock('../services/skillService', () => ({ skillService: { getPublishedSkills: jest.fn(async () => []) } }));
jest.mock('../services/analyticsConfigResolver', () => ({
  resolveAnalyticsConfig: jest.fn(async () => ({})),
  resolveConfigTarget: jest.fn(async () => ({ canEdit: false })),
}));

const app = express();
app.use(express.json());
app.use('/api/auth', authRoutes);

function callAs(userId: string, isAdmin = false) {
  mockedAuthenticate.mockImplementation(async (req: any, _res: any, next: any) => {
    req.user = { userId, isAdmin };
    next();
    return undefined;
  });
  return request(app).get('/api/auth/me');
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, 'error').mockImplementation(() => {});
  (userDb.getUserById as jest.Mock).mockResolvedValue({ userId: 'u1', email: 'u@test.com', roles: ['customer'] });
  (orgDb.getOrgById as jest.Mock).mockResolvedValue(null);
});
afterEach(() => jest.restoreAllMocks());

describe('GET /api/auth/me modelCompareEntitled', () => {
  it('is true when the entitlement function allows', async () => {
    mockIsEntitled.mockResolvedValue(true);
    const res = await callAs('u1').expect(200);
    expect(res.body.modelCompareEntitled).toBe(true);
    expect(mockIsEntitled).toHaveBeenCalledWith({ userId: 'u1', isAdmin: false });
  });

  it('is false when the plan lacks the add-on (switch on)', async () => {
    mockIsEntitled.mockResolvedValue(false);
    const res = await callAs('u1').expect(200);
    expect(res.body.modelCompareEntitled).toBe(false);
  });

  it('passes the admin flag through', async () => {
    mockIsEntitled.mockResolvedValue(true);
    await callAs('u1', true).expect(200);
    expect(mockIsEntitled).toHaveBeenCalledWith({ userId: 'u1', isAdmin: true });
  });

  it('omits the field (portal then shows the button) if the evaluation throws, and never breaks /me', async () => {
    mockIsEntitled.mockRejectedValue(new Error('boom'));
    const res = await callAs('u1').expect(200);
    expect(res.body).not.toHaveProperty('modelCompareEntitled');
    expect(res.body.email).toBe('u@test.com');
  });

  it('is not persisted: /me performs no user write', async () => {
    mockIsEntitled.mockResolvedValue(false);
    await callAs('u1').expect(200);
    expect(Object.keys(userDb)).toEqual(['getUserById']);
  });
});
