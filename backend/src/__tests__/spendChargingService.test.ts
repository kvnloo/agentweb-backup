/**
 * Tests for the ENG-1250 §2 charging API.
 *
 * The store (spendEventDb) is mocked here on purpose — its own invariants are
 * covered in spendEventDb.test.ts, and what matters at this layer is the
 * decisions: who gets billed, what the cost resolves to, whether a call is
 * AgentWeb's to bill at all, and that a failed vendor call voids rather than
 * charges.
 */
jest.mock('../services/spendEventDb', () => ({
  recordSpendEvent: jest.fn(),
  transitionSpendEvent: jest.fn(),
  getSpendEvent: jest.fn(),
}));

import {
  ChargeRequest,
  InvalidChargeQuantityError,
  UnpricedSpendError,
  chargeForCall,
  classify,
  recordSettledSpend,
  reserveSpend,
  resolveBillingSubject,
  resolveCost,
  settleSpend,
  voidSpend,
} from '../services/spendChargingService';
import { recordSpendEvent, transitionSpendEvent, getSpendEvent } from '../services/spendEventDb';
import { VENDOR_RATE_CARD_VERSION, setVendorRateOverridesForTests } from '../utils/vendorRateCard';

const mockRecord = recordSpendEvent as jest.Mock;
const mockTransition = transitionSpendEvent as jest.Mock;
const mockGet = getSpendEvent as jest.Mock;

const aRequest = (over: Partial<ChargeRequest> = {}): ChargeRequest => ({
  idempotencyKey: 'evt-1',
  subject: { actingUserId: 'user-1' },
  provider: 'you.com',
  operation: 'query',
  quantity: 1,
  ...over,
});

describe('spendChargingService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRecord.mockImplementation(async (event) => ({ stored: true, event }));
    mockTransition.mockResolvedValue(true);
    mockGet.mockResolvedValue(null);
  });

  describe('resolveBillingSubject (step 1)', () => {
    it('bills the acting user when no billing subject is given', () => {
      expect(resolveBillingSubject({ actingUserId: 'user-1' })).toEqual({
        billingUserId: 'user-1',
        actingUserId: 'user-1',
      });
    });

    it('marks onBehalfOf only when the payer differs from the actor', () => {
      const delegated = resolveBillingSubject({ actingUserId: 'member-2', billingUserId: 'owner-1' });
      expect(delegated).toMatchObject({ billingUserId: 'owner-1', onBehalfOf: 'member-2' });

      // An ordinary self-serve call must not look delegated.
      expect(resolveBillingSubject({ actingUserId: 'owner-1', billingUserId: 'owner-1' }))
        .not.toHaveProperty('onBehalfOf');
    });

    it('falls back to "system" for unattributable work, matching recordVendorUsage', () => {
      expect(resolveBillingSubject({ actingUserId: '' }).billingUserId).toBe('system');
    });
  });

  describe('resolveCost (step 3)', () => {
    it('prices from the rate card and stamps the card version', () => {
      const cost = resolveCost(aRequest({ provider: 'you.com', operation: 'query', quantity: 4 }));

      expect(cost.costSource).toBe('allocated');
      expect(cost.rateCardVersion).toBe(VENDOR_RATE_CARD_VERSION);
      expect(cost.costMicroUsd).toBe(50000); // 4 x $0.0125
      expect(cost.unit).toBe('query');
    });

    describe('with an admin rate override (ENG-2271)', () => {
      afterEach(() => setVendorRateOverridesForTests(null));

      it('prices and stamps from the same override snapshot', () => {
        setVendorRateOverridesForTests({ twilio: { voice_minute_outbound: 0.02 } }, '2026-11-01T00:00:00.000Z');
        const cost = resolveCost(aRequest({ provider: 'twilio', operation: 'voice_minute_outbound', quantity: 10 }));

        expect(cost.costMicroUsd).toBe(200000);
        expect(cost.rateCardVersion).toBe(`${VENDOR_RATE_CARD_VERSION}+ovr:2026-11-01T00:00:00.000Z`);
      });

      it('keeps the plain version for a key the override does not touch', () => {
        setVendorRateOverridesForTests({ twilio: { voice_minute_outbound: 0.02 } });
        const cost = resolveCost(aRequest({ provider: 'you.com', operation: 'query', quantity: 4 }));

        expect(cost.rateCardVersion).toBe(VENDOR_RATE_CARD_VERSION);
      });
    });

    it('lets a vendor-reported cost win over the card, with no rate version', () => {
      const cost = resolveCost(aRequest({ measuredCostUsd: 0.5 }));

      expect(cost.costSource).toBe('measured');
      expect(cost.costMicroUsd).toBe(500000);
      expect(cost.rateCardVersion).toBeUndefined();
    });

    it('throws on an unpriced unit rather than booking a silent $0', () => {
      expect(() => resolveCost(aRequest({ provider: 'brand_new_vendor', operation: 'thing' })))
        .toThrow(UnpricedSpendError);
    });

    it('rounds to whole micro-dollars', () => {
      // 3 x $0.0495 = $0.1485 -> 148500 micro-dollars, exactly
      const cost = resolveCost(aRequest({ provider: 'apollo', operation: 'email_reveal', quantity: 3 }));
      expect(Number.isInteger(cost.costMicroUsd)).toBe(true);
      expect(cost.costMicroUsd).toBe(148500);
    });

    it('rejects a negative measured cost', () => {
      expect(() => resolveCost(aRequest({ measuredCostUsd: -1 }))).toThrow(/non-negative/);
    });

    // CodeRabbit, PR #2788: coercing these to 0 produced costMicroUsd 0 with
    // costSource still "allocated" — a row that looks priced and re-derivable
    // but books nothing, on the revenue path.
    it.each([-5, Number.NaN, Number.POSITIVE_INFINITY])(
      'rejects quantity %s rather than booking a silent $0 allocated charge',
      (quantity) => {
        expect(() => resolveCost(aRequest({ quantity }))).toThrow(InvalidChargeQuantityError);
      },
    );

    it('still allows a zero quantity — buying nothing really does cost nothing', () => {
      const cost = resolveCost(aRequest({ quantity: 0 }));
      expect(cost.costMicroUsd).toBe(0);
      expect(cost.costSource).toBe('allocated');
    });

    it('an invalid quantity never reaches the store', async () => {
      await expect(reserveSpend(aRequest({ quantity: Number.NaN }))).rejects.toBeInstanceOf(
        InvalidChargeQuantityError,
      );
      expect(mockRecord).not.toHaveBeenCalled();
    });

    it('persists the validated quantity, not the raw request value', async () => {
      await reserveSpend(aRequest({ quantity: 7 }));
      expect(mockRecord.mock.calls[0][0].quantity).toBe(7);
    });
  });

  describe('classification (step 2)', () => {
    it('defaults to AgentWeb-paid', () => {
      expect(classify(aRequest())).toBe('agentweb_paid');
    });

    it.each(['customer_paid', 'platform_overhead'] as const)(
      'writes NO ledger row for %s — AC2 says these are not charged',
      async (classification) => {
        const result = await reserveSpend(aRequest({ classification }));

        expect(result).toEqual({ charged: false, classification });
        expect(mockRecord).not.toHaveBeenCalled();
      },
    );
  });

  describe('reserveSpend (step 4)', () => {
    it('writes a reserved event carrying the resolved cost and derived month', async () => {
      const result = await reserveSpend(
        aRequest({ occurredAt: '2026-09-07T10:00:00.000Z', subject: { actingUserId: 'u', billingUserId: 'owner-1' } }),
      );

      const event = mockRecord.mock.calls[0][0];
      expect(event.lifecycle).toBe('reserved');
      expect(event.billingMonth).toBe('2026-09');
      expect(event.billingUserId).toBe('owner-1');
      expect(event.onBehalfOf).toBe('u');
      expect(result).toMatchObject({ charged: true, stored: true });
    });

    it('derives billingMonth from occurredAt, never from the clock', async () => {
      // A backdated record must land in ITS month, not this one.
      await reserveSpend(aRequest({ occurredAt: '2026-01-15T00:00:00.000Z' }));
      expect(mockRecord.mock.calls[0][0].billingMonth).toBe('2026-01');
    });

    it('reports stored:false when the idempotency key was already charged', async () => {
      mockRecord.mockResolvedValue({ stored: false, event: { billingUserId: 'user-1', eventId: 'evt-1' } });

      const result = await reserveSpend(aRequest());

      expect(result).toMatchObject({ charged: true, stored: false });
    });
  });

  describe('recordSettledSpend', () => {
    it('writes a settled event directly for call sites that cannot reserve', async () => {
      await recordSettledSpend(aRequest({ measuredCostUsd: 0.25 }));

      expect(mockRecord.mock.calls[0][0].lifecycle).toBe('settled');
      expect(mockRecord.mock.calls[0][0].costMicroUsd).toBe(250000);
    });
  });

  describe('settleSpend / voidSpend (step 7)', () => {
    it('settles at the reserved amount when no actual cost is supplied', async () => {
      mockGet.mockResolvedValue({ billingUserId: 'owner-1', eventId: 'evt-1', costMicroUsd: 12500 });

      await settleSpend('owner-1', 'evt-1');

      expect(mockTransition).toHaveBeenCalledWith('owner-1', 'evt-1', 'settled', 12500);
    });

    it('settles at the actual amount when one is supplied', async () => {
      await settleSpend('owner-1', 'evt-1', 0.42);

      expect(mockTransition).toHaveBeenCalledWith('owner-1', 'evt-1', 'settled', 420000);
    });

    it('does not invent a settlement for an event that is gone', async () => {
      mockGet.mockResolvedValue(null);

      await expect(settleSpend('owner-1', 'missing')).resolves.toBe(false);
      expect(mockTransition).not.toHaveBeenCalled();
    });

    it('voids without a cost', async () => {
      await voidSpend('owner-1', 'evt-1');
      expect(mockTransition).toHaveBeenCalledWith('owner-1', 'evt-1', 'voided');
    });
  });

  describe('chargeForCall — the whole contract', () => {
    it('reserves, runs the call, then settles', async () => {
      const order: string[] = [];
      mockRecord.mockImplementation(async (event) => {
        order.push('reserve');
        return { stored: true, event };
      });
      mockTransition.mockImplementation(async (_u, _e, to) => {
        order.push(to);
        return true;
      });

      const result = await chargeForCall(aRequest(), async () => {
        order.push('vendor');
        return 'ok';
      });

      expect(result).toBe('ok');
      expect(order).toEqual(['reserve', 'vendor', 'settled']);
    });

    it('voids the reservation and rethrows when the vendor call fails', async () => {
      const boom = new Error('vendor exploded');

      await expect(
        chargeForCall(aRequest(), async () => {
          throw boom;
        }),
      ).rejects.toBe(boom);

      expect(mockTransition).toHaveBeenCalledWith(expect.any(String), 'evt-1', 'voided');
      expect(mockTransition).not.toHaveBeenCalledWith(expect.any(String), 'evt-1', 'settled', expect.anything());
    });

    it('settles the vendor-derived cost when a settleWith mapper is given', async () => {
      await chargeForCall(
        aRequest({ measuredCostUsd: 0 }),
        async () => ({ actualUsd: 1.25 }),
        (r) => r.actualUsd,
      );

      expect(mockTransition).toHaveBeenCalledWith(expect.any(String), 'evt-1', 'settled', 1250000);
    });

    // CodeRabbit, PR #2788: both of these sit on the wrapper every adapter is
    // meant to use, so a DynamoDB blip degraded every wrapped vendor call.
    it('re-throws the VENDOR error even when voiding the reservation also fails', async () => {
      const vendorError = new Error('vendor exploded');
      mockTransition.mockRejectedValue(new Error('DynamoDB throttled'));

      await expect(
        chargeForCall(aRequest(), async () => {
          throw vendorError;
        }),
      ).rejects.toBe(vendorError);
    });

    it('returns the vendor result even when settling fails — the money is already spent', async () => {
      mockTransition.mockRejectedValue(new Error('DynamoDB throttled'));

      // Throwing here would discard work the customer has paid for and invite a
      // duplicate vendor call. The reservation stays open for §8 instead.
      await expect(chargeForCall(aRequest(), async () => 'paid-for-result')).resolves.toBe('paid-for-result');
    });

    it('returns the vendor result even when the settleWith mapper itself throws', async () => {
      // settleWith is caller code reading a vendor response shape; it can throw
      // as easily as the ledger can, and the outcome must be the same.
      await expect(
        chargeForCall(aRequest(), async () => 'paid-for-result', () => {
          throw new Error('unexpected vendor response shape');
        }),
      ).resolves.toBe('paid-for-result');
    });

    it('runs the vendor call and charges nothing for customer-paid work', async () => {
      const call = jest.fn().mockResolvedValue('done');

      const result = await chargeForCall(aRequest({ classification: 'customer_paid' }), call);

      expect(result).toBe('done');
      expect(call).toHaveBeenCalledTimes(1);
      expect(mockRecord).not.toHaveBeenCalled();
      expect(mockTransition).not.toHaveBeenCalled();
    });

    it('propagates an unpriced vendor as an error instead of a $0 charge', async () => {
      const call = jest.fn();

      await expect(chargeForCall(aRequest({ provider: 'unknown_vendor' }), call)).rejects.toBeInstanceOf(
        UnpricedSpendError,
      );
      // and the vendor was never called, so nothing was spent unrecorded
      expect(call).not.toHaveBeenCalled();
    });
  });

  describe('no enforcement (ENG-1250 AC6)', () => {
    it('exposes no admission or balance surface at all', async () => {
      const api = await import('../services/spendChargingService');
      const names = Object.keys(api).join(' ').toLowerCase();

      // Step 5 lands with the monthly projection, and wiring it is Harsha's
      // call behind shadow-reconciliation evidence. If a future change adds an
      // admission check here, this test is the tripwire.
      expect(names).not.toMatch(/admit|admission|balance|remaining|enforce|pause|block/);
    });
  });
});
