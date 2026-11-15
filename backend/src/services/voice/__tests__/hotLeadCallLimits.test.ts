import { FakeLimitStore } from '../../../__tests__/helpers/fakeLimitStore';
import { setLimitStoreForTests } from '../limitStore';
import { claimMemberCooldown, cooldownKey, dailyCapKey, hourlyCapKey, isWithinCallWindow, localMonth, monthlyCapKey, phoneMarkerKey, reserveCallSlot } from '../hotLeadCallLimits';
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
    expect([...limits.counters.values()]).toEqual([0, 0, 0, 0]);
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

describe('reserveCallSlot for a press-2 retry (retry: true, ENG-2783)', () => {
  const reserve = (over: Partial<Parameters<typeof reserveCallSlot>[0]> = {}) =>
    reserveCallSlot({ orgId: 'o', listId: 'list-a', leadId: 'lead-a', phoneE164: PHONE, config, now: NOW, ...over });
  // Computed per use: the key is an HMAC under JWT_SECRET, which the suite sets in beforeEach.
  const markerKey = (): string => phoneMarkerKey('o', PHONE);

  it('accepts the marker this same lead took for its first call (in_progress is bypassed), takes fresh counters and keeps the marker', async () => {
    await reserve();
    const holder = limits.claims.get(markerKey())?.token;
    expect(holder).toMatch(/^list-a#lead-a#/);
    expect(await reserve()).toEqual({ ok: false, reason: 'in_progress' }); // without the flag
    const slot = await reserve({ retry: true });
    expect(slot.ok).toBe(true);
    expect(limits.counters.get(hourlyCapKey('o', NOW))).toBe(2); // the first call's slot and the retry's
    expect(limits.claims.get(markerKey())?.token).toBe(holder);
    if (slot.ok) await slot.release();
    expect(limits.counters.get(hourlyCapKey('o', NOW))).toBe(1); // only what the retry took is given back
    expect(limits.claims.get(markerKey())?.token).toBe(holder);
  });

  it('still refuses a marker held by ANOTHER lead as duplicate_phone', async () => {
    await reserve({ leadId: 'lead-b' });
    expect(await reserve({ retry: true })).toEqual({ ok: false, reason: 'duplicate_phone' });
    expect(await reserve({ retry: true, listId: 'list-b', leadId: 'lead-a' })).toEqual({ ok: false, reason: 'duplicate_phone' });
  });

  it('takes the marker itself when the first call\'s has expired', async () => {
    await reserve();
    const later = new Date(NOW.getTime() + 25 * 3600_000);
    expect((await reserve({ retry: true, now: later })).ok).toBe(true);
    expect(limits.claims.get(markerKey())?.token).toMatch(/^list-a#lead-a#/);
  });

  it('still obeys the counters: a full hourly cap refuses the retry', async () => {
    await reserve();
    const tight = { ...config, maxCallsPerHour: 1 } as HotLeadCallConfig;
    expect(await reserve({ retry: true, config: tight })).toEqual({ ok: false, reason: 'org_hourly_cap' });
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

describe('monthly cap (ENG-2783)', () => {
  const capped = (cap: number, over: Partial<HotLeadCallConfig> = {}) => ({ ...config, maxCallsPerHour: 30, maxCallsPerDay: 100, maxCallsPerMonth: cap, ...over }) as HotLeadCallConfig;
  let n = 0;
  // A fresh number per lead: the phone marker would otherwise refuse the repeat first.
  const reserve = (cfg: HotLeadCallConfig, now: Date = NOW) =>
    reserveCallSlot({ orgId: 'o', listId: 'list-a', leadId: `lead-${n}`, phoneE164: `+1555555${String(1000 + n++).padStart(4, '0')}`, config: cfg, now });
  beforeEach(() => { n = 0; });

  it('admits cap - 1 and cap leads, refuses the next, and names org_monthly_cap', async () => {
    const cfg = capped(3);
    for (let i = 0; i < 3; i++) expect((await reserve(cfg)).ok).toBe(true);
    expect(await reserve(cfg)).toEqual({ ok: false, reason: 'org_monthly_cap' });
    expect(limits.counters.get(monthlyCapKey('o', 'America/Chicago', NOW))).toBe(3);
  });

  it('reports the month\'s count after this lead was counted', async () => {
    const cfg = capped(5);
    expect(await reserve(cfg)).toMatchObject({ ok: true, monthlyUsed: 1 });
    expect(await reserve(cfg)).toMatchObject({ ok: true, monthlyUsed: 2 });
  });

  it('gives the hourly, daily and phone slots back when the monthly cap refuses, and its own counter does not move', async () => {
    const cfg = capped(1);
    await reserve(cfg);
    const hour = hourlyCapKey('o', NOW);
    const day = dailyCapKey('o', 'America/Chicago', NOW);
    const claimsBefore = limits.claims.size;
    expect(await reserve(cfg)).toEqual({ ok: false, reason: 'org_monthly_cap' });
    expect(limits.counters.get(hour)).toBe(1);
    expect(limits.counters.get(day)).toBe(1);
    expect(limits.counters.get(monthlyCapKey('o', 'America/Chicago', NOW))).toBe(1);
    expect(limits.claims.size).toBe(claimsBefore);
  });

  it('does not take the monthly counter when the hourly or daily cap refused first', async () => {
    const cfg = capped(5, { maxCallsPerHour: 1 });
    await reserve(cfg);
    expect(await reserve(cfg)).toEqual({ ok: false, reason: 'org_hourly_cap' });
    expect(limits.counters.get(monthlyCapKey('o', 'America/Chicago', NOW))).toBe(1);
  });

  it('release() gives the monthly slot back', async () => {
    const r = await reserve(capped(1));
    if (!r.ok) throw new Error('expected a reservation');
    await r.release();
    expect(limits.counters.get(monthlyCapKey('o', 'America/Chicago', NOW))).toBe(0);
    expect((await reserve(capped(1))).ok).toBe(true);
  });

  it('treats a config without the field as the default of 150', async () => {
    const noField = { ...capped(1), maxCallsPerHour: 1000, maxCallsPerDay: 1000 } as Partial<HotLeadCallConfig>;
    delete noField.maxCallsPerMonth;
    for (let i = 0; i < 150; i++) expect((await reserve(noField as HotLeadCallConfig)).ok).toBe(true);
    expect(await reserve(noField as HotLeadCallConfig)).toEqual({ ok: false, reason: 'org_monthly_cap' });
  });

  it('expires the counter about 40 days out', async () => {
    await reserve(capped(5));
    expect(limits.counterExpiresAtS.get(monthlyCapKey('o', 'America/Chicago', NOW))).toBe(Math.floor(NOW.getTime() / 1000) + 40 * 86400);
  });

  describe('the month is the org-local calendar month', () => {
    it.each([
      ['Chicago, last second of October local (CDT)', 'America/Chicago', '2026-11-01T04:59:59Z', '2026-10'],
      ['Chicago, first second of November local (CDT)', 'America/Chicago', '2026-11-01T05:00:00Z', '2026-11'],
      ['Chicago, UTC is already November but local is not', 'America/Chicago', '2026-11-01T03:00:00Z', '2026-10'],
      ['Los Angeles, the instant the DST-end day starts (PDT)', 'America/Los_Angeles', '2026-11-01T06:59:59Z', '2026-10'],
      ['Los Angeles, the same month after it starts', 'America/Los_Angeles', '2026-11-01T07:00:00Z', '2026-11'],
      ['Chicago, last second of March (CDT, after the 8 March spring-forward)', 'America/Chicago', '2026-04-01T04:59:59Z', '2026-03'],
      ['Chicago, first second of April', 'America/Chicago', '2026-04-01T05:00:00Z', '2026-04'],
      ['Chicago, 1 March in standard time (CST), just before the first instant', 'America/Chicago', '2026-03-01T05:59:59Z', '2026-02'],
      ['Chicago, 1 March in standard time (CST), first instant', 'America/Chicago', '2026-03-01T06:00:00Z', '2026-03'],
      ['Auckland (NZDT, UTC+13), last second of October local', 'Pacific/Auckland', '2026-10-31T10:59:59Z', '2026-10'],
      ['Auckland, first instant of November local (UTC is still 31 October)', 'Pacific/Auckland', '2026-10-31T11:00:00Z', '2026-11'],
      ['Kolkata (UTC+5:30), already the 1st locally', 'Asia/Kolkata', '2026-10-31T18:30:00Z', '2026-11'],
      ['Kolkata, one second before the local 1st', 'Asia/Kolkata', '2026-10-31T18:29:59Z', '2026-10'],
      ['Chicago, 31 Dec to 1 Jan (CST)', 'America/Chicago', '2027-01-01T06:00:00Z', '2027-01'],
    ])('%s', (_n, tz, iso, month) => {
      expect(localMonth(tz, new Date(iso))).toBe(month);
    });
    it('builds the key from orgId and the local month', () => {
      expect(monthlyCapKey('org-x', 'America/Chicago', new Date('2026-11-01T05:00:00Z'))).toBe('hlc#cap#m#org-x#2026-11');
    });

    it('starts a fresh count on the 1st in the org zone, not at UTC midnight', async () => {
      const cfg = capped(1);
      const lastOfOct = new Date('2026-11-01T03:00:00Z'); // 22:00 on 31 October in Chicago
      const firstOfNov = new Date('2026-11-01T05:00:00Z'); // 00:00 on 1 November in Chicago
      expect((await reserve(cfg, lastOfOct)).ok).toBe(true);
      expect(await reserve(cfg, new Date('2026-11-01T04:30:00Z'))).toEqual({ ok: false, reason: 'org_monthly_cap' });
      expect((await reserve(cfg, firstOfNov)).ok).toBe(true);
    });

    it('uses the UTC month when the org has no calling hours', async () => {
      const noHours = { ...capped(5) } as Partial<HotLeadCallConfig>;
      delete noHours.callingHours;
      expect((await reserve(noHours as HotLeadCallConfig, new Date('2026-10-31T23:30:00Z'))).ok).toBe(true);
      expect((await reserve(noHours as HotLeadCallConfig, new Date('2026-11-01T00:30:00Z'))).ok).toBe(true);
      expect([...limits.counters.keys()].filter(k => k.startsWith('hlc#cap#m#')).sort()).toEqual(['hlc#cap#m#o#2026-10', 'hlc#cap#m#o#2026-11']);
    });
  });

  it('a store failure on the monthly counter releases everything taken and throws', async () => {
    const cfg = capped(5);
    const real = limits.incrementBelow.bind(limits);
    limits.incrementBelow = async (key, cap, exp) => {
      if (key.startsWith('hlc#cap#m#')) throw new Error('ddb down');
      return real(key, cap, exp);
    };
    await expect(reserve(cfg)).rejects.toThrow('ddb down');
    expect([...limits.counters.values()]).toEqual([0, 0]);
    expect(limits.claims.size).toBe(0);
  });

  it('a failing count read for the notice never fails the reservation', async () => {
    limits.read = async () => { throw new Error('read down'); };
    const r = await reserve(capped(5));
    expect(r.ok).toBe(true);
    expect(r).not.toHaveProperty('monthlyUsed', expect.any(Number));
  });
});
