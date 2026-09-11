import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { evaluationHttpBoundary } from '../middleware/evaluation';
import { evaluationStore } from '../services/evaluationStore';

jest.mock('../config/jwt', () => ({ getJwtSecret: () => 'synthetic-evaluation-signing-secret' }));
jest.mock('../services/db', () => ({ userDb: { getUserById: jest.fn(), getUserByEmailConsistent: jest.fn().mockResolvedValue({ userId: 'eval_test', email: 'case@example.invalid', isActive: true, isAdmin: false }) } }));
jest.mock('../services/evaluationStore', () => ({ evaluationStore: { get: jest.fn() } }));

describe('ENG-1870 direct-route and revocation acceptance', () => {
  const app = express();
  app.use(express.json(), evaluationHttpBoundary);
  app.use((_req, res) => res.json({ escaped: true }));
  const token = jwt.sign({ userId: 'eval_test', email: 'case@example.invalid', isAdmin: false }, 'synthetic-evaluation-signing-secret');
  beforeEach(() => {
    (evaluationStore.get as jest.Mock).mockResolvedValue({ userId: 'eval_test', email: 'case@example.invalid', status: 'active', expiresAt: Date.now() + 60000 });
  });
  it.each([
    ['post', '/api/meta/campaigns'], ['post', '/api/emma/generate-image'],
    ['post', '/api/oauth/meta/connect'], ['get', '/api/oauth/meta/auth'],
    ['post', '/api/files/upload'], ['get', '/api/org/other'],
    ['get', '/api/agent-mode/share/other'], ['post', '/api/agent-mode/session/other/transfer'],
    ['post', '/api/agent-mode/generate'], ['post', '/api/schedules'],
    ['post', '/api/mcp-servers'], ['post', '/api/admin/delegate'],
    ['get', '/api/brand'], ['post', '/api/landing-pages/deploy'],
    ['post', '/api/future/unknown'],
  ])('%s %s cannot reach a production handler', async (method, url) => {
    const result = await (request(app) as any)[method](url).set('Authorization', `Bearer ${token}`).send({ userId: 'staff', clientId: 'staff' });
    expect(result.status).toBe(403);
    expect(result.body.escaped).toBeUndefined();
  });
  it('revocation invalidates a previously valid application JWT', async () => {
    (evaluationStore.get as jest.Mock).mockResolvedValue({ userId: 'eval_test', status: 'revoked' });
    expect((await request(app).get('/api/evaluation').set('Authorization', `Bearer ${token}`)).status).toBe(401);
  });
  it('policy-store outage fails closed', async () => {
    (evaluationStore.get as jest.Mock).mockRejectedValue(new Error('unavailable'));
    expect((await request(app).get('/api/evaluation').set('Authorization', `Bearer ${token}`)).status).toBe(401);
  });
  it('ordinary request continues to existing authorization', async () => {
    expect((await request(app).get('/api/brand')).body).toEqual({ escaped: true });
  });
  it('cannot replay the app JWT as connector OAuth state without an Authorization header', async () => {
    const result = await request(app).get('/api/oauth/meta/callback').query({ state: token, code: 'synthetic' });
    expect(result.status).toBe(401);
    expect(result.body.escaped).toBeUndefined();
  });
});
