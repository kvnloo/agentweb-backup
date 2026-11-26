/**
 * Reads of the platform's own landing-page analytics (GA4 property, Search Console domain property) keep only the caller's own landing
 * pages (services/landingAnalyticsScope.ts). Before this, a caller saw every customer's landing-page traffic and search queries.
 */
const mockLandingConfig = jest.fn();
const mockListDomains = jest.fn();
const mockPagesByOwner = jest.fn();
const mockOrgMembers = jest.fn();
jest.mock('../utils/secretsManager', () => ({ getLandingPagesConfig: (...a: any[]) => mockLandingConfig(...a) }));
jest.mock('../services/customDomainService', () => ({ listDomains: (...a: any[]) => mockListDomains(...a) }));
jest.mock('../services/v0Service', () => ({ getLandingPagesByOwner: (...a: any[]) => mockPagesByOwner(...a) }));
jest.mock('../services/db', () => ({ orgDb: { getOrgMembers: (...a: any[]) => mockOrgMembers(...a) } }));

import {
  andFilters,
  createLandingAnalyticsScope,
  ga4LocationsFilter,
  gscLocationsFilter,
  gscScopeFilter,
  resetLandingAnalyticsScopeForTest,
  scopeGaClient,
} from '../services/landingAnalyticsScope';

const PLATFORM = { ga4PropertyId: '999000111', gscDomain: 'agentwebforms.com', additionalDomains: [{ ga4PropertyId: '999000222', gscDomain: 'agentweb.pro' }] };

beforeEach(() => {
  resetLandingAnalyticsScopeForTest();
  for (const m of [mockLandingConfig, mockListDomains, mockPagesByOwner, mockOrgMembers]) m.mockReset();
  mockLandingConfig.mockResolvedValue(PLATFORM);
  mockListDomains.mockResolvedValue([]);
  mockPagesByOwner.mockResolvedValue([]);
  mockOrgMembers.mockResolvedValue([]);
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

const matches = (filter: { expression: string }, url: string) => new RegExp(filter.expression).test(url);

describe('the GA4 filter for the caller\'s own locations', () => {
  it('whole hosts are one hostName list; a page path keeps its host AND the path itself or under it', () => {
    expect(ga4LocationsFilter([{ host: 'acme.agentwebforms.com' }])).toEqual({ filter: { fieldName: 'hostName', inListFilter: { values: ['acme.agentwebforms.com'], caseSensitive: false } } });
    const both = ga4LocationsFilter([{ host: 'acme.agentwebforms.com' }, { host: 'audit.agentweb.pro', path: '/acme' }]);
    expect(both.orGroup.expressions).toHaveLength(2);
    const pathPart = both.orGroup.expressions[1].andGroup.expressions;
    expect(pathPart[0]).toEqual({ filter: { fieldName: 'hostName', stringFilter: { matchType: 'EXACT', value: 'audit.agentweb.pro', caseSensitive: false } } });
    expect(pathPart[1].orGroup.expressions.map((e: any) => [e.filter.stringFilter.matchType, e.filter.stringFilter.value])).toEqual([['EXACT', '/acme'], ['BEGINS_WITH', '/acme/']]);
  });

  it('no own location: an impossible host, never the whole property', () => {
    expect(ga4LocationsFilter([])).toEqual({ filter: { fieldName: 'hostName', stringFilter: { matchType: 'EXACT', value: 'no-own-landing-page.invalid' } } });
  });

  it('is ANDed with a filter the report already had, keeping an existing andGroup flat', () => {
    const scope = { filter: { fieldName: 'hostName' } };
    expect(andFilters(undefined, scope)).toBe(scope);
    expect(andFilters({ notExpression: {} }, scope)).toEqual({ andGroup: { expressions: [{ notExpression: {} }, scope] } });
    expect(andFilters({ andGroup: { expressions: [1, 2] } }, scope)).toEqual({ andGroup: { expressions: [1, 2, scope] } });
  });
});

describe('the Search Console filter for the caller\'s own locations', () => {
  it('matches the caller\'s pages and nothing else (escaped, anchored, path boundaries)', () => {
    const f = gscLocationsFilter([{ host: 'acme.agentwebforms.com' }, { host: 'audit.agentweb.pro', path: '/acme' }]);
    expect(f).toMatchObject({ dimension: 'page', operator: 'includingRegex' });
    for (const ok of ['https://acme.agentwebforms.com/', 'https://acme.agentwebforms.com', 'https://acme.agentwebforms.com/pricing?x=1', 'http://audit.agentweb.pro/acme', 'https://audit.agentweb.pro/acme/report']) {
      expect({ url: ok, matched: matches(f, ok) }).toEqual({ url: ok, matched: true });
    }
    for (const bad of ['https://other.agentwebforms.com/', 'https://acmeXagentwebforms.com/', 'https://acme.agentwebforms.com.evil.test/', 'https://audit.agentweb.pro/acme-2', 'https://audit.agentweb.pro/', 'https://evil.test/https://acme.agentwebforms.com/']) {
      expect({ url: bad, matched: matches(f, bad) }).toEqual({ url: bad, matched: false });
    }
  });

  it('no own location: matches nothing', () => {
    const f = gscLocationsFilter([]);
    expect(matches(f, 'https://acme.agentwebforms.com/')).toBe(false);
  });
});

describe('createLandingAnalyticsScope', () => {
  it('recognises the platform GA4 properties (any form) and Search Console sites (the domain and its subdomains)', async () => {
    const scope = createLandingAnalyticsScope({ userId: 'u1' });
    expect(await scope.isPlatformGa4('999000111')).toBe(true);
    expect(await scope.isPlatformGa4('properties/999000222')).toBe(true);
    expect(await scope.isPlatformGa4('123456789')).toBe(false);
    for (const site of ['sc-domain:agentwebforms.com', 'https://agentwebforms.com/', 'sc-domain:acme.agentwebforms.com', 'sc-domain:agentweb.pro']) {
      expect({ site, platform: await scope.isPlatformGscSite(site) }).toEqual({ site, platform: true });
    }
    for (const site of ['sc-domain:customer.com', 'https://notagentwebforms.com/']) {
      expect({ site, platform: await scope.isPlatformGscSite(site) }).toEqual({ site, platform: false });
    }
    expect(mockLandingConfig).toHaveBeenCalledTimes(1);
  });

  it('own locations: owned domains whole; a page on an unowned platform host by path only; never the root of a shared host; vercel hosts whole', async () => {
    mockListDomains.mockResolvedValueOnce([{ domain: 'acme.agentwebforms.com' }, { domain: 'www.acme.com' }]);
    mockPagesByOwner.mockResolvedValueOnce([
      { customDomainUrl: 'https://acme.agentwebforms.com/pricing', deployedUrl: 'https://acme-site.vercel.app/pricing' },
      { deployedUrl: 'https://audit.agentweb.pro/acme' },
      { deployedUrl: 'https://audit.agentweb.pro/' },
      { customDomainUrl: 'not a url' },
    ]);
    const scope = createLandingAnalyticsScope({ userId: 'u1' });
    expect(await scope.locations()).toEqual([
      { host: 'acme.agentwebforms.com' },
      { host: 'www.acme.com' },
      { host: 'acme-site.vercel.app' },
      { host: 'audit.agentweb.pro', path: '/acme' },
    ]);
    expect(await scope.hasLocationOn('audit.agentweb.pro')).toBe(true);
    expect(await scope.hasLocationOn('other.agentwebforms.com')).toBe(false);
  });

  it('organization members are one tenant: their pages count, and each member is read once', async () => {
    mockOrgMembers.mockResolvedValueOnce([{ userId: 'u1' }, { userId: 'u2' }]);
    mockListDomains.mockImplementation(async (id: string) => (id === 'u2' ? [{ domain: 'team.agentwebforms.com' }] : []));
    const scope = createLandingAnalyticsScope({ userId: 'u1', orgId: 'org-1' });
    expect(await scope.locations()).toEqual([{ host: 'team.agentwebforms.com' }]);
    expect(mockListDomains.mock.calls.map((c) => c[0]).sort()).toEqual(['u1', 'u2']);
  });

  it('a failure reading the caller\'s pages fails closed: no own location', async () => {
    mockListDomains.mockRejectedValueOnce(new Error('throttled'));
    const scope = createLandingAnalyticsScope({ userId: 'u1' });
    expect(await scope.locations()).toEqual([]);
  });

  it('the lists are cached per caller (one read in 5 minutes)', async () => {
    await createLandingAnalyticsScope({ userId: 'u1' }).locations();
    await createLandingAnalyticsScope({ userId: 'u1' }).locations();
    expect(mockListDomains).toHaveBeenCalledTimes(1);
  });

  it('platform ids that cannot be read are unknown (nothing is recognised) and are retried after a minute, not on every read', async () => {
    mockLandingConfig.mockResolvedValue(null);
    const scope = createLandingAnalyticsScope({ userId: 'u1' });
    expect(await scope.isPlatformGa4('999000111')).toBe(false);
    expect(await scope.isPlatformGa4('999000111')).toBe(false);
    expect(mockLandingConfig).toHaveBeenCalledTimes(1);
  });
});

describe('scopeGaClient', () => {
  const client = () => ({ runReport: jest.fn(async (req: any) => [{ rows: [], echo: req }]), other: jest.fn(() => 'other') });

  it('a report on a platform property gets the caller\'s own locations ANDed in; other properties are untouched', async () => {
    mockListDomains.mockResolvedValueOnce([{ domain: 'acme.agentwebforms.com' }]);
    const inner = client();
    const scoped = scopeGaClient(inner as any, createLandingAnalyticsScope({ userId: 'u1' })) as any;
    const existing = { notExpression: { filter: { fieldName: 'hostName' } } };
    await scoped.runReport({ property: 'properties/999000111', dimensionFilter: existing });
    await scoped.runReport({ property: 'properties/123456789', dimensionFilter: existing });
    expect(inner.runReport.mock.calls[0][0].dimensionFilter).toEqual({ andGroup: { expressions: [existing, { filter: { fieldName: 'hostName', inListFilter: { values: ['acme.agentwebforms.com'], caseSensitive: false } } }] } });
    expect(inner.runReport.mock.calls[1][0].dimensionFilter).toBe(existing);
    expect(scoped.other()).toBe('other');
  });

  it('a caller with no landing page asks the platform property for an impossible host, never the whole property', async () => {
    const inner = client();
    const scoped = scopeGaClient(inner as any, createLandingAnalyticsScope({ userId: 'u-none' })) as any;
    await scoped.runReport({ property: 'properties/999000111' });
    expect(JSON.stringify(inner.runReport.mock.calls[0][0].dimensionFilter)).toContain('no-own-landing-page.invalid');
  });

  it('a null client stays null', () => {
    expect(scopeGaClient(null, createLandingAnalyticsScope({ userId: 'u1' }))).toBeNull();
  });
});

describe('gscScopeFilter', () => {
  it('only for platform sites', async () => {
    mockListDomains.mockResolvedValueOnce([{ domain: 'acme.agentwebforms.com' }]);
    const scope = createLandingAnalyticsScope({ userId: 'u1' });
    expect(await gscScopeFilter(scope, 'sc-domain:customer.com')).toBeNull();
    const f = await gscScopeFilter(scope, 'sc-domain:agentwebforms.com');
    expect(f && matches(f, 'https://acme.agentwebforms.com/')).toBe(true);
    expect(f && matches(f, 'https://victim.agentwebforms.com/')).toBe(false);
  });
});
