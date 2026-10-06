/**
 * Auth + request-contract tests for the admin session-cleanup router (ENG-2314).
 * The REAL isAdmin middleware is used (not mocked) so the admin-only / no-delegation
 * guarantee is exercised the way app.ts mounts it.
 */
import express from 'express';
import request from 'supertest';

let currentUser: any = { userId: 'admin-1', email: 'admin@example.com', isAdmin: true };
let delegated = false;
jest.mock('../../middleware/auth', () => ({
  authenticateToken: (req: any, _res: any, next: any) => {
    req.user = currentUser;
    if (delegated) req.delegateInfo = { isDelegated: true };
    next();
  },
}));
jest.mock('../../services/adminAuditLog', () => ({ recordAdminAudit: jest.fn() }));
jest.mock('../../services/sessionRowCleanupService', () => {
  const actual = jest.requireActual('../../services/sessionRowCleanupService');
  return {
    ...actual,
    previewDedupe: jest.fn(),
    previewExplicitDelete: jest.fn(),
    applyDedupe: jest.fn(),
    applyExplicitDelete: jest.fn(),
  };
});

import router from '../adminSessionCleanup';
import { authenticateToken } from '../../middleware/auth';
import { isAdmin } from '../../middleware/admin';
import { recordAdminAudit } from '../../services/adminAuditLog';
import * as svc from '../../services/sessionRowCleanupService';

const app = express();
app.use(express.json());
app.use('/api/admin/session-cleanup', authenticateToken, isAdmin, router);

const ok = { listId: 'L', planHash: 'h', expectedRowsToDelete: 2, confirm: true };

beforeEach(() => {
  currentUser = { userId: 'admin-1', email: 'admin@example.com', isAdmin: true };
  delegated = false;
});

describe('access', () => {
  it.each(['/preview', '/apply'])('%s rejects non-admins and delegated sessions without touching the service', async (path) => {
    currentUser = { userId: 'u', email: 'u@x.com', isAdmin: false };
    expect((await request(app).post(`/api/admin/session-cleanup${path}`).send(ok)).status).toBe(403);
    currentUser = { userId: 'admin-1', email: 'a@x.com', isAdmin: true };
    delegated = true;
    expect((await request(app).post(`/api/admin/session-cleanup${path}`).send(ok)).status).toBe(403);
    expect(svc.previewDedupe).not.toHaveBeenCalled();
    expect(svc.applyDedupe).not.toHaveBeenCalled();
  });
});

describe('apply request contract', () => {
  it.each([
    [{ ...ok, confirm: undefined }],
    [{ ...ok, confirm: 'true' }],
    [{ ...ok, planHash: undefined }],
    [{ ...ok, expectedRowsToDelete: '2' }],
    [{ ...ok, expectedRowsToDelete: -1 }],
    [{ ...ok, listId: '' }],
  ])('400 and no service call for %j', async (body) => {
    const res = await request(app).post('/api/admin/session-cleanup/apply').send(body);
    expect(res.status).toBe(400);
    expect(svc.applyDedupe).not.toHaveBeenCalled();
    expect(svc.applyExplicitDelete).not.toHaveBeenCalled();
  });

  it('maps a plan mismatch to 409 and audits the refusal', async () => {
    (svc.applyDedupe as jest.Mock).mockRejectedValue(new svc.SessionCleanupError(409, 'plan_mismatch', 'changed', { expectedPlanHash: 'z' }));
    const res = await request(app).post('/api/admin/session-cleanup/apply').send(ok);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('plan_mismatch');
    expect(recordAdminAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'session_cleanup_apply_refused', actorUserId: 'admin-1', listId: 'L' }));
  });

  it('routes leadIds to explicit mode and audits who/list/counts/hash', async () => {
    (svc.applyExplicitDelete as jest.Mock).mockResolvedValue({ mode: 'explicit', planHash: 'h', deletedCount: 1, continuationRequired: false, groups: [{ status: 'deleted', deletedLeadIds: ['a'] }], backup: [] });
    const res = await request(app).post('/api/admin/session-cleanup/apply').send({ ...ok, leadIds: ['a'] });
    expect(res.status).toBe(200);
    expect(svc.applyDedupe).not.toHaveBeenCalled();
    expect(recordAdminAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'session_cleanup_apply', actorUserId: 'admin-1', listId: 'L', planHash: 'h', deletedCount: 1, deletedLeadIds: ['a'] }));
  });
});

describe('preview', () => {
  it('audits and returns the plan', async () => {
    (svc.previewDedupe as jest.Mock).mockResolvedValue({ mode: 'dedupe', counts: { rowsToDelete: 3 }, planHash: 'p', groups: [] });
    const res = await request(app).post('/api/admin/session-cleanup/preview').send({ listId: 'L' });
    expect(res.status).toBe(200);
    expect(recordAdminAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'session_cleanup_preview', rowsToDelete: 3, planHash: 'p', actorEmail: 'admin@example.com' }));
  });
  it('400 without listId', async () => {
    expect((await request(app).post('/api/admin/session-cleanup/preview').send({})).status).toBe(400);
  });
});
