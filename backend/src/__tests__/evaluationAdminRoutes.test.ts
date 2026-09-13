import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { evaluationAdminRoutes } from '../routes/evaluation';
import { evaluationStore, SandboxTierMissing } from '../services/evaluationStore';
import { userDb } from '../services/db';

jest.mock('../config/jwt', () => ({ getJwtSecret: () => 'synthetic-route-signing-secret' }));
jest.mock('../services/db', () => ({ userDb: {
  getUserByIdConsistent: jest.fn(async (userId: string) => ({ userId, isAdmin: userId === 'admin', isActive: true })),
  getUserById: jest.fn(async (userId: string) => ({ userId, email: 'test@example.invalid', isAdmin: userId === 'admin' })),
  getUserByEmailConsistent: jest.fn(async () => ({ userId: 'eval_test', email: 'test@example.invalid', isActive: true, isAdmin: false })),
} }));
jest.mock('../services/evaluationStore', () => {
  // Mirrors the real class: the route forwards its message, which names the fix.
  class SandboxTierMissing extends Error { constructor() { super('The "Sandbox" subscription tier is not defined; run scripts/ensure-sandbox-tier.ts before provisioning.'); } }
  return { SandboxTierMissing, evaluationStore: { get: jest.fn(), provision: jest.fn(), revoke: jest.fn(), review: jest.fn() } };
});

describe('ENG-1907 sandbox admin routes', () => {
  const app = express();
  app.use(express.json());
  app.use('/api/admin/evaluations', evaluationAdminRoutes);
  app.use((_error: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => res.status(500).json({ error: 'Internal server error' }));
  const token = (userId: string) => jwt.sign({ userId, email: 'test@example.invalid', isAdmin: userId === 'admin' }, 'synthetic-route-signing-secret');
  const provision = { email: 'candidate@example.invalid', displayName: 'Synthetic', password: 'Synthetic-password-123!', expiresAt: Date.now() + 3600000, brandGuidelines: { brandName: 'Synthetic Co' } };
  beforeEach(() => {
    jest.clearAllMocks();
    (evaluationStore.get as jest.Mock).mockResolvedValue({ userId: 'eval_test', email: 'test@example.invalid', status: 'active', expiresAt: Date.now() + 60000 });
    (evaluationStore.provision as jest.Mock).mockResolvedValue({ userId: 'eval_new', expiresAt: provision.expiresAt, audit: { action: 'provision' } });
    (evaluationStore.revoke as jest.Mock).mockResolvedValue({ userId: 'eval_test', status: 'revoked' });
  });
  it('admin can provision through the product API', async () => {
    const result = await request(app).post('/api/admin/evaluations').set('Authorization', `Bearer ${token('admin')}`).send(provision);
    expect(result.status).toBe(201);
    expect(evaluationStore.provision).toHaveBeenCalledWith('admin', provision);
    expect(result.body.userId).toBe('eval_new');
  });
  it('a missing Sandbox tier row is reported as a precondition failure, not a denial or a crash (AC 4)', async () => {
    (evaluationStore.provision as jest.Mock).mockRejectedValueOnce(new SandboxTierMissing());
    const result = await request(app).post('/api/admin/evaluations').set('Authorization', `Bearer ${token('admin')}`).send(provision);
    expect(result.status).toBe(412);
    expect(result.body.error).toContain('ensure-sandbox-tier');
  });
  it('a stale admin session cannot provision after administrator deactivation', async () => {
    (userDb.getUserByIdConsistent as jest.Mock).mockResolvedValueOnce({ userId: 'admin', isAdmin: true, isActive: false });
    const result = await request(app).post('/api/admin/evaluations').set('Authorization', `Bearer ${token('admin')}`).send(provision);
    expect(result.status).toBe(403);
    expect(evaluationStore.provision).not.toHaveBeenCalled();
  });
  it('provider/storage failure reaches the error handler instead of masquerading as a denial', async () => {
    (evaluationStore.provision as jest.Mock).mockRejectedValueOnce(new Error('synthetic storage failure'));
    const result = await request(app).post('/api/admin/evaluations').set('Authorization', `Bearer ${token('admin')}`).send(provision);
    expect(result.status).toBe(500);
  });
  it.each(['customer', 'eval_test'])('%s cannot provision or revoke another workspace', async userId => {
    expect((await request(app).post('/api/admin/evaluations').set('Authorization', `Bearer ${token(userId)}`).send(provision)).status).toBe(403);
    expect((await request(app).post('/api/admin/evaluations/eval_test/revoke').set('Authorization', `Bearer ${token(userId)}`).send({})).status).toBe(403);
    expect(evaluationStore.provision).not.toHaveBeenCalled();
    expect(evaluationStore.revoke).not.toHaveBeenCalled();
  });
  it('admin revoke returns the audited result', async () => {
    const result = await request(app).post('/api/admin/evaluations/eval_test/revoke').set('Authorization', `Bearer ${token('admin')}`).send({});
    expect(result.status).toBe(200);
    expect(evaluationStore.revoke).toHaveBeenCalledWith('admin', 'eval_test');
  });
  it('assigned reviewer reads status and audit through scoped review authorization', async () => {
    (evaluationStore.review as jest.Mock).mockResolvedValue({ userId: 'eval_test', status: 'active', audit: [], truncated: false });
    const result = await request(app).get('/api/admin/evaluations/eval_test').set('Authorization', `Bearer ${token('reviewer')}`);
    expect(result.status).toBe(200);
    expect(evaluationStore.review).toHaveBeenCalledWith('reviewer', 'eval_test');
    expect(result.headers['cache-control']).toBe('no-store');
  });
  it('deactivated reviewers cannot read retained evaluation state', async () => {
    (userDb.getUserByIdConsistent as jest.Mock).mockResolvedValueOnce({ userId: 'reviewer', isActive: false });
    const result = await request(app).get('/api/admin/evaluations/eval_test').set('Authorization', `Bearer ${token('reviewer')}`);
    expect(result.status).toBe(403);
    expect(evaluationStore.review).not.toHaveBeenCalled();
  });
  it('the candidate artifact download route no longer exists', async () => {
    const result = await request(app).get('/api/admin/evaluations/eval_test/artifacts/file').set('Authorization', `Bearer ${token('admin')}`);
    expect(result.status).toBe(404);
  });
});
