/**
 * ENG-2313: the tracking routes are authenticated (ordinary user, NOT admin), pure and bounded.
 */
import express, { type NextFunction, type Request, type Response } from 'express';
import request from 'supertest';

// Authentication is the only boundary faked: the header stands in for a verified JWT.
jest.mock('../../middleware/auth', () => ({
  authenticateToken: (req: Request & { user?: unknown }, res: Response, next: NextFunction) => {
    if (!req.header('x-test-user')) {
      res.status(401).json({ message: 'Access token required' });
      return;
    }
    req.user = JSON.parse(req.header('x-test-user') as string);
    next();
  },
}));

import trackingRoutes from '../tracking';
import { classifyTraffic } from '../../utils/trafficSource';

const USER = JSON.stringify({ userId: 'user-1', email: 'user@example.com', isAdmin: false });
const app = express();
app.use(express.json());
app.use('/api/tracking', trackingRoutes);

const BASE = 'https://go.dramabreak.ai/guilty-before-the-mic-v2';

describe('tracking routes: auth', () => {
  it.each([['get', '/api/tracking/channels'], ['post', '/api/tracking/tagged-links']] as const)('%s %s needs a token', async (method, path) => {
    const res = await request(app)[method](path).send({});
    expect(res.status).toBe(401);
  });

  it('a non-admin user is allowed (not an admin route)', async () => {
    const res = await request(app).get('/api/tracking/channels').set('x-test-user', USER);
    expect(res.status).toBe(200);
  });
});

describe('GET /channels', () => {
  it('returns the taxonomy, presets and the bulk cap', async () => {
    const res = await request(app).get('/api/tracking/channels').set('x-test-user', USER);
    expect(res.body.classifierVersion).toEqual(expect.any(String));
    expect(res.body.channels.find((c: { key: string }) => c.key === 'tiktok')).toMatchObject({ name: 'TikTok', group: 'Organic Social', utmSource: 'tiktok' });
    expect(res.body.taggedLinkPresets.map((p: { platform: string }) => p.platform)).toContain('agency');
    expect(res.body.maxBulkRows).toBe(200);
  });
});

describe('POST /tagged-links', () => {
  const post = (body: unknown) => request(app).post('/api/tracking/tagged-links').set('x-test-user', USER).send(body as object);

  it('builds a single link that the classifier maps back to the intended channel', async () => {
    const res = await post({ baseUrl: BASE, platform: 'instagram', campaign: 'launch', content: 'ep3', postId: '1009' });
    expect(res.status).toBe(200);
    expect(res.body.link.url).toBe(`${BASE}?utm_source=instagram&utm_medium=bio&utm_campaign=launch&utm_content=ig-ep3-1009`);
    expect(classifyTraffic({ landingUrl: res.body.link.url, referrer: 'https://l.instagram.com/' }).channel).toBe(res.body.link.channel);
  });

  it('builds bulk with per-row failures reported, not thrown', async () => {
    const res = await post({ defaults: { baseUrl: BASE, campaign: 'launch' }, rows: [{ platform: 'tiktok' }, { platform: 'bogus' }] });
    expect(res.status).toBe(200);
    expect(res.body.summary).toEqual({ total: 2, ok: 1, failed: 1 });
    expect(res.body.results[1].error.code).toBe('unknown_platform');
  });

  it('rejects more than 200 rows and an empty batch with 400', async () => {
    const rows = Array.from({ length: 201 }, () => ({ platform: 'tiktok' }));
    expect((await post({ defaults: { baseUrl: BASE, campaign: 'c' }, rows })).body.code).toBe('too_many_rows');
    expect((await post({ rows: [] })).status).toBe(400);
  });

  it('maps validation failures to 400 with a stable code', async () => {
    const res = await post({ baseUrl: 'http://go.dramabreak.ai/x', platform: 'tiktok', campaign: 'c' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('base_url_not_https');
  });

  it('honours the allowedHosts guard in single and bulk mode', async () => {
    expect((await post({ baseUrl: BASE, platform: 'tiktok', campaign: 'c', allowedHosts: ['other.com'] })).body.code).toBe('base_url_host_not_allowed');
    const bulk = await post({ rows: [{ baseUrl: BASE, platform: 'tiktok', campaign: 'c' }], allowedHosts: ['other.com'] });
    expect(bulk.body.results[0].error.code).toBe('base_url_host_not_allowed');
  });

  it('rejects a malformed allowedHosts and a non-object body', async () => {
    expect((await post({ baseUrl: BASE, platform: 'tiktok', campaign: 'c', allowedHosts: 'nope' })).status).toBe(400);
    expect((await post([1, 2])).status).toBe(400);
  });
});
