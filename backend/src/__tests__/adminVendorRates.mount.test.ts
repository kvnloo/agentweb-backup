/**
 * ENG-2271: the vendor-rates router must be mounted in the REAL app behind the admin gate
 * (same approach as agentRunsAuth.mountOrder.test.ts): an unauthenticated request must be
 * rejected by auth, not answered by the route or fall through to a 404.
 */

jest.mock('aws-sdk', () => ({
  config: { update: jest.fn() },
  EC2: jest.fn(() => ({})),
  SSM: jest.fn(() => ({})),
  IAM: jest.fn(() => ({})),
  DynamoDB: {
    DocumentClient: jest.fn(() => ({
      query: jest.fn().mockReturnThis(),
      put: jest.fn().mockReturnThis(),
      delete: jest.fn().mockReturnThis(),
      get: jest.fn().mockReturnThis(),
      update: jest.fn().mockReturnThis(),
      scan: jest.fn().mockReturnThis(),
      promise: jest.fn(),
    })),
  },
  S3: jest.fn(() => ({
    getObject: jest.fn().mockReturnThis(),
    putObject: jest.fn().mockReturnThis(),
    promise: jest.fn(),
  })),
  SES: jest.fn(() => ({})),
}));

jest.mock('../services/db', () => ({
  userDb: {
    getUserById: jest.fn(),
    getUserByEmail: jest.fn(),
    getAllUsers: jest.fn(),
  },
}));

jest.mock('../utils/secretsManager', () => ({
  getMetaAccessToken: jest.fn().mockResolvedValue('mock-token'),
  getSecret: jest.fn().mockResolvedValue('mock-secret'),
}));

import request from 'supertest';
import app from '../app';

describe('/api/admin/vendor-rates — real app mount', () => {
  it('the router is mounted under /api/admin with GET and PUT', () => {
    // The catch-all admin router already answers 401 for ANY /api/admin path, so the status check
    // below cannot tell a mounted route from an unmounted one; inspect the router stack as well.
    type Layer = { route?: { path: string; methods: Record<string, boolean> }; handle?: { stack?: Layer[] } };
    const stack = (app as unknown as { _router: { stack: Layer[] } })._router.stack;
    const routes = stack.flatMap((l) => l.handle?.stack ?? []).filter((l) => l.route?.path === '/vendor-rates');
    expect(routes.map((l) => Object.keys(l.route!.methods).sort()).flat()).toEqual(['get', 'put']);
  });

  it.each(['get', 'put'] as const)('%s without a token is rejected by the admin gate', async (m) => {
    const res = await request(app)[m]('/api/admin/vendor-rates').send({});
    expect(res.status).toBe(401);
    expect(res.body.message).toBe('No token provided');
  });
});
