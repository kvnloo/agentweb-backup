/**
 * ENG-1929 — vendor pricing happens inside recordVendorUsage.
 *
 * Call sites used to compute `costUsd: computeAllocatedCost(...)` inline. That
 * argument is evaluated BEFORE the fire-and-forget call, so a missing rate threw
 * into the vendor request itself and failed the user's search or render. These
 * tests hold the recorder to the ticket's criteria:
 *   1. No vendor call can fail because its own cost could not be computed.
 *   2. An unpriced unit is still reported loudly and never recorded as $0
 *      (ENG-703 AC2 preserved).
 */
jest.mock('../services/usageRecordDb', () => {
  const actual = jest.requireActual('../services/usageRecordDb');
  return {
    ...actual,
    usageRecordDb: {
      ...actual.usageRecordDb,
      incrementUsage: jest.fn(),
      incrementUsageWithSpendEvent: jest.fn(),
    },
  };
});

import {
  recordVendorUsage,
  __resetUnpricedVendorReportsForTests,
  __setBillingOwnerResolverForTests,
} from '../services/usageRecorderService';
import { usageRecordDb } from '../services/usageRecordDb';
import { resetDroppedWriteState, setDroppedWriteAlertSink } from '../services/usageWriteFailureMonitor';
import { getAllocatedRate, setVendorRateOverridesForTests, VENDOR_RATE_CARD_VERSION } from '../utils/vendorRateCard';

const mockTxn = usageRecordDb.incrementUsageWithSpendEvent as jest.Mock;
const mockPlain = usageRecordDb.incrementUsage as jest.Mock;

const base = {
  userId: 'user-1',
  provider: 'apollo',
  operation: 'email_reveal',
  feature: 'crm_enrichment',
  unit: 'reveal',
  quantity: 4,
};

describe('recordVendorUsage prices from a rateKey (ENG-1929)', () => {
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    resetDroppedWriteState();
    setDroppedWriteAlertSink(() => {});
    __resetUnpricedVendorReportsForTests();
    mockTxn.mockResolvedValue('applied');
    mockPlain.mockResolvedValue(undefined);
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => errorSpy.mockRestore());

  it('prices quantity x the card rate, recorded as allocated on both rails', async () => {
    await recordVendorUsage({ ...base, rateKey: 'email_reveal' });

    const rate = getAllocatedRate('apollo', 'email_reveal')!;
    expect(rate).toBeGreaterThan(0);
    const [increment, event] = mockTxn.mock.calls[0];
    expect(increment).toMatchObject({ costSource: 'allocated', costMicroUsd: Math.round(4 * rate * 1e6) });
    expect(event).toMatchObject({
      costSource: 'allocated',
      costMicroUsd: Math.round(4 * rate * 1e6),
      rateCardVersion: VENDOR_RATE_CARD_VERSION,
    });
  });

  it('an admin override prices the call and its event carries the override version', async () => {
    setVendorRateOverridesForTests({ twilio: { voice_minute_outbound: 0.02 } }, '2026-11-01T00:00:00.000Z');
    try {
      await recordVendorUsage({ ...base, provider: 'twilio', operation: 'voice_minute_outbound', unit: 'minute', quantity: 10, rateKey: 'voice_minute_outbound' });
    } finally {
      setVendorRateOverridesForTests(null);
    }
    const [increment, event] = mockTxn.mock.calls[0];
    expect(increment.costMicroUsd).toBe(200000);
    expect(event).toMatchObject({
      costMicroUsd: 200000,
      rateCardVersion: `${VENDOR_RATE_CARD_VERSION}+ovr:2026-11-01T00:00:00.000Z`,
    });
  });

  it('the event is stamped with the version of the rate that priced it, even if the override changes before the ledger write', async () => {
    setVendorRateOverridesForTests({ twilio: { voice_minute_outbound: 0.02 } }, '2026-11-01T00:00:00.000Z');
    // The billing-owner lookup runs between pricing and the ledger event being built.
    __setBillingOwnerResolverForTests(async (id: string) => {
      setVendorRateOverridesForTests({ twilio: { voice_minute_outbound: 0.03 } }, '2026-11-02T00:00:00.000Z');
      return id;
    });
    try {
      await recordVendorUsage({ ...base, userId: 'user-race', provider: 'twilio', operation: 'voice_minute_outbound', unit: 'minute', quantity: 10, rateKey: 'voice_minute_outbound' });
    } finally {
      __setBillingOwnerResolverForTests(null);
      setVendorRateOverridesForTests(null);
    }
    const [, event] = mockTxn.mock.calls[0];
    expect(event.costMicroUsd).toBe(200000); // priced at 0.02
    expect(event.rateCardVersion).toBe(`${VENDOR_RATE_CARD_VERSION}+ovr:2026-11-01T00:00:00.000Z`);
  });

  it('AC1: an unpriced key never throws — not synchronously, not as a rejection', async () => {
    let returned: Promise<void> | undefined;
    expect(() => {
      returned = recordVendorUsage({ ...base, rateKey: 'no-such-rate' });
    }).not.toThrow();
    await expect(returned).resolves.toBeUndefined();
  });

  it('AC2: an unpriced key is recorded unpriced — never as $0 allocated, and with no spend event', async () => {
    await recordVendorUsage({ ...base, rateKey: 'no-such-rate' });

    expect(mockTxn).not.toHaveBeenCalled();
    expect(mockPlain).toHaveBeenCalledTimes(1);
    expect(mockPlain.mock.calls[0][0]).toMatchObject({ costSource: 'unpriced', costMicroUsd: 0 });
  });

  it('AC2: an unpriced key is reported loudly, once per key per process', async () => {
    await recordVendorUsage({ ...base, rateKey: 'no-such-rate' });
    await recordVendorUsage({ ...base, rateKey: 'no-such-rate' });
    await recordVendorUsage({ ...base, provider: 'not-a-vendor', rateKey: 'x' });

    const loud = errorSpy.mock.calls.map((c) => String(c[0])).filter((m) => m.includes('UNPRICED vendor unit'));
    expect(loud).toEqual([
      expect.stringContaining('apollo:no-such-rate'),
      expect.stringContaining('not-a-vendor:x'),
    ]);
  });

  it('a negative, zero or non-finite quantity prices at $0 — never a negative charge', async () => {
    for (const quantity of [-3, 0, Number.NaN]) {
      mockTxn.mockClear();
      await recordVendorUsage({ ...base, quantity, rateKey: 'email_reveal' });
      expect(mockTxn.mock.calls[0][0].costMicroUsd).toBe(0);
    }
  });

  it('a pre-priced figure (costSource + costUsd) is recorded unchanged', async () => {
    await recordVendorUsage({ ...base, provider: 'twitter', costSource: 'allocated', costUsd: 0.015 });

    expect(mockTxn.mock.calls[0][0]).toMatchObject({ costSource: 'allocated', costMicroUsd: 15_000 });
  });
});
