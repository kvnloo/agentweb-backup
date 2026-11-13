/** Platform-wide daily call ceiling (ENG-2783): key, env parser, counter order and rollback, retry, and the operator alert. */
jest.mock('../../emailService', () => ({ emailService: { sendEmail: jest.fn(), escapeHtml: (t: string) => t } }));

import { FakeLimitStore } from '../../../__tests__/helpers/fakeLimitStore';
import { emailService } from '../../emailService';
import { setLimitStoreForTests } from '../limitStore';
import { dailyCapKey, hourlyCapKey, monthlyCapKey, phoneMarkerKey, platformDailyCapKey, reserveCallSlot } from '../hotLeadCallLimits';
import { notifyPlatformCap, platformMarker, platformNoticeKey } from '../hotLeadCallPlatformAlert';
import { HOT_LEAD_CALL_PLATFORM_DAILY, parsePlatformDailyMax, platformDailyMax, type HotLeadCallConfig } from '../../hotLeadCallConfig';

const config = {
  maxCallsPerHour: 6, maxCallsPerDay: 20, maxCallsPerMonth: 200, memberCooldownMinutes: 2,
  callingHours: { start: '08:00', end: '21:00', timezone: 'America/Chicago' },
} as HotLeadCallConfig;
const NOW = new Date('2026-10-19T17:00:00Z');
const ENV = 'HOT_LEAD_CALL_PLATFORM_DAILY_MAX';
const send = emailService.sendEmail as jest.Mock;
let limits: FakeLimitStore;
let errorSpy: jest.SpyInstance;
let warnSpy: jest.SpyInstance;

beforeEach(() => {
  process.env.JWT_SECRET = 'test-secret';
  delete process.env[ENV];
  delete process.env.HOT_LEAD_CALL_ALERT_EMAIL;
  limits = new FakeLimitStore();
  setLimitStoreForTests(limits);
  send.mockReset().mockResolvedValue('sent');
  errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => {
  setLimitStoreForTests(null);
  jest.restoreAllMocks();
  delete process.env[ENV];
  delete process.env.HOT_LEAD_CALL_ALERT_EMAIL;
});

describe('platformDailyCapKey', () => {
  it('buckets by the UTC calendar day, whatever any org zone says', () => {
    expect(platformDailyCapKey(new Date('2026-10-19T23:59:59Z'))).toBe('hlc#cap#g#2026-10-19');
    expect(platformDailyCapKey(new Date('2026-10-20T00:00:00Z'))).toBe('hlc#cap#g#2026-10-20');
  });
  it('has the notice keys of the same day', () => {
    expect(platformNoticeKey(80, '2026-10-19')).toBe('hlc#notify#g80#2026-10-19');
    expect(platformNoticeKey(100, '2026-10-19')).toBe('hlc#notify#g100#2026-10-19');
  });
});

describe('parsePlatformDailyMax', () => {
  it('uses the default (300) when unset or blank, without a warning', () => {
    expect(HOT_LEAD_CALL_PLATFORM_DAILY.default).toBe(300);
    expect(parsePlatformDailyMax(undefined)).toBe(300);
    expect(parsePlatformDailyMax('  ')).toBe(300);
    expect(warnSpy).not.toHaveBeenCalled();
  });
  it('accepts a positive integer and clamps to the sane maximum', () => {
    expect(parsePlatformDailyMax('50')).toBe(50);
    expect(parsePlatformDailyMax(' 1 ')).toBe(1);
    expect(parsePlatformDailyMax('100000')).toBe(100000);
    expect(parsePlatformDailyMax('999999999')).toBe(100000);
    expect(parsePlatformDailyMax('99999999999999999999')).toBe(300); // too long to trust: default
  });
  it.each(['0', '-5', '1.5', 'abc', '1e3', '0x10', '12abc'])('treats %p as invalid: default and ONE warn per distinct value', (raw) => {
    expect(parsePlatformDailyMax(raw)).toBe(300);
    expect(parsePlatformDailyMax(raw)).toBe(300);
    expect(warnSpy.mock.calls.filter(c => String(c[0]).includes('HOT_LEAD_CALL_PLATFORM_DAILY_MAX'))).toHaveLength(1);
  });
  it('platformDailyMax reads the environment on every call', () => {
    process.env[ENV] = '7';
    expect(platformDailyMax()).toBe(7);
    delete process.env[ENV];
    expect(platformDailyMax()).toBe(300);
  });
});

describe('reserveCallSlot with the platform ceiling', () => {
  const reserve = (over: Partial<Parameters<typeof reserveCallSlot>[0]> = {}) =>
    reserveCallSlot({ orgId: 'o', listId: 'list-a', leadId: 'lead-a', phoneE164: '+15555550100', config, now: NOW, ...over });
  const lead = (n: number) => ({ leadId: `lead-${n}`, phoneE164: `+1555555${String(100 + n).padStart(4, '0')}` });
  const orgCounters = () => [hourlyCapKey('o', NOW), dailyCapKey('o', 'America/Chicago', NOW), monthlyCapKey('o', 'America/Chicago', NOW)].map(k => limits.counters.get(k) ?? 0);

  it('counts every admitted lead across orgs and reports used and cap', async () => {
    process.env[ENV] = '10';
    const a = await reserve(lead(1));
    const b = await reserve({ ...lead(2), orgId: 'other' });
    expect(a).toMatchObject({ ok: true, platformUsed: 1, platformCap: 10 });
    expect(b).toMatchObject({ ok: true, platformUsed: 2, platformCap: 10 });
    expect(limits.counters.get(platformDailyCapKey(NOW))).toBe(2);
    expect(limits.counterExpiresAtS.get(platformDailyCapKey(NOW))).toBeGreaterThanOrEqual(NOW.getTime() / 1000 + 2 * 86400);
  });

  it('refuses the lead after the cap as platform_daily_cap and rolls back the phone marker and every org counter', async () => {
    process.env[ENV] = '1';
    expect((await reserve(lead(1))).ok).toBe(true);
    const before = orgCounters();
    expect(await reserve({ ...lead(2), orgId: 'other' })).toEqual({ ok: false, reason: 'platform_daily_cap', at: NOW });
    expect(orgCounters()).toEqual(before);
    expect(limits.counters.get(hourlyCapKey('other', NOW))).toBe(0);
    expect(limits.counters.get(dailyCapKey('other', 'America/Chicago', NOW))).toBe(0);
    expect(limits.counters.get(monthlyCapKey('other', 'America/Chicago', NOW))).toBe(0);
    expect(limits.claims.has(phoneMarkerKey('other', lead(2).phoneE164))).toBe(false);
    expect(limits.counters.get(platformDailyCapKey(NOW))).toBe(1);
  });

  it.each([
    ['org_hourly_cap', { maxCallsPerHour: 1 }],
    ['org_daily_cap', { maxCallsPerDay: 1 }],
    ['org_monthly_cap', { maxCallsPerMonth: 1 }],
  ])('an %s refusal never leaks into the platform counter', async (reason, over) => {
    const tight = { ...config, ...over } as HotLeadCallConfig;
    expect((await reserve({ ...lead(1), config: tight })).ok).toBe(true);
    expect(await reserve({ ...lead(2), config: tight })).toEqual({ ok: false, reason });
    expect(limits.counters.get(platformDailyCapKey(NOW))).toBe(1);
  });

  it('does not touch the platform counter at all when an org counter refuses first (no transient inflation)', async () => {
    const tight = { ...config, maxCallsPerHour: 1 } as HotLeadCallConfig;
    await reserve({ ...lead(1), config: tight });
    limits.keysTouched.length = 0;
    await reserve({ ...lead(2), config: tight });
    expect(limits.keysTouched).not.toContain(platformDailyCapKey(NOW));
  });

  it('a press-2 retry counts against the ceiling and cannot bypass it', async () => {
    process.env[ENV] = '2';
    expect((await reserve(lead(1))).ok).toBe(true);
    const retry = await reserve({ ...lead(1), retry: true });
    expect(retry).toMatchObject({ ok: true, platformUsed: 2 });
    // The ceiling is now spent: a second retry of the same lead, and a new lead, are both refused.
    expect(await reserve({ ...lead(1), retry: true })).toEqual({ ok: false, reason: 'platform_daily_cap', at: NOW });
    expect(await reserve(lead(3))).toEqual({ ok: false, reason: 'platform_daily_cap', at: NOW });
    expect(limits.counters.get(platformDailyCapKey(NOW))).toBe(2);
    // The refused retry kept the phone marker the first call took.
    expect(limits.claims.has(phoneMarkerKey('o', lead(1).phoneE164))).toBe(true);
  });

  it('reports the instant whose UTC day it counted, on success and on a platform refusal, so the alert keys the same day', async () => {
    process.env[ENV] = '1';
    const late = new Date('2026-10-19T23:59:59Z');
    const first = await reserve({ ...lead(1), now: late });
    const refused = await reserve({ ...lead(2), now: late });
    expect(first).toMatchObject({ ok: true });
    expect(first.ok && first.at).toEqual(late);
    expect(refused).toMatchObject({ ok: false, reason: 'platform_daily_cap' });
    expect(!refused.ok && refused.at).toEqual(late);
  });

  it('release gives the platform slot back', async () => {
    const r = await reserve(lead(1));
    if (!r.ok) throw new Error('expected a reservation');
    await r.release();
    expect(limits.counters.get(platformDailyCapKey(NOW))).toBe(0);
  });

  it('a new UTC day starts a fresh counter', async () => {
    process.env[ENV] = '1';
    expect((await reserve(lead(1))).ok).toBe(true);
    expect((await reserve({ ...lead(2), now: new Date('2026-10-19T23:59:00Z') })).ok).toBe(false);
    expect((await reserve({ ...lead(3), now: new Date('2026-10-20T00:00:00Z') })).ok).toBe(true);
  });

  it('rolls back and rethrows when the platform write throws', async () => {
    const original = limits.incrementBelow.bind(limits);
    limits.incrementBelow = async (...args) => { if (args[0].includes('#cap#g#')) throw new Error('ddb down'); return original(...args); };
    await expect(reserve(lead(1))).rejects.toThrow('ddb down');
    expect(orgCounters()).toEqual([0, 0, 0]);
    expect(limits.claims.size).toBe(0);
  });

  it('a failed read of the count never fails the reservation', async () => {
    const original = limits.read.bind(limits);
    limits.read = async (key: string) => { if (key.includes('#cap#g#')) throw new Error('read failed'); return original(key); };
    expect(await reserve(lead(1))).toMatchObject({ ok: true, platformUsed: undefined });
  });
});

describe('notifyPlatformCap', () => {
  const D = '2026-10-19';
  const markers = (spy: jest.SpyInstance) => spy.mock.calls.map(c => String(c[0]));

  it('alerts at 80% (ceil(0.8*cap)) with an ERROR marker, once per day, and not below it', async () => {
    process.env.HOT_LEAD_CALL_ALERT_EMAIL = 'ops@example.com';
    await notifyPlatformCap({ cap: 10, now: NOW, event: { kind: 'counted', used: 7 } });
    expect(errorSpy).not.toHaveBeenCalled();
    await Promise.all([8, 8, 9].map(used => notifyPlatformCap({ cap: 10, now: NOW, event: { kind: 'counted', used } })));
    expect(markers(errorSpy)).toEqual([`${platformMarker(80)} ${D} used=8 cap=10`]);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).toBe('ops@example.com');
    expect(limits.claims.has(platformNoticeKey(80, D))).toBe(true);
  });

  it('two concurrent calls of the 100% alert send once, whether counted or refused', async () => {
    process.env.HOT_LEAD_CALL_ALERT_EMAIL = 'ops@example.com';
    await Promise.all([
      notifyPlatformCap({ cap: 10, now: NOW, event: { kind: 'counted', used: 10 } }),
      notifyPlatformCap({ cap: 10, now: NOW, event: { kind: 'refused' } }),
      notifyPlatformCap({ cap: 10, now: NOW, event: { kind: 'refused' } }),
    ]);
    expect(markers(errorSpy).filter(m => m.startsWith('[hotLeadCall] PLATFORM daily cap 100%'))).toHaveLength(1);
    // The count that lands on the cap also owes the 80% level when none was sent (both reached levels are processed): one send per level.
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('a count that reaches the cap before any 80% alert still sends the 80% alert, then the 100% one (two concurrent reads of the cap)', async () => {
    process.env.HOT_LEAD_CALL_ALERT_EMAIL = 'ops@example.com';
    await Promise.all([
      notifyPlatformCap({ cap: 5, now: NOW, event: { kind: 'counted', used: 5 } }),
      notifyPlatformCap({ cap: 5, now: NOW, event: { kind: 'counted', used: 5 } }),
    ]);
    expect(markers(errorSpy).sort()).toEqual([`${platformMarker(100)} ${D} used=5 cap=5`, `${platformMarker(80)} ${D} used=5 cap=5`].sort());
    expect(limits.claims.has(platformNoticeKey(80, D))).toBe(true);
    expect(limits.claims.has(platformNoticeKey(100, D))).toBe(true);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('alerts again the next UTC day', async () => {
    await notifyPlatformCap({ cap: 10, now: NOW, event: { kind: 'refused' } });
    await notifyPlatformCap({ cap: 10, now: new Date('2026-10-20T00:00:01Z'), event: { kind: 'refused' } });
    expect(errorSpy).toHaveBeenCalledTimes(2);
  });

  it('a cap below 5 has no separate 80% level', async () => {
    await notifyPlatformCap({ cap: 4, now: NOW, event: { kind: 'counted', used: 3 } });
    expect(errorSpy).not.toHaveBeenCalled();
    await notifyPlatformCap({ cap: 4, now: NOW, event: { kind: 'counted', used: 4 } });
    expect(markers(errorSpy)[0]).toContain('PLATFORM daily cap 100%');
  });

  it('with the email env unset it logs the marker and sends nothing', async () => {
    await notifyPlatformCap({ cap: 10, now: NOW, event: { kind: 'refused' } });
    expect(markers(errorSpy)).toEqual([`${platformMarker(100)} ${D} used=10 cap=10`]);
    expect(send).not.toHaveBeenCalled();
  });

  it('never throws when the email fails (rejects or reports failed); the message carries no address', async () => {
    process.env.HOT_LEAD_CALL_ALERT_EMAIL = 'ops@example.com';
    send.mockRejectedValue(new Error('boom ops@example.com'));
    await expect(notifyPlatformCap({ cap: 10, now: NOW, event: { kind: 'refused' } })).resolves.toBeUndefined();
    send.mockResolvedValue('failed');
    await expect(notifyPlatformCap({ cap: 10, now: NOW, event: { kind: 'counted', used: 8 } })).resolves.toBeUndefined();
    expect(JSON.stringify([...warnSpy.mock.calls, ...errorSpy.mock.calls])).not.toContain('ops@example.com');
  });

  it('a failed send keeps the claim at both levels (no resend storm, the ERROR marker logs once per level per day)', async () => {
    process.env.HOT_LEAD_CALL_ALERT_EMAIL = 'ops@example.com';
    send.mockResolvedValue('failed');
    await notifyPlatformCap({ cap: 10, now: NOW, event: { kind: 'refused' } });
    await notifyPlatformCap({ cap: 10, now: NOW, event: { kind: 'refused' } });
    expect(send).toHaveBeenCalledTimes(1);
    expect(limits.claims.has(platformNoticeKey(100, D))).toBe(true);
    expect(markers(warnSpy).some(m => m.includes('platform cap 100% alert email failed'))).toBe(true);

    errorSpy.mockClear();
    await notifyPlatformCap({ cap: 10, now: NOW, event: { kind: 'counted', used: 8 } });
    await notifyPlatformCap({ cap: 10, now: NOW, event: { kind: 'counted', used: 9 } });
    expect(send).toHaveBeenCalledTimes(2); // one 100% attempt, one 80% attempt
    expect(limits.claims.has(platformNoticeKey(80, D))).toBe(true);
    expect(markers(errorSpy).filter(m => m.startsWith('[hotLeadCall] PLATFORM daily cap 80%'))).toHaveLength(1);
    expect(markers(warnSpy).some(m => m.includes('platform cap 80% alert email failed'))).toBe(true);
  });

  it('never throws when the limit store fails', async () => {
    limits.failNext = new Error('store down');
    await expect(notifyPlatformCap({ cap: 10, now: NOW, event: { kind: 'refused' } })).resolves.toBeUndefined();
  });

  it('puts no lead data, phone or org name in the log or email', async () => {
    process.env.HOT_LEAD_CALL_ALERT_EMAIL = 'ops@example.com';
    await notifyPlatformCap({ cap: 10, now: NOW, event: { kind: 'refused' } });
    expect(JSON.stringify([send.mock.calls, errorSpy.mock.calls])).not.toMatch(/\+\d{7,}|org-|lead-/);
  });
});
