import { FakeLimitStore } from '../fakeLimitStore';
import { setLimitStoreForTests } from '../limitStore';
import { cooldownKey, dailyCapKey, hourlyCapKey, isWithinCallWindow, phoneMarkerKey, reserveCallSlot } from '../hotLeadCallLimits';
import type { HotLeadCallConfig } from '../../hotLeadCallConfig';

const config = {
  maxCallsPerHour: 6, maxCallsPerDay: 20, memberCooldownMinutes: 2,
  callingHours: { start: '08:00', end: '21:00', timezone: 'America/Chicago' },
} as HotLeadCallConfig;
const NOW = new Date('2026-10-19T17:00:00Z');
const PHONE = '+15555550100';
let limits: FakeLimitStore;

beforeEach(() => {
  process.env.JWT_SECRET = 'test-secret';
  limits = new FakeLimitStore();
  setLimitStoreForTests(limits);
});
afterEach(() => setLimitStoreForTests(null));

describe('isWithinCallWindow', () => {
  const w = (start: string, end: string, timezone = 'America/Chicago') => ({ start, end, timezone });
  it('is start-inclusive and end-exclusive at minute granularity', () => {
    expect(isWithinCallWindow(w('08:00', '21:00'), new Date('2026-10-19T13:00:00Z'))).toBe(true);
    expect(isWithinCallWindow(w('08:00', '21:00'), new Date('2026-10-19T12:59:59Z'))).toBe(false);
    expect(isWithinCallWindow(w('08:00', '21:00'), new Date('2026-10-20T01:59:59Z'))).toBe(true);
    expect(isWithinCallWindow(w('08:00', '21:00'), new Date('2026-10-20T02:00:00Z'))).toBe(false);
  });
  it('wraps past midnight', () => {
    const win = w('21:00', '08:00');
    expect(isWithinCallWindow(win, new Date('2026-10-20T02:00:00Z'))).toBe(true); // 21:00 CDT
    expect(isWithinCallWindow(win, new Date('2026-10-20T05:00:00Z'))).toBe(true); // midnight CDT
    expect(isWithinCallWindow(win, new Date('2026-10-20T12:59:00Z'))).toBe(true); // 07:59 CDT
    expect(isWithinCallWindow(win, new Date('2026-10-20T13:00:00Z'))).toBe(false); // 08:00 CDT
  });
  it('follows DST in both directions in the stored zone', () => {
    const spring = w('02:30', '04:00'); // 02:00-03:00 does not exist on 2026-03-08
    expect(isWithinCallWindow(spring, new Date('2026-03-08T07:59:00Z'))).toBe(false); // 01:59 CST
    expect(isWithinCallWindow(spring, new Date('2026-03-08T08:00:00Z'))).toBe(true); // 03:00 CDT
    expect(isWithinCallWindow(spring, new Date('2026-03-08T09:00:00Z'))).toBe(false); // 04:00 CDT
    const fall = w('01:30', '02:30'); // 01:00-02:00 happens twice on 2026-11-01
    expect(isWithinCallWindow(fall, new Date('2026-11-01T06:30:00Z'))).toBe(true); // 01:30 CDT
    expect(isWithinCallWindow(fall, new Date('2026-11-01T07:00:00Z'))).toBe(false); // 01:00 CST
    expect(isWithinCallWindow(fall, new Date('2026-11-01T07:30:00Z'))).toBe(true); // 01:30 CST
    expect(isWithinCallWindow(fall, new Date('2026-11-01T08:30:00Z'))).toBe(false); // 02:30 CST
  });
  it('fails closed without a window', () => {
    expect(isWithinCallWindow(undefined, NOW)).toBe(false);
  });
});

describe('keys', () => {
  it('never contain the phone number and depend on org and phone', () => {
    const key = phoneMarkerKey('org-a', PHONE);
    expect(key).toMatch(/^hlc#phone#[0-9a-f]{64}$/);
    expect(key).not.toContain('5550100');
    expect(phoneMarkerKey('org-b', PHONE)).not.toBe(key);
    expect(phoneMarkerKey('org-a', '+15555550101')).not.toBe(key);
  });
  it('change with the server secret, so the table alone cannot be dictionary-attacked', () => {
    const before = phoneMarkerKey('org-a', PHONE);
    process.env.JWT_SECRET = 'other-secret';
    expect(phoneMarkerKey('org-a', PHONE)).not.toBe(before);
  });
  it('bucket the counters by UTC hour and by the org-local day', () => {
    expect(hourlyCapKey('org-a', NOW)).toBe('hlc#cap#h#org-a#2026-10-19T17');
    expect(dailyCapKey('org-a', 'America/Chicago', new Date('2026-10-20T04:59:00Z'))).toBe('hlc#cap#d#org-a#2026-10-19');
    expect(dailyCapKey('org-a', 'America/Chicago', new Date('2026-10-20T05:00:00Z'))).toBe('hlc#cap#d#org-a#2026-10-20');
    expect(cooldownKey('org-a')).toBe('hlc#cool#org-a');
  });
});

describe('reserveCallSlot', () => {
  it('names the first limit that refuses, in the documented order', async () => {
    const a = await reserveCallSlot({ orgId: 'o', phoneE164: PHONE, config, now: NOW });
    expect(a.ok).toBe(true);
    const sameEverything = await reserveCallSlot({ orgId: 'o', phoneE164: PHONE, config, now: NOW });
    expect(sameEverything).toEqual({ ok: false, reason: 'duplicate_phone' });
    const otherPhone = await reserveCallSlot({ orgId: 'o', phoneE164: '+15555550101', config, now: NOW });
    expect(otherPhone).toEqual({ ok: false, reason: 'owner_cooldown' });
  });

  it('a claim expires exactly at its ttl and not before', async () => {
    await reserveCallSlot({ orgId: 'o', phoneE164: PHONE, config, now: NOW });
    const at = (s: number) => new Date(NOW.getTime() + s * 1000);
    expect(await reserveCallSlot({ orgId: 'o', phoneE164: '+15555550101', config, now: at(119) })).toEqual({ ok: false, reason: 'owner_cooldown' });
    expect((await reserveCallSlot({ orgId: 'o', phoneE164: '+15555550101', config, now: at(120) })).ok).toBe(true);
  });

  it('stamps counters with an expiry beyond their window so the reaper never races a live window', async () => {
    await reserveCallSlot({ orgId: 'o', phoneE164: PHONE, config, now: NOW });
    const nowS = NOW.getTime() / 1000;
    expect(limits.counterExpiresAtS.get(hourlyCapKey('o', NOW))).toBeGreaterThanOrEqual(nowS + 3600);
    expect(limits.counterExpiresAtS.get(dailyCapKey('o', 'America/Chicago', NOW))).toBeGreaterThanOrEqual(nowS + 24 * 3600);
  });

  it('release returns counters and drops only its own claims', async () => {
    const r = await reserveCallSlot({ orgId: 'o', phoneE164: PHONE, config, now: NOW });
    if (!r.ok) throw new Error('expected a reservation');
    await r.release();
    expect([...limits.counters.values()]).toEqual([0, 0]);
    expect(limits.claims.size).toBe(0);
  });

  it('a stale release cannot drop a claim someone else took after expiry', async () => {
    const r = await reserveCallSlot({ orgId: 'o', phoneE164: PHONE, config, now: NOW });
    if (!r.ok) throw new Error('expected a reservation');
    const later = new Date(NOW.getTime() + 25 * 3600 * 1000);
    const second = await reserveCallSlot({ orgId: 'o', phoneE164: PHONE, config, now: later });
    expect(second.ok).toBe(true);
    await r.release();
    expect(limits.claims.has(phoneMarkerKey('o', PHONE))).toBe(true);
  });

  it('rolls back what it took when a later step throws, and rethrows', async () => {
    const original = limits.incrementBelow.bind(limits);
    limits.incrementBelow = async (...args) => { if (args[0].includes('#cap#d#')) throw new Error('ddb down'); return original(...args); };
    await expect(reserveCallSlot({ orgId: 'o', phoneE164: PHONE, config, now: NOW })).rejects.toThrow('ddb down');
    expect([...limits.counters.values()]).toEqual([0]);
    expect(limits.claims.size).toBe(0);
  });
});
