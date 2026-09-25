/**
 * Regression test for a real bug found live in production (2026-09-25): the D78 gate
 * (middleware/agentRunsAuth.ts) worked correctly in isolation (agentRunsAuth.test.ts,
 * an Express app with only the gate itself mounted) but was unreachable in the REAL app —
 * `app.use("/api/admin", adminRoutes)` applies `router.use(authenticateToken)` with no
 * path filter, so it ran for every request under `/api/admin/*`, including `/agent-runs`,
 * and rejected an unauthenticated request before Express ever reached the gate's own later
 * mount. A correct AW_AGENT_RUNS_SECRET header could never have worked in production.
 *
 * This test exercises the REAL `app` export (registration order and all), the same way
 * healthEndpoint.test.ts does, specifically so a future reordering of app.ts's `/api/admin`
 * mounts fails a test instead of silently regressing again.
 */

jest.mock('aws-sdk', () => ({
  config: { update: jest.fn() },
  EC2: jest.fn(() => ({})),
  SSM: jest.fn(() => ({})),
  IAM: jest.fn(() => ({})),
  DynamoDB: {
    DocumentClient: jest.fn(() => ({
      query: jest.fn().mockReturnThis(),
      put: jest.fn().mockReturnThis(),
      delete: jest.fn().mockReturnThis(),
      get: jest.fn().mockReturnThis(),
      update: jest.fn().mockReturnThis(),
      scan: jest.fn().mockReturnThis(),
      promise: jest.fn(),
    })),
  },
  S3: jest.fn(() => ({
    getObject: jest.fn().mockReturnThis(),
    putObject: jest.fn().mockReturnThis(),
    promise: jest.fn(),
  })),
  SES: jest.fn(() => ({})),
}));

jest.mock('../services/db', () => ({
  userDb: {
    getUserById: jest.fn(),
    getUserByEmail: jest.fn(),
    getAllUsers: jest.fn(),
  },
}));

jest.mock('../utils/secretsManager', () => ({
  getMetaAccessToken: jest.fn().mockResolvedValue('mock-token'),
  getSecret: jest.fn().mockResolvedValue('mock-secret'),
}));

const mockGetAgentRunsForSession = jest.fn().mockResolvedValue({ runs: [] });
jest.mock('../routes/agentRuns', () => {
  const express = require('express');
  const router = express.Router();
  router.get('/', (req: any, res: any) => {
    res.status(200).json({ ok: true, query: req.query, via: 'real-app' });
  });
  return { __esModule: true, default: router };
});

import request from 'supertest';
import app from '../app';
import { AGENT_RUNS_SECRET_HEADER, AW_AGENT_RUNS_SECRET_ENV } from '../middleware/agentRunsAuth';

const SECRET = 'mount-order-regression-secret';

describe('GET /api/admin/agent-runs — real app, real mount order', () => {
  const originalEnv = process.env[AW_AGENT_RUNS_SECRET_ENV];

  afterEach(() => {
    if (originalEnv === undefined) delete process.env[AW_AGENT_RUNS_SECRET_ENV];
    else process.env[AW_AGENT_RUNS_SECRET_ENV] = originalEnv;
  });

  it('reaches the D78 gate — a correct secret authenticates without any admin session, even under the catch-all /api/admin router', async () => {
    process.env[AW_AGENT_RUNS_SECRET_ENV] = SECRET;

    const res = await request(app)
      .get('/api/admin/agent-runs')
      .set(AGENT_RUNS_SECRET_HEADER, SECRET)
      .query({ sessionId: 'abc123' });

    // Before the fix this was 401 "No token provided" from the catch-all adminRoutes
    // router's blanket authenticateToken, mounted earlier and never reaching this gate.
    expect(res.status).toBe(200);
    expect(res.body.via).toBe('real-app');
  });

  it('a wrong secret still fails closed, and never falls through to a real admin session check', async () => {
    process.env[AW_AGENT_RUNS_SECRET_ENV] = SECRET;

    const res = await request(app)
      .get('/api/admin/agent-runs')
      .set(AGENT_RUNS_SECRET_HEADER, 'not-the-secret')
      .query({ sessionId: 'abc123' });

    expect(res.status).toBe(401);
  });

  it('no header at all still requires real admin auth, unchanged from before D78', async () => {
    delete process.env[AW_AGENT_RUNS_SECRET_ENV];

    const res = await request(app).get('/api/admin/agent-runs').query({ sessionId: 'abc123' });

    expect(res.status).toBe(401);
    expect(res.body.message).toBe('No token provided');
  });
});
