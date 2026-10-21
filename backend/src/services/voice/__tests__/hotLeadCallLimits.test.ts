import { FakeLimitStore } from '../../../__tests__/helpers/fakeLimitStore';
import { setLimitStoreForTests } from '../limitStore';
import { claimMemberCooldown, cooldownKey, dailyCapKey, hourlyCapKey, isWithinCallWindow, phoneMarkerKey, reserveCallSlot } from '../hotLeadCallLimits';
import type { HotLeadCallConfig } from '../../hotLeadCallConfig';
import { teamMember } from '../../../__tests__/helpers/hotLeadCallFixtures';

const config = {
  maxCallsPerHour: 6, maxCallsPerDay: 20, memberCooldownMinutes: 2,
  callingHours: { start: '08:00', end: '21:00', timezone: 'America/Chicago' },
} as HotLeadCallConfig;
const A = teamMember('+15555550100', { id: 'maaaaaaa' });
const B = teamMember('+15555550101', { id: 'mbbbbbbb' });
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
    expect(cooldownKey('org-a', 'maaaaaaa')).toBe('hlc#cool#org-a#maaaaaaa');
  });
});

describe('reserveCallSlot', () => {
  const reserve = (over: Partial<Parameters<typeof reserveCallSlot>[0]> = {}) =>
    reserveCallSlot({ orgId: 'o', listId: 'list-a', leadId: 'lead-a', phoneE164: PHONE, config, now: NOW, ...over });

  it('names the first limit that refuses, in the documented order', async () => {
    expect((await reserve()).ok).toBe(true);
    expect(await reserve({ leadId: 'lead-b' })).toEqual({ ok: false, reason: 'duplicate_phone' });
    const tight = { ...config, maxCallsPerHour: 1 } as HotLeadCallConfig;
    expect(await reserve({ leadId: 'lead-c', phoneE164: '+15555550101', config: tight })).toEqual({ ok: false, reason: 'org_hourly_cap' });
  });

  it('takes no member cooldown: that is claimed per attempt', async () => {
    await reserve();
    expect([...limits.claims.keys()].filter(k => k.startsWith('hlc#cool#'))).toEqual([]);
  });

  it('recognises a second dispatch of the same lead as in progress, not as a duplicate phone', async () => {
    await reserve();
    expect(await reserve()).toEqual({ ok: false, reason: 'in_progress' });
    expect(await reserve({ listId: 'list-b' })).toEqual({ ok: false, reason: 'duplicate_phone' });
  });

  it('lets the same lead retry once the first dispatch gave its slot back', async () => {
    const first = await reserve();
    if (!first.ok) throw new Error('expected a reservation');
    await first.release();
    expect((await reserve()).ok).toBe(true);
  });

  it('stamps counters with an expiry beyond their window so the reaper never races a live window', async () => {
    await reserve();
    const nowS = NOW.getTime() / 1000;
    expect(limits.counterExpiresAtS.get(hourlyCapKey('o', NOW))).toBeGreaterThanOrEqual(nowS + 3600);
    expect(limits.counterExpiresAtS.get(dailyCapKey('o', 'America/Chicago', NOW))).toBeGreaterThanOrEqual(nowS + 24 * 3600);
  });

  it('release returns counters and drops only its own claims', async () => {
    const r = await reserve();
    if (!r.ok) throw new Error('expected a reservation');
    await r.release();
    expect([...limits.counters.values()]).toEqual([0, 0]);
    expect(limits.claims.size).toBe(0);
  });

  it('a stale release cannot drop a claim someone else took after expiry', async () => {
    const r = await reserve();
    if (!r.ok) throw new Error('expected a reservation');
    const second = await reserve({ now: new Date(NOW.getTime() + 25 * 3600 * 1000) });
    expect(second.ok).toBe(true);
    await r.release();
    expect(limits.claims.has(phoneMarkerKey('o', PHONE))).toBe(true);
  });

  it('rolls back what it took when a later step throws, and rethrows', async () => {
    const original = limits.incrementBelow.bind(limits);
    limits.incrementBelow = async (...args) => { if (args[0].includes('#cap#d#')) throw new Error('ddb down'); return original(...args); };
    await expect(reserve()).rejects.toThrow('ddb down');
    expect([...limits.counters.values()]).toEqual([0]);
    expect(limits.claims.size).toBe(0);
  });
});

describe('claimMemberCooldown', () => {
  const claim = (memberId: string, now = NOW) => claimMemberCooldown({ orgId: 'o', memberId, config, now });

  it('claims per member: one member in cooldown does not block another', async () => {
    expect(await claim(A.id)).not.toBeNull();
    expect(await claim(A.id)).toBeNull();
    expect(await claim(B.id)).not.toBeNull();
    expect(limits.claims.has(cooldownKey('o', A.id))).toBe(true);
    expect(limits.claims.has(cooldownKey('o', B.id))).toBe(true);
  });

  it('expires exactly after memberCooldownMinutes and not before', async () => {
    await claim(A.id);
    const at = (s: number) => new Date(NOW.getTime() + s * 1000);
    expect(await claim(A.id, at(119))).toBeNull();
    expect(await claim(A.id, at(120))).not.toBeNull();
  });

  it('release gives the claim back, only while it is still the holder', async () => {
    const release = await claim(A.id);
    await release!();
    expect(limits.claims.size).toBe(0);
    const stale = await claim(A.id);
    const later = new Date(NOW.getTime() + 121 * 1000);
    await claim(A.id, later);
    await stale!();
    expect(limits.claims.has(cooldownKey('o', A.id))).toBe(true);
  });
});
