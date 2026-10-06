/**
 * ENG-2312 — pure contract for the session identity, the deterministic lead id and the
 * merge-plan classification. The DB request shapes are pinned in
 * crmDb.mergeSessionLeadEvent.test.ts; the handler wiring in webhooks.forwardLead.sessionUpsert.test.ts.
 */
import { resolveSessionIdentity, sessionLeadId } from '../utils/sessionList';
import { buildSessionMergePlan } from '../utils/sessionMergePlan';

const NOW = 1_780_000_000_000;
const SID = 'abcd1234-ef56-7890';

describe('resolveSessionIdentity', () => {
  it('reads sessionId/sessionStartMs from the top level or from customFields', () => {
    expect(resolveSessionIdentity({ sessionId: SID, sessionStartMs: NOW - 1000 }, NOW))
      .toEqual({ sessionId: SID, sessionStartMs: NOW - 1000 });
    expect(resolveSessionIdentity({ customFields: { sessionId: SID, sessionStartMs: NOW - 1000 } }, NOW))
      .toEqual({ sessionId: SID, sessionStartMs: NOW - 1000 });
    // mixed: id in customFields (what LPs post today), start flat (the new field)
    expect(resolveSessionIdentity({ sessionStartMs: NOW, customFields: { sessionId: SID } }, NOW))
      .toEqual({ sessionId: SID, sessionStartMs: NOW });
  });

  it('accepts a digit-string start time and upper-case ids', () => {
    expect(resolveSessionIdentity({ sessionId: 'ABCD1234', sessionStartMs: String(NOW) }, NOW))
      .toEqual({ sessionId: 'ABCD1234', sessionStartMs: NOW });
  });

  it.each([
    ['missing id', { sessionStartMs: NOW }],
    ['missing start', { sessionId: SID }],
    ['id too short', { sessionId: 'abc1234', sessionStartMs: NOW }],
    ['id too long', { sessionId: 'a'.repeat(65), sessionStartMs: NOW }],
    ['id with bad chars', { sessionId: 'abcd1234_ef56', sessionStartMs: NOW }],
    ['id not a string', { sessionId: 12345678, sessionStartMs: NOW }],
    ['start a float', { sessionId: SID, sessionStartMs: NOW + 0.5 }],
    ['start NaN', { sessionId: SID, sessionStartMs: NaN }],
    ['start a non-digit string', { sessionId: SID, sessionStartMs: '12e9' }],
    ['start older than 48h', { sessionId: SID, sessionStartMs: NOW - 48 * 3600e3 - 1 }],
    ['start more than 5min ahead', { sessionId: SID, sessionStartMs: NOW + 5 * 60e3 + 1 }],
    ['start 0 / epoch', { sessionId: SID, sessionStartMs: 0 }],
  ])('returns null (legacy behaviour) for %s', (_n, body) => {
    expect(resolveSessionIdentity(body, NOW)).toBeNull();
  });

  it('window edges are inclusive', () => {
    expect(resolveSessionIdentity({ sessionId: SID, sessionStartMs: NOW - 48 * 3600e3 }, NOW)).not.toBeNull();
    expect(resolveSessionIdentity({ sessionId: SID, sessionStartMs: NOW + 5 * 60e3 }, NOW)).not.toBeNull();
  });

  it('never throws on garbage bodies', () => {
    for (const b of [null, undefined, 'x', 5, [], { customFields: 'x' }, { customFields: null }]) {
      expect(resolveSessionIdentity(b as any, NOW)).toBeNull();
    }
  });
});

describe('sessionLeadId', () => {
  const id = { sessionId: SID, sessionStartMs: NOW };

  it('is lead_<13-digit ms>_<12 hex>, deterministic per (list, session), case-insensitive in the session id', () => {
    const a = sessionLeadId('listA', id);
    expect(a).toMatch(/^lead_\d{13}_[0-9a-f]{12}$/);
    expect(a).toBe(sessionLeadId('listA', id));
    expect(a).toBe(sessionLeadId('listA', { ...id, sessionId: SID.toUpperCase() }));
    expect(a).not.toBe(sessionLeadId('listB', id)); // same session id in another list => another row
    expect(a).not.toBe(sessionLeadId('listA', { ...id, sessionId: SID + '0' }));
  });

  it('pinned vector (guards an accidental change to the hash input, which would orphan every session row)', () => {
    // sha256("listA:abcd1234-ef56-7890") = 7997ba15a35a...
    expect(sessionLeadId('listA', id)).toBe(`lead_${NOW}_7997ba15a35a`);
  });

  it('sorts by recency among ordinary lead_<ms>_<rand> ids (getLeadsByListId is ScanIndexForward:false)', () => {
    const ordinary = (ms: number) => `lead_${ms}_${Math.random().toString(36).substr(2, 9)}`;
    const ids = [
      ordinary(NOW - 5000), sessionLeadId('L', { sessionId: SID, sessionStartMs: NOW - 3000 }),
      ordinary(NOW - 1000), sessionLeadId('L', { sessionId: 'zzzzzzzz', sessionStartMs: NOW }),
      ordinary(NOW - 9000),
    ];
    const newestFirst = [...ids].sort().reverse();
    const msOf = (s: string) => Number(s.split('_')[1]);
    expect(newestFirst.map(msOf)).toEqual([...newestFirst.map(msOf)].sort((x, y) => y - x));
    // contrast: the lead_ph_ ids that broke ordering sort ABOVE every timestamped id
    expect(['lead_ph_abc', ordinary(NOW)].sort().reverse()[0]).toBe('lead_ph_abc');
  });
});

describe('buildSessionMergePlan', () => {
  const base = {
    leadData: { firstName: '', lastName: '', phone: '', company: '', title: '', notes: '' } as Record<string, any>,
    callerSuppliedSource: false,
    touch: null as any,
  };
  const cf = {
    dwellSec: 30, activeSec: 20, videoWatchSec: 4, maxScrollPct: 80, channel: 'tiktok',
    journey: 'a>b', eventCount: 7, clickLog: ['x'], clickCount: 1, showsClicked: ['s1'],
    forwardedAt: '2026-01-01T00:00:00.000Z', source: 'api', domain: 'x.com', system: 'y',
  };

  it('journey keys go under the eventCount guard; everything else is last-write-wins', () => {
    const p = buildSessionMergePlan({ ...base, incomingCustomFields: cf });
    expect(p.monotonic).toEqual({
      counterKey: 'eventCount', counter: 7,
      fields: { journey: 'a>b', eventCount: 7, clickLog: ['x'], clickCount: 1, showsClicked: ['s1'] },
    });
    expect(Object.keys(p.customFields).sort()).toEqual(
      ['activeSec', 'channel', 'domain', 'dwellSec', 'maxScrollPct', 'system', 'videoWatchSec']);
  });

  it('never writes forwardedAt; writes source only if the caller named one', () => {
    expect(buildSessionMergePlan({ ...base, incomingCustomFields: cf }).customFields).not.toHaveProperty('source');
    const named = buildSessionMergePlan({ ...base, callerSuppliedSource: true, incomingCustomFields: cf });
    expect(named.customFields.source).toBe('api');
    for (const p of [named, buildSessionMergePlan({ ...base, incomingCustomFields: cf })]) {
      expect(JSON.stringify(p)).not.toContain('forwardedAt');
    }
  });

  it('no usable numeric counter => no guard, journey keys degrade to last-write-wins (not dropped)', () => {
    for (const ec of [undefined, 'x', NaN, null]) {
      const p = buildSessionMergePlan({ ...base, incomingCustomFields: { ...cf, eventCount: ec } });
      expect(p.monotonic).toBeUndefined();
      expect(p.customFields).toMatchObject({ journey: 'a>b', clickLog: ['x'] });
    }
  });

  it('standard fields: non-empty only; attribution: lastTouch LWW, firstTouch/utm/clickIds/ids write-once', () => {
    const touch = { utm: { source: 'tt', medium: 'paid' }, clickIds: { gclid: 'g1' }, landingUrl: 'https://x' };
    const p = buildSessionMergePlan({
      ...base, incomingCustomFields: {}, touch,
      leadData: { ...base.leadData, firstName: ' Ann ', company: '', clientIp: '1.2.3.4', metaFbp: 'fb.1', lastTouch: touch },
    });
    expect(p.topLevel).toEqual({ firstName: 'Ann', lastTouch: touch });
    expect(p.topLevelIfNotExists).toMatchObject({
      firstTouch: touch, utmSource: 'tt', utmMedium: 'paid', clientIp: '1.2.3.4', metaFbp: 'fb.1', clickIds: { gclid: 'g1' },
    });
    expect(p.topLevel).not.toHaveProperty('email');
    expect(p.topLevel).not.toHaveProperty('linkedin');
  });
});
