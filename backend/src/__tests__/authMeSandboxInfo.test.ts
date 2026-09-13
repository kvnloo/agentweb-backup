/**
 * ENG-1907 AC1: `/api/auth/me` carries `sandboxInfo` for a sandbox principal —
 * the one field the customer portal needs to render the "Sandbox" pill — and
 * never for anyone else. A revoked sandbox must not receive a normal /me.
 */
import request from 'supertest';
import express from 'express';
import authRoutes from '../routes/auth';
import { authenticateToken } from '../middleware/auth';
import { userDb } from '../services/db';
import { evaluationStore } from '../services/evaluationStore';

jest.mock('../middleware/auth');
const mockedAuthenticate = authenticateToken as jest.MockedFunction<typeof authenticateToken>;

jest.mock('../services/db', () => ({
  userDb: { getUserById: jest.fn() },
  taskDb: {},
  subscriberDb: {},
  orgDb: { getOrgById: jest.fn() },
}));
jest.mock('../services/evaluationStore', () => ({ evaluationStore: { get: jest.fn() } }));
jest.mock('../services/subscriptionService', () => ({
  getUserSubscriptionType: jest.fn(async () => 'Sandbox'),
  getAllowedPages: jest.fn(async () => []),
  getAllowedSkills: jest.fn(async () => []),
  getAllowedFeatures: jest.fn(async () => []),
  getHiddenPages: jest.fn(async () => []),
}));
jest.mock('../services/skillService', () => ({ skillService: { getPublishedSkills: jest.fn(async () => []) } }));
jest.mock('../services/analyticsConfigResolver', () => ({
  resolveAnalyticsConfig: jest.fn(async () => ({})),
  resolveConfigTarget: jest.fn(async () => ({ canEdit: false })),
}));

const mockedUserDb = userDb as jest.Mocked<typeof userDb>;
let app: express.Application;

function callAs(userId: string) {
  mockedAuthenticate.mockImplementation(async (req: any, _res: any, next: any) => {
    req.user = { userId };
    next();
    return undefined;
  });
  return request(app).get('/api/auth/me');
}

describe('GET /api/auth/me — sandboxInfo', () => {
  const expiresAt = Date.now() + 86400000;
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'error').mockImplementation(() => {});
    app = express();
    app.use(express.json());
    app.use('/api/auth', authRoutes);
    mockedUserDb.getUserById.mockImplementation((async (id: string) => ({ userId: id, email: `${id}@example.invalid`, roles: ['customer'], password: 'hash' })) as any);
    (evaluationStore.get as jest.Mock).mockResolvedValue({ userId: 'eval_test', email: 'eval_test@example.invalid', status: 'active', expiresAt });
  });
  afterEach(() => { (console.error as jest.Mock).mockRestore?.(); });

  it('carries sandboxInfo for an active sandbox principal', async () => {
    const res = await callAs('eval_test').expect(200);
    expect(res.body.sandboxInfo).toEqual({ isSandbox: true, label: 'Sandbox', datasetId: null, datasetVersion: null, expiresAt });
    expect(res.body.password).toBeUndefined();
  });
  it('carries no sandboxInfo for an ordinary customer', async () => {
    const res = await callAs('customer').expect(200);
    expect(res.body.sandboxInfo).toBeUndefined();
    expect(evaluationStore.get).not.toHaveBeenCalled();
  });
  it('answers 401 for a revoked sandbox instead of a normal profile', async () => {
    (evaluationStore.get as jest.Mock).mockResolvedValue({ userId: 'eval_test', status: 'revoked' });
    const res = await callAs('eval_test').expect(401);
    expect(res.body.code).toBe('session_invalid');
    expect(res.body.email).toBeUndefined();
  });
  it('answers 500, not a session error, when the policy store is unavailable', async () => {
    (evaluationStore.get as jest.Mock).mockRejectedValue(new Error('unavailable'));
    const res = await callAs('eval_test').expect(500);
    expect(res.body.code).toBeUndefined();
    expect(res.body.email).toBeUndefined();
  });
});
