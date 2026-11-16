import { decideDripSend, rampCap, nextUtcDayStart, DEFAULT_WARMUP_RAMP } from '../dripSequenceSendQuota';

const now = new Date('2026-10-18T22:15:00Z');
const tomorrow = new Date('2026-10-19T00:00:00Z');

describe('decideDripSend (ENG-2533)', () => {
  it('allows when under the effective cap', () => {
    expect(decideDripSend({ sentToday: 10, dailyCap: 200, senderAgeDays: 40, now })).toEqual({
      allow: true, reason: 'ok', effectiveCap: 200,
    });
  });

  it('daily_cap when configured cap reached, retryAt = next UTC day', () => {
    const d = decideDripSend({ sentToday: 200, dailyCap: 200, senderAgeDays: 40, now });
    expect(d).toEqual({ allow: false, reason: 'daily_cap', effectiveCap: 200, retryAt: tomorrow });
  });

  it('warmup_cap when ramp is below configured cap', () => {
    const d = decideDripSend({ sentToday: 20, dailyCap: 200, senderAgeDays: 1, now });
    expect(d).toEqual({ allow: false, reason: 'warmup_cap', effectiveCap: 20, retryAt: tomorrow });
    expect(decideDripSend({ sentToday: 19, dailyCap: 200, senderAgeDays: 1, now }).allow).toBe(true);
  });

  it('effective cap = min(configured, ramp)', () => {
    expect(decideDripSend({ sentToday: 0, dailyCap: 30, senderAgeDays: 7, now }).effectiveCap).toBe(30);
    expect(decideDripSend({ sentToday: 0, dailyCap: 300, senderAgeDays: 7, now }).effectiveCap).toBe(100);
  });

  it.each([
    null,
    undefined,
    { sentToday: -1, dailyCap: 10, senderAgeDays: 0, now },
    { sentToday: 0, dailyCap: 0, senderAgeDays: 0, now },
    { sentToday: 0, dailyCap: 1.5, senderAgeDays: 0, now },
    { sentToday: 0, dailyCap: 10, senderAgeDays: NaN, now },
    { sentToday: 0, dailyCap: 10, senderAgeDays: 0, now: new Date('bad') },
    { sentToday: 0, dailyCap: 10, senderAgeDays: 0, now, ramp: [] },
    { sentToday: 0, dailyCap: 10, senderAgeDays: 0, now, ramp: [{ fromDay: 2, cap: 5 }] },
    { sentToday: 0, dailyCap: 10, senderAgeDays: 0, now, ramp: [{ fromDay: 0, cap: 5 }, { fromDay: 0, cap: 9 }] },
    { sentToday: 0, dailyCap: 10, senderAgeDays: 0, now, ramp: [null] },
    { sentToday: 0, dailyCap: 10, senderAgeDays: 0, now, ramp: [{ fromDay: 0, cap: 5 }, null] },
  ])('fails closed on invalid config %#', (input) => {
    expect(decideDripSend(input as never)).toEqual({ allow: false, reason: 'invalid_config' });
  });

  it('default ramp steps and next UTC day across month boundary', () => {
    expect(rampCap(0)).toBe(20);
    expect(rampCap(13)).toBe(100);
    expect(rampCap(28, DEFAULT_WARMUP_RAMP)).toBe(Number.POSITIVE_INFINITY);
    expect(nextUtcDayStart(new Date('2026-10-31T23:59:59Z')).toISOString()).toBe('2026-11-01T00:00:00.000Z');
  });
});
