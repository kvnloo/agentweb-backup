/**
 * ENG-2110 (B3): the HTTP face of connecting a Claude subscription. The service is faked;
 * under test: the session decides who the caller is, a delegated admin is passed through
 * (and refused by the service), inputs are validated, errors carry codes only, and neither
 * a response nor a log line carries the one-time code.
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
jest.mock('../../services/funding/claudeSubscriptionService', () => {
  class ClaudeSubscriptionError extends Error {
    constructor(public code: string, public httpStatus = 400) { super(code); }
  }
  return { ClaudeSubscriptionError, getClaudeSubscriptionService: jest.fn() };
});

import { createClaudeSubscriptionRouter } from '../claudeSubscription';
import { ClaudeSubscriptionError } from '../../services/funding/claudeSubscriptionService';

const CODE = 'THE-ONE-TIME-CODE-1#THE-STATE-VALUE-1';
const START = { loginId: 'abc123', authorizeUrl: 'https://claude.com/cai/oauth/authorize?x=1', expiresAt: '2026-10-14T12:00:00.000Z' };

function makeApp() {
  const service = {
    startLogin: jest.fn(async (..._a: any[]) => START),
    completeLogin: jest.fn(async (..._a: any[]) => ({ connectionId: 'sub-1', kind: 'claude_subscription' })),
    cancelLogin: jest.fn(async (..._a: any[]) => undefined),
  };
  const app = express();
  app.use(express.json());
  app.use('/api/llm-connections/claude-subscription', createClaudeSubscriptionRouter(() => service as any));
  return { app, service };
}
const BASE = '/api/llm-connections/claude-subscription';

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

  it('starts a sign-in as the session user, never a user named in the request', async () => {
    const { app, service } = makeApp();
    const res = await request(app).post(`${BASE}/start`).send({ userId: 'someone-else' });
    expect(res.status).toBe(201);
    expect(res.body).toEqual(START);
    expect(service.startLogin).toHaveBeenCalledWith({ userId: 'user-1' }, { reconnectConnectionId: undefined });
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('passes a delegated admin through so the service can refuse it, and returns its code', async () => {
    session = { userId: 'user-1', adminUserId: 'admin-9' };
    const { app, service } = makeApp();
    service.startLogin.mockRejectedValue(new (ClaudeSubscriptionError as any)('forbidden', 403));
    const res = await request(app).post(`${BASE}/start`).send({});
    expect(service.startLogin).toHaveBeenCalledWith({ userId: 'user-1', adminId: 'admin-9' }, expect.anything());
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'forbidden' });
  });

  it('validates the reconnect id and the complete body', async () => {
    const { app, service } = makeApp();
    expect((await request(app).post(`${BASE}/start`).send({ reconnectConnectionId: 5 })).status).toBe(400);
    expect((await request(app).post(`${BASE}/start`).send({ reconnectConnectionId: 'x'.repeat(200) })).status).toBe(400);
    for (const body of [{}, { loginId: 'a' }, { code: CODE }, { loginId: 5, code: CODE }, { loginId: 'a', code: 5 }, { loginId: 'a'.repeat(200), code: CODE }, { loginId: 'a', code: 'x'.repeat(600) }]) {
      expect((await request(app).post(`${BASE}/complete`).send(body as any)).status).toBe(400);
    }
    expect(service.startLogin).not.toHaveBeenCalled();
    expect(service.completeLogin).not.toHaveBeenCalled();
  });

  it('completes a sign-in and never echoes or logs the code', async () => {
    const { app, service } = makeApp();
    const res = await request(app).post(`${BASE}/complete`).send({ loginId: 'abc123', code: CODE });
    expect(res.status).toBe(201);
    expect(service.completeLogin).toHaveBeenCalledWith({ userId: 'user-1' }, 'abc123', CODE);
    expect(JSON.stringify(res.body) + res.text + logged.join(' ')).not.toContain('THE-ONE-TIME-CODE');
  });

  it.each([['login_not_found', 409], ['code_rejected', 400], ['disabled', 403], ['too_many_logins', 429]])('maps %s to %i', async (code, status) => {
    const { app, service } = makeApp();
    service.completeLogin.mockRejectedValue(new (ClaudeSubscriptionError as any)(code, status));
    const res = await request(app).post(`${BASE}/complete`).send({ loginId: 'a', code: CODE });
    expect(res.status).toBe(status);
    expect(res.body).toEqual({ error: code });
  });

  it('turns an unexpected error into a bare 500 and logs a code only, never the message or the code', async () => {
    const { app, service } = makeApp();
    service.completeLogin.mockRejectedValue(Object.assign(new Error(`boom ${CODE} sk-ant-LEAK`), { code: 'EBOOM' }));
    const res = await request(app).post(`${BASE}/complete`).send({ loginId: 'a', code: CODE });
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'internal_error' });
    expect(logged.join(' ')).toContain('EBOOM');
    expect(logged.join(' ')).not.toMatch(/THE-ONE-TIME-CODE|LEAK/);
  });

  it('cancels a pending sign-in as the session user', async () => {
    const { app, service } = makeApp();
    const res = await request(app).delete(`${BASE}/login/abc123`);
    expect(res.status).toBe(204);
    expect(service.cancelLogin).toHaveBeenCalledWith({ userId: 'user-1' }, 'abc123');
  });
});
