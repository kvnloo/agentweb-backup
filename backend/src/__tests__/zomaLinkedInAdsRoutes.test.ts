/**
 * The LinkedIn connect routes through the REAL app mount (app.ts), not a stub app:
 *  - flag off: /api/zoma/linkedin/* do not exist: they answer exactly what an unknown /api/zoma path answers,
 *    and use none of the shared Zoma throttle bucket; the portal /callback ignores a Zoma-signed state
 *  - flag read/true: the same paths reach the Zoma handlers, and the portal /callback forwards them
 * Mock-only (no LinkedIn call is made).
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
  S3: jest.fn(() => ({ getObject: jest.fn().mockReturnThis(), putObject: jest.fn().mockReturnThis(), promise: jest.fn() })),
  SES: jest.fn(() => ({})),
}));
jest.mock('../services/db', () => ({ userDb: { getUserById: jest.fn(), getUserByEmail: jest.fn(), getAllUsers: jest.fn() } }));
jest.mock('../utils/secretsManager', () => ({
  getMetaAccessToken: jest.fn().mockResolvedValue('mock-token'),
  getSecret: jest.fn().mockResolvedValue('mock-secret'),
}));

import jwt from 'jsonwebtoken';
import request from 'supertest';
import app from '../app';
import { getJwtSecret } from '../config/jwt';
import { rateLimiter } from '../middleware/rateLimiter';
import { ZOMA_MCP_SETUP } from '../mcp/zomaSetupLinks';

const zomaState = () => jwt.sign({ userId: 'u1', zoma: ZOMA_MCP_SETUP, nonce: 'n' }, getJwtSecret(), { expiresIn: '15m' });
const prev = { li: process.env.ZOMA_LINKEDIN_ADS_ENABLED, front: process.env.CUSTOMER_FRONTEND_URL };
afterEach(() => {
  if (prev.li === undefined) delete process.env.ZOMA_LINKEDIN_ADS_ENABLED; else process.env.ZOMA_LINKEDIN_ADS_ENABLED = prev.li;
  if (prev.front === undefined) delete process.env.CUSTOMER_FRONTEND_URL; else process.env.CUSTOMER_FRONTEND_URL = prev.front;
  jest.restoreAllMocks();
});

/** Status, content type and body of a response with the request path taken out (an unknown route's 404 names its path). */
const shape = (res: request.Response, path: string) => ({
  status: res.status,
  contentType: res.headers['content-type'],
  csp: res.headers['content-security-policy'],
  body: (res.text || JSON.stringify(res.body)).split(path).join('<PATH>'),
});
const zomaActivateCalls = (spy: jest.SpyInstance) => spy.mock.calls.filter(([key]) => String(key).startsWith('zoma-activate'));

describe('flag off, through the real app', () => {
  it.each([undefined, 'false', 'TRUE', 'Read', '1'])('ZOMA_LINKEDIN_ADS_ENABLED=%s: the LinkedIn Zoma routes are unknown routes and spend none of the throttle', async (value) => {
    if (value === undefined) delete process.env.ZOMA_LINKEDIN_ADS_ENABLED; else process.env.ZOMA_LINKEDIN_ADS_ENABLED = value;
    const check = jest.spyOn(rateLimiter, 'check');
    const unknownGet = await request(app).get('/api/zoma/no-such-route').query({ code: 'c', state: zomaState() });
    const unknownPost = await request(app).post('/api/zoma/no-such-route').type('form').send({ t: 'x', account_id: '1' });
    const callback = await request(app).get('/api/zoma/linkedin/callback').query({ code: 'c', state: zomaState() });
    const select = await request(app).post('/api/zoma/linkedin/select').type('form').send({ t: 'x', account_id: '1' });
    expect(unknownGet.status).toBe(404);
    expect(shape(callback, '/api/zoma/linkedin/callback')).toEqual(shape(unknownGet, '/api/zoma/no-such-route'));
    expect(shape(select, '/api/zoma/linkedin/select')).toEqual(shape(unknownPost, '/api/zoma/no-such-route'));
    expect(shape(callback, '/api/zoma/linkedin/callback').body).not.toMatch(/Zoma setup|This link is not available|linkedin/i);
    expect(zomaActivateCalls(check)).toEqual([]);
  });

  it('the portal /callback treats a Zoma-signed state as any other state: it goes to the portal, never to the Zoma page', async () => {
    delete process.env.ZOMA_LINKEDIN_ADS_ENABLED;
    process.env.CUSTOMER_FRONTEND_URL = 'https://portal.test';
    const res = await request(app).get('/api/oauth/linkedin-ads/callback').query({ code: 'abc', state: zomaState() });
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('https://portal.test/oauth/linkedin-ads/callback');
    expect(res.headers.location).not.toContain('/api/zoma/');
  });
});

describe('flag on, through the real app', () => {
  it('the Zoma routes exist (and are throttled), and the portal /callback forwards a verified Zoma state to them', async () => {
    process.env.ZOMA_LINKEDIN_ADS_ENABLED = 'read';
    process.env.CUSTOMER_FRONTEND_URL = 'https://portal.test';
    const check = jest.spyOn(rateLimiter, 'check');
    const page = await request(app).get('/api/zoma/linkedin/callback').query({ code: 'c', state: 'not-a-jwt' });
    expect(page.status).toBe(400);
    expect(page.text).toContain('LinkedIn Ads connection link is invalid or has expired');
    expect(zomaActivateCalls(check)).toHaveLength(1);
    const forwarded = await request(app).get('/api/oauth/linkedin-ads/callback').query({ code: 'abc', state: zomaState() });
    expect(forwarded.status).toBe(302);
    expect(forwarded.headers.location).toMatch(/^\/api\/zoma\/linkedin\/callback\?/);
  });
});
