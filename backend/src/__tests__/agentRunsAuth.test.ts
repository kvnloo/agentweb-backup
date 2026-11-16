/**
 * Tests for the D78 gate in front of GET /api/admin/agent-runs
 * (middleware/agentRunsAuth.ts).
 *
 * The route serves two very different callers:
 *   - the partner-portal admin UI (AgentRunsInspector.tsx), with a real admin's session JWT,
 *     browsing arbitrary runs by runId/userId with no sessionId filter
 *   - .aw-agent/lib/adminapi.mjs, with exactly one shape: a sessionId and limit=3
 *
 * so `authenticateToken`/`isAdmin` are mocked here rather than exercised for real: these tests are
 * about the GATE's own branching (which path a request takes, and that a wrong or missing secret
 * never falls through to the other path), not about session-JWT validation, which auth.test.ts /
 * admin.test.ts already own.
 */

import express, { Request, Response, NextFunction } from 'express';
import request from 'supertest';

const mockAuthenticateToken = jest.fn((req: Request, res: Response, next: NextFunction) => next());
const mockIsAdmin = jest.fn((req: Request, res: Response, next: NextFunction) => next());

jest.mock('../middleware/auth', () => ({
  authenticateToken: (req: Request, res: Response, next: NextFunction) => mockAuthenticateToken(req, res, next),
}));
jest.mock('../middleware/admin', () => ({
  isAdmin: (req: Request, res: Response, next: NextFunction) => mockIsAdmin(req, res, next),
}));

import {
  authenticateAgentRunsSecretOrAdmin,
  AGENT_RUNS_SECRET_HEADER,
  AW_AGENT_RUNS_SECRET_ENV,
  AGENT_RUNS_SECRET_MAX_LIMIT,
  __resetAgentRunsSecretWarnForTests,
} from '../middleware/agentRunsAuth';

const SECRET = 'test-agent-runs-secret-value';

function buildApp(downstream = (req: Request, res: Response) => res.status(200).json({ ok: true, query: req.query })) {
  const app = express();
  app.use('/api/admin/agent-runs', authenticateAgentRunsSecretOrAdmin(downstream));
  return app;
}

describe('authenticateAgentRunsSecretOrAdmin', () => {
  const originalSecret = process.env[AW_AGENT_RUNS_SECRET_ENV];

  beforeEach(() => {
    jest.clearAllMocks();
    __resetAgentRunsSecretWarnForTests();
    process.env[AW_AGENT_RUNS_SECRET_ENV] = SECRET;
  });

  afterAll(() => {
    if (originalSecret === undefined) delete process.env[AW_AGENT_RUNS_SECRET_ENV];
    else process.env[AW_AGENT_RUNS_SECRET_ENV] = originalSecret;
  });

  describe('secret path (x-aw-agent-runs-secret header present)', () => {
    it('reaches the route directly on a correct secret, bypassing authenticateToken/isAdmin', async () => {
      const res = await request(buildApp())
        .get('/api/admin/agent-runs')
        .query({ sessionId: 'session-abc' })
        .set(AGENT_RUNS_SECRET_HEADER, SECRET);

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(mockAuthenticateToken).not.toHaveBeenCalled();
      expect(mockIsAdmin).not.toHaveBeenCalled();
    });

    it('refuses sub-routes such as /trace (403): the secret covers the run list only', async () => {
      const downstream = jest.fn((req: Request, res: Response) => res.status(200).json({ ok: true }));
      const res = await request(buildApp(downstream))
        .get('/api/admin/agent-runs/trace')
        .query({ sessionId: 'session-abc' })
        .set(AGENT_RUNS_SECRET_HEADER, SECRET);

      expect(res.status).toBe(403);
      expect(downstream).not.toHaveBeenCalled();
      expect(mockAuthenticateToken).not.toHaveBeenCalled();
    });

    it('lets an admin session (no secret header) reach /trace', async () => {
      const res = await request(buildApp()).get('/api/admin/agent-runs/trace').query({ sessionId: 'session-abc' });

      expect(res.status).toBe(200);
      expect(mockAuthenticateToken).toHaveBeenCalled();
      expect(mockIsAdmin).toHaveBeenCalled();
    });

    it('fails closed (401) on a wrong secret and never falls through to a real admin session', async () => {
      // authenticateToken/isAdmin are stubbed to ALWAYS succeed here — if the gate ever fell
      // through to them on a bad secret, this request would come back 200, not 401.
      const res = await request(buildApp())
        .get('/api/admin/agent-runs')
        .query({ sessionId: 'session-abc' })
        .set(AGENT_RUNS_SECRET_HEADER, 'wrong-secret');

      expect(res.status).toBe(401);
      expect(mockAuthenticateToken).not.toHaveBeenCalled();
      expect(mockIsAdmin).not.toHaveBeenCalled();
    });

    it('fails closed (503) when the header is sent but the server has no secret configured', async () => {
      delete process.env[AW_AGENT_RUNS_SECRET_ENV];

      const res = await request(buildApp())
        .get('/api/admin/agent-runs')
        .query({ sessionId: 'session-abc' })
        .set(AGENT_RUNS_SECRET_HEADER, SECRET);

      expect(res.status).toBe(503);
      expect(mockAuthenticateToken).not.toHaveBeenCalled();
    });

    it('requires sessionId — a secret alone does not permit the admin UI\'s open-ended browsing', async () => {
      const res = await request(buildApp())
        .get('/api/admin/agent-runs')
        .set(AGENT_RUNS_SECRET_HEADER, SECRET);

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/sessionId is required/);
    });

    it(`caps limit at ${AGENT_RUNS_SECRET_MAX_LIMIT} server-side regardless of what was requested`, async () => {
      const res = await request(buildApp())
        .get('/api/admin/agent-runs')
        .query({ sessionId: 'session-abc', limit: '500' })
        .set(AGENT_RUNS_SECRET_HEADER, SECRET);

      expect(res.status).toBe(200);
      expect(res.body.query.limit).toBe(String(AGENT_RUNS_SECRET_MAX_LIMIT));
    });

    it('drops runId/userId — the secret authenticates one session lookup, not a browse', async () => {
      const res = await request(buildApp())
        .get('/api/admin/agent-runs')
        .query({ sessionId: 'session-abc', runId: 'some-run', userId: 'some-user' })
        .set(AGENT_RUNS_SECRET_HEADER, SECRET);

      expect(res.status).toBe(200);
      expect(res.body.query.runId).toBeUndefined();
      expect(res.body.query.userId).toBeUndefined();
      expect(res.body.query.sessionId).toBe('session-abc');
    });

    it('defaults limit to the cap when none is requested, matching adminapi.mjs\'s own limit=3', async () => {
      const res = await request(buildApp())
        .get('/api/admin/agent-runs')
        .query({ sessionId: 'session-abc' })
        .set(AGENT_RUNS_SECRET_HEADER, SECRET);

      expect(res.body.query.limit).toBe(String(AGENT_RUNS_SECRET_MAX_LIMIT));
    });
  });

  describe('no secret header — unchanged admin-UI path', () => {
    it('falls through to authenticateToken and isAdmin exactly as before', async () => {
      const res = await request(buildApp())
        .get('/api/admin/agent-runs')
        .query({ runId: 'any-run' }); // no sessionId — the admin UI's own browsing shape

      expect(res.status).toBe(200);
      expect(mockAuthenticateToken).toHaveBeenCalledTimes(1);
      expect(mockIsAdmin).toHaveBeenCalledTimes(1);
      // untouched: the admin-UI path is not narrowed the way the secret path is
      expect(res.body.query.runId).toBe('any-run');
    });

    it('is rejected by authenticateToken exactly as before when that middleware denies it', async () => {
      mockAuthenticateToken.mockImplementationOnce((req: Request, res: Response) =>
        res.status(401).json({ message: 'No token provided' }));

      const res = await request(buildApp()).get('/api/admin/agent-runs');

      expect(res.status).toBe(401);
      expect(mockIsAdmin).not.toHaveBeenCalled();
    });

    it('is rejected by isAdmin exactly as before when the session is not an admin', async () => {
      mockIsAdmin.mockImplementationOnce((req: Request, res: Response) =>
        res.status(403).json({ message: 'Admin access required' }));

      const res = await request(buildApp()).get('/api/admin/agent-runs');

      expect(res.status).toBe(403);
      expect(mockAuthenticateToken).toHaveBeenCalledTimes(1);
    });
  });
});
