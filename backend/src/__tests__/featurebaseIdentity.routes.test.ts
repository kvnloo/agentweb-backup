/**
 * Tests for GET /api/featurebase/identity — mints a Featurebase SSO JWT for the logged-in user.
 * Verifies the contract the frontend depends on: { jwt, organization, appId } on success, a clean
 * 503 (not 500) when SSO isn't configured, and 401 without an authenticated user.
 */

// ─── Mocks (before importing the router) ─────────────────────────────────────
jest.mock('../middleware/auth', () => ({
  authenticateToken: (req: any, _res: any, next: any) => { req.user = { userId: 'u1', email: 'u@e.com' }; next(); },
  AuthenticatedRequest: {},
}));

const mockSign = jest.fn();
const mockCreds = jest.fn();
jest.mock('../services/featurebaseService', () => ({
  signFeaturebaseIdentityJwt: (...a: any[]) => mockSign(...a),
  getFeaturebaseCredentials: (...a: any[]) => mockCreds(...a),
  FEATUREBASE_ORG: 'agentweb',
}));

jest.mock('../services/db', () => ({ userDb: { getUserById: jest.fn() } }));

import router from '../routes/featurebase';
import { userDb } from '../services/db';

const findHandler = (routerObj: any, path: string, method: string) => {
  const layer = routerObj.stack.find((r: any) => r.route?.path === path && r.route?.methods?.[method]);
  const stack = layer.route.stack;
  const handle = stack[stack.length - 1].handle;
  return (req: any, res: any) => handle(req, res, jest.fn());
};

function mockRes() {
  const res: any = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

describe('GET /api/featurebase/identity', () => {
  const handler = findHandler(router, '/identity', 'get');
  beforeEach(() => jest.clearAllMocks());

  it('returns { jwt, organization, appId } for an authenticated user, with the display name from db', async () => {
    (userDb.getUserById as jest.Mock).mockResolvedValue({ displayName: 'Test User' });
    mockSign.mockResolvedValue('signed.jwt.token');
    mockCreds.mockResolvedValue({ apiKey: 'k', appId: 'app123', ssoSecret: 's' });
    const res = mockRes();
    await handler({ user: { userId: 'u1', email: 'u@e.com' } }, res);
    expect(mockSign).toHaveBeenCalledWith({ userId: 'u1', email: 'u@e.com', name: 'Test User' });
    expect(res.json).toHaveBeenCalledWith({ jwt: 'signed.jwt.token', organization: 'agentweb', appId: 'app123' });
  });

  it('still mints when the display-name lookup fails (name is optional, must not block feedback)', async () => {
    (userDb.getUserById as jest.Mock).mockRejectedValue(new Error('db down'));
    mockSign.mockResolvedValue('tok');
    mockCreds.mockResolvedValue({ appId: 'app123' });
    const res = mockRes();
    await handler({ user: { userId: 'u1', email: 'u@e.com' } }, res);
    expect(mockSign).toHaveBeenCalledWith({ userId: 'u1', email: 'u@e.com', name: undefined });
    expect(res.json).toHaveBeenCalledWith({ jwt: 'tok', organization: 'agentweb', appId: 'app123' });
  });

  it('returns 401 when there is no authenticated user', async () => {
    const res = mockRes();
    await handler({ user: undefined }, res);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(mockSign).not.toHaveBeenCalled();
  });

  it('returns 503 (not 500) when SSO is not configured, so the widget degrades to anonymous', async () => {
    (userDb.getUserById as jest.Mock).mockResolvedValue({ displayName: 'U' });
    mockSign.mockRejectedValue(new Error('Featurebase ssoSecret not configured'));
    const res = mockRes();
    await handler({ user: { userId: 'u1', email: 'u@e.com' } }, res);
    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith({ message: 'Featurebase identity unavailable' });
  });
});
