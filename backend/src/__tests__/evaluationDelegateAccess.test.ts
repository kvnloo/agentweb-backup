import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { evaluationHttpBoundary } from '../middleware/evaluation';
import { authenticateToken } from '../middleware/auth';
import { evaluationStore } from '../services/evaluationStore';
import { userDb } from '../services/db';
import { mintDelegateToken } from '../services/delegateAccessToken';

// Supertest matrices spin one ephemeral server per request; under the full-suite
// pre-push run a slow worker can exceed jest's 5s default and surface as "socket hang up".
jest.setTimeout(30000);
const secret = 'synthetic-evaluation-delegation-secret';
jest.mock('../config/jwt', () => ({ getJwtSecret: () => 'synthetic-evaluation-delegation-secret' }));
jest.mock('../services/db', () => ({ userDb: { getUserByIdConsistent: jest.fn(), getUserByEmailConsistent: jest.fn() } }));
jest.mock('../services/evaluationStore', () => ({ evaluationStore: { get: jest.fn(), provision: jest.fn(), revoke: jest.fn() } }));

/**
 * ENG-1907 AC5: Admin → Access Portal opens the sandbox account in the REAL
 * customer portal. The evaluation-scoped delegate authenticates as the
 * candidate on ordinary portal routes, stays inside the sandbox denylist, and
 * fails closed on every revocation signal (ENG-1870 criteria 7 and 5).
 */
const claims = { userId: 'eval_test', email: 'candidate@example.invalid', isAdmin: false, dte: 2, sv: 3,
  delegateAccess: { scope: 'evaluation', adminUserId: 'admin', adminEmail: 'admin@example.invalid', targetUserId: 'eval_test', targetEmail: 'candidate@example.invalid' } };
const token = (override = {}, expiresIn = 3600) => jwt.sign({ ...claims, ...override }, secret, { expiresIn });
const app = express();
app.use(express.json(), evaluationHttpBoundary);
app.get('/api/auth/me', authenticateToken, (req: any, res) => res.json({ user: req.user, delegated: req.delegateInfo?.isDelegated }));
app.use((_req, res) => res.json({ escaped: true }));

beforeEach(() => {
  jest.clearAllMocks();
  (userDb.getUserByIdConsistent as jest.Mock).mockResolvedValue({ userId: 'admin', email: 'admin@example.invalid', isAdmin: true, isActive: true });
  (userDb.getUserByEmailConsistent as jest.Mock).mockResolvedValue({ userId: 'eval_test', email: claims.email, isActive: true, delegateTokenEpoch: 2, sessionVersion: 3 });
  (evaluationStore.get as jest.Mock).mockResolvedValue({ userId: 'eval_test', email: claims.email, status: 'active', expiresAt: Date.now() + 60000 });
});

it('authenticates the scoped delegate as the candidate, never as admin', async () => {
  const result = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${token()}`);
  expect(result.status).toBe(200);
  expect(result.body).toMatchObject({ user: { userId: 'eval_test', isAdmin: false }, delegated: true });
});
it.each(['/api/agent-mode/generate', '/api/agent-mode/sessions', '/api/brand', '/api/meta/ad-performance', '/api/user-work-plans'])('the scoped delegate reaches the ordinary portal route %s', async path => {
  const result = await request(app).post(path).set('Authorization', `Bearer ${token()}`).send({});
  expect(result.status).toBe(200);
  expect(result.body).toEqual({ escaped: true });
});
it.each(['/api/admin/evaluations', '/api/admin/evaluations/eval_test/revoke', '/api/admin/users/customer/delegate-access', '/api/oauth/meta/connect-ad-accounts', '/api/admin/mcp-servers', '/api/stripe/checkout', '/api/org/invite', '/api/agent-mode/share', '/api/evaluation'])('scoped delegation is denied on %s', async path => {
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
  // /api/auth/me carries authenticateToken, so a non-evaluation-shaped garbage
  // bearer is refused by ordinary auth and every evaluation-shaped one by the boundary.
  expect((await request(app).get('/api/auth/me').set('Authorization', `Bearer ${bearer}`)).status).toBe(401);
});
it('generic minting continues to deny evaluation targets and actors', () => {
  expect(() => mintDelegateToken({ userId: 'admin', email: 'admin@example.invalid' }, { userId: 'eval_test' }, '8h')).toThrow();
  expect(() => mintDelegateToken({ userId: 'eval_test', email: claims.email }, { userId: 'customer' }, '8h')).toThrow();
});
