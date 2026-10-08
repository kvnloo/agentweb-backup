/**
 * ENG-2315 — the PUBLIC ingest: anonymous + CORS-open, so every gate is a contract.
 * crmDb is mocked at the module boundary; the route, parser, limiter and shared upsert are real.
 */
import request from 'supertest';
import express from 'express';
import { crmDb } from '../../services/db';
import { createTrackIngestRouter, createIngestRateLimiter, createIngestIpRateLimiter, trackBodyParser } from '../trackIngest';
import { ingestListCache } from '../../utils/ingestListCache';
import { sessionLeadId } from '../../utils/sessionList';

jest.mock('../../services/db', () => ({
  crmDb: { getLeadListById: jest.fn(), getLeadById: jest.fn(), createLead: jest.fn(), mergeSessionLeadEvent: jest.fn() },
}));

const LIST_ID = 'list_1790938330308_abc';
const SID = 'abcd1234-ef56-7890';
const ORIGIN = 'https://go.example.com';
const CHROME = 'Mozilla/5.0 (Windows NT 10.0) Chrome/120';

function makeApp(limit?: number, ipLimit?: number) {
  const app = express();
  app.set('trust proxy', 2);
  // Same order as app.ts: the 16kb parser first.
  app.use('/api/track/event', ...trackBodyParser);
  app.use('/api/track', createTrackIngestRouter({ rateLimiter: createIngestRateLimiter({ limit: limit ?? 1000 }), ipRateLimiter: createIngestIpRateLimiter({ limit: ipLimit ?? 100000 }) }));
  return app;
}
const sessionList = (over: Record<string, any> = {}) => ({
  listId: LIST_ID, userId: 'u1', listType: 'session', publicAccessEnabled: true,
  trackingConfig: { allowedOrigins: [ORIGIN], pageLabel: 'Guilty v2' }, ...over,
});
const event = (over: Record<string, any> = {}) => ({
  listId: LIST_ID, event: 'lp_view', sessionId: SID, sessionStartMs: Date.now() - 5000, eventCount: 1,
  landingUrl: 'https://go.example.com/p?utm_source=instagram&utm_medium=bio', referrer: '', ...over,
});
const post = (app: express.Express, body: unknown, headers: Record<string, string> = {}) =>
  request(app).post('/api/track/event').set('User-Agent', CHROME).set('Origin', ORIGIN).set(headers)
    .set('Content-Type', 'text/plain;charset=UTF-8').send(typeof body === 'string' ? body : JSON.stringify(body));

describe('POST /api/track/event: segment routing (ENG-2316)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    ingestListCache.clear(); // ENG-2325: the ingest caches the list row; every test starts cold
    (crmDb.createLead as jest.Mock).mockImplementation(async (_l: string, d: any) => ({ ...d }));
    (crmDb.getLeadListById as jest.Mock).mockImplementation(async (id: string) => id === LIST_ID
      ? sessionList({ trackingConfig: { allowedOrigins: [ORIGIN], routing: [{ id: 'organic', match: { trafficType: 'organic' }, childListId: 'list_child_org1' }] } })
      : { listId: id, userId: 'u1', listType: 'session' });
  });

  it('an organic session is copied to the child through the public route; the response is still 204', async () => {
    const res = await post(makeApp(), event());
    expect(res.status).toBe(204);
    expect((crmDb.createLead as jest.Mock).mock.calls.map((c) => c[0]).sort()).toEqual(['list_child_org1', LIST_ID].sort());
  });

  it('a paid session is not', async () => {
    const res = await post(makeApp(), event({ landingUrl: 'https://go.example.com/p?utm_medium=paid&fbclid=Z' }));
    expect(res.status).toBe(204);
    expect((crmDb.createLead as jest.Mock).mock.calls.map((c) => c[0])).toEqual([LIST_ID]);
  });

  it('a failing child never turns the response into an error', async () => {
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    (crmDb.createLead as jest.Mock).mockImplementation(async (l: string, d: any) => { if (l === 'list_child_org1') throw new Error('boom'); return { ...d }; });
    expect((await post(makeApp(), event())).status).toBe(204);
  });
});

describe('POST /api/track/event', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    ingestListCache.clear(); // ENG-2325: the ingest caches the list row; every test starts cold
    (crmDb.getLeadListById as jest.Mock).mockResolvedValue(sessionList());
    (crmDb.createLead as jest.Mock).mockImplementation(async (_l: string, d: any) => ({ ...d }));
    (crmDb.mergeSessionLeadEvent as jest.Mock).mockResolvedValue({ exists: true, changed: true, guardApplied: true });
  });

  it('happy path: 204 with open CORS, one conditional create on the deterministic id, no lead side effects', async () => {
    const app = makeApp();
    const b = event();
    const res = await post(app, b, { 'X-Forwarded-For': '203.0.113.9, 10.0.0.1' });

    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe('*');
    expect(crmDb.createLead).toHaveBeenCalledTimes(1);
    const [listId, lead] = (crmDb.createLead as jest.Mock).mock.calls[0];
    expect(listId).toBe(LIST_ID);
    expect(lead).toMatchObject({
      leadId: sessionLeadId(LIST_ID, { sessionId: SID, sessionStartMs: b.sessionStartMs }),
      failIfExists: true, skipEmailDuplicateCheck: true, suppressSideEffects: true,
      clientIp: '203.0.113.9', clientUserAgent: CHROME,
    });
    expect(lead).not.toHaveProperty('email'); // a session row has no synthetic address
    expect(lead.customFields).toMatchObject({
      sessionId: SID, sessionStartMs: b.sessionStartMs, source: 'tracker-sdk', page: 'Guilty v2',
      channel: 'Instagram', trafficType: 'organic', lp_view_at: expect.any(String), eventCount: 1,
    });
  });

  it.each([['+3d', 3 * 24 * 3600_000], ['-3d', -3 * 24 * 3600_000], ['+10min', 10 * 60_000]])(
    'ENG-2324: a device clock %s off is accepted (204) and every event of the session targets ONE row id, time-prefixed within the last 24h', async (_l, skew) => {
      (crmDb.getLeadById as jest.Mock).mockResolvedValue(null);
      const app = makeApp();
      const start = Date.now() + skew;
      for (const ev of ['lp_view', 'play_start', 'click', 'page_exit']) {
        expect((await post(app, event({ event: ev, sessionStartMs: start }))).status).toBe(204);
      }
      const ids = new Set((crmDb.createLead as jest.Mock).mock.calls.map(([, d]) => d.leadId));
      expect(ids.size).toBe(1);
      const prefix = Number([...ids][0].split('_')[1]);
      expect(prefix).toBeLessThanOrEqual(Date.now());
      expect(prefix).toBeGreaterThan(Date.now() - 24 * 3600_000);
      expect((crmDb.createLead as jest.Mock).mock.calls[0][1].customFields.sessionStartMs).toBe(prefix);
    });

  it('ENG-2324: an in-window event never pays the extra substitute probe read', async () => {
    await post(makeApp(), event());
    expect(crmDb.getLeadById).not.toHaveBeenCalled();
  });

  it('a later event for the same session takes the atomic merge, not a second row', async () => {
    (crmDb.createLead as jest.Mock).mockRejectedValue(Object.assign(new Error('exists'), { leadAlreadyExists: true }));
    const res = await post(makeApp(), event({ event: 'page_exit', dwellSec: 42, eventCount: 3 }));
    expect(res.status).toBe(204);
    const [, , plan] = (crmDb.mergeSessionLeadEvent as jest.Mock).mock.calls[0];
    expect(plan.customFields).toMatchObject({ dwellSec: 42, page_exit_at: expect.any(String) });
    expect(plan.monotonic).toMatchObject({ counterKey: 'eventCount', counter: 3 });
  });

  it('"latest state" fields ride the eventCount guard, so an out-of-order older event cannot regress them', async () => {
    (crmDb.createLead as jest.Mock).mockRejectedValue(Object.assign(new Error('exists'), { leadAlreadyExists: true }));
    await post(makeApp(), event({ event: 'play_start', eventCount: 2, furthestStage: 'play_start', journey: 'lp_view > play_start' }));
    const [, , plan] = (crmDb.mergeSessionLeadEvent as jest.Mock).mock.calls[0];
    expect(Object.keys(plan.monotonic.fields)).toEqual(expect.arrayContaining(['journey', 'eventCount', 'lastEvent', 'furthestStage']));
    expect(plan.customFields).not.toHaveProperty('lastEvent');
    expect(plan.customFields).toMatchObject({ play_start_at: expect.any(String) }); // plain scalars stay last-write-wins
  });

  it('OPTIONS preflight answers 204 with CORS headers and touches no data', async () => {
    const res = await request(makeApp()).options('/api/track/event').set('Origin', 'https://anything.test');
    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe('*');
    expect(crmDb.getLeadListById).not.toHaveBeenCalled();
  });

  describe('list gates (resolved from the DB row, never the body)', () => {
    it('unknown list -> 404', async () => {
      (crmDb.getLeadListById as jest.Mock).mockResolvedValue(null);
      expect((await post(makeApp(), event())).status).toBe(404);
      expect(crmDb.createLead).not.toHaveBeenCalled();
    });
    it.each([
      ['a sales list', { listType: 'sales' }],
      ['a list with no listType', { listType: undefined }],
      ['public access off', { publicAccessEnabled: false }],
      ['public access missing', { publicAccessEnabled: undefined }],
      ['public access truthy-but-not-true', { publicAccessEnabled: 'true' }],
    ])('refuses %s (403) and writes nothing', async (_l, over) => {
      (crmDb.getLeadListById as jest.Mock).mockResolvedValue(sessionList(over));
      const res = await post(makeApp(), event({ listType: 'session' })); // the body cannot opt in
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('tracking_not_enabled');
      expect(crmDb.createLead).not.toHaveBeenCalled();
      expect(crmDb.mergeSessionLeadEvent).not.toHaveBeenCalled();
    });
  });

  describe('Origin', () => {
    it.each([
      ['not in the list', 'https://evil.test'],
      ['a suffix trick', 'https://go.example.com.evil.test'],
      ['the opaque origin', 'null'],
      ['a different scheme', 'http://go.example.com'],
    ])('403 when Origin is %s', async (_l, origin) => {
      const res = await post(makeApp(), event(), { Origin: origin });
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('origin_not_allowed');
      expect(crmDb.createLead).not.toHaveBeenCalled();
    });

    it('empty or missing allowedOrigins denies every browser', async () => {
      for (const trackingConfig of [{ allowedOrigins: [] }, undefined, { allowedOrigins: 'https://go.example.com' }]) {
        (crmDb.getLeadListById as jest.Mock).mockResolvedValue(sessionList({ trackingConfig }));
        expect((await post(makeApp(), event())).status).toBe(403);
      }
      expect(crmDb.createLead).not.toHaveBeenCalled();
    });

    it('a request with NO Origin header (server-side caller) passes the origin gate', async () => {
      const res = await request(makeApp()).post('/api/track/event').set('User-Agent', CHROME).type('text/plain').send(JSON.stringify(event()));
      expect(res.status).toBe(204);
    });
  });

  describe('validation: 400, never a 500', () => {
    it.each([
      ['invalid JSON', '{not json'],
      ['a JSON array', '[1,2,3]'],
      ['a JSON string', '"hello"'],
      ['empty body', ''],
    ])('%s', async (_l, raw) => {
      const res = await post(makeApp(), raw);
      expect(res.status).toBe(400);
      expect(crmDb.createLead).not.toHaveBeenCalled();
    });

    it.each([
      ['unknown event', { event: 'purchase' }],
      ['bad session id', { sessionId: 'x' }],
      ['non-numeric sessionStartMs', { sessionStartMs: 'soon' }],
      ['missing listId', { listId: undefined }],
      ['custom without name', { event: 'custom' }],
    ])('rejects %s', async (_l, over) => {
      const res = await post(makeApp(), event(over));
      expect(res.status).toBe(400);
      expect(crmDb.getLeadListById).not.toHaveBeenCalled(); // rejected before any database read
    });

    it('a hostile payload (huge keys, wrong types, prototype keys) is bounded and stores nothing extra', async () => {
      const hostile: Record<string, any> = event({
        visitNo: { $gt: 0 }, eventCount: ['1'], journey: 'j'.repeat(5000), lpVariant: 'v'.repeat(2000),
        referrer: 'https://r.test/' + 'r'.repeat(2000), landingUrl: `https://go.example.com/?${'a=b&'.repeat(200)}`,
        props: 'nope', name: 7,
      });
      hostile['__proto__'] = { polluted: true };
      (hostile as any).constructor = { prototype: { polluted: true } };
      for (let i = 0; i < 40; i++) hostile[`junk_${i}_${'k'.repeat(100)}`] = 'x'.repeat(40);
      const raw = JSON.stringify(hostile);
      expect(raw.length).toBeLessThan(16 * 1024);

      const res = await post(makeApp(), raw);
      expect(res.status).toBe(204);
      const cf = (crmDb.createLead as jest.Mock).mock.calls[0][1].customFields;
      expect(Object.keys(cf).some((k) => k.startsWith('junk_'))).toBe(false);
      expect(cf).not.toHaveProperty('polluted');
      expect(({} as any).polluted).toBeUndefined();
      expect(String(cf.lpVariant).length).toBeLessThanOrEqual(80);
      expect(String(cf.journey ?? '').length).toBeLessThanOrEqual(3000);
      expect(cf.referrer.length).toBeLessThanOrEqual(300);
      expect(cf).not.toHaveProperty('visitNo');
      expect(cf).not.toHaveProperty('eventCount');
    });

    it('body over 16kb -> 413 before any database read', async () => {
      const res = await post(makeApp(), JSON.stringify(event({ journey: 'x'.repeat(17 * 1024) })));
      expect(res.status).toBe(413);
      expect(res.headers['access-control-allow-origin']).toBe('*');
      expect(crmDb.getLeadListById).not.toHaveBeenCalled();
    });
  });

  describe('rate limit (drops, per IP + list)', () => {
    it('429s past the limit for one IP+list, still 204s a different list and a different IP', async () => {
      const app = makeApp(3);
      for (let i = 0; i < 3; i++) expect((await post(app, event(), { 'X-Forwarded-For': '198.51.100.7' })).status).toBe(204);
      const limited = await post(app, event(), { 'X-Forwarded-For': '198.51.100.7' });
      expect(limited.status).toBe(429);
      expect(limited.headers['access-control-allow-origin']).toBe('*');
      const before = (crmDb.createLead as jest.Mock).mock.calls.length;

      // other list, same IP: its own budget
      (crmDb.getLeadListById as jest.Mock).mockResolvedValue(sessionList({ listId: 'list_other_123456' }));
      expect((await post(app, event({ listId: 'list_other_123456' }), { 'X-Forwarded-For': '198.51.100.7' })).status).toBe(204);
      expect((crmDb.createLead as jest.Mock).mock.calls.length).toBe(before + 1);
    });

    it('is keyed on the proxy-trusted address, not on a client-chosen X-Forwarded-For first hop', async () => {
      const app = makeApp(2);
      // Production chain is "<whatever the client sent>, <client as the ALB saw it>, <ALB>" and supertest is the
      // nginx hop: with trust proxy 2 the forged leftmost entry must not change the limiter key.
      const forged = (i: number) => ({ 'X-Forwarded-For': `${i}.${i}.${i}.${i}, 198.51.100.1, 10.0.0.9` });
      const statuses: number[] = [];
      for (let i = 1; i <= 5; i++) statuses.push((await post(app, event(), forged(i))).status);
      expect(statuses.filter((s) => s === 429).length).toBeGreaterThanOrEqual(1);
    });

    it('rotating listIds from ONE IP cannot dodge the limit: the IP-wide cap 429s before any list read', async () => {
      const app = makeApp(1000, 5);
      const ip = { 'X-Forwarded-For': '198.51.100.9, 198.51.100.9, 10.0.0.9' };
      const statuses: number[] = [];
      for (let i = 0; i < 12; i++) statuses.push((await post(app, event({ listId: `list_rotating_${i}` }), ip)).status);
      expect(statuses.filter((s) => s === 429)).toHaveLength(7);
      expect(statuses.slice(0, 5).every((s) => s !== 429)).toBe(true);
      expect(crmDb.getLeadListById).toHaveBeenCalledTimes(5); // the 7 dropped requests cost no database read
      // another address is unaffected
      expect((await post(app, event(), { 'X-Forwarded-For': '203.0.113.1, 203.0.113.1, 10.0.0.9' })).status).toBe(204);
    });

    it('never touches the lead-save route: the limiter lives only on /api/track/event', async () => {
      const app = makeApp(1);
      app.post('/api/webhooks/forward-lead', (_req, res) => { res.status(200).json({ ok: true }); });
      await post(app, event());
      expect((await post(app, event())).status).toBe(429);
      expect((await request(app).post('/api/webhooks/forward-lead').send({})).status).toBe(200);
    });
  });

  it('a database failure is a 500 with no internal detail', async () => {
    (crmDb.createLead as jest.Mock).mockRejectedValue(new Error('ProvisionedThroughputExceeded: table AW-Leads'));
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const res = await post(makeApp(), event());
    expect(res.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toMatch(/AW-Leads|Provisioned/);
  });
});

describe('POST /api/track/event: list-read cache (ENG-2325)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    ingestListCache.clear();
    (crmDb.getLeadListById as jest.Mock).mockResolvedValue(sessionList());
    (crmDb.createLead as jest.Mock).mockImplementation(async (_l: string, d: any) => ({ ...d }));
    (crmDb.mergeSessionLeadEvent as jest.Mock).mockResolvedValue({ exists: true, changed: true, guardApplied: true });
  });

  it('N events for one list = ONE list read (a consistent one); the events themselves all land', async () => {
    const app = makeApp();
    for (let i = 0; i < 40; i++) expect((await post(app, event({ eventCount: i + 1 }))).status).toBe(204);
    expect(crmDb.getLeadListById).toHaveBeenCalledTimes(1);
    expect(crmDb.getLeadListById).toHaveBeenCalledWith(LIST_ID, { consistentRead: true });
    expect((crmDb.createLead as jest.Mock).mock.calls.length + (crmDb.mergeSessionLeadEvent as jest.Mock).mock.calls.length).toBe(40);
  });

  it('SECURITY: the gates are evaluated against the cached row on EVERY request (a cached allowed origin does not admit another)', async () => {
    const app = makeApp();
    expect((await post(app, event())).status).toBe(204);
    expect((await post(app, event(), { Origin: 'https://evil.test' })).status).toBe(403);
    expect((await post(app, event(), { Origin: 'https://evil.test' })).body.code).toBe('origin_not_allowed');
    expect((await post(app, event())).status).toBe(204);
    expect(crmDb.getLeadListById).toHaveBeenCalledTimes(1);
  });

  it('a list that is DISABLED stops accepting once the entry is invalidated (this process) ...', async () => {
    const app = makeApp();
    expect((await post(app, event())).status).toBe(204);
    (crmDb.getLeadListById as jest.Mock).mockResolvedValue(sessionList({ publicAccessEnabled: false }));
    expect((await post(app, event())).status).toBe(204); // other instance's view: still cached, within the TTL
    ingestListCache.invalidate(LIST_ID);                  // what crmDb.updateLeadList does on the instance that took the change
    const res = await post(app, event());
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('tracking_not_enabled');
  });

  it('... and a shrunk allowedOrigins stops admitting the removed origin the same way', async () => {
    const app = makeApp();
    expect((await post(app, event())).status).toBe(204);
    (crmDb.getLeadListById as jest.Mock).mockResolvedValue(sessionList({ trackingConfig: { allowedOrigins: ['https://other.example.com'] } }));
    ingestListCache.invalidate(LIST_ID);
    expect((await post(app, event())).status).toBe(403);
  });

  it('... and within one TTL on an instance that was NOT told (clock past the TTL, no invalidate)', async () => {
    const real = Date.now;
    let t = real();
    jest.spyOn(Date, 'now').mockImplementation(() => t);
    try {
      const app = makeApp();
      expect((await post(app, event({ sessionStartMs: t - 5000 }))).status).toBe(204);
      (crmDb.getLeadListById as jest.Mock).mockResolvedValue(sessionList({ publicAccessEnabled: false }));
      t += 19_000;
      expect((await post(app, event({ sessionStartMs: t - 5000 }))).status).toBe(204);
      t += 2_000;
      expect((await post(app, event({ sessionStartMs: t - 5000 }))).status).toBe(403);
    } finally { jest.restoreAllMocks(); }
  });

  it('a non-session list and a list that does not exist are still refused (and the unknown id is negatively cached, bounded)', async () => {
    (crmDb.getLeadListById as jest.Mock).mockResolvedValue(sessionList({ listType: undefined }));
    expect((await post(makeApp(), event())).status).toBe(403);
    ingestListCache.clear();
    (crmDb.getLeadListById as jest.Mock).mockResolvedValue(null);
    for (let i = 0; i < 5; i++) expect((await post(makeApp(), event())).status).toBe(404);
    expect(crmDb.getLeadListById).toHaveBeenCalledTimes(2);
  });

  it('a database failure is not cached: the next event retries and succeeds', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    (crmDb.getLeadListById as jest.Mock).mockRejectedValueOnce(new Error('throttled'));
    const app = makeApp();
    expect((await post(app, event())).status).toBe(500);
    expect((await post(app, event())).status).toBe(204);
  });
});
