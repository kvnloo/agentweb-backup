/**
 * Emma's analytics readers (fetchGoogleAnalyticsMetrics, fetchSearchConsoleMetrics) read the platform's own landing-page property and
 * domain only for the caller's own landing pages, like the portal routes.
 */
jest.mock('../services/sharedGoogleAudit', () => ({ auditSharedGoogleRead: jest.fn() }));
jest.mock('../services/db', () => ({
  userDb: { getUserById: jest.fn(async (userId: string) => ({ userId, email: `${userId}@example.com` })) },
  orgDb: { getOrgMembers: jest.fn(async () => []) },
}));
jest.mock('../utils/secretsManager', () => ({
  getSecret: jest.fn(async () => JSON.stringify({ private_key: 'k', client_email: 'sa@example.iam.gserviceaccount.com' })),
  getLandingPagesConfig: jest.fn(async () => ({ ga4PropertyId: '999000111', gscDomain: 'agentwebforms.com' })),
}));
jest.mock('../services/customDomainService', () => ({ listDomains: jest.fn(async (userId: string) => (userId === 'owner-1' ? [{ domain: 'mine.agentwebforms.com', status: 'active' }] : [])) }));
jest.mock('../services/v0Service', () => ({ getLandingPagesByOwner: jest.fn(async () => []) }));
jest.mock('google-auth-library', () => ({
  JWT: jest.fn().mockImplementation(() => ({ getAccessToken: jest.fn().mockResolvedValue({ token: 't' }) })),
}));
const mockRunReport = jest.fn();
jest.mock('@google-analytics/data', () => ({ BetaAnalyticsDataClient: jest.fn().mockImplementation(() => ({ runReport: mockRunReport })) }));

import { fetchGoogleAnalyticsMetrics, fetchSearchConsoleMetrics } from '../services/seoService';
import { resetLandingAnalyticsScopeForTest } from '../services/landingAnalyticsScope';

const config = (properties: string[], seoDomains: string[]): any => ({
  properties: properties.map((propertyId) => ({ propertyId, label: propertyId })), seoDomains, clarityProjects: [], gaFilteredDomains: [], primaryPropertyId: properties[0] ?? null, productDomain: null, source: 'self',
});
let fetchMock: jest.Mock;
beforeEach(() => {
  jest.clearAllMocks();
  resetLandingAnalyticsScopeForTest();
  mockRunReport.mockResolvedValue([{ rows: [] }]);
  fetchMock = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ rows: [] }) });
  global.fetch = fetchMock as any;
});

it('fetchGoogleAnalyticsMetrics: the platform property keeps only the caller\'s own hosts; a customer property is untouched', async () => {
  await fetchGoogleAnalyticsMetrics('owner-1', '30d', undefined, config(['999000111', '123456789'], [])).catch(() => undefined);
  const reports = mockRunReport.mock.calls.map((c) => c[0]);
  const platform = reports.filter((r) => r.property === 'properties/999000111');
  const own = reports.filter((r) => r.property === 'properties/123456789');
  expect(platform.length).toBeGreaterThan(0);
  expect(own.length).toBeGreaterThan(0);
  for (const r of platform) expect(JSON.stringify(r.dimensionFilter)).toContain('mine.agentwebforms.com');
  for (const r of own) expect(JSON.stringify(r.dimensionFilter ?? {})).not.toContain('mine.agentwebforms.com');
});

it('fetchSearchConsoleMetrics: the platform domain keeps only the caller\'s own pages; a customer domain is untouched', async () => {
  await fetchSearchConsoleMetrics('owner-1', '30d', undefined, config([], ['agentwebforms.com', 'customer.com'])).catch(() => undefined);
  const calls = fetchMock.mock.calls.filter((c) => String(c[0]).includes('searchAnalytics'));
  const platform = calls.filter((c) => String(c[0]).includes(encodeURIComponent('sc-domain:agentwebforms.com'))).map((c) => JSON.parse(c[1].body));
  const customer = calls.filter((c) => String(c[0]).includes(encodeURIComponent('sc-domain:customer.com'))).map((c) => JSON.parse(c[1].body));
  expect(platform.length).toBe(4);
  expect(customer.length).toBe(4);
  for (const body of platform) {
    const re = new RegExp(body.dimensionFilterGroups[0].filters[0].expression);
    expect(re.test('https://mine.agentwebforms.com/')).toBe(true);
    expect(re.test('https://victim.agentwebforms.com/')).toBe(false);
  }
  for (const body of customer) expect(body.dimensionFilterGroups).toBeUndefined();
});
