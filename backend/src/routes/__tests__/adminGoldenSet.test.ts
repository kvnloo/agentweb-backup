/**
 * ENG-2135: the golden-set labelling routes are admin-only (real isAdmin middleware, so a
 * delegated session is refused too) and inert until the store is provisioned.
 */

import express, { type NextFunction, type Request, type Response } from 'express';
import request from 'supertest';
import { newCreativePairCase, newGoldenCase } from '../../loops/eval/goldenSet';
import { createGoldenSetStore, GoldenCaseNotFoundError, type GoldenSetStore } from '../../loops/eval/goldenSetStore';

interface TestUser {
  userId: string;
  email: string;
  isAdmin?: boolean;
}

// Authentication is the only boundary faked: the test header stands in for a verified JWT.
jest.mock('../../middleware/auth', () => ({
  authenticateToken: (req: Request & { user?: TestUser; delegateInfo?: { isDelegated: boolean } }, res: Response, next: NextFunction) => {
    const header = req.header('x-test-user');
    if (!header) {
      res.status(401).json({ message: 'Access token required' });
      return;
    }
    const parsed = JSON.parse(header) as TestUser & { delegated?: boolean };
    req.user = { userId: parsed.userId, email: parsed.email, isAdmin: parsed.isAdmin };
    if (parsed.delegated) req.delegateInfo = { isDelegated: true };
    next();
  },
}));
jest.mock('../../services/adminAuditLog', () => ({ recordAdminAudit: jest.fn() }));

import { recordAdminAudit } from '../../services/adminAuditLog';
import { createAdminGoldenSetRouter } from '../adminGoldenSet';

const ADMIN = JSON.stringify({ userId: 'admin-1', email: 'admin@example.com', isAdmin: true });
const CUSTOMER = JSON.stringify({ userId: 'user-1', email: 'user@example.com', isAdmin: false });
const DELEGATED = JSON.stringify({ userId: 'user-1', email: 'user@example.com', isAdmin: true, delegated: true });

const NOW = new Date('2026-09-25T00:00:00.000Z');
const CASE = newGoldenCase({ surface: 'agent', taskType: 'fp_catalogue', sourceId: 'session-1', seedSource: 'fp_catalogue:ENG-972', now: NOW });

function fakeStore(overrides: Partial<GoldenSetStore> = {}): jest.Mocked<GoldenSetStore> {
  return {
    tableName: 'T',
    isProvisioned: jest.fn(() => true),
    getCase: jest.fn(async (id: string) => (id === CASE.caseId ? CASE : null)),
    listCases: jest.fn(async () => [CASE]),
    createCase: jest.fn(async () => 'created' as const),
    saveLabels: jest.fn(async (_id, update, labeller) => ({ ...CASE, labels: update.labels, labeller, version: update.expectedVersion + 1 })),
    setExclusion: jest.fn(async (id, exclusion) => {
      if (id !== CASE.caseId) throw new GoldenCaseNotFoundError(id);
      return exclusion ? { ...CASE, excluded: exclusion } : CASE;
    }),
    ...overrides,
  } as jest.Mocked<GoldenSetStore>;
}

function app(store: GoldenSetStore) {
  const a = express();
  a.use(express.json());
  a.use('/api/admin/eval/golden-cases', createAdminGoldenSetRouter(() => store));
  return a;
}

const base = '/api/admin/eval/golden-cases';
const labelsPath = `${base}/${encodeURIComponent(CASE.caseId)}/labels`;

describe('admin golden-set routes: auth', () => {
  it.each([
    ['GET', `${base}/status`],
    ['GET', `${base}?surface=agent`],
    ['GET', `${base}/${encodeURIComponent(CASE.caseId)}`],
    ['PUT', labelsPath],
  ])('%s %s: 401 without a token, 403 for a customer and for a delegated session', async (method, path) => {
    const store = fakeStore();
    const send = (user?: string) => {
      const r = method === 'GET' ? request(app(store)).get(path) : request(app(store)).put(path).send({ labels: {}, expectedVersion: 0 });
      return user ? r.set('x-test-user', user) : r;
    };
    expect((await send()).status).toBe(401);
    expect((await send(CUSTOMER)).status).toBe(403);
    expect((await send(DELEGATED)).status).toBe(403);
    expect(store.getCase).not.toHaveBeenCalled();
    expect(store.listCases).not.toHaveBeenCalled();
    expect(store.saveLabels).not.toHaveBeenCalled();
  });
});

describe('admin golden-set routes: behaviour', () => {
  it('lists a surface (optionally one split) for an admin and validates the query', async () => {
    const store = fakeStore();
    const ok = await request(app(store)).get(`${base}?surface=agent&split=test`).set('x-test-user', ADMIN);
    expect(ok.status).toBe(200);
    expect(ok.body.cases).toEqual([CASE]);
    expect(store.listCases).toHaveBeenCalledWith('agent', { split: 'test' });
    expect((await request(app(store)).get(`${base}?surface=ads`).set('x-test-user', ADMIN)).status).toBe(400);
    expect((await request(app(store)).get(`${base}?surface=agent&split=train`).set('x-test-user', ADMIN)).status).toBe(400);
  });

  it('lists excluded cases only when asked (ENG-2608)', async () => {
    const store = fakeStore();
    await request(app(store)).get(`${base}?surface=agent&includeExcluded=true`).set('x-test-user', ADMIN);
    expect(store.listCases).toHaveBeenCalledWith('agent', { includeExcluded: true });
    expect((await request(app(store)).get(`${base}?surface=agent&includeExcluded=yes`).set('x-test-user', ADMIN)).status).toBe(400);
  });

  it('excludes a case with a reason as the admin, and restores it (ENG-2608)', async () => {
    const store = fakeStore();
    const path = `${base}/${encodeURIComponent(CASE.caseId)}/exclusion`;
    const res = await request(app(store)).put(path).set('x-test-user', ADMIN).send({ reason: 'empty_session' });
    expect(res.status).toBe(200);
    expect(store.setExclusion).toHaveBeenCalledWith(CASE.caseId, { reason: 'empty_session', by: 'admin@example.com', at: expect.any(String) });
    expect(res.body.case.excluded).toMatchObject({ reason: 'empty_session', by: 'admin@example.com' });

    const restored = await request(app(store)).delete(path).set('x-test-user', ADMIN);
    expect(restored.status).toBe(200);
    expect(store.setExclusion).toHaveBeenLastCalledWith(CASE.caseId, null);

    expect((await request(app(store)).put(path).set('x-test-user', ADMIN).send({})).status).toBe(400);
    expect((await request(app(store)).put(path).set('x-test-user', ADMIN).send({ reason: 'x'.repeat(201) })).status).toBe(400);
    expect((await request(app(store)).put(`${base}/nope/exclusion`).set('x-test-user', ADMIN).send({ reason: 'empty_session' })).status).toBe(404);
    expect((await request(app(store)).put(path).set('x-test-user', CUSTOMER).send({ reason: 'empty_session' })).status).toBe(403);
  });

  it('audits each exclude and restore, keeping who excluded the case once it is restored (ENG-2608)', async () => {
    (recordAdminAudit as jest.Mock).mockClear();
    const exclusion = { reason: 'empty_session', by: 'other-admin@example.com', at: '2026-10-01T00:00:00.000Z' };
    const store = fakeStore();
    (store.getCase as jest.Mock).mockResolvedValue({ ...CASE, excluded: exclusion });
    const path = `${base}/${encodeURIComponent(CASE.caseId)}/exclusion`;

    await request(app(store)).put(path).set('x-test-user', ADMIN).send({ reason: 'empty_session' });
    expect(recordAdminAudit).toHaveBeenLastCalledWith({
      actorUserId: 'admin-1', actorEmail: 'admin@example.com', action: 'golden_case_exclude', caseId: CASE.caseId, reason: 'empty_session',
    });

    await request(app(store)).delete(path).set('x-test-user', ADMIN);
    expect(recordAdminAudit).toHaveBeenLastCalledWith({
      actorUserId: 'admin-1', actorEmail: 'admin@example.com', action: 'golden_case_restore', caseId: CASE.caseId, previousExclusion: exclusion,
    });

    await request(app(store)).put(`${base}/nope/exclusion`).set('x-test-user', ADMIN).send({ reason: 'empty_session' });
    expect(recordAdminAudit).toHaveBeenCalledTimes(2);
  });

  it('answers 400, not 500, for a case id longer than DynamoDB allows, before touching the store (ENG-2608)', async () => {
    const store = fakeStore();
    const long = encodeURIComponent('x'.repeat(2049));
    expect((await request(app(store)).put(`${base}/${long}/exclusion`).set('x-test-user', ADMIN).send({ reason: 'empty_session' })).status).toBe(400);
    expect((await request(app(store)).delete(`${base}/${long}/exclusion`).set('x-test-user', ADMIN)).status).toBe(400);
    expect((await request(app(store)).get(`${base}/${long}`).set('x-test-user', ADMIN)).status).toBe(400);
    expect(store.setExclusion).not.toHaveBeenCalled();
    expect(store.getCase).not.toHaveBeenCalled();
  });

  it('saves labels as the admin, validating them against the case surface', async () => {
    const store = fakeStore();
    const res = await request(app(store)).put(labelsPath).set('x-test-user', ADMIN).send({ labels: { task_success: 'fail' }, notes: 'claimed publish', expectedVersion: 0 });
    expect(res.status).toBe(200);
    expect(res.body.case).toMatchObject({ labels: { task_success: 'fail' }, labeller: 'admin@example.com', version: 1 });
    expect(store.saveLabels).toHaveBeenCalledWith(CASE.caseId, { labels: { task_success: 'fail' }, notes: 'claimed publish', expectedVersion: 0 }, 'admin@example.com');

    const bad = await request(app(store)).put(labelsPath).set('x-test-user', ADMIN).send({ labels: { hook: 'pass' }, expectedVersion: 0 });
    expect(bad.status).toBe(400);
    expect(bad.body.message).toMatch(/not a agent criterion/);
    const missing = await request(app(store)).put(`${base}/nope/labels`).set('x-test-user', ADMIN).send({ labels: {}, expectedVersion: 0 });
    expect(missing.status).toBe(404);
  });

  it('saves an A / B / tie choice on a pairwise calibration case through the same route (ENG-2142)', async () => {
    const pair = newCreativePairCase({
      candidateIdA: 'cand-a',
      pair: { candidateIdB: 'cand-b', batch: '2026-W39', position: 0, batchSize: 20, category: 'ad', placement: 'unknown', signal: 'unscored' },
      now: NOW,
    });
    const store = fakeStore({
      getCase: jest.fn(async (id: string) => (id === pair.caseId ? pair : null)),
      saveLabels: jest.fn(async (_id, update, labeller) => ({ ...pair, labels: update.labels, labeller, version: 1 })),
    });
    const path = `${base}/${encodeURIComponent(pair.caseId)}/labels`;
    const res = await request(app(store)).put(path).set('x-test-user', ADMIN).send({ labels: { pairwise_preference: 'B' }, notes: 'clearer offer', expectedVersion: 0 });
    expect(res.status).toBe(200);
    expect(store.saveLabels).toHaveBeenCalledWith(pair.caseId, { labels: { pairwise_preference: 'B' }, notes: 'clearer offer', expectedVersion: 0 }, 'admin@example.com');

    const binary = await request(app(store)).put(path).set('x-test-user', ADMIN).send({ labels: { pairwise_preference: 'pass' }, expectedVersion: 0 });
    expect(binary.status).toBe(400);
    const single = await request(app(store)).put(path).set('x-test-user', ADMIN).send({ labels: { hook: 'pass' }, expectedVersion: 0 });
    expect(single.status).toBe(400);
    expect(store.saveLabels).toHaveBeenCalledTimes(1);
    expect((await request(app(store)).put(path).set('x-test-user', CUSTOMER).send({ labels: { pairwise_preference: 'A' }, expectedVersion: 0 })).status).toBe(403);
  });

  it('answers 409 when the case changed since the labeller loaded it', async () => {
    const store = createGoldenSetStore({
      tableName: 'T',
      db: {
        get: jest.fn(async () => ({ Item: CASE })),
        put: jest.fn(),
        query: jest.fn(),
        update: jest.fn(async () => {
          throw Object.assign(new Error('conditional'), { code: 'ConditionalCheckFailedException' });
        }),
      },
    });
    const res = await request(app(store)).put(labelsPath).set('x-test-user', ADMIN).send({ labels: { task_success: 'pass' }, expectedVersion: 0 });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('version_conflict');
  });

  it('is inert with a clear 503 until the store is provisioned (status still answers)', async () => {
    const store = createGoldenSetStore({ tableName: null });
    const status = await request(app(store)).get(`${base}/status`).set('x-test-user', ADMIN);
    expect(status.status).toBe(200);
    expect(status.body.provisioned).toBe(false);
    expect(status.body.criteria.agent).toContain('task_success');

    for (const r of [
      request(app(store)).get(`${base}?surface=agent`),
      request(app(store)).get(`${base}/${encodeURIComponent(CASE.caseId)}`),
      request(app(store)).put(labelsPath).send({ labels: {}, expectedVersion: 0 }),
    ]) {
      const res = await r.set('x-test-user', ADMIN);
      expect(res.status).toBe(503);
      expect(res.body.error).toBe('golden_set_store_not_provisioned');
      expect(res.body.message).toMatch(/EVAL_GOLDEN_CASES_TABLE/);
    }
  });
});
