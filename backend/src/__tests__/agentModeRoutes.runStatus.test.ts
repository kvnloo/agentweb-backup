/** ENG-1015: authenticated, owner-only, read-only durable run status. */
jest.mock('../controllers/agentModeController', () => ({
  agentModeController: new Proxy({}, { get: () => jest.fn() }),
}));
jest.mock('../services/chatbotService', () => ({ chatbotDb: {} }));
jest.mock('../services/voiceService', () => ({ synthesizeSpeech: jest.fn() }));
jest.mock('../services/db', () => ({ userDb: { getUserById: jest.fn() } }));
jest.mock('../services/evaluationPolicy', () => ({ isEvaluationUser: () => false }));

import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import router from '../routes/agentMode';
import { __setDocumentClientForTests, AGENT_RUNS_TABLE } from '../services/agentMode/runStore';
import { userDb } from '../services/db';

const app = express().use('/api/agent-mode', router);
const get = jest.fn();
const item = {
  pk: 'run#r1', runId: 'r1', sessionId: 's1', userId: 'owner', kind: 'interactive',
  status: 'completed', finishReason: 'stop', startedAt: '2026-09-17T00:00:00Z',
  finishedAt: '2026-09-17T00:01:00Z', ttl: 9999999999, traceId: 'private-trace',
};
const originalFlag = process.env.AGENT_RUN_STORE;
const originalSecret = process.env.JWT_SECRET;
function poll(userId = 'owner', isAdmin = false) {
  (userDb.getUserById as jest.Mock).mockResolvedValue({ userId, email: 'test@example.com', isAdmin });
  const token = jwt.sign({ userId, email: 'test@example.com' }, process.env.JWT_SECRET!);
  return request(app).get('/api/agent-mode/runs/r1').set('Authorization', `Bearer ${token}`);
}
beforeEach(() => {
  process.env.AGENT_RUN_STORE = 'true';
  process.env.JWT_SECRET = 'eng-1015-test-only-secret';
  get.mockReset().mockReturnValue({ promise: async () => ({ Item: item }) });
  __setDocumentClientForTests({ get } as any);
});
afterAll(() => {
  __setDocumentClientForTests(null);
  if (originalFlag === undefined) delete process.env.AGENT_RUN_STORE;
  else process.env.AGENT_RUN_STORE = originalFlag;
  if (originalSecret === undefined) delete process.env.JWT_SECRET;
  else process.env.JWT_SECRET = originalSecret;
});
it('requires authentication before reading a record', async () => {
  expect((await request(app).get('/api/agent-mode/runs/r1')).status).toBe(401);
  expect(get).not.toHaveBeenCalled();
});
it.each(['running', 'completed', 'failed', 'interrupted'])('returns only the owner status projection: %s', async status => {
  get.mockReturnValue({ promise: async () => ({ Item: { ...item, status } }) });
  const res = await poll();
  expect(res.status).toBe(200);
  expect(res.headers['cache-control']).toBe('no-store');
  expect(res.body).toEqual({ runId: 'r1', sessionId: 's1', status, finishReason: 'stop' });
  expect(get).toHaveBeenCalledWith({ TableName: AGENT_RUNS_TABLE, Key: { pk: 'run#r1' }, ConsistentRead: true });
});
it('refuses other users including admins without leaking record existence', async () => {
  const other = await poll('other');
  const admin = await poll('admin', true);
  get.mockReturnValue({ promise: async () => ({}) });
  const missing = await poll();
  expect(other.status).toBe(404);
  expect(admin.status).toBe(missing.status);
  expect(other.body).toEqual(missing.body);
  expect(admin.body).toEqual(missing.body);
  expect(missing.body.completion_confirmed).toBe(false);
});
it.each([
  { ...item, ttl: 1 }, { ...item, status: 'unknown' }, { ...item, userId: undefined },
  { ...item, sessionId: {} }, { ...item, runId: 'other' }, { ...item, finishReason: {} },
])('never exposes expired or malformed records', async record => {
  get.mockReturnValue({ promise: async () => ({ Item: record }) });
  const res = await poll();
  expect(res.status).toBe(404);
  expect(res.body.completion_confirmed).toBe(false);
});
it('does not read the store when disabled', async () => {
  process.env.AGENT_RUN_STORE = 'false';
  const res = await poll();
  expect(res.status).toBe(404);
  expect(res.body.completion_confirmed).toBe(false);
  expect(get).not.toHaveBeenCalled();
});
it('reports read failure as unconfirmed without exposing internals', async () => {
  get.mockReturnValue({ promise: async () => { throw new Error('private table details'); } });
  const res = await poll();
  expect(res.status).toBe(503);
  expect(res.body.completion_confirmed).toBe(false);
  expect(JSON.stringify(res.body)).not.toContain('private');
});

it('rejects invalid credentials without reading the store', async () => {
  const res = await request(app).get('/api/agent-mode/runs/r1').set('Authorization', 'Bearer invalid');
  expect(res.status).toBe(401);
  expect(get).not.toHaveBeenCalled();
});
it('returns null when a valid run has no finish reason', async () => {
  get.mockReturnValue({ promise: async () => ({ Item: { ...item, finishReason: undefined } }) });
  const res = await poll();
  expect(res.status).toBe(200);
  expect(res.body.finishReason).toBeNull();
});

it('refuses an oversized key without issuing a DynamoDB request', async () => {
  const token = jwt.sign({ userId: 'owner', _svc: true }, process.env.JWT_SECRET!);
  const res = await request(app).get(`/api/agent-mode/runs/${'x'.repeat(2045)}`)
    .set('Authorization', `Bearer ${token}`);
  expect(res.status).toBe(404);
  expect(res.body.completion_confirmed).toBe(false);
  expect(get).not.toHaveBeenCalled();
});
