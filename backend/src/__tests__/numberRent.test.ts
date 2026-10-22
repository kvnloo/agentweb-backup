/**
 * ENG-2614: the monthly rent of a hot-lead caller number is metered every calendar UTC month, not only the
 * month of the purchase. The purchase and the daily sweep share one idempotency key per (sid, month).
 */
jest.mock('../services/usageRecordDb', () => {
  const actual = jest.requireActual('../services/usageRecordDb');
  return {
    ...actual,
    usageRecordDb: {
      ...actual.usageRecordDb,
      incrementUsage: jest.fn(),
      incrementUsageWithSpendEvent: jest.fn(),
      incrementUsageWithDedupeMarker: jest.fn(),
    },
  };
});

import { orgDb, type Organization } from '../services/db';
import { usageRecordDb } from '../services/usageRecordDb';
import { resetDroppedWriteState, setDroppedWriteAlertSink } from '../services/usageWriteFailureMonitor';
import * as recorder from '../services/usageRecorderService';
import * as rateCard from '../utils/vendorRateCard';
import { isRentMeteringEnabled, meterNumberRent, numberRentKey, runNumberRentSweep } from '../services/voice/numberRent';

const SID_A = 'PN' + 'a'.repeat(32);
const SID_B = 'PN' + 'b'.repeat(32);
const SID_C = 'PN' + 'c'.repeat(32);

const org = (orgId: string, sid: string | undefined, ownerUserId: string | undefined = `owner-${orgId}`): Organization =>
  ({ orgId, ownerUserId, ...(sid ? { hotLeadCall: { twilioNumberSid: sid, twilioNumber: '+14155550123' } } : {}) }) as unknown as Organization;

const mockTxn = usageRecordDb.incrementUsageWithSpendEvent as jest.Mock;
const ENV = 'HOT_LEAD_CALL_RENT_METERING';

/** Only Date is faked: the recorder dates its event from `new Date()`. */
const setNow = (iso: string) => jest.useFakeTimers({
  now: new Date(iso),
  doNotFake: ['nextTick', 'setImmediate', 'clearImmediate', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'queueMicrotask'],
});

describe('numberRentKey', () => {
  it('is the UTC month of the clock', () => {
    expect(numberRentKey(SID_A, new Date('2026-01-31T23:59:59.999Z'))).toBe(`twilio:number:${SID_A}:2026-01`);
    expect(numberRentKey(SID_A, new Date('2026-02-01T00:00:00.000Z'))).toBe(`twilio:number:${SID_A}:2026-02`);
  });
  it('does not use the local time zone', () => {
    // 23:30 on Jan 31 in UTC-5 is already Feb 1 in UTC.
    expect(numberRentKey(SID_A, new Date('2026-01-31T23:30:00-05:00'))).toBe(`twilio:number:${SID_A}:2026-02`);
  });
});

describe('isRentMeteringEnabled', () => {
  afterEach(() => { delete process.env[ENV]; });
  it('is on by default and off for 0, false and off in any case', () => {
    expect(isRentMeteringEnabled()).toBe(true);
    for (const v of ['0', 'false', 'FALSE', 'off', ' Off ']) {
      process.env[ENV] = v;
      expect(isRentMeteringEnabled()).toBe(false);
    }
    for (const v of ['1', 'true', 'on', '']) {
      process.env[ENV] = v;
      expect(isRentMeteringEnabled()).toBe(true);
    }
  });
});

describe('meterNumberRent', () => {
  let record: jest.SpyInstance;
  beforeEach(() => { record = jest.spyOn(recorder, 'recordVendorUsage').mockResolvedValue(undefined); });
  afterEach(() => { jest.restoreAllMocks(); });

  it('records one unit of number_monthly_rent under the month key', async () => {
    await expect(meterNumberRent('u1', SID_A, new Date('2026-10-22T11:00:00Z'))).resolves.toBe('recorded');
    expect(record).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledWith({
      userId: 'u1', provider: 'twilio', operation: 'number_monthly_rent', feature: 'hot_lead_call', unit: 'number_month',
      quantity: 1, rateKey: 'number_monthly_rent', idempotencyKey: `twilio:number:${SID_A}:2026-10`,
    });
  });
  it('reports a missing rate-card unit without recording or throwing', async () => {
    jest.spyOn(rateCard, 'getRecordingUnit').mockReturnValue(null as never);
    const err = jest.spyOn(console, 'error').mockImplementation(() => {});
    await expect(meterNumberRent('u1', SID_A)).resolves.toBe('no_rate_unit');
    expect(record).not.toHaveBeenCalled();
    expect(err).toHaveBeenCalledWith(expect.stringContaining('missing from the rate card'));
  });
  it('turns a recorder exception into an error result', async () => {
    record.mockRejectedValue(new Error('boom'));
    jest.spyOn(console, 'error').mockImplementation(() => {});
    await expect(meterNumberRent('u1', SID_A)).resolves.toBe('error');
  });
});

describe('runNumberRentSweep', () => {
  let record: jest.SpyInstance;
  let listAll: jest.SpyInstance;
  const NOW = new Date('2026-10-22T11:00:00Z');
  beforeEach(() => {
    delete process.env[ENV];
    record = jest.spyOn(recorder, 'recordVendorUsage').mockResolvedValue(undefined);
    listAll = jest.spyOn(orgDb, 'listAll');
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => { jest.restoreAllMocks(); delete process.env[ENV]; });

  it('meters each org with a number to its owner with the first-month event fields', async () => {
    listAll.mockResolvedValue([org('o1', SID_A), org('o2', SID_B)]);
    const summary = await runNumberRentSweep(NOW);
    expect(summary).toMatchObject({ enabled: true, scanned: 2, withNumber: 2, metered: 2, failed: 0 });
    expect(record.mock.calls.map(c => c[0])).toEqual([
      { userId: 'owner-o1', provider: 'twilio', operation: 'number_monthly_rent', feature: 'hot_lead_call', unit: 'number_month', quantity: 1, rateKey: 'number_monthly_rent', idempotencyKey: `twilio:number:${SID_A}:2026-10` },
      { userId: 'owner-o2', provider: 'twilio', operation: 'number_monthly_rent', feature: 'hot_lead_call', unit: 'number_month', quantity: 1, rateKey: 'number_monthly_rent', idempotencyKey: `twilio:number:${SID_B}:2026-10` },
    ]);
  });
  it('uses the key a purchase made in the same month would use', async () => {
    listAll.mockResolvedValue([org('o1', SID_A)]);
    await meterNumberRent('purchaser', SID_A, NOW);
    await runNumberRentSweep(NOW);
    expect(record.mock.calls[0][0].idempotencyKey).toBe(record.mock.calls[1][0].idempotencyKey);
  });
  it('crosses the UTC month boundary', async () => {
    listAll.mockResolvedValue([org('o1', SID_A)]);
    await runNumberRentSweep(new Date('2026-01-31T23:59:59Z'));
    await runNumberRentSweep(new Date('2026-02-01T00:00:00Z'));
    expect(record.mock.calls.map(c => c[0].idempotencyKey)).toEqual([`twilio:number:${SID_A}:2026-01`, `twilio:number:${SID_A}:2026-02`]);
  });
  it('skips orgs without a number, with an invalid sid, or without an owner, and counts why', async () => {
    listAll.mockResolvedValue([org('none', undefined), org('bad', 'PN123'), org('noowner', SID_B, ''), org('ok', SID_C)]);
    const summary = await runNumberRentSweep(NOW);
    expect(summary).toMatchObject({ scanned: 4, withNumber: 3, metered: 1, skippedInvalidSid: 1, skippedNoOwner: 1, failed: 0 });
    expect(record).toHaveBeenCalledTimes(1);
    expect(record.mock.calls[0][0].userId).toBe('owner-ok');
  });
  it('keeps going when one org fails', async () => {
    listAll.mockResolvedValue([org('o1', SID_A), org('o2', SID_B), org('o3', SID_C)]);
    record.mockImplementation(async (ctx: { userId: string }) => { if (ctx.userId === 'owner-o2') throw new Error('boom'); });
    const summary = await runNumberRentSweep(NOW);
    expect(summary).toMatchObject({ withNumber: 3, metered: 2, failed: 1 });
    expect(record).toHaveBeenCalledTimes(3);
  });
  it('isolates an exception thrown outside the metering helper too', async () => {
    const throwing = { orgId: 'bad', ownerUserId: 'x', get hotLeadCall(): never { throw new Error('corrupt'); } } as unknown as Organization;
    listAll.mockResolvedValue([org('o1', SID_A)]);
    // A getter that throws only on the first read would escape the loop's guard; the guard must cover the org.
    listAll.mockResolvedValue([throwing, org('o1', SID_A)]);
    const summary = await runNumberRentSweep(NOW);
    expect(summary.metered).toBe(1);
    expect(summary.failed).toBe(1);
  });
  it('counts every number as skipped when the rate card has no unit', async () => {
    jest.spyOn(rateCard, 'getRecordingUnit').mockReturnValue(null as never);
    listAll.mockResolvedValue([org('o1', SID_A), org('o2', SID_B)]);
    const summary = await runNumberRentSweep(NOW);
    expect(summary).toMatchObject({ withNumber: 2, metered: 0, skippedNoRateUnit: 2, failed: 0 });
    expect(record).not.toHaveBeenCalled();
  });
  it('does nothing when the kill switch is off', async () => {
    process.env[ENV] = 'off';
    listAll.mockResolvedValue([org('o1', SID_A)]);
    const summary = await runNumberRentSweep(NOW);
    expect(summary.enabled).toBe(false);
    expect(listAll).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
  });
  it('lets a failed scan reach the caller', async () => {
    listAll.mockRejectedValue(new Error('scan failed'));
    await expect(runNumberRentSweep(NOW)).rejects.toThrow('scan failed');
  });
});

describe('runNumberRentSweep over the real recorder', () => {
  /** The spend-event table as DynamoDB keeps it: one row per (billingUserId, eventId). */
  const events = new Map<string, Record<string, unknown>>();
  beforeEach(() => {
    jest.restoreAllMocks();
    delete process.env[ENV];
    events.clear();
    resetDroppedWriteState();
    setDroppedWriteAlertSink(() => {});
    mockTxn.mockImplementation(async (_inc: unknown, ev: { billingUserId: string; eventId: string }) => {
      const k = `${ev.billingUserId}|${ev.eventId}`;
      if (events.has(k)) return 'duplicate';
      events.set(k, ev as unknown as Record<string, unknown>);
      return 'applied';
    });
    jest.spyOn(orgDb, 'listAll').mockResolvedValue([org('o1', SID_A)]);
  });
  afterEach(() => { jest.useRealTimers(); jest.restoreAllMocks(); });

  it('two sweeps in a month give one event, and the next month a second', async () => {
    setNow('2026-10-22T11:00:00Z');
    await runNumberRentSweep();
    jest.setSystemTime(new Date('2026-10-23T11:00:00Z'));
    await runNumberRentSweep();
    expect([...events.values()]).toHaveLength(1);
    expect([...events.values()][0]).toMatchObject({
      billingUserId: 'owner-o1', eventId: `twilio:number:${SID_A}:2026-10`, billingMonth: '2026-10', lifecycle: 'settled',
    });

    jest.setSystemTime(new Date('2026-11-01T11:00:00Z'));
    await runNumberRentSweep();
    expect([...events.keys()].sort()).toEqual([`owner-o1|twilio:number:${SID_A}:2026-10`, `owner-o1|twilio:number:${SID_A}:2026-11`]);
  });
  it('a sweep after the purchase in the same month adds nothing, and the events have the same shape', async () => {
    setNow('2026-10-22T09:00:00Z');
    await meterNumberRent('owner-o1', SID_A);
    const [purchase] = [...events.values()];
    jest.setSystemTime(new Date('2026-10-22T11:00:00Z'));
    await runNumberRentSweep();
    expect(events.size).toBe(1);

    // The same event written by the sweep in the next month differs only in its key, month and instant.
    jest.setSystemTime(new Date('2026-11-01T11:00:00Z'));
    await runNumberRentSweep();
    const next = [...events.values()].find(e => e.eventId === `twilio:number:${SID_A}:2026-11`)!;
    const strip = ({ eventId, billingMonth, occurredAt, ...rest }: Record<string, unknown>) => (void eventId, void billingMonth, void occurredAt, rest);
    expect(strip(next)).toEqual(strip(purchase));
    expect(purchase).toMatchObject({ provider: 'twilio', costMicroUsd: 1_150_000 });
  });
  it('writes nothing when the kill switch is off', async () => {
    process.env[ENV] = 'false';
    await runNumberRentSweep();
    expect(events.size).toBe(0);
  });
});
