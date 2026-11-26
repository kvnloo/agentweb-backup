/**
 * The portal's analytics routes read the platform's own landing-page GA4 property and Search Console domain only for the caller's own
 * landing pages. Before: GET /api/seo/metrics?domain=<any managed host> returned that host's traffic to anyone, and a deployer (whose config
 * received the platform property and domain on deploy) saw every customer's landing-page traffic and search queries.
 */
jest.mock('../middleware/auth', () => ({ authenticateToken: jest.fn() }));
import { authenticateToken } from '../middleware/auth';

jest.mock('../services/sharedGoogleAudit', () => ({ auditSharedGoogleRead: jest.fn() }));
jest.mock('../services/db', () => ({ userDb: { getUserById: jest.fn() }, orgDb: { getOrgMembers: jest.fn(async () => []) } }));
jest.mock('../utils/secretsManager', () => ({
  getSecret: jest.fn(async () => JSON.stringify({ private_key: 'mock-private-key', client_email: 'sa@example.iam.gserviceaccount.com' })),
  getLandingPagesConfig: jest.fn(async () => ({ ga4PropertyId: '999000111', gscDomain: 'agentwebforms.com' })),
}));
const mockListDomains = jest.fn();
jest.mock('../services/customDomainService', () => ({ listDomains: (...a: any[]) => mockListDomains(...a) }));
jest.mock('../services/v0Service', () => ({ getLandingPagesByOwner: jest.fn(async () => []) }));
jest.mock('google-auth-library', () => ({
  JWT: jest.fn().mockImplementation(() => ({ getAccessToken: jest.fn().mockResolvedValue({ token: 'mock-access-token' }) })),
}));
// The funnel branch of /metrics reads its stored funnel from AW-Settings with its own DocumentClient.
jest.mock('aws-sdk', () => ({
  DynamoDB: { DocumentClient: jest.fn().mockImplementation(() => ({
    get: () => ({ promise: async () => ({ Item: { funnels: { f1: { stages: jest.requireActual('../services/funnelService').DEFAULT_FUNNEL_STAGES } } } }) }),
  })) },
}));
const mockRunReport = jest.fn();
jest.mock('@google-analytics/data', () => ({
  BetaAnalyticsDataClient: jest.fn().mockImplementation(() => ({ runReport: mockRunReport })),
}));

import express from 'express';
import request from 'supertest';
import seoRoutes from '../routes/seo';
import { userDb } from '../services/db';
import { resetLandingAnalyticsScopeForTest } from '../services/landingAnalyticsScope';

const PLATFORM = '999000111';
const OWN_HOST = 'mine.agentwebforms.com';
const VICTIM = 'victim.agentwebforms.com';
let app: express.Application;
let fetchMock: jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
  resetLandingAnalyticsScopeForTest();
  mockRunReport.mockResolvedValue([{ rows: [] }]);
  mockListDomains.mockImplementation(async (userId: string) => (userId === 'owner-1' ? [{ domain: OWN_HOST }] : []));
  fetchMock = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ rows: [] }) });
  global.fetch = fetchMock as any;
  (authenticateToken as jest.Mock).mockImplementation(async (req: any, _res: any, next: any) => {
    req.user = { userId: req.headers['x-test-user'] || 'owner-1', email: 'u@example.com' };
    next();
  });
  app = express();
  app.use(express.json());
  app.use('/api/seo', seoRoutes);
});

/** The user record after a landing-page deploy: the platform property and root domain were added to its analytics config. */
const deployer = (userId = 'owner-1', extra: Record<string, unknown> = {}) => ({
  userId, email: `${userId}@example.com`, seoDomains: ['agentwebforms.com'], googleAnalyticsProperties: [{ propertyId: PLATFORM, label: 'agentwebforms.com' }], ...extra,
});
const platformReports = () => mockRunReport.mock.calls.map((c) => c[0]).filter((r) => r.property === `properties/${PLATFORM}`);
const gscBodies = () => fetchMock.mock.calls.filter((c) => String(c[0]).includes('searchAnalytics')).map((c) => JSON.parse(c[1].body));
const regexOf = (body: any) => body.dimensionFilterGroups?.[0]?.filters?.find((f: any) => f.operator === 'includingRegex')?.expression;

describe('GET /api/seo/metrics for a deployer (platform property and domain in their config)', () => {
  it('every GA4 report on the platform property keeps only the caller\'s own hosts', async () => {
    (userDb.getUserById as jest.Mock).mockResolvedValue(deployer());
    await request(app).get('/api/seo/metrics');
    expect(platformReports().length).toBeGreaterThan(0);
    for (const report of platformReports()) {
      const text = JSON.stringify(report.dimensionFilter);
      expect(text).toContain(OWN_HOST);
      expect(text).toContain('inListFilter');
    }
  });

  it('every Search Console query on the platform domain keeps only the caller\'s own pages', async () => {
    (userDb.getUserById as jest.Mock).mockResolvedValue(deployer());
    await request(app).get('/api/seo/metrics');
    expect(gscBodies().length).toBeGreaterThan(0);
    for (const body of gscBodies()) {
      const re = new RegExp(regexOf(body));
      expect(re.test(`https://${OWN_HOST}/pricing`)).toBe(true);
      expect(re.test(`https://${VICTIM}/`)).toBe(false);
    }
  });

  it('a deployer with no landing page of their own reads nothing of the platform property', async () => {
    (userDb.getUserById as jest.Mock).mockResolvedValue(deployer('nobody-1'));
    await request(app).get('/api/seo/metrics').set('x-test-user', 'nobody-1');
    for (const report of platformReports()) expect(JSON.stringify(report.dimensionFilter)).toContain('no-own-landing-page.invalid');
    for (const body of gscBodies()) expect(new RegExp(regexOf(body)).test(`https://${VICTIM}/`)).toBe(false);
  });
});

describe('GET /api/seo/metrics?domain=<host>', () => {
  it('another customer\'s host: the platform property is not added for a caller without it', async () => {
    (userDb.getUserById as jest.Mock).mockResolvedValue({ userId: 'owner-1', email: 'u@example.com', googleAnalyticsPropertyId: '123456789' });
    await request(app).get('/api/seo/metrics').query({ domain: VICTIM });
    expect(platformReports()).toEqual([]);
  });

  it('another customer\'s host, for a deployer: every read is that host AND the caller\'s own, so nothing of it comes back', async () => {
    (userDb.getUserById as jest.Mock).mockResolvedValue(deployer());
    await request(app).get('/api/seo/metrics').query({ domain: VICTIM });
    for (const report of platformReports()) {
      const text = JSON.stringify(report.dimensionFilter);
      expect(text).toContain(VICTIM);
      expect(text).toContain(OWN_HOST);
      expect(report.dimensionFilter.andGroup).toBeDefined();
    }
    for (const body of gscBodies()) {
      const filters = body.dimensionFilterGroups[0].filters;
      expect(filters).toEqual(expect.arrayContaining([expect.objectContaining({ operator: 'contains', expression: VICTIM })]));
      expect(new RegExp(regexOf(body)).test(`https://${VICTIM}/`)).toBe(false);
    }
  });

  it('the caller\'s own host: the platform property is added and read for that host', async () => {
    (userDb.getUserById as jest.Mock).mockResolvedValue({ userId: 'owner-1', email: 'u@example.com', googleAnalyticsPropertyId: '123456789' });
    await request(app).get('/api/seo/metrics').query({ domain: OWN_HOST });
    expect(platformReports().length).toBeGreaterThan(0);
    for (const report of platformReports()) expect(JSON.stringify(report.dimensionFilter)).toContain(OWN_HOST);
  });
});

describe('GET /api/seo/product-metrics', () => {
  it('a platform primary property is read only for the caller\'s own hosts, whatever product domain is saved', async () => {
    (userDb.getUserById as jest.Mock).mockResolvedValue(deployer('owner-1', { productDomain: VICTIM }));
    await request(app).get('/api/seo/product-metrics');
    expect(platformReports().length).toBeGreaterThan(0);
    for (const report of platformReports()) expect(JSON.stringify(report.dimensionFilter)).toContain(OWN_HOST);
  });

  it('a customer\'s own property is untouched', async () => {
    (userDb.getUserById as jest.Mock).mockResolvedValue({ userId: 'owner-1', email: 'u@example.com', googleAnalyticsPropertyId: '123456789', productDomain: 'app.example.com' });
    await request(app).get('/api/seo/product-metrics');
    const reports = mockRunReport.mock.calls.map((c) => c[0]);
    expect(reports.length).toBeGreaterThan(0);
    for (const report of reports) expect(JSON.stringify(report.dimensionFilter ?? {})).not.toContain('inListFilter');
  });
});

describe('the other call sites', () => {
  it('the funnel report on a platform primary property keeps only the caller\'s own hosts', async () => {
    (userDb.getUserById as jest.Mock).mockResolvedValue(deployer());
    await request(app).get('/api/seo/metrics').query({ funnelId: 'f1' });
    const funnelReports = platformReports().filter((r) => JSON.stringify(r).includes('eventName'));
    expect(funnelReports.length).toBeGreaterThan(0);
    for (const report of platformReports()) expect(JSON.stringify(report.dimensionFilter)).toContain(OWN_HOST);
  });

  it('GET /api/seo/debug on the platform domain keeps only the caller\'s own pages', async () => {
    (userDb.getUserById as jest.Mock).mockResolvedValue(deployer());
    await request(app).get('/api/seo/debug');
    expect(gscBodies()).toHaveLength(1);
    const re = new RegExp(regexOf(gscBodies()[0]));
    expect(re.test(`https://${OWN_HOST}/`)).toBe(true);
    expect(re.test(`https://${VICTIM}/`)).toBe(false);
  });
});
