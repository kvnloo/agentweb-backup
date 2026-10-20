const mockRecord = jest.fn();
jest.mock('../services/usageRecorderService', () => ({
  recordVendorUsage: (...args: unknown[]) => mockRecord(...args),
}));

import { billableMinutes, recordCallUsage } from '../services/voice/voiceUsage';
import { getAllocatedRate } from '../utils/vendorRateCard';

const base = { userId: 'user-1', callSid: 'CA00000000000000000000000000000001', leg: 'lead' as const };

describe('billableMinutes', () => {
  it.each([
    [1, 1],
    [60, 1],
    [61, 2],
    [125, 3],
  ])('rounds %d seconds up to %d minutes', (seconds, minutes) => {
    expect(billableMinutes(seconds)).toBe(minutes);
  });

  it.each([0, -5, NaN, Infinity])('bills nothing for %p seconds', (seconds) => {
    expect(billableMinutes(seconds)).toBe(0);
  });
});

describe('recordCallUsage', () => {
  beforeEach(() => {
    mockRecord.mockReset();
    mockRecord.mockResolvedValue(undefined);
  });

  it('records one Twilio minute-priced event per call leg, priced by rateKey', async () => {
    await recordCallUsage({ ...base, durationSeconds: 61 });
    expect(mockRecord).toHaveBeenCalledTimes(1);
    const ctx = mockRecord.mock.calls[0][0];
    expect(ctx).toMatchObject({
      userId: 'user-1',
      provider: 'twilio',
      unit: 'minute',
      quantity: 2,
      rateKey: 'voice_minute_outbound',
    });
    expect(ctx).not.toHaveProperty('costUsd');
    expect(ctx).not.toHaveProperty('costSource');
  });

  it('uses a distinct idempotency key per leg and a stable one per (callSid, leg)', async () => {
    await recordCallUsage({ ...base, leg: 'member', durationSeconds: 30 });
    await recordCallUsage({ ...base, leg: 'lead', durationSeconds: 30 });
    await recordCallUsage({ ...base, leg: 'lead', durationSeconds: 30 });
    const keys = mockRecord.mock.calls.map((c) => c[0].idempotencyKey);
    expect(keys[0]).not.toBe(keys[1]);
    expect(keys[1]).toBe(keys[2]);
    expect(keys[1]).toContain(base.callSid);
  });

  it('records nothing for an unanswered leg with zero duration', async () => {
    await recordCallUsage({ ...base, durationSeconds: 0 });
    expect(mockRecord).not.toHaveBeenCalled();
  });

  it('skips and warns on a non-finite duration instead of metering garbage', async () => {
    const spy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    await recordCallUsage({ ...base, durationSeconds: NaN });
    expect(mockRecord).not.toHaveBeenCalled();
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it('names a rate key that exists on the card, so the event is priced rather than unpriced', async () => {
    await recordCallUsage({ ...base, durationSeconds: 10 });
    expect(getAllocatedRate('twilio', mockRecord.mock.calls[0][0].rateKey)).not.toBeNull();
  });
});
