/**
 * The portal's analytics routes audit the GA4 properties and Search Console domains they read through the platform's shared Google
 * service account (log only, services/sharedGoogleAudit.ts), including the platform's own landing-page property that GET /metrics adds
 * for a host named in ?domain=.
 */
jest.mock('../middleware/auth', () => ({ authenticateToken: jest.fn() }));
import { authenticateToken } from '../middleware/auth';

const mockAudit = jest.fn();
jest.mock('../services/sharedGoogleAudit', () => ({ auditSharedGoogleRead: (...a: any[]) => mockAudit(...a) }));
jest.mock('../services/db', () => ({ userDb: { getUserById: jest.fn() }, orgDb: { getOrgMembers: jest.fn(async () => []) } }));
// The landing-page analytics scope (landingAnalyticsScope.ts): user-1 owns the managed host the ?domain= test names.
jest.mock('../services/customDomainService', () => ({ listDomains: jest.fn(async (userId: string) => (userId === 'user-1' ? [{ domain: 'someone.agentwebforms.com', status: 'active' }] : [])) }));
jest.mock('../services/v0Service', () => ({ getLandingPagesByOwner: jest.fn(async () => []) }));
jest.mock('../utils/secretsManager', () => ({
  getSecret: jest.fn(async () => JSON.stringify({ private_key: 'mock-private-key', client_email: 'sa@example.iam.gserviceaccount.com' })),
  getLandingPagesConfig: jest.fn(async () => ({ ga4PropertyId: '999000111', gscDomain: 'agentwebforms.com' })),
}));
jest.mock('google-auth-library', () => ({
  JWT: jest.fn().mockImplementation(() => ({ getAccessToken: jest.fn().mockResolvedValue({ token: 'mock-access-token' }) })),
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

let app: express.Application;
beforeEach(() => {
  jest.clearAllMocks();
  resetLandingAnalyticsScopeForTest();
  mockRunReport.mockResolvedValue([{ rows: [] }]);
  global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ rows: [] }) }) as any;
  (authenticateToken as jest.Mock).mockImplementation(async (req: any, _res: any, next: any) => {
    req.user = { userId: 'user-1', email: 'u@example.com' };
    next();
  });
  app = express();
  app.use(express.json());
  app.use('/api/seo', seoRoutes);
});

const sources = () => mockAudit.mock.calls.map((c) => c[0].source);

describe('GET /api/seo/metrics', () => {
  it('audits the configured GA4 properties and Search Console domains, with the organization and config source', async () => {
    (userDb.getUserById as jest.Mock).mockResolvedValue({ userId: 'user-1', email: 'u@example.com', orgId: undefined, seoDomains: ['example.com'], googleAnalyticsPropertyId: '123456789' });
    await request(app).get('/api/seo/metrics');
    expect(mockAudit).toHaveBeenCalledWith(expect.objectContaining({ kind: 'ga4', userId: 'user-1', configSource: 'self', ids: ['123456789'], source: 'GET /api/seo/metrics' }));
    expect(mockAudit).toHaveBeenCalledWith(expect.objectContaining({ kind: 'gsc', userId: 'user-1', ids: ['example.com'], source: 'GET /api/seo/metrics' }));
    expect(sources().some((s) => /landing page property/.test(s))).toBe(false);
  });

  it('the caller\'s own landing-page host in ?domain= adds the platform property, and that read is audited too', async () => {
    (userDb.getUserById as jest.Mock).mockResolvedValue({ userId: 'user-1', email: 'u@example.com', seoDomains: [], googleAnalyticsPropertyId: '123456789' });
    await request(app).get('/api/seo/metrics').query({ domain: 'someone.agentwebforms.com', status: 'active' });
    expect(mockAudit).toHaveBeenCalledWith(expect.objectContaining({ kind: 'ga4', userId: 'user-1', ids: ['999000111'], source: 'GET /api/seo/metrics ?domain (landing page property)' }));
  });
});

describe('GET /api/seo/product-metrics', () => {
  it('audits the primary GA4 property it reads', async () => {
    (userDb.getUserById as jest.Mock).mockResolvedValue({ userId: 'user-1', email: 'u@example.com', productDomain: 'app.example.com', googleAnalyticsPropertyId: '123456789' });
    await request(app).get('/api/seo/product-metrics');
    expect(mockAudit).toHaveBeenCalledWith(expect.objectContaining({ kind: 'ga4', userId: 'user-1', ids: ['123456789'], source: 'GET /api/seo/product-metrics' }));
  });
});

describe('POST /api/seo/config/ga/test', () => {
  it('audits the property id the caller probes, after the numeric check', async () => {
    (userDb.getUserById as jest.Mock).mockResolvedValue({ userId: 'user-1', email: 'u@example.com' });
    await request(app).post('/api/seo/config/ga/test').send({ propertyId: 'not-a-number' });
    expect(sources()).not.toContain('POST /api/seo/config/ga/test');
    await request(app).post('/api/seo/config/ga/test').send({ propertyId: '123456789' });
    expect(mockAudit).toHaveBeenCalledWith(expect.objectContaining({ kind: 'ga4', userId: 'user-1', ids: ['123456789'], source: 'POST /api/seo/config/ga/test' }));
  });
});
