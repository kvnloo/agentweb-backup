/**
 * Tests for the ENG-1250 §9 observe-only dual-write.
 *
 * What matters here: the shadow row agrees with the row it mirrors (or the
 * whole reconciliation is noise), unpriced calls never become $0 spend, and a
 * failure can never escape into the metering path.
 */
jest.mock('../services/spendEventDb', () => ({
  recordSpendEvent: jest.fn(),
}));

import {
  VendorUsageMirrorInput,
  allocateMicroUsd,
  buildLlmSpendEvent,
  buildShadowEvent,
  isDualWriteEnabled,
  isLlmSpendEvent,
  mirrorVendorUsage,
  resolveRateProvenance,
} from '../services/spendLedgerDualWrite';
import { recordSpendEvent } from '../services/spendEventDb';
import type { SpendEvent } from '../services/spendEventDb';
import { VENDOR_RATE_CARD_VERSION, setVendorRateOverridesForTests } from '../utils/vendorRateCard';

const mockRecord = recordSpendEvent as jest.Mock;
const AT = '2026-09-07T10:00:00.000Z';

const anInput = (over: Partial<VendorUsageMirrorInput> = {}): VendorUsageMirrorInput => ({
  userId: 'user-1',
  provider: 'you.com',
  operation: 'query',
  feature: 'agent-search',
  unit: 'query',
  quantity: 1,
  costSource: 'allocated',
  costUsd: 0.0125,
  ...over,
});

describe('spendLedgerDualWrite', () => {
  const originalEnv = process.env.SPEND_LEDGER_DUAL_WRITE;

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.SPEND_LEDGER_DUAL_WRITE;
    mockRecord.mockImplementation(async (event) => ({ stored: true, event }));
  });
  afterAll(() => {
    if (originalEnv === undefined) delete process.env.SPEND_LEDGER_DUAL_WRITE;
    else process.env.SPEND_LEDGER_DUAL_WRITE = originalEnv;
  });

  describe('kill switch', () => {
    it('defaults ON so shadow evidence actually accumulates', () => {
      expect(isDualWriteEnabled()).toBe(true);
    });

    it('is disabled only by the exact string "false"', () => {
      process.env.SPEND_LEDGER_DUAL_WRITE = 'false';
      expect(isDualWriteEnabled()).toBe(false);
      process.env.SPEND_LEDGER_DUAL_WRITE = 'true';
      expect(isDualWriteEnabled()).toBe(true);
      process.env.SPEND_LEDGER_DUAL_WRITE = '0';
      expect(isDualWriteEnabled()).toBe(true);
    });

    it('writes nothing when disabled', async () => {
      process.env.SPEND_LEDGER_DUAL_WRITE = 'false';

      await expect(mirrorVendorUsage(anInput(), AT)).resolves.toEqual({ status: 'skipped', reason: 'disabled' });
      expect(mockRecord).not.toHaveBeenCalled();
    });
  });

  describe('the shadow row agrees with the row it mirrors', () => {
    // If these two roundings ever diverge, every §8 comparison reports drift
    // that is really one number rounded two ways. The cases below are chosen to
    // DISCRIMINATE: 0.0495 rounds and floors identically, so it would pass
    // against the wrong implementation and prove nothing.
    it.each([
      [0.0495, 49500],
      [0.0000125, 13], // rounds up; a floor would give 12
      [0.0000004, 0],
      [-0.5, 0], // clamped, not carried through as negative money
    ])('uses the SAME micro-dollar arithmetic as recordVendorUsage: $%s -> %s micro', (costUsd, expected) => {
      const built = buildShadowEvent(anInput({ costUsd }), AT) as { event: SpendEvent };

      expect(built.event.costMicroUsd).toBe(Math.max(0, Math.round((costUsd || 0) * 1e6)));
      expect(built.event.costMicroUsd).toBe(expected);
    });

    it('resolves the billing subject the same way (billingUserId || userId || system)', () => {
      const explicit = buildShadowEvent(anInput({ userId: 'u', billingUserId: 'owner' }), AT) as { event: SpendEvent };
      expect(explicit.event).toMatchObject({ billingUserId: 'owner', actingUserId: 'u' });
      // Passed through, NOT derived from payer != actor the way the charging
      // service derives it. Shadow parity is the goal here: recordVendorUsage
      // only writes onBehalfOf when its caller supplied one, so deriving it
      // would make the two rails disagree on rows that are otherwise identical.
      expect(explicit.event.onBehalfOf).toBeUndefined();

      const fallback = buildShadowEvent(anInput({ userId: 'u', billingUserId: undefined }), AT) as { event: SpendEvent };
      expect(fallback.event.billingUserId).toBe('u');

      const system = buildShadowEvent(anInput({ userId: undefined, billingUserId: undefined }), AT) as { event: SpendEvent };
      expect(system.event.billingUserId).toBe('system');
    });

    it('carries onBehalfOf and sessionId through', () => {
      const built = buildShadowEvent(anInput({ onBehalfOf: 'member-2', sessionId: 's-9' }), AT) as { event: SpendEvent };

      expect(built.event.onBehalfOf).toBe('member-2');
      expect(built.event.references).toEqual({ sessionId: 's-9' });
    });

    it('records settled, not reserved — the vendor call already happened', () => {
      const built = buildShadowEvent(anInput(), AT) as { event: SpendEvent };
      expect(built.event.lifecycle).toBe('settled');
    });

    it('derives billingMonth from the same instant', () => {
      const built = buildShadowEvent(anInput(), '2026-01-31T23:59:59.999Z') as { event: SpendEvent };
      expect(built.event.billingMonth).toBe('2026-01');
    });
  });

  describe('unpriced calls', () => {
    it('are skipped, never written as $0 spend', async () => {
      const built = buildShadowEvent(anInput({ costSource: 'unpriced', costUsd: undefined }), AT);

      expect(built).toEqual({ skip: 'unpriced' });
      await expect(mirrorVendorUsage(anInput({ costSource: 'unpriced' }), AT)).resolves.toEqual({
        status: 'skipped',
        reason: 'unpriced',
      });
      expect(mockRecord).not.toHaveBeenCalled();
    });

    it('a priced $0 call IS still recorded — zero from a known rate is real', async () => {
      await mirrorVendorUsage(anInput({ costSource: 'allocated', costUsd: 0 }), AT);

      expect(mockRecord).toHaveBeenCalledTimes(1);
      expect(mockRecord.mock.calls[0][0].costMicroUsd).toBe(0);
    });
  });

  describe('rate provenance (§5)', () => {
    it('stamps the card version when the card can price it', () => {
      expect(resolveRateProvenance('you.com', 'query')).toBe(VENDOR_RATE_CARD_VERSION);
      expect(resolveRateProvenance('apollo', 'email_reveal')).toBe(VENDOR_RATE_CARD_VERSION);
    });

    it('stamps the override version when an admin override priced the unit', () => {
      setVendorRateOverridesForTests({ twilio: { voice_minute_outbound: 0.02 } }, '2026-11-01T00:00:00.000Z');
      try {
        expect(resolveRateProvenance('twilio', 'voice_minute_outbound'))
          .toBe(`${VENDOR_RATE_CARD_VERSION}+ovr:2026-11-01T00:00:00.000Z`);
        expect(resolveRateProvenance('twilio', 'number_monthly_rent')).toBe(VENDOR_RATE_CARD_VERSION);
      } finally {
        setVendorRateOverridesForTests(null);
      }
    });

    it('prefers the version the caller priced with over a fresh lookup', () => {
      // The override changed between pricing and mirroring: the event must carry the version of
      // the rate that produced its amount.
      setVendorRateOverridesForTests({ twilio: { voice_minute_outbound: 0.02 } }, '2026-11-02T00:00:00.000Z');
      try {
        const built = buildShadowEvent(
          anInput({ provider: 'twilio', operation: 'voice_minute_outbound', rateCardVersion: VENDOR_RATE_CARD_VERSION }),
          AT,
        ) as { event: SpendEvent };
        expect(built.event.rateCardVersion).toBe(VENDOR_RATE_CARD_VERSION);
      } finally {
        setVendorRateOverridesForTests(null);
      }
    });

    it('does NOT claim the card priced X/Twitter, which it deliberately excludes', () => {
      // ENG-703 scope note: X rates live in twitterPricing.ts, not the card.
      expect(resolveRateProvenance('twitter', 'post_read')).toBe('caller:twitter');
    });

    it('omits the version entirely for a vendor-measured cost', () => {
      const built = buildShadowEvent(anInput({ costSource: 'measured' }), AT) as { event: SpendEvent };
      expect(built.event.rateCardVersion).toBeUndefined();
    });

    it('always sets a version for an allocated cost, so the event is never unattributable', () => {
      const carded = buildShadowEvent(anInput({ provider: 'you.com', operation: 'query' }), AT) as { event: SpendEvent };
      const uncarded = buildShadowEvent(anInput({ provider: 'twitter', operation: 'post_read' }), AT) as { event: SpendEvent };

      expect(carded.event.rateCardVersion).toBeTruthy();
      expect(uncarded.event.rateCardVersion).toBeTruthy();
    });
  });

  describe('idempotency', () => {
    it('uses a call-site token when one is supplied', () => {
      const built = buildShadowEvent(anInput({ idempotencyKey: 'vendor-req-42' }), AT) as { event: SpendEvent };
      expect(built.event.eventId).toBe('vendor-req-42');
    });

    it('generates a marked id when none is — retries duplicate, matching the live rail', () => {
      const a = buildShadowEvent(anInput(), AT) as { event: SpendEvent };
      const b = buildShadowEvent(anInput(), AT) as { event: SpendEvent };

      expect(a.event.eventId).toMatch(/^gen:/);
      expect(a.event.eventId).not.toBe(b.event.eventId);
    });

    it('reports a replayed token as duplicate rather than a second charge', async () => {
      mockRecord.mockResolvedValue({ stored: false, event: { eventId: 'vendor-req-42' } });

      const result = await mirrorVendorUsage(anInput({ idempotencyKey: 'vendor-req-42' }), AT);

      expect(result.status).toBe('duplicate');
    });
  });

  describe('fail-open', () => {
    it('never throws when the ledger write fails', async () => {
      mockRecord.mockRejectedValue(new Error('DynamoDB is down'));

      await expect(mirrorVendorUsage(anInput(), AT)).resolves.toEqual({
        status: 'failed',
        reason: 'DynamoDB is down',
      });
    });

    it('never throws even when building the event itself blows up', async () => {
      // The whole function is inside its try, not just the store call. It runs
      // fire-and-forget from a hot metering path, so a rejection escaping it
      // becomes an unhandled promise rejection and takes the process down --
      // the shadow ledger killing the rail it observes.
      await expect(mirrorVendorUsage(anInput(), null as unknown as string)).resolves.toMatchObject({
        status: 'failed',
      });
      expect(mockRecord).not.toHaveBeenCalled();
    });

    it('never throws when the event is rejected as invalid', async () => {
      mockRecord.mockRejectedValue(new Error('billingMonth disagrees with occurredAt'));

      await expect(mirrorVendorUsage(anInput(), AT)).resolves.toMatchObject({ status: 'failed' });
    });
  });
});

// ── ENG-1934: LLM ledger coverage ───────────────────────────────────────────

describe('isLlmSpendEvent (ENG-1934)', () => {
  it('recognises only the two LLM units', () => {
    expect(isLlmSpendEvent({ unit: 'llm_token' })).toBe(true);
    expect(isLlmSpendEvent({ unit: 'llm_generation' })).toBe(true);
    for (const vendorUnit of ['query', 'render', 'solve', '1k_characters', 'token', 'generation']) {
      expect(isLlmSpendEvent({ unit: vendorUnit })).toBe(false);
    }
  });
});

describe('buildLlmSpendEvent generation count (ENG-1934)', () => {
  const input = {
    actingUserId: 'u', billingUserId: 'o', provider: 'openai', model: 'gpt-image-1', feature: 'f',
    totalTokens: 0, perGeneration: true, costMicroUsd: 120_000, costSource: 'allocated' as const,
    rateProvenance: 'caller:agent-engine',
  };

  it('records how many generations a grouped cost covers', () => {
    const built = buildLlmSpendEvent({ ...input, generationCount: 3 }, '2026-09-14T10:00:00.000Z');
    expect('event' in built && built.event).toMatchObject({ unit: 'llm_generation', quantity: 3, costMicroUsd: 120_000 });
  });

  it('defaults to one generation for a single in-process call', () => {
    const built = buildLlmSpendEvent(input, '2026-09-14T10:00:00.000Z');
    expect('event' in built && built.event.quantity).toBe(1);
  });
});

describe('allocateMicroUsd (ENG-1934)', () => {
  const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

  it('four parts of 0.51 micro-dollars sum to the total of 2, not 4 (CodeRabbit, PR #2904)', () => {
    const shares = allocateMicroUsd(2, [0.51, 0.51, 0.51, 0.51]);
    expect(sum(shares)).toBe(2);
    expect(shares.every((x) => x >= 0)).toBe(true);
  });

  it('always sums exactly to the total and never goes negative, across awkward splits', () => {
    const cases: Array<[number, number[]]> = [
      [10, [1, 1, 1]],
      [1, [0.3, 0.3, 0.4]],
      [1_000_003, [0.1234567, 0.8765433]],
      [7, [5, 0, 2]],
      [0, [1, 2, 3]],
    ];
    for (const [total, weights] of cases) {
      const shares = allocateMicroUsd(total, weights);
      expect(sum(shares)).toBe(total);
      expect(shares.every((x) => Number.isInteger(x) && x >= 0)).toBe(true);
    }
  });

  it('splits in proportion to the parts', () => {
    expect(allocateMicroUsd(1_000_000, [3, 1])).toEqual([750_000, 250_000]);
  });

  it('gives the whole total to the first part when no weight is positive', () => {
    expect(allocateMicroUsd(5, [0, 0])).toEqual([5, 0]);
    expect(allocateMicroUsd(5, [])).toEqual([]);
  });
});
