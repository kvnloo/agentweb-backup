import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { evaluationHttpBoundary } from '../middleware/evaluation';
import { authenticateToken } from '../middleware/auth';
import { evaluationRoutes, evaluationAdminRoutes } from '../routes/evaluation';
import { evaluationStore } from '../services/evaluationStore';
import { userDb } from '../services/db';
import { mintDelegateToken } from '../services/delegateAccessToken';

const secret = 'synthetic-evaluation-delegation-secret';
jest.mock('../config/jwt', () => ({ getJwtSecret: () => 'synthetic-evaluation-delegation-secret' }));
jest.mock('../services/db', () => ({ userDb: { getUserByIdConsistent: jest.fn(), getUserByEmailConsistent: jest.fn() } }));
jest.mock('../services/evaluationService', () => ({ runEvaluation: jest.fn() }));
jest.mock('../services/evaluationStore', () => ({ evaluationStore: { get: jest.fn(), simulate: jest.fn(), provision: jest.fn(), revoke: jest.fn() } }));

const claims = { userId: 'eval_test', email: 'candidate@example.invalid', isAdmin: false, dte: 2, sv: 3,
  delegateAccess: { scope: 'evaluation', adminUserId: 'admin', adminEmail: 'admin@example.invalid', targetUserId: 'eval_test', targetEmail: 'candidate@example.invalid' } };
const token = (override = {}, expiresIn = 3600) => jwt.sign({ ...claims, ...override }, secret, { expiresIn });
const app = express();
app.use(express.json(), evaluationHttpBoundary);
app.use('/api/evaluation', evaluationRoutes);
app.use('/api/admin/evaluations', evaluationAdminRoutes);
app.get('/api/auth/me', authenticateToken, (req: any, res) => res.json({ user: req.user, delegated: req.delegateInfo?.isDelegated }));
app.use((_req, res) => res.json({ escaped: true }));

beforeEach(() => {
  jest.clearAllMocks();
  (userDb.getUserByIdConsistent as jest.Mock).mockResolvedValue({ userId: 'admin', email: 'admin@example.invalid', isAdmin: true, isActive: true });
  (userDb.getUserByEmailConsistent as jest.Mock).mockResolvedValue({ userId: 'eval_test', email: claims.email, isActive: true, delegateTokenEpoch: 2, sessionVersion: 3 });
  (evaluationStore.get as jest.Mock).mockResolvedValue({ userId: 'eval_test', email: claims.email, status: 'active', expiresAt: Date.now() + 60000, remaining: 5, materials: [] });
  (evaluationStore.simulate as jest.Mock).mockResolvedValue({ ok: true });
});

it('authenticates the scoped delegate as the candidate, never as admin', async () => {
  const result = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${token()}`);
  expect(result.status).toBe(200);
  expect(result.body).toMatchObject({ user: { userId: 'eval_test', isAdmin: false }, delegated: true });
  expect((await request(app).get('/api/evaluation').set('Authorization', `Bearer ${token()}`)).status).toBe(200);
});
it('allows candidate simulator reset/reseed with the scoped delegate', async () => {
  const result = await request(app).post('/api/evaluation').set('Authorization', `Bearer ${token()}`).send({ action: 'simulate', command: { operation: 'reset' } });
  expect(result.status).toBe(200);
  expect(evaluationStore.simulate).toHaveBeenCalledWith('eval_test', { operation: 'reset' });
});
it.each(['/api/admin/evaluations', '/api/admin/evaluations/eval_test/revoke', '/api/admin/users/customer/delegate-access', '/api/meta/campaigns', '/api/oauth/meta/connect', '/api/mcp-servers', '/api/agent-mode/generate', '/api/schedules', '/api/landing-pages/deploy', '/api/future/unknown'])('scoped delegation denies %s', async path => {
  const result = await request(app).post(path).set('Authorization', `Bearer ${token()}`).send({});
  expect(result.status).toBe(403);
  expect(result.body.escaped).toBeUndefined();
  expect(evaluationStore.provision).not.toHaveBeenCalled();
  expect(evaluationStore.revoke).not.toHaveBeenCalled();
});
it.each(['invalid', 'expired', 'delegate-revoked', 'session-revoked', 'evaluation-revoked', 'admin-deactivated', 'target-deactivated', 'generic', 'wrong-target', 'evaluation-admin', 'service'])('fails closed for %s tokens', async kind => {
  let bearer = token();
  if (kind === 'invalid') bearer = 'invalid';
  if (kind === 'expired') bearer = token({}, -1);
  if (kind === 'delegate-revoked') (userDb.getUserByEmailConsistent as jest.Mock).mockResolvedValue({ userId: 'eval_test', email: claims.email, isActive: true, delegateTokenEpoch: 3 });
  if (kind === 'session-revoked') (userDb.getUserByEmailConsistent as jest.Mock).mockResolvedValue({ userId: 'eval_test', email: claims.email, isActive: true, sessionVersion: 4 });
  if (kind === 'evaluation-revoked') (evaluationStore.get as jest.Mock).mockResolvedValue({ userId: 'eval_test', status: 'revoked' });
  if (kind === 'admin-deactivated') (userDb.getUserByIdConsistent as jest.Mock).mockResolvedValue({ userId: 'admin', isAdmin: true, isActive: false });
  if (kind === 'target-deactivated') (userDb.getUserByEmailConsistent as jest.Mock).mockResolvedValue({ userId: 'eval_test', isActive: false });
  if (kind === 'generic') bearer = token({ delegateAccess: { ...claims.delegateAccess, scope: undefined } });
  if (kind === 'wrong-target') bearer = token({ delegateAccess: { ...claims.delegateAccess, targetUserId: 'customer' } });
  if (kind === 'evaluation-admin') bearer = token({ delegateAccess: { ...claims.delegateAccess, adminUserId: 'eval_admin' } });
  if (kind === 'service') bearer = token({ _svc: true });
  expect((await request(app).get('/api/evaluation').set('Authorization', `Bearer ${bearer}`)).status).toBe(401);
});
it('generic minting continues to deny evaluation targets and actors', () => {
  expect(() => mintDelegateToken({ userId: 'admin', email: 'admin@example.invalid' }, { userId: 'eval_test' }, '8h')).toThrow();
  expect(() => mintDelegateToken({ userId: 'eval_test', email: claims.email }, { userId: 'customer' }, '8h')).toThrow();
});
