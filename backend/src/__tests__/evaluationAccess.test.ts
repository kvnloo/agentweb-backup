import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { evaluationHttpBoundary } from '../middleware/evaluation';
import { evaluationStore } from '../services/evaluationStore';

jest.mock('../config/jwt', () => ({ getJwtSecret: () => 'synthetic-evaluation-signing-secret' }));
jest.mock('../services/db', () => ({ userDb: { getUserById: jest.fn(), getUserByEmailConsistent: jest.fn().mockResolvedValue({ userId: 'eval_test', email: 'case@example.invalid', isActive: true, isAdmin: false }) } }));
jest.mock('../services/evaluationStore', () => ({ evaluationStore: { get: jest.fn() } }));

/**
 * ENG-1907 AC2: a sandbox principal uses the real portal, so the boundary is a
 * DENYLIST of side-effect / identity / exposure routes — everything else reaches
 * the normal route authorization. ENG-1870's revocation and OAuth-state-replay
 * assertions still hold.
 */
describe('ENG-1907 sandbox HTTP boundary', () => {
  const app = express();
  app.use(express.json(), evaluationHttpBoundary);
  app.use((_req, res) => res.json({ escaped: true }));
  const secret = 'synthetic-evaluation-signing-secret';
  const token = jwt.sign({ userId: 'eval_test', email: 'case@example.invalid', isAdmin: false }, secret);
  beforeEach(() => {
    (evaluationStore.get as jest.Mock).mockResolvedValue({ userId: 'eval_test', email: 'case@example.invalid', status: 'active', expiresAt: Date.now() + 60000 });
  });

  it.each([
    ['post', '/api/oauth/meta/init'], ['get', '/api/oauth/meta/callback'], ['post', '/api/oauth/meta/connect-ad-accounts'],
    ['get', '/api/oauth/google-ads/init'], ['post', '/api/oauth/linkedin/callback'],
    ['delete', '/api/oauth/connected-accounts/meta'], ['delete', '/api/oauth/connected-accounts/meta/123'],
    ['patch', '/api/oauth/connected-accounts/meta/123/conversion-relay'],
    ['post', '/oauth/register'], ['get', '/oauth/authorize'], ['post', '/oauth/authorize/decision'], ['post', '/oauth/token'],
    ['get', '/.well-known/oauth-authorization-server'],
    ['post', '/api/mcp-oauth/anything'], ['post', '/api/mcp-servers'], ['post', '/api/admin/mcp-servers'],
    ['post', '/api/v1/agent/keys'], ['get', '/api/v1/agent/keys'], ['delete', '/api/v1/agent/keys/k1'],
    ['post', '/api/stripe/create-customer-portal-session'], ['post', '/api/stripe/connect/onboard'], ['get', '/api/stripe/status'],
    ['get', '/api/org/other'], ['post', '/api/org/invite'], ['get', '/api/orgs/me/members'], ['get', '/api/orgs/me/share-settings'],
    ['get', '/api/featurebase/identity'],
    ['post', '/api/agent-mode/share'], ['put', '/api/agent-mode/session/other/transfer'], ['post', '/api/agent-mode/session/other/transfer'],
    ['post', '/api/settings/replay-sessions'],
    ['get', '/api/admin/users'], ['post', '/api/admin/delegate'], ['get', '/api/admin/evaluations/eval_test'],
    ['get', '/api/evaluation'], ['post', '/api/evaluation'], ['get', '/api/evaluation/artifacts/x'],
  ])('%s %s is refused for a sandbox principal', async (method, url) => {
    const result = await (request(app) as any)[method](url).set('Authorization', `Bearer ${token}`).send({ userId: 'staff', clientId: 'staff' });
    expect(result.status).toBe(403);
    expect(result.body).toEqual({ error: 'Not available in this sandbox workspace' });
  });

  it.each([
    ['post', '/api/agent-mode/generate'], ['get', '/api/agent-mode/sessions'], ['get', '/api/agent-mode/session/abc/progress'],
    ['delete', '/api/agent-mode/session/abc/share'],
    ['get', '/api/brand'], ['put', '/api/brand'],
    ['get', '/api/meta/ad-performance'], ['get', '/api/meta/account-status'], ['get', '/api/meta/v2/pixels'],
    ['get', '/api/oauth/connected-accounts'],
    ['post', '/api/emma/generate-image'], ['get', '/api/user-work-plans'], ['get', '/api/subscription/usage'],
    ['get', '/api/auth/me'], ['put', '/api/auth/change-password'], ['get', '/api/tasks'], ['post', '/api/files/upload'],
    ['get', '/api/settings/customer/email-campaign-tasks'], ['post', '/api/crm/lists'],
  ])('%s %s reaches normal authorization for a sandbox principal', async (method, url) => {
    const result = await (request(app) as any)[method](url).set('Authorization', `Bearer ${token}`).send({});
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ escaped: true });
  });

  it('revocation invalidates a previously valid application JWT', async () => {
    (evaluationStore.get as jest.Mock).mockResolvedValue({ userId: 'eval_test', status: 'revoked' });
    expect((await request(app).get('/api/brand').set('Authorization', `Bearer ${token}`)).status).toBe(401);
  });
  it('an expired policy fails closed', async () => {
    (evaluationStore.get as jest.Mock).mockResolvedValue({ userId: 'eval_test', email: 'case@example.invalid', status: 'active', expiresAt: Date.now() - 1 });
    expect((await request(app).get('/api/brand').set('Authorization', `Bearer ${token}`)).status).toBe(401);
  });
  it('policy-store outage fails closed', async () => {
    (evaluationStore.get as jest.Mock).mockRejectedValue(new Error('unavailable'));
    expect((await request(app).get('/api/brand').set('Authorization', `Bearer ${token}`)).status).toBe(401);
  });
  it('ordinary request continues to existing authorization', async () => {
    expect((await request(app).get('/api/brand')).body).toEqual({ escaped: true });
    const customer = jwt.sign({ userId: 'customer', email: 'c@example.invalid' }, secret);
    expect((await request(app).post('/api/oauth/meta/init').set('Authorization', `Bearer ${customer}`)).body).toEqual({ escaped: true });
  });
  it('cannot replay the app JWT as connector OAuth state without an Authorization header', async () => {
    const result = await request(app).get('/api/oauth/meta/callback').query({ state: token, code: 'synthetic' });
    expect(result.status).toBe(401);
    expect(result.body.escaped).toBeUndefined();
  });
  it('an app JWT presented as OAuth state with a matching bearer is still denied on the connector route', async () => {
    const result = await request(app).get('/api/oauth/meta/callback').set('Authorization', `Bearer ${token}`).query({ state: token, code: 'synthetic' });
    expect(result.status).toBe(403);
  });
  it('a sandbox token in the MCP OAuth authorize state cannot reach the consent flow', async () => {
    const result = await request(app).get('/oauth/authorize').set('Authorization', `Bearer ${token}`).query({ state: token });
    expect(result.status).toBe(403);
  });
});
