/**
 * ENG-2105 (A1): the HTTP face of customer provider keys. The service is faked; what
 * is under test is that the session decides who the caller is, that a delegated
 * admin is recorded, and that neither a response nor a log line ever carries a key.
 */
import express from 'express';
import request from 'supertest';

let session: { userId: string; adminUserId?: string } | null = { userId: 'user-1' };
jest.mock('../../middleware/auth', () => ({
  authenticateToken: (req: any, res: any, next: any) => {
    if (!session) return res.status(401).json({ error: 'unauthenticated' });
    req.user = { userId: session.userId, email: 'u@example.com', isAdmin: false };
    if (session.adminUserId) req.delegateInfo = { adminUserId: session.adminUserId, isDelegated: true };
    next();
  },
}));
jest.mock('../../services/funding/llmConnectionService', () => {
  class LlmConnectionError extends Error {
    constructor(public code: string, public checkResult?: string, public httpStatus = 400) {
      super(code);
    }
  }
  return { LlmConnectionError, getLlmConnectionService: jest.fn() };
});

import { createLlmConnectionsRouter } from '../llmConnections';
import { LlmConnectionError } from '../../services/funding/llmConnectionService';

const KEY = 'sk-ant-api03-THE-CUSTOMER-KEY-0123456789';
const VIEW = { connectionId: 'conn-1', provider: 'anthropic', status: 'active', keyLast4: '6789', ownedByCaller: true };

function makeApp() {
  const service = {
    list: jest.fn(async () => ({ connections: [VIEW], canManage: true, inOrg: false })),
    add: jest.fn(async () => VIEW),
    validate: jest.fn(async () => ({ result: 'ok', connection: VIEW })),
    setShared: jest.fn(async () => VIEW),
    revoke: jest.fn(async () => undefined),
  };
  const app = express();
  app.use(express.json());
  app.use('/api/llm-connections', createLlmConnectionsRouter(() => service as any));
  return { app, service };
}

describe('/api/llm-connections', () => {
  let logged: string[];
  beforeEach(() => {
    session = { userId: 'user-1' };
    logged = [];
    for (const level of ['log', 'info', 'warn', 'error'] as const) {
      jest.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        logged.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
      });
    }
  });
  afterEach(() => jest.restoreAllMocks());

  it('requires a session', async () => {
    session = null;
    const { app, service } = makeApp();
    expect((await request(app).get('/api/llm-connections')).status).toBe(401);
    expect((await request(app).post('/api/llm-connections').send({ provider: 'anthropic', apiKey: KEY })).status).toBe(401);
    expect(service.add).not.toHaveBeenCalled();
  });

  it('lists for the session user and forbids caching', async () => {
    const { app, service } = makeApp();
    const res = await request(app).get('/api/llm-connections?userId=someone-else');
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(service.list).toHaveBeenCalledWith('user-1');
  });

  it('adds a key for the session user, ignoring any user id in the body, and never echoes the key', async () => {
    const { app, service } = makeApp();
    const res = await request(app)
      .post('/api/llm-connections')
      .send({ provider: 'anthropic', apiKey: KEY, shareWithOrg: 'yes', userId: 'someone-else', ownerUserId: 'someone-else' });
    expect(res.status).toBe(201);
    expect(service.add).toHaveBeenCalledWith({ userId: 'user-1' }, { provider: 'anthropic', apiKey: KEY, shareWithOrg: false });
    expect(JSON.stringify(res.body)).not.toContain(KEY);
    expect(logged.join('\n')).not.toContain(KEY);
  });

  it('records the delegated admin as the actor\'s admin', async () => {
    session = { userId: 'customer-1', adminUserId: 'admin-9' };
    const { app, service } = makeApp();
    await request(app).post('/api/llm-connections').send({ provider: 'openai', apiKey: KEY });
    await request(app).delete('/api/llm-connections/conn-1');
    expect((service.add.mock.calls as unknown[][])[0][0]).toEqual({ userId: 'customer-1', adminId: 'admin-9' });
    expect(service.revoke).toHaveBeenCalledWith({ userId: 'customer-1', adminId: 'admin-9' }, 'conn-1');
  });

  it('returns a typed refusal, with the fixed check result and nothing from the provider', async () => {
    const { app, service } = makeApp();
    service.add.mockRejectedValueOnce(new (LlmConnectionError as any)('key_rejected', 'invalid_key', 422));
    const res = await request(app).post('/api/llm-connections').send({ provider: 'anthropic', apiKey: KEY });
    expect(res.status).toBe(422);
    expect(res.body).toEqual({ error: 'key_rejected', checkResult: 'invalid_key' });
  });

  it('answers an unexpected failure with a bare 500 and logs no detail that could hold the key', async () => {
    const { app, service } = makeApp();
    const boom = Object.assign(new Error(`request failed; headers: {"x-api-key":"${KEY}"}`), { code: 'ECONNRESET', config: { headers: { 'x-api-key': KEY } } });
    service.add.mockRejectedValueOnce(boom);
    const res = await request(app).post('/api/llm-connections').send({ provider: 'anthropic', apiKey: KEY });
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'internal_error' });
    expect(logged.join('\n')).toContain('add failed: ECONNRESET');
    expect(logged.join('\n')).not.toContain(KEY);
  });

  it('validates, shares and revokes by id for the session user', async () => {
    const { app, service } = makeApp();
    expect((await request(app).post('/api/llm-connections/conn-1/validate')).body).toEqual({ result: 'ok', connection: VIEW });
    expect(service.validate).toHaveBeenCalledWith({ userId: 'user-1' }, 'conn-1');

    expect((await request(app).patch('/api/llm-connections/conn-1').send({ sharedWithOrg: true })).status).toBe(200);
    expect(service.setShared).toHaveBeenCalledWith({ userId: 'user-1' }, 'conn-1', true);
    expect((await request(app).patch('/api/llm-connections/conn-1').send({ sharedWithOrg: 'true' })).status).toBe(400);

    expect((await request(app).delete('/api/llm-connections/conn-1')).status).toBe(204);
  });

  it('rate-limits per user', async () => {
    const { app } = makeApp();
    let last = 200;
    for (let i = 0; i < 31; i++) last = (await request(app).get('/api/llm-connections')).status;
    expect(last).toBe(429);
    session = { userId: 'user-2' };
    expect((await request(app).get('/api/llm-connections')).status).toBe(200);
  });
});
