/**
 * ENG-2144: GET /api/admin/loops/eval-v2-trend — admin-only, and every grader it reports is
 * labelled with its registry validation state (unvalidated today).
 *
 * The router is mounted the way app.ts mounts it (behind authentication and the real isAdmin
 * middleware); authentication itself is stubbed from a test header.
 */
import express, { type NextFunction, type Request, type Response } from 'express';
import request from 'supertest';

import { isAdmin } from '../middleware/admin';
import type { AuthRequest } from '../types/express';
import type { DynamoAttributeMap, DynamoPort } from '../loops/core/ports';
import { aggregateEvalV2, buildSnapshotItem } from '../loops/eval/evalV2Sampler';
import { awsDynamoAdapter } from '../loops/adapters/awsAdapters';
import loopHealthRouter from '../routes/loopHealth';
import { CREATIVE_GATES_VERSION } from '../services/creativeGates';

jest.mock('../loops/adapters/awsAdapters', () => ({ awsDynamoAdapter: jest.fn() }));
jest.mock('../loops/health/loopHealthService', () => ({ getLoopHealthReport: jest.fn() }));

const snapshotRows: DynamoAttributeMap[] = [
  buildSnapshotItem(aggregateEvalV2([{
    sessionId: 's', sampleDate: '2026-09-24', surface: 'agent/regular', model: 'm', taskType: 'ads',
    taskVerdict: 'success', toolVerdict: 'pass', toolCalls: 2, groundednessVerdict: 'grounded', graderVersions: { 'agent-task-success': 1 },
  }], { date: '2026-09-24', windowLabel: '7d', now: new Date('2026-09-25T17:15:00Z') })),
];

const fakeDynamo: DynamoPort = {
  putItem: jest.fn(),
  getItem: jest.fn(),
  query: jest.fn(async () => ({ items: snapshotRows })),
};

type TestUser = { userId: string; isAdmin: boolean; delegated?: boolean };

/** Stand-in for authenticateToken: the user comes from a test header. */
function fakeAuth(req: Request, res: Response, next: NextFunction) {
  const raw = req.header('x-test-user');
  if (!raw) return res.status(401).json({ message: 'No token' });
  const user = JSON.parse(raw) as TestUser;
  const authReq = req as AuthRequest & { delegateInfo?: { isDelegated: boolean } };
  (authReq as unknown as { user: TestUser }).user = user;
  if (user.delegated) authReq.delegateInfo = { isDelegated: true };
  return next();
}

function makeApp() {
  const app = express();
  app.use('/api/admin/loops', fakeAuth, isAdmin, loopHealthRouter);
  return app;
}

const get = (user?: TestUser) => {
  const r = request(makeApp()).get('/api/admin/loops/eval-v2-trend');
  return user ? r.set('x-test-user', JSON.stringify(user)) : r;
};

describe('GET /api/admin/loops/eval-v2-trend', () => {
  beforeEach(() => {
    jest.mocked(awsDynamoAdapter).mockReturnValue(fakeDynamo);
    delete process.env.EVAL_V2_SAMPLER_ENABLED;
  });

  it('rejects an unauthenticated request', async () => {
    expect((await get()).status).toBe(401);
    expect(fakeDynamo.query).not.toHaveBeenCalled();
  });

  it('rejects a non-admin and a delegated session', async () => {
    expect((await get({ userId: 'u', isAdmin: false })).status).toBe(403);
    expect((await get({ userId: 'a', isAdmin: true, delegated: true })).status).toBe(403);
    expect(fakeDynamo.query).not.toHaveBeenCalled();
  });

  it('serves the trend to an admin with n, CI and every grader marked unvalidated', async () => {
    const res = await get({ userId: 'a', isAdmin: true });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ windowLabel: '7d', samplerEnabled: false, count: 1, hasData: true });
    expect(res.body.graders.map((g: { id: string; mayGate: boolean }) => [g.id, g.mayGate])).toEqual([
      ['agent-task-success', false],
      ['agent-tool-correctness', false],
      ['agent-groundedness-offline', false],
      ['agent-reply-length-adherence', false],
      ['agent-format-adherence', false],
      ['agent-act-without-asking', false],
    ]);
    const metric = res.body.snapshots[0].groups[0].metrics[0];
    expect(metric).toMatchObject({ graderId: 'agent-task-success', n: 1, passes: 1, mayGate: false });
    expect(metric.ci.low).toBeGreaterThan(0);
    expect(metric.ci.high).toBe(1);
  });

  it('serves the creative and account-health snapshots and every registry grader with its version (ENG-2196)', async () => {
    const res = await get({ userId: 'a', isAdmin: true });
    expect(res.body.creative).toEqual([]);
    expect(res.body.accountHealth).toEqual([]);
    const registry = res.body.registry as Array<{ id: string; surface: string; version: string; mayGate: boolean }>;
    expect(registry.length).toBeGreaterThan(20);
    expect(registry.every((g) => typeof g.version === 'string' && g.version.length > 0 && g.mayGate === false)).toBe(true);
    expect(registry.find((g) => g.id === 'creative-deterministic-gates')).toMatchObject({ surface: 'creative', version: CREATIVE_GATES_VERSION });
  });

  it('reads the 1d window on request and reports the sampler flag', async () => {
    process.env.EVAL_V2_SAMPLER_ENABLED = 'true';
    const res = await get({ userId: 'a', isAdmin: true }).query({ window: '1d' });
    expect(res.body).toMatchObject({ windowLabel: '1d', samplerEnabled: true, count: 0, hasData: false });
  });
});
