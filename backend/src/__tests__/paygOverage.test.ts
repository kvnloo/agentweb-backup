/**
 * ENG-668 — the pure PAYG admission rule, its switch, and its 429 copy.
 *
 * Billing invariant: PAYG only ever turns a `hard_threshold_reached` 429 into an admit when EVERY
 * condition holds; any one missing or unreadable keeps the 429. Each condition is knocked out in turn.
 */
import {
  createPaygOverageSwitch,
  evaluatePaygAdmission,
  paygCapMicroUsd,
  paygOverageThresholdMicroUsd,
  PAYG_OVERAGE_SETTING,
  validatePaygOverageTierConfig,
  type PaygOverageSettings,
} from '../services/paygOverage';
import type { LlmUsageModeDecision } from '../services/llmUsagePolicyService';
import { buildUsageBlockCopy } from '../utils/usageBlockCopy';

const USD = 1_000_000;
const PAUSED: LlmUsageModeDecision = { usageMode: 'paused', admissionAllowed: false, reason: 'hard_threshold_reached' };

const account = (over: Partial<PaygOverageSettings> = {}): PaygOverageSettings => ({
  enabled: true,
  capPercentOfPool: 50,
  capMicroUsd: 50 * USD,
  enabledBy: 'owner-1',
  updatedAt: '2026-10-01T00:00:00.000Z',
  version: 1,
  ...over,
});

/** Every admit condition true: $120 spent against a $100 pool, $50 cap => $20 overage, 40% of cap. */
const admitting = () => ({
  decision: PAUSED,
  switchOn: true,
  tier: { allowed: true, markupBps: 25_000 },
  account: account(),
  hasPaymentMethod: true as unknown,
  subscriptionStatus: 'active' as unknown,
  costUsedMicroUsd: 120 * USD,
  overageThresholdMicroUsd: 100 * USD,
});

describe('evaluatePaygAdmission', () => {
  it('admits past the pool as full_choice with reason payg_overage when every condition holds', () => {
    const result = evaluatePaygAdmission(admitting());
    expect(result.decision).toEqual({ usageMode: 'full_choice', admissionAllowed: true, reason: 'payg_overage' });
    expect(result.overage).toEqual({ overageMicroUsd: 20 * USD, capMicroUsd: 50 * USD, percentOfCap: 40 });
    expect(result.blockReason).toBeNull();
  });

  it('admits a trialing subscription too', () => {
    expect(evaluatePaygAdmission({ ...admitting(), subscriptionStatus: 'trialing' }).decision.admissionAllowed).toBe(true);
  });

  it.each<[string, Partial<ReturnType<typeof admitting>>]>([
    ['the switch is off', { switchOn: false }],
    ['the tier has no PAYG config', { tier: undefined }],
    ['the tier does not allow PAYG', { tier: { allowed: false, markupBps: 25_000 } }],
    ['the account never opted in', { account: undefined }],
    ['the account turned PAYG off', { account: account({ enabled: false }) }],
    ['the account is suspended', { account: account({ suspended: { reason: 'payment_failed', at: '2026-10-02T00:00:00.000Z' } }) }],
    ['no payment method is on file', { hasPaymentMethod: false }],
    ['the payment-method flag is unreadable', { hasPaymentMethod: undefined }],
    ['the subscription is past due', { subscriptionStatus: 'past_due' }],
    ['the subscription is canceled', { subscriptionStatus: 'canceled' }],
    ['the subscription status is missing', { subscriptionStatus: undefined }],
    ['the cap is reached exactly', { costUsedMicroUsd: 150 * USD }],
    ['the cap is exceeded', { costUsedMicroUsd: 400 * USD }],
    ['the stored cap is zero', { account: account({ capMicroUsd: 0 }) }],
    ['the stored cap is unreadable', { account: account({ capMicroUsd: Number.NaN }) }],
    ['spend is unreadable', { costUsedMicroUsd: Number.NaN }],
  ])('keeps the 429 when %s', (_label, override) => {
    const result = evaluatePaygAdmission({ ...admitting(), ...override });
    expect(result.decision).toBe(PAUSED);
    expect(result.decision.admissionAllowed).toBe(false);
  });

  it('names the cap as the reason once the cap is reached', () => {
    const result = evaluatePaygAdmission({ ...admitting(), costUsedMicroUsd: 150 * USD });
    expect(result.blockReason).toBe('payg_cap_reached');
    expect(result.overage).toEqual({ overageMicroUsd: 50 * USD, capMicroUsd: 50 * USD, percentOfCap: 100 });
  });

  it('names the suspension as the reason, ahead of the cap', () => {
    const result = evaluatePaygAdmission({
      ...admitting(),
      costUsedMicroUsd: 400 * USD,
      account: account({ suspended: { reason: 'dispute', at: '2026-10-02T00:00:00.000Z' } }),
    });
    expect(result.blockReason).toBe('payg_suspended');
  });

  it('gives no PAYG reason for a payment-method or subscription problem (the plain block copy applies)', () => {
    expect(evaluatePaygAdmission({ ...admitting(), hasPaymentMethod: false }).blockReason).toBeNull();
    expect(evaluatePaygAdmission({ ...admitting(), subscriptionStatus: 'past_due' }).blockReason).toBeNull();
  });

  it.each<LlmUsageModeDecision>([
    { usageMode: 'full_choice', admissionAllowed: true, reason: 'hard_cap_only' },
    { usageMode: 'full_choice', admissionAllowed: true, reason: 'policy_not_enforced' },
  ])('returns any non-hard-threshold decision untouched ($reason)', (decision) => {
    const result = evaluatePaygAdmission({ ...admitting(), decision });
    expect(result).toEqual({ decision, overage: null, blockReason: null });
    expect(result.decision).toBe(decision);
  });

  it('reports 99, not a rounded-up 100, just below the cap', () => {
    const result = evaluatePaygAdmission({ ...admitting(), costUsedMicroUsd: 150 * USD - 1 });
    expect(result.decision.admissionAllowed).toBe(true);
    expect(result.overage!.percentOfCap).toBe(99);
  });
});

describe('paygOverageThresholdMicroUsd — mid-month downgrade', () => {
  it('measures overage above the month\'s high-water mark when today\'s pool is lower', () => {
    expect(paygOverageThresholdMicroUsd({
      effectiveHardThresholdMicroUsd: 100 * USD,
      poolHighWater: { month: '2026-10', thresholdMicroUsd: 150 * USD },
      month: '2026-10',
    })).toBe(150 * USD);
  });

  it('ignores last month\'s high-water mark', () => {
    expect(paygOverageThresholdMicroUsd({
      effectiveHardThresholdMicroUsd: 100 * USD,
      poolHighWater: { month: '2026-09', thresholdMicroUsd: 150 * USD },
      month: '2026-10',
    })).toBe(100 * USD);
  });

  it('uses today\'s pool when it is the higher one (an upgrade or a top-up)', () => {
    expect(paygOverageThresholdMicroUsd({
      effectiveHardThresholdMicroUsd: 200 * USD,
      poolHighWater: { month: '2026-10', thresholdMicroUsd: 150 * USD },
      month: '2026-10',
    })).toBe(200 * USD);
  });

  it('a downgrade creates no retroactive overage: usage inside the old pool is still admitted at 0%', () => {
    // $120 spent; the pool was $150 earlier this month and is $100 after the downgrade.
    const result = evaluatePaygAdmission({
      ...admitting(),
      costUsedMicroUsd: 120 * USD,
      overageThresholdMicroUsd: paygOverageThresholdMicroUsd({
        effectiveHardThresholdMicroUsd: 100 * USD,
        poolHighWater: { month: '2026-10', thresholdMicroUsd: 150 * USD },
        month: '2026-10',
      }),
    });
    expect(result.decision.admissionAllowed).toBe(true);
    expect(result.overage).toEqual({ overageMicroUsd: 0, capMicroUsd: 50 * USD, percentOfCap: 0 });
  });
});

describe('paygCapMicroUsd', () => {
  it('is the chosen percentage of the pool, in whole micro-USD', () => {
    expect(paygCapMicroUsd(25, 150 * USD)).toBe(37.5 * USD);
    expect(paygCapMicroUsd(200, 150 * USD)).toBe(300 * USD);
    expect(paygCapMicroUsd(50, 3)).toBe(1);
  });
});

describe('validatePaygOverageTierConfig', () => {
  it('accepts a boolean and a markup of at least 1x', () => {
    expect(validatePaygOverageTierConfig({ allowed: true, markupBps: 10_000 })).toEqual([]);
  });

  it('rejects a non-boolean allowed and a below-cost or fractional markup', () => {
    expect(validatePaygOverageTierConfig({ allowed: 'yes' as any, markupBps: 9_999 })).toEqual([
      'allowed must be boolean',
      'markupBps must be an integer of at least 10000 (1x)',
    ]);
    expect(validatePaygOverageTierConfig({ allowed: true, markupBps: 12_500.5 })).toHaveLength(1);
  });
});

describe('createPaygOverageSwitch', () => {
  const build = (getSetting: jest.Mock, clock = { t: 0 }) => ({
    clock,
    sw: createPaygOverageSwitch({ getSetting, now: () => clock.t, log: jest.fn() }),
  });

  it.each([
    ['true', true],
    ['TRUE', false],
    [' true', false],
    ['1', false],
    [true, false],
  ])('treats settingValue %p as %p', async (value, expected) => {
    const { sw } = build(jest.fn().mockResolvedValue({ settingValue: value }));
    expect(await sw.isEnabled()).toBe(expected);
  });

  it('reads the payg_overage_enabled row and is off when it is absent', async () => {
    const getSetting = jest.fn().mockResolvedValue(null);
    const { sw } = build(getSetting);
    expect(await sw.isEnabled()).toBe(false);
    expect(getSetting).toHaveBeenCalledWith(PAYG_OVERAGE_SETTING);
    expect(PAYG_OVERAGE_SETTING).toBe('payg_overage_enabled');
  });

  it('is off when the very first read fails', async () => {
    const { sw } = build(jest.fn().mockRejectedValue(new Error('dynamo down')));
    expect(await sw.isEnabled()).toBe(false);
  });

  it('caches a read for 60s, then keeps the last-known value when a refresh fails', async () => {
    const getSetting = jest.fn().mockResolvedValue({ settingValue: 'true' });
    const { sw, clock } = build(getSetting);
    expect(await sw.isEnabled()).toBe(true);
    clock.t = 59_999;
    expect(await sw.isEnabled()).toBe(true);
    expect(getSetting).toHaveBeenCalledTimes(1);
    clock.t = 60_000;
    getSetting.mockRejectedValueOnce(new Error('blip'));
    expect(await sw.isEnabled()).toBe(true);
    expect(getSetting).toHaveBeenCalledTimes(2);
  });
});

describe('buildUsageBlockCopy — PAYG variants', () => {
  it('leaves the plain block copy exactly as it was (no reason key)', () => {
    const plain = buildUsageBlockCopy({ month: '2026-10' });
    expect(plain).not.toHaveProperty('reason');
    expect(buildUsageBlockCopy({ month: '2026-10', reason: undefined })).toEqual(plain);
    expect(buildUsageBlockCopy({ month: '2026-10', reason: null })).toEqual(plain);
  });

  it('says the pay-as-you-go limit was reached, with the reset date', () => {
    const copy = buildUsageBlockCopy({ month: '2026-10', reason: 'payg_cap_reached' });
    expect(copy.reason).toBe('payg_cap_reached');
    expect(copy.headline).toMatch(/pay-as-you-go limit/);
    expect(copy.resetDate).toBe('2026-11-01');
    expect(copy.message).toContain('November 1, 2026');
    expect(copy.message).toMatch(/pay-as-you-go limit/);
  });

  it('says pay-as-you-go is on hold for a payment problem', () => {
    const copy = buildUsageBlockCopy({ month: '2026-10', reason: 'payg_suspended' });
    expect(copy.reason).toBe('payg_suspended');
    expect(copy.body).toMatch(/payment/);
    expect(copy.message).toMatch(/payment method/);
  });

  it('falls back to undated wording when the month is unreadable', () => {
    const copy = buildUsageBlockCopy({ month: 'garbage', reason: 'payg_cap_reached' });
    expect(copy.resetDate).toBeNull();
    expect(copy.resetSentence).toBeNull();
    expect(copy.message).not.toMatch(/resets on/);
  });

  it('never states a dollar amount', () => {
    for (const reason of ['payg_cap_reached', 'payg_suspended'] as const) {
      expect(JSON.stringify(buildUsageBlockCopy({ month: '2026-10', reason }))).not.toMatch(/\$/);
    }
  });
});
