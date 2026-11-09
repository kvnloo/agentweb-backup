/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unused-vars -- test doubles for express and cron deps */
/**
 * ENG-2110 (1c): the HTTP face of connecting a hosted subscription login. The service is faked; under test: the session decides who
 * the caller is, the provider comes from the path, a delegated admin is passed through (and refused by the service), inputs are
 * validated, errors carry codes only, and neither a response nor a log line carries the one-time code.
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
jest.mock('../../services/funding/hostedSubscriptionService', () => {
  class HostedSubscriptionError extends Error {
    constructor(public code: string, public httpStatus = 400) { super(code); }
  }
  return { HostedSubscriptionError, getHostedSubscriptionService: jest.fn() };
});

import { createHostedSubscriptionsRouter } from '../hostedSubscriptions';
import { HostedSubscriptionError } from '../../services/funding/hostedSubscriptionService';

const CODE = 'THE-ONE-TIME-CODE-1#THE-STATE-VALUE-1';
const START = { loginId: 'abc123', authorizeUrl: 'https://claude.com/cai/oauth/authorize?x=1', ceremony: 'paste_code', expiresAt: '2026-10-21T12:00:00.000Z' };

function makeApp() {
  const service = {
    startLogin: jest.fn(async (..._a: any[]) => START),
    completeLogin: jest.fn(async (..._a: any[]) => ({ connectionId: 'sub-1', kind: 'claude_subscription' })),
    cancelLogin: jest.fn(async (..._a: any[]) => undefined),
  };
  const app = express();
  app.use(express.json());
  app.use('/api/llm-connections/subscriptions/:provider', createHostedSubscriptionsRouter(() => service as any));
  return { app, service };
}
const BASE = '/api/llm-connections/subscriptions/claude';

describe(BASE, () => {
  let logged: string[];
  beforeEach(() => {
    session = { userId: 'user-1' };
    logged = [];
    for (const level of ['log', 'info', 'warn', 'error'] as const) {
      jest.spyOn(console, level).mockImplementation((...args: unknown[]) => { logged.push(args.map((a) => (typeof a === 'string' ? a : a instanceof Error ? `${a.message} ${a.stack}` : JSON.stringify(a))).join(' ')); });
    }
  });
  afterEach(() => jest.restoreAllMocks());

  it('requires a session on every route', async () => {
    session = null;
    const { app, service } = makeApp();
    expect((await request(app).post(`${BASE}/start`)).status).toBe(401);
    expect((await request(app).post(`${BASE}/complete`).send({ loginId: 'a', code: CODE })).status).toBe(401);
    expect((await request(app).delete(`${BASE}/login/a`)).status).toBe(401);
    expect(service.startLogin).not.toHaveBeenCalled();
  });

  it('takes the provider from the path and the caller from the session, never from the body', async () => {
    const { app, service } = makeApp();
    const res = await request(app).post(`${BASE}/start`).send({ userId: 'someone-else', reconnectConnectionId: 'c-1' });
    expect(res.status).toBe(201);
    expect(res.body).toEqual(START);
    expect(service.startLogin).toHaveBeenCalledWith({ userId: 'user-1' }, 'claude', { reconnectConnectionId: 'c-1' });
    await request(app).post('/api/llm-connections/subscriptions/codex/start').send({});
    expect(service.startLogin).toHaveBeenLastCalledWith({ userId: 'user-1' }, 'codex', { reconnectConnectionId: undefined });
  });

  it('passes a delegated admin through so the service can refuse it', async () => {
    session = { userId: 'customer-1', adminUserId: 'admin-1' };
    const { app, service } = makeApp();
    await request(app).post(`${BASE}/start`).send({});
    expect(service.startLogin).toHaveBeenCalledWith({ userId: 'customer-1', adminId: 'admin-1' }, 'claude', { reconnectConnectionId: undefined });
  });

  it('validates inputs before the service sees them', async () => {
    const { app, service } = makeApp();
    expect((await request(app).post(`${BASE}/start`).send({ reconnectConnectionId: 5 })).status).toBe(400);
    expect((await request(app).post(`${BASE}/complete`).send({ loginId: 'a' })).status).toBe(400);
    expect((await request(app).post(`${BASE}/complete`).send({ loginId: 'a', code: 'x'.repeat(513) })).status).toBe(400);
    expect((await request(app).post(`${BASE}/complete`).send({ loginId: 'a'.repeat(1025), code: CODE })).status).toBe(400); // longer than any sealed token
    expect(service.startLogin).not.toHaveBeenCalled();
    expect(service.completeLogin).not.toHaveBeenCalled();
  });

  it('accepts a sealed-token-sized loginId (up to 1024 characters)', async () => {
    const { app, service } = makeApp();
    const res = await request(app).post(`${BASE}/complete`).send({ loginId: 'a'.repeat(1024), code: CODE });
    expect(res.status).toBe(201);
    expect(service.completeLogin).toHaveBeenCalledWith({ userId: 'user-1' }, 'a'.repeat(1024), CODE);
  });

  it('completes with the code in the body only, and the code is in no response and no log line', async () => {
    const { app, service } = makeApp();
    const res = await request(app).post(`${BASE}/complete`).send({ loginId: 'abc123', code: CODE });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ connection: { connectionId: 'sub-1', kind: 'claude_subscription' } });
    expect(service.completeLogin).toHaveBeenCalledWith({ userId: 'user-1' }, 'abc123', CODE);
    expect(JSON.stringify(res.body) + logged.join('\n')).not.toContain('THE-ONE-TIME-CODE');
  });

  it('maps service errors to their code and status, and unknown errors to a bare 500 that logs a code only', async () => {
    const { app, service } = makeApp();
    service.completeLogin.mockRejectedValueOnce(new (HostedSubscriptionError as any)('code_rejected', 400));
    const bad = await request(app).post(`${BASE}/complete`).send({ loginId: 'a', code: CODE });
    expect(bad.status).toBe(400);
    expect(bad.body).toEqual({ error: 'code_rejected' });
    service.completeLogin.mockRejectedValueOnce(Object.assign(new Error(`boom ${CODE}`), { code: 'EWHATEVER' }));
    const boom = await request(app).post(`${BASE}/complete`).send({ loginId: 'a', code: CODE });
    expect(boom.status).toBe(500);
    expect(boom.body).toEqual({ error: 'internal_error' });
    expect(logged.join('\n')).not.toContain('THE-ONE-TIME-CODE');
  });

  it('cancels a pending sign-in with 204 and sets no-store', async () => {
    const { app, service } = makeApp();
    const res = await request(app).delete(`${BASE}/login/abc123`);
    expect(res.status).toBe(204);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(service.cancelLogin).toHaveBeenCalledWith({ userId: 'user-1' }, 'abc123');
  });
});
