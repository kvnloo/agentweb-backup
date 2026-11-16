/**
 * ENG-1103 AC3/AC4 — the orphaned org join-request diagnostic is admin-only and read-only.
 *
 * Mounted exactly as app.ts does (`isAdmin` from ../middleware/admin in front of the router),
 * with the authenticated principal stubbed in place of authenticateToken. The service is
 * mocked: a denied caller must never reach it, so no scan (and no audit event) happens.
 */

const findOrphanedOrgJoinRequests = jest.fn();
jest.mock('../services/orphanedOrgJoinRequestService', () => ({
  findOrphanedOrgJoinRequests: (...a: any[]) => findOrphanedOrgJoinRequests(...a),
}));

import express from 'express';
import request from 'supertest';
import { isAdmin } from '../middleware/admin';
import router from '../routes/adminOrgDiagnostics';

const appAs = (principal: { user?: any; delegateInfo?: any }) => {
  const app = express();
  app.use((req: any, _res, next) => {
    if (principal.user) req.user = principal.user;
    if (principal.delegateInfo) req.delegateInfo = principal.delegateInfo;
    next();
  });
  app.use('/api/admin/org-diagnostics', isAdmin as any, router);
  return app;
};

const PATH = '/api/admin/org-diagnostics/orphaned-org-join-requests';

beforeEach(() => {
  findOrphanedOrgJoinRequests.mockReset();
  findOrphanedOrgJoinRequests.mockResolvedValue({
    organizationsScanned: 2,
    pendingRequestsScanned: 3,
    missingUserReferences: [{ orgId: 'org-1', userId: 'gone' }],
    truncated: false,
  });
});

describe('authorization-denied paths never run the scan', () => {
  it('401s with no authenticated user', async () => {
    const res = await request(appAs({})).get(PATH);
    expect(res.status).toBe(401);
    expect(findOrphanedOrgJoinRequests).not.toHaveBeenCalled();
  });

  it('403s for an authenticated non-admin', async () => {
    const res = await request(appAs({ user: { userId: 'u1', isAdmin: false } })).get(PATH);
    expect(res.status).toBe(403);
    expect(findOrphanedOrgJoinRequests).not.toHaveBeenCalled();
  });

  it('403s for a delegated session even when the underlying user is an admin', async () => {
    const res = await request(
      appAs({ user: { userId: 'u1', isAdmin: true }, delegateInfo: { isDelegated: true } }),
    ).get(PATH);
    expect(res.status).toBe(403);
    expect(findOrphanedOrgJoinRequests).not.toHaveBeenCalled();
  });
});

describe('authorized admin', () => {
  it('returns the scanned/pending/missing breakdown', async () => {
    const res = await request(appAs({ user: { userId: 'admin', isAdmin: true } })).get(PATH);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      organizationsScanned: 2,
      pendingRequestsScanned: 3,
      missingUserReferences: [{ orgId: 'org-1', userId: 'gone' }],
      truncated: false,
    });
    expect(findOrphanedOrgJoinRequests).toHaveBeenCalledTimes(1);
  });

  it('500s with a generic message (no internals leaked) when the scan fails', async () => {
    findOrphanedOrgJoinRequests.mockRejectedValue(new Error('ddb boom secret-arn'));
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const res = await request(appAs({ user: { userId: 'admin', isAdmin: true } })).get(PATH);
    errSpy.mockRestore();
    expect(res.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toContain('secret-arn');
  });

  it('exposes no mutating verb on the diagnostic path', async () => {
    const app = appAs({ user: { userId: 'admin', isAdmin: true } });
    for (const verb of ['post', 'put', 'patch', 'delete'] as const) {
      const res = await (request(app) as any)[verb](PATH);
      expect(res.status).toBe(404);
    }
    expect(findOrphanedOrgJoinRequests).not.toHaveBeenCalled();
  });
});
