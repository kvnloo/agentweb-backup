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

import { omit } from '../utils/omit';
import { orgDb, type Organization } from '../services/db';
import { usageRecordDb } from '../services/usageRecordDb';
import { resetDroppedWriteState, setDroppedWriteAlertSink } from '../services/usageWriteFailureMonitor';
import { __setBillingOwnerResolverForTests } from '../services/usageRecorderService';
import * as recorder from '../services/usageRecorderService';
import * as rateCard from '../utils/vendorRateCard';
import * as numberRent from '../services/voice/numberRent';
import { isRentMeteringEnabled, meterNumberRent, numberRentKey, runNumberRentSweep, type NumberRentSweepSummary } from '../services/voice/numberRent';
import { runNumberRentCron } from '../cron/numberRentCron';
import { provisionNumber } from '../services/voice/numberProvisioning';
import { FakeVoiceProvider } from './helpers/fakeVoiceProvider';
import { setVoiceProviderForTests } from '../services/voice/voiceProvider';
import { storedConfigFixture, teamMember } from './helpers/hotLeadCallFixtures';

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
    const base = { provider: 'twilio', operation: 'number_monthly_rent', feature: 'hot_lead_call', unit: 'number_month', quantity: 1, rateKey: 'number_monthly_rent' };
    expect(record.mock.calls.map(c => c[0])).toEqual([
      expect.objectContaining({ ...base, userId: 'owner-o1', idempotencyKey: `twilio:number:${SID_A}:2026-10` }),
      expect.objectContaining({ ...base, userId: 'owner-o2', idempotencyKey: `twilio:number:${SID_B}:2026-10` }),
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
  it('logs every skipped org loudly with its reason and no phone number', async () => {
    const err = console.error as unknown as jest.Mock;
    listAll.mockResolvedValue([org('bad', 'PN123'), org('noowner', SID_B, ''), org('ok', SID_C)]);
    await runNumberRentSweep(NOW);
    const lines = err.mock.calls.map(c => c.join(' '));
    expect(lines).toContainEqual(expect.stringMatching(/\[hotLeadCall\].*org bad.*invalid/));
    expect(lines).toContainEqual(expect.stringMatching(/\[hotLeadCall\].*org noowner.*no owner/));
    expect(lines.filter(l => l.includes('org ok'))).toEqual([]);
    expect(lines.join('\n')).not.toMatch(/\+1415/);
  });
  it('logs an org skipped for a missing rate-card unit exactly once', async () => {
    jest.spyOn(rateCard, 'getRecordingUnit').mockReturnValue(null as never);
    listAll.mockResolvedValue([org('o1', SID_A)]);
    await runNumberRentSweep(NOW);
    const lines = (console.error as unknown as jest.Mock).mock.calls.map(c => c.join(' '));
    expect(lines.filter(l => l.includes('rate card'))).toHaveLength(1);
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
    // The getter throws on every read of the org, outside the metering helper, so only the per-org guard can contain it.
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

/** Installs the spend-event table as DynamoDB keeps it, one row per (billingUserId, eventId), and resets shared state. */
function useFakeSpendStore(): Map<string, Record<string, unknown>> {
  const events = new Map<string, Record<string, unknown>>();
  jest.restoreAllMocks();
  delete process.env[ENV];
  resetDroppedWriteState();
  setDroppedWriteAlertSink(() => {});
  mockTxn.mockImplementation(async (_inc: unknown, ev: { billingUserId: string; eventId: string }) => {
    const k = `${ev.billingUserId}|${ev.eventId}`;
    if (events.has(k)) return 'duplicate';
    events.set(k, ev as unknown as Record<string, unknown>);
    return 'applied';
  });
  return events;
}

describe('runNumberRentSweep over the real recorder', () => {
  let events: Map<string, Record<string, unknown>>;
  beforeEach(() => {
    events = useFakeSpendStore();
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
    const strip = (e: Record<string, unknown>) => omit(e, ['eventId', 'billingMonth', 'occurredAt']);
    expect(strip(next)).toEqual(strip(purchase));
    expect(purchase).toMatchObject({ provider: 'twilio', costMicroUsd: 1_150_000 });
  });
  it('writes nothing when the kill switch is off', async () => {
    process.env[ENV] = 'false';
    await runNumberRentSweep();
    expect(events.size).toBe(0);
  });
});

describe('runNumberRentCron summary level', () => {
  const sweep = (over: Partial<NumberRentSweepSummary>) => jest.spyOn(numberRent, 'runNumberRentSweep').mockResolvedValue({
    enabled: true, scanned: 1, withNumber: 1, metered: 1, skippedNoOwner: 0, skippedInvalidSid: 0, skippedNoRateUnit: 0, failed: 0, ...over,
  });
  let info: jest.SpyInstance; let error: jest.SpyInstance;
  beforeEach(() => { jest.restoreAllMocks(); info = jest.spyOn(console, 'info').mockImplementation(() => {}); error = jest.spyOn(console, 'error').mockImplementation(() => {}); });
  afterEach(() => jest.restoreAllMocks());

  it('is info when nothing was skipped or failed', async () => {
    sweep({});
    await runNumberRentCron();
    expect(info).toHaveBeenCalledTimes(1);
    expect(error).not.toHaveBeenCalled();
  });
  it.each(['failed', 'skippedNoOwner', 'skippedInvalidSid', 'skippedNoRateUnit'] as const)('is an error when %s is above zero', async key => {
    sweep({ [key]: 1 });
    await runNumberRentCron();
    expect(error).toHaveBeenCalledTimes(1);
    expect(info).not.toHaveBeenCalled();
  });
});

describe('rent of a purchase and of the sweep land on the owner, whoever bought', () => {
  let events: Map<string, Record<string, unknown>>;
  const buy = (owner: string | undefined, buyer: string) => {
    const fake = new FakeVoiceProvider();
    fake.queueBuyNumberResult({ numberSid: SID_A, phoneNumber: '+14155550123' });
    setVoiceProviderForTests(fake);
    const config = storedConfigFixture({ enabled: false, twilioNumber: undefined, twilioNumberSid: undefined }, [teamMember('+14155550100')]);
    return provisionNumber({ org: { orgId: 'o1', ownerUserId: owner, hotLeadCall: config } as unknown as Organization, config: config as never, userId: buyer });
  };
  beforeEach(() => {
    events = useFakeSpendStore();
    jest.spyOn(orgDb, 'updateOrg').mockResolvedValue(undefined as never);
    jest.spyOn(console, 'error').mockImplementation(() => {});
    setNow('2026-10-22T09:00:00Z');
  });
  afterEach(() => { __setBillingOwnerResolverForTests(null); setVoiceProviderForTests(null); jest.useRealTimers(); jest.restoreAllMocks(); });

  it('an admin who pays for themselves buys, the sweep runs the same month: one event, billed to the owner', async () => {
    __setBillingOwnerResolverForTests(async id => id);
    await buy('owner-o1', 'adminSelfPay');
    jest.spyOn(orgDb, 'listAll').mockResolvedValue([org('o1', SID_A)]);
    jest.setSystemTime(new Date('2026-10-22T11:00:00Z'));
    await runNumberRentSweep();
    expect([...events.keys()]).toEqual([`owner-o1|twilio:number:${SID_A}:2026-10`]);
  });
  it('an admin pooled onto the owner: one event', async () => {
    __setBillingOwnerResolverForTests(async () => 'owner-o1');
    await buy('owner-o1', 'admin');
    jest.spyOn(orgDb, 'listAll').mockResolvedValue([org('o1', SID_A)]);
    await runNumberRentSweep();
    expect([...events.keys()]).toEqual([`owner-o1|twilio:number:${SID_A}:2026-10`]);
  });
  it('an org without an owner is charged to the buyer at purchase, logged, and skipped loudly by the sweep', async () => {
    __setBillingOwnerResolverForTests(async id => id);
    await buy(undefined, 'admin');
    expect([...events.keys()]).toEqual([`admin|twilio:number:${SID_A}:2026-10`]);
    const err = console.error as unknown as jest.Mock;
    expect(err.mock.calls.map(c => c.join(' '))).toContainEqual(expect.stringMatching(/org o1 has no owner/));
    err.mockClear();
    jest.spyOn(orgDb, 'listAll').mockResolvedValue([org('o1', SID_A, '')]);
    const summary = await runNumberRentSweep();
    expect(summary.skippedNoOwner).toBe(1);
    expect(events.size).toBe(1);
    expect(err.mock.calls.map(c => c.join(' '))).toContainEqual(expect.stringMatching(/org o1.*no owner/));
  });
});
