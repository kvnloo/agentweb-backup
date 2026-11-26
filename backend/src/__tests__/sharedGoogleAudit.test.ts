/**
 * Log-only audit of reads through the platform's shared Google service account (services/sharedGoogleAudit.ts). It must write one structured
 * line per resource, never the raw id, and never break the read it describes.
 */
import { auditSharedGoogleRead, hashShared } from '../services/sharedGoogleAudit';

let info: jest.SpyInstance;
beforeEach(() => { info = jest.spyOn(console, 'info').mockImplementation(() => undefined); });
afterEach(() => info.mockRestore());
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

  it('the same resource read by two accounts hashes to the same value (the cross-tenant signal)', () => {
    auditSharedGoogleRead({ kind: 'gsc', userId: 'user-a', ids: ['example.com'], source: 's' });
    auditSharedGoogleRead({ kind: 'gsc', userId: 'user-b', ids: ['example.com'], source: 's' });
    const [a, b] = lines();
    expect(a.idHash).toBe(b.idHash);
    expect(a.userId).not.toBe(b.userId);
  });

  it('writes nothing for an empty or unusable list, and at most 50 lines for a long one', () => {
    auditSharedGoogleRead({ kind: 'ga4', userId: 'u', ids: [], source: 's' });
    auditSharedGoogleRead({ kind: 'ga4', userId: 'u', ids: ['', null as any, 7 as any], source: 's' });
    auditSharedGoogleRead({ kind: 'ga4', userId: 'u', ids: undefined as any, source: 's' });
    expect(info).not.toHaveBeenCalled();
    auditSharedGoogleRead({ kind: 'ga4', userId: 'u', ids: Array.from({ length: 80 }, (_, i) => `p${i}`), source: 's' });
    expect(info).toHaveBeenCalledTimes(50);
  });

  it('never throws, even when logging itself fails', () => {
    info.mockImplementation(() => { throw new Error('log sink down'); });
    expect(() => auditSharedGoogleRead({ kind: 'drive-file', userId: 'u', ids: ['x'], source: 's' })).not.toThrow();
    const circular: any = {}; circular.self = circular;
    expect(() => auditSharedGoogleRead({ kind: 'ga4', userId: circular, ids: ['x'], source: 's' })).not.toThrow();
  });
});
