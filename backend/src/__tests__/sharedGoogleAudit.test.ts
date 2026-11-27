/**
 * Log-only audit of reads through the platform's shared Google service account (services/sharedGoogleAudit.ts). It must write one structured
 * line per resource, never the raw id, and never break the read it describes.
 */
const mockLandingConfig = jest.fn();
jest.mock('../utils/secretsManager', () => ({ getLandingPagesConfig: (...a: any[]) => mockLandingConfig(...a) }));

import { auditSharedGoogleRead, hashShared, resetPlatformIdsForTest } from '../services/sharedGoogleAudit';

let info: jest.SpyInstance;
beforeEach(() => {
  info = jest.spyOn(console, 'info').mockImplementation(() => undefined);
  resetPlatformIdsForTest();
  mockLandingConfig.mockReset();
  mockLandingConfig.mockResolvedValue(null);
});
afterEach(() => jest.restoreAllMocks());
const settle = () => new Promise((resolve) => setImmediate(resolve));
const lines = () => info.mock.calls.map((c) => JSON.parse(String(c[0])));

describe('hashShared', () => {
  it('is 12 hex characters, stable, and different for different ids', () => {
    expect(hashShared('1abcDEF')).toMatch(/^[0-9a-f]{12}$/);
    expect(hashShared('1abcDEF')).toBe(hashShared('1abcDEF'));
    expect(hashShared('1abcDEF')).not.toBe(hashShared('1abcDEG'));
  });
});

describe('auditSharedGoogleRead', () => {
  it('writes one line per id with who, what kind, from where, and only the hash of the id', () => {
    auditSharedGoogleRead({ kind: 'drive-file', userId: 'user-1', ids: ['FILE-ID-SECRET-123'], source: 'readGoogleFileById', reason: 'no_oauth', outcome: 'ok' });
    const [line] = lines();
    expect(lines()).toHaveLength(1);
    expect(line).toMatchObject({ audit: 'shared_google_read', kind: 'drive-file', userId: 'user-1', idHash: hashShared('FILE-ID-SECRET-123'), source: 'readGoogleFileById', reason: 'no_oauth', outcome: 'ok' });
    expect(JSON.stringify(info.mock.calls)).not.toContain('FILE-ID-SECRET-123');
    expect(typeof line.at).toBe('string');
    expect(line.ofIds).toBeUndefined();
  });

  it('one line per property or domain, each marked with how many were read together', () => {
    auditSharedGoogleRead({ kind: 'ga4', userId: 'u', ids: ['111111111', '222222222'], source: 'fetchGa4KeyEvents' });
    expect(lines().map((l) => l.idHash)).toEqual([hashShared('111111111'), hashShared('222222222')]);
    expect(lines().every((l) => l.ofIds === 2 && l.kind === 'ga4' && l.reason === undefined && l.outcome === undefined)).toBe(true);
    expect(JSON.stringify(info.mock.calls)).not.toContain('111111111');
  });

  it('a Search Console property hashes the same whatever its case, scheme, trailing slash or domain-property prefix', () => {
    auditSharedGoogleRead({ kind: 'gsc', userId: 'u', ids: ['Example.com', 'https://example.com/', 'sc-domain:example.com', 'example.com'], source: 's' });
    expect(new Set(lines().map((l) => l.idHash)).size).toBe(1);
  });

  it('the same resource read by two accounts hashes to the same value (the cross-tenant signal)', () => {
    auditSharedGoogleRead({ kind: 'gsc', userId: 'user-a', ids: ['example.com'], source: 's' });
    auditSharedGoogleRead({ kind: 'gsc', userId: 'user-b', ids: ['example.com'], source: 's' });
    const [a, b] = lines();
    expect(a.idHash).toBe(b.idHash);
    expect(a.userId).not.toBe(b.userId);
  });

  it('writes nothing for an empty or unusable list, and at most 50 lines for a long one', () => {
    auditSharedGoogleRead({ kind: 'ga4', userId: 'u', ids: [], source: 's' });
    auditSharedGoogleRead({ kind: 'ga4', userId: 'u', ids: ['', null, undefined, {}, Number.NaN], source: 's' });
    auditSharedGoogleRead({ kind: 'ga4', userId: 'u', ids: undefined as any, source: 's' });
    expect(info).not.toHaveBeenCalled();
    auditSharedGoogleRead({ kind: 'ga4', userId: 'u', ids: Array.from({ length: 80 }, (_, i) => `p${i}`), source: 's' });
    expect(info).toHaveBeenCalledTimes(50);
  });

  it('a GA4 property id stored as a number is audited like its text form', () => {
    auditSharedGoogleRead({ kind: 'ga4', userId: 'u', ids: [123456789], source: 's' });
    expect(lines()).toEqual([expect.objectContaining({ idHash: hashShared('123456789') })]);
  });

  it('carries the organization and the config the ids came from, when given', () => {
    auditSharedGoogleRead({ kind: 'ga4', userId: 'member-1', orgId: 'org-9', configSource: 'org', ids: ['111'], source: 's' });
    auditSharedGoogleRead({ kind: 'drive-file', userId: 'solo', orgId: null, ids: ['f'], source: 's' });
    const [member, solo] = lines();
    expect(member).toMatchObject({ orgId: 'org-9', configSource: 'org' });
    expect(solo.orgId).toBeUndefined();
    expect(solo.configSource).toBeUndefined();
  });

  it('never throws, even when logging itself fails', () => {
    info.mockImplementation(() => { throw new Error('log sink down'); });
    expect(() => auditSharedGoogleRead({ kind: 'drive-file', userId: 'u', ids: ['x'], source: 's' })).not.toThrow();
    const circular: any = {}; circular.self = circular;
    expect(() => auditSharedGoogleRead({ kind: 'ga4', userId: circular, ids: ['x'], source: 's' })).not.toThrow();
  });
});

describe('the platform\'s own landing-page analytics ids are marked', () => {
  it('once the landing-page config has loaded, each analytics line says whether its id is a platform id; the first lines carry no mark', async () => {
    mockLandingConfig.mockResolvedValue({ ga4PropertyId: '999000111', gscDomain: 'agentwebforms.com', additionalDomains: [{ ga4PropertyId: '999000222', gscDomain: 'agentweb.pro' }] });
    auditSharedGoogleRead({ kind: 'ga4', userId: 'u', ids: ['999000111'], source: 's' });
    expect(lines()[0].platform).toBeUndefined();
    await settle();
    auditSharedGoogleRead({ kind: 'ga4', userId: 'u', ids: ['999000222', '123456789'], source: 's' });
    auditSharedGoogleRead({ kind: 'gsc', userId: 'u', ids: ['agentwebforms.com', 'customer.com'], source: 's' });
    expect(lines().slice(1).map((l) => l.platform)).toEqual([true, false, true, false]);
    expect(mockLandingConfig).toHaveBeenCalledTimes(1);
  });

  it('Drive lines never load the config and never carry the mark', async () => {
    auditSharedGoogleRead({ kind: 'drive-file', userId: 'u', ids: ['f'], source: 's' });
    await settle();
    expect(mockLandingConfig).not.toHaveBeenCalled();
    expect(lines()[0].platform).toBeUndefined();
  });

  it('a config that cannot be read (getLandingPagesConfig answers null, it never throws) leaves the mark off: unknown, not "no"', async () => {
    mockLandingConfig.mockResolvedValue(null);
    auditSharedGoogleRead({ kind: 'ga4', userId: 'u', ids: ['1'], source: 's' });
    await settle();
    auditSharedGoogleRead({ kind: 'ga4', userId: 'u', ids: ['1'], source: 's' });
    auditSharedGoogleRead({ kind: 'gsc', userId: 'u', ids: ['agentwebforms.com'], source: 's' });
    expect(lines().map((l) => l.platform)).toEqual([undefined, undefined, undefined]);
  });

  it('a failing load is not retried on every read: at most one per 10 minutes', async () => {
    mockLandingConfig.mockResolvedValue(null);
    for (let i = 0; i < 5; i++) {
      auditSharedGoogleRead({ kind: 'ga4', userId: 'u', ids: ['1'], source: 's' });
      await settle();
    }
    expect(mockLandingConfig).toHaveBeenCalledTimes(1);
  });

  it('a later failed refresh keeps the last known set', async () => {
    const realNow = Date.now;
    let now = realNow();
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    mockLandingConfig.mockResolvedValueOnce({ ga4PropertyId: '999000111', gscDomain: 'agentwebforms.com' }).mockResolvedValueOnce(null);
    auditSharedGoogleRead({ kind: 'ga4', userId: 'u', ids: ['999000111'], source: 's' });
    await settle();
    now += 11 * 60_000;
    auditSharedGoogleRead({ kind: 'ga4', userId: 'u', ids: ['999000111'], source: 's' });
    await settle();
    auditSharedGoogleRead({ kind: 'ga4', userId: 'u', ids: ['999000111'], source: 's' });
    expect(mockLandingConfig).toHaveBeenCalledTimes(2);
    expect(lines().map((l) => l.platform)).toEqual([undefined, true, true]);
  });

  it('a rejected load (should it ever reject) is also unknown, and never reaches the read', async () => {
    mockLandingConfig.mockRejectedValue(new Error('secrets down'));
    expect(() => auditSharedGoogleRead({ kind: 'ga4', userId: 'u', ids: ['1'], source: 's' })).not.toThrow();
    await settle();
    auditSharedGoogleRead({ kind: 'ga4', userId: 'u', ids: ['1'], source: 's' });
    expect(lines().map((l) => l.platform)).toEqual([undefined, undefined]);
  });

  it('platform ids are matched in their normal form (a numeric GA4 id in the config, a Search Console URL form in a user config)', async () => {
    mockLandingConfig.mockResolvedValue({ ga4PropertyId: 999000111, gscDomain: 'AgentWebForms.com' });
    auditSharedGoogleRead({ kind: 'ga4', userId: 'u', ids: ['x'], source: 's' });
    await settle();
    auditSharedGoogleRead({ kind: 'ga4', userId: 'u', ids: ['999000111'], source: 's' });
    auditSharedGoogleRead({ kind: 'gsc', userId: 'u', ids: ['https://agentwebforms.com/', 'sc-domain:agentwebforms.com'], source: 's' });
    expect(lines().slice(1).map((l) => l.platform)).toEqual([true, true, true]);
  });
});
