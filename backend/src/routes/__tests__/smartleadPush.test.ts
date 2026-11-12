import express from 'express';
import request from 'supertest';

jest.mock('../../middleware/auth', () => ({
  authenticateToken: jest.fn((req: any, _res: any, next: any) => {
    req.user = { userId: req.headers['x-test-user'] || 'user-123' };
    next();
  }),
}));

const svc = {
  campaigns: jest.fn(), campaignStats: jest.fn(), preview: jest.fn(), start: jest.fn(), history: jest.fn(), status: jest.fn(), pause: jest.fn(), resume: jest.fn(), cancel: jest.fn(), release: jest.fn(),
};
jest.mock('../../services/smartleadPushRuntime', () => ({ getSmartleadPushService: () => svc }));

import smartleadPushRouter from '../smartleadPush';

const app = () => {
  const a = express();
  a.use(express.json());
  a.use('/api/crm/smartlead-push', smartleadPushRouter);
  return a;
};
const base = '/api/crm/smartlead-push';
let nextUser = 0;
const user = () => `user-${++nextUser}`;

describe('Smartlead push routes (ENG-673)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('passes the authenticated user, never one from the body, and returns the service result', async () => {
    svc.preview.mockResolvedValue({ ok: true, preview: { token: 't' } });
    const res = await request(app()).post(`${base}/preview`).set('x-test-user', 'u-9').send({ listId: 'L', campaignId: 5, userId: 'someone-else' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ preview: { token: 't' } });
    expect(svc.preview).toHaveBeenCalledWith('u-9', expect.objectContaining({ listId: 'L', campaignId: 5 }));
  });

  it('campaign stats: the authenticated user, a numeric campaign id, the optional connection', async () => {
    svc.campaignStats.mockResolvedValue({ ok: true, connection: { accountId: 'a' }, stats: { campaignId: 7 } });
    const res = await request(app()).get(`${base}/campaigns/7/stats?accountId=acc-1`).set('x-test-user', 'u-7');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ connection: { accountId: 'a' }, stats: { campaignId: 7 } });
    expect(svc.campaignStats).toHaveBeenCalledWith('u-7', 7, 'acc-1');
  });

  it.each(['0', 'abc', '1.5', '-3', '1234567890123456'])('campaign stats refuses campaign id %s without calling Smartlead', async (id) => {
    const res = await request(app()).get(`${base}/campaigns/${id}/stats`).set('x-test-user', user());
    expect(res.status).toBe(400);
    expect(svc.campaignStats).not.toHaveBeenCalled();
  });

  it('ignores a user id in the body on start too', async () => {
    svc.start.mockResolvedValue({ ok: true, started: true, run: { runId: 'r' } });
    await request(app()).post(`${base}/start`).set('x-test-user', 'real-user').send({ token: 'x', userId: 'evil', pushedBy: 'evil' });
    expect(svc.start.mock.calls[0][0]).toBe('real-user');
  });

  it('answers 202 when a run started, 200 when one is already live', async () => {
    svc.start.mockResolvedValueOnce({ ok: true, started: true, run: { runId: 'r1' } });
    const a = await request(app()).post(`${base}/start`).set('x-test-user', user()).send({ token: 'x' });
    expect(a.status).toBe(202);
    expect(a.body).toEqual({ started: true, run: { runId: 'r1' } });
    svc.start.mockResolvedValueOnce({ ok: true, started: false, run: { runId: 'r0' } });
    const b = await request(app()).post(`${base}/start`).set('x-test-user', user()).send({ token: 'x' });
    expect(b.status).toBe(200);
    expect(b.body.started).toBe(false);
  });

  it.each([
    [403, 'forbidden', 'You need edit access.'],
    [409, 'sequence_changed', 'The sequence changed.'],
    [503, 'unavailable', 'Temporarily unavailable.'],
  ])('turns a failed result into HTTP %i with a message and a code', async (status, code, message) => {
    svc.status.mockResolvedValue({ ok: false, status, code, message });
    const res = await request(app()).get(`${base}/runs/r1`).set('x-test-user', user());
    expect(res.status).toBe(status);
    expect(res.body).toEqual({ error: message, code });
  });

  it('carries blocking details through', async () => {
    svc.start.mockResolvedValue({ ok: false, status: 409, code: 'blocked', message: 'No.', details: [{ code: 'unknown_tag' }] });
    const res = await request(app()).post(`${base}/start`).set('x-test-user', user()).send({ token: 'x' });
    expect(res.body.details).toEqual([{ code: 'unknown_tag' }]);
  });

  it.each([
    ['get', '/campaigns', 'campaigns'], ['get', '/lists/L1/runs', 'history'], ['get', '/runs/r1', 'status'],
    ['post', '/runs/r1/pause', 'pause'], ['post', '/runs/r1/resume', 'resume'], ['post', '/runs/r1/cancel', 'cancel'],
  ])('%s %s calls the service as the authenticated user', async (method, path, fn) => {
    (svc as any)[fn].mockResolvedValue({ ok: true });
    const res = await (request(app()) as any)[method](`${base}${path}`).set('x-test-user', 'u-7');
    expect(res.status).toBe(200);
    expect((svc as any)[fn].mock.calls[0][0]).toBe('u-7');
  });

  it('release passes the authenticated user (never one from the body) and is rate limited per user', async () => {
    svc.release.mockResolvedValue({ ok: true, released: 2, skipped: { notFound: 0, nothingToRelease: 0 } });
    const u = user();
    const res = await request(app()).post(`${base}/leads/release`).set('x-test-user', u).send({ listId: 'L', leadIds: ['a'], userId: 'evil' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ released: 2 });
    expect(svc.release.mock.calls[0][0]).toBe(u);
    for (let i = 0; i < 29; i++) await request(app()).post(`${base}/leads/release`).set('x-test-user', u).send({ listId: 'L', leadIds: ['a'] });
    expect((await request(app()).post(`${base}/leads/release`).set('x-test-user', u).send({ listId: 'L', leadIds: ['a'] })).status).toBe(429);
  });

  it('hides an unexpected error behind a generic 500 and never leaks it', async () => {
    svc.preview.mockRejectedValue(new Error('boom api_key=SECRETKEY999 at /srv/secret/path.ts'));
    const res = await request(app()).post(`${base}/preview`).set('x-test-user', user()).send({});
    expect(res.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toMatch(/SECRETKEY999|secret\/path/);
    expect(JSON.stringify((console.error as jest.Mock).mock.calls)).not.toContain('SECRETKEY999');
  });

  it('limits starts per user (10 in 15 minutes) without affecting other users', async () => {
    svc.start.mockResolvedValue({ ok: true, started: true, run: { runId: 'r' } });
    const u = user();
    for (let i = 0; i < 10; i++) expect((await request(app()).post(`${base}/start`).set('x-test-user', u).send({ token: 'x' })).status).toBe(202);
    const limited = await request(app()).post(`${base}/start`).set('x-test-user', u).send({ token: 'x' });
    expect(limited.status).toBe(429);
    expect(limited.body.code).toBe('rate_limited');
    expect((await request(app()).post(`${base}/start`).set('x-test-user', user()).send({ token: 'x' })).status).toBe(202);
  });

  it('limits campaign listing per user, because it spends the customer\'s own Smartlead API budget', async () => {
    svc.campaigns.mockResolvedValue({ ok: true, campaigns: [] });
    const u = user();
    for (let i = 0; i < 30; i++) await request(app()).get(`${base}/campaigns`).set('x-test-user', u);
    expect((await request(app()).get(`${base}/campaigns`).set('x-test-user', u)).status).toBe(429);
  });

  it('limits previews per user (30 in 15 minutes)', async () => {
    svc.preview.mockResolvedValue({ ok: true, preview: {} });
    const u = user();
    for (let i = 0; i < 30; i++) await request(app()).post(`${base}/preview`).set('x-test-user', u).send({});
    expect((await request(app()).post(`${base}/preview`).set('x-test-user', u).send({})).status).toBe(429);
  });
});
