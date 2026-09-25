/**
 * ENG-2135: the golden-set labelling routes are admin-only (real isAdmin middleware, so a
 * delegated session is refused too) and inert until the store is provisioned.
 */

import express, { type NextFunction, type Request, type Response } from 'express';
import request from 'supertest';
import { newGoldenCase } from '../../loops/eval/goldenSet';
import { createGoldenSetStore, type GoldenSetStore } from '../../loops/eval/goldenSetStore';

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
