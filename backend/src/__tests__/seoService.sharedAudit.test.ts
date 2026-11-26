/**
 * The analytics readers audit the ids they are about to read through the platform's shared Google service account (log only).
 */
const mockAudit = jest.fn();
jest.mock('../services/sharedGoogleAudit', () => ({ auditSharedGoogleRead: (...a: any[]) => mockAudit(...a) }));
jest.mock('../services/db', () => ({ userDb: { getUserById: jest.fn(async () => ({ userId: 'user-1', email: 'u@x.test' })) } }));
jest.mock('../utils/secretsManager', () => ({ getSecret: jest.fn(async () => { throw new Error('no secret in tests'); }) }));

import { fetchGa4KeyEvents, fetchGoogleAnalyticsMetrics, fetchSearchConsoleMetrics } from '../services/seoService';

const resolved = (properties: string[], seoDomains: string[]): any => ({
  properties: properties.map((propertyId) => ({ propertyId, label: propertyId })),
  seoDomains,
  clarityProjects: [],
  gaFilteredDomains: [],
  primaryPropertyId: properties[0] ?? null,
  productDomain: null,
});

beforeEach(() => mockAudit.mockReset());

describe('the analytics readers audit what they read through the shared account', () => {
  it('fetchGa4KeyEvents names the user and the configured GA4 properties', async () => {
    await fetchGa4KeyEvents('user-1', undefined, undefined, resolved(['111111111', '222222222'], [])).catch(() => undefined);
    expect(mockAudit).toHaveBeenCalledWith({ kind: 'ga4', userId: 'user-1', ids: ['111111111', '222222222'], source: 'fetchGa4KeyEvents' });
  });

  it('fetchGoogleAnalyticsMetrics names the user and the configured GA4 properties', async () => {
    await fetchGoogleAnalyticsMetrics('user-1', '30d', undefined, resolved(['333333333'], [])).catch(() => undefined);
    expect(mockAudit).toHaveBeenCalledWith({ kind: 'ga4', userId: 'user-1', ids: ['333333333'], source: 'fetchGoogleAnalyticsMetrics' });
  });

  it('fetchSearchConsoleMetrics names the user and the configured domains', async () => {
    await fetchSearchConsoleMetrics('user-1', '30d', undefined, resolved([], ['example.com', 'example.org'])).catch(() => undefined);
    expect(mockAudit).toHaveBeenCalledWith({ kind: 'gsc', userId: 'user-1', ids: ['example.com', 'example.org'], source: 'fetchSearchConsoleMetrics' });
  });

  it('a user with nothing configured is audited with no ids (nothing is logged for them) and still gets the not-configured answer', async () => {
    const answer = await fetchGa4KeyEvents('user-1', undefined, undefined, resolved([], []));
    expect(answer.message).toMatch(/not configured/i);
    expect(mockAudit).toHaveBeenCalledWith(expect.objectContaining({ ids: [] }));
  });
});
