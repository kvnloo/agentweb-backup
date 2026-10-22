/**
 * ENG-668 — the pure PAYG admission rule, its switch, and its 429 copy.
 *
 * Billing invariant: PAYG only ever turns a `hard_threshold_reached` 429 into an admit when EVERY
 * condition holds; any one missing or unreadable keeps the 429. Each condition is knocked out in turn.
 * The cap is a percentage of the month's pool (never a stored dollar figure), and only usage after
 * opting in is overage.
 */
import {
  createExactTrueSwitch,
  evaluatePaygAdmission,
  paygCapMicroUsd,
  paygEffectiveBaselineMicroUsd,
  paygGrossOverageMicroUsd,
  paygOverageThresholdMicroUsd,
  PAYG_OVERAGE_SETTING,
  toCustomerPaygOverage,
  validatePaygOverageTierConfig,
  type PaygOverageSettings,
} from '../services/paygOverage';
import type { LlmUsageModeDecision } from '../services/llmUsagePolicyService';
import { buildUsageBlockCopy } from '../utils/usageBlockCopy';

const USD = 1_000_000;
const MONTH = '2026-10';
const PAUSED: LlmUsageModeDecision = { usageMode: 'paused', admissionAllowed: false, reason: 'hard_threshold_reached' };

const account = (over: Partial<PaygOverageSettings> = {}): PaygOverageSettings => ({
  enabled: true,
  capPercentOfPool: 50,
  updatedBy: 'owner-1',
  updatedAt: '2026-10-01T00:00:00.000Z',
  version: 1,
  ...over,
});

/** Every admit condition true: $120 spent against a $100 pool, 50% cap = $50 => $20 overage, 40% of cap. */
const admitting = () => ({
  decision: PAUSED,
  switchOn: true,
  tier: { allowed: true, markupBps: 25_000 },
  account: account(),
  hasPaymentMethod: true as unknown,
  subscriptionStatus: 'active' as unknown,
  costUsedMicroUsd: 120 * USD,
  overageThresholdMicroUsd: 100 * USD,
  month: MONTH,
});

describe('evaluatePaygAdmission', () => {
  it('admits past the pool as full_choice with reason payg_overage when every condition holds', () => {
    const result = evaluatePaygAdmission(admitting());
    expect(result.decision).toEqual({ usageMode: 'full_choice', admissionAllowed: true, reason: 'payg_overage' });
    expect(result.overage).toMatchObject({ overageMicroUsd: 20 * USD, capMicroUsd: 50 * USD, percentOfCap: 40 });
    expect(result.block).toBeNull();
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
    ['the stored cap percentage is not one of the four', { account: account({ capPercentOfPool: 75 as any }) }],
    ['the pool is zero (no cap can be derived)', { overageThresholdMicroUsd: 0 }],
    ['spend is unreadable', { costUsedMicroUsd: Number.NaN }],
    ['the opt-in baseline is unreadable', { account: account({ optIn: { month: MONTH, overageBaselineMicroUsd: Number.NaN } }) }],
  ])('keeps the 429 when %s', (_label, override) => {
    const result = evaluatePaygAdmission({ ...admitting(), ...override });
    expect(result.decision).toBe(PAUSED);
    expect(result.decision.admissionAllowed).toBe(false);
  });

  it('names the cap as the reason once the cap is reached', () => {
    const result = evaluatePaygAdmission({ ...admitting(), costUsedMicroUsd: 150 * USD });
    expect(result.block).toEqual({ reason: 'payg_cap_reached' });
    expect(result.overage).toMatchObject({ overageMicroUsd: 50 * USD, capMicroUsd: 50 * USD, percentOfCap: 100 });
  });

  it('names the suspension as the reason, ahead of the cap', () => {
    const result = evaluatePaygAdmission({
      ...admitting(),
      costUsedMicroUsd: 400 * USD,
      account: account({ suspended: { reason: 'dispute', at: '2026-10-02T00:00:00.000Z' } }),
    });
    expect(result.block).toEqual({ reason: 'payg_suspended', paygSuspendedReason: 'dispute' });
  });

  it('names a lost dispute and an unconfirmed payment (rv6 MINOR 4b / 5)', () => {
    const lost = evaluatePaygAdmission({
      ...admitting(), costUsedMicroUsd: 400 * USD,
      account: account({ suspended: { reason: 'dispute', at: '2026-10-02T00:00:00.000Z', lost: true } }),
    });
    expect(lost.block).toEqual({ reason: 'payg_suspended', paygSuspendedReason: 'dispute_lost' });
    const unconfirmed = evaluatePaygAdmission({
      ...admitting(), costUsedMicroUsd: 400 * USD,
      account: account({ suspended: { reason: 'payment_failed', at: '2026-10-02T00:00:00.000Z', unconfirmed: true } }),
    });
    expect(unconfirmed.block).toEqual({ reason: 'payg_suspended', paygSuspendedReason: 'payment_unconfirmed' });
  });

  it('says PAYG is on but not covering when no payment method is on file', () => {
    expect(evaluatePaygAdmission({ ...admitting(), hasPaymentMethod: false }).block)
      .toEqual({ reason: 'payg_inactive', paygInactiveReason: 'no_payment_method' });
  });

  it('says PAYG is on but not covering when the subscription is not live', () => {
    expect(evaluatePaygAdmission({ ...admitting(), subscriptionStatus: 'past_due' }).block)
      .toEqual({ reason: 'payg_inactive', paygInactiveReason: 'subscription_inactive' });
  });

  it.each<LlmUsageModeDecision>([
    { usageMode: 'full_choice', admissionAllowed: true, reason: 'hard_cap_only' },
    { usageMode: 'full_choice', admissionAllowed: true, reason: 'policy_not_enforced' },
  ])('returns any non-hard-threshold decision untouched ($reason)', (decision) => {
    const result = evaluatePaygAdmission({ ...admitting(), decision });
    expect(result).toEqual({ decision, overage: null, block: null });
    expect(result.decision).toBe(decision);
  });

  it('reports 99, not a rounded-up 100, just below the cap', () => {
    const result = evaluatePaygAdmission({ ...admitting(), costUsedMicroUsd: 150 * USD - 1 });
    expect(result.decision.admissionAllowed).toBe(true);
    expect(result.overage!.percentOfCap).toBe(99);
  });
});

describe('the cap is a percentage of the month\'s pool, never a frozen dollar figure', () => {
  it('derives the cap from the pool the check measures against', () => {
    expect(evaluatePaygAdmission({ ...admitting(), overageThresholdMicroUsd: 400 * USD, costUsedMicroUsd: 500 * USD }).overage)
      .toEqual({ overageMicroUsd: 100 * USD, capMicroUsd: 200 * USD, poolMicroUsd: 400 * USD, percentOfCap: 50 });
  });

  it('follows a smaller pool the next month (no cap carried over from a bigger plan)', () => {
    // 50% of a $100 pool is $50, whatever the pool was when the cap was chosen.
    const result = evaluatePaygAdmission({ ...admitting(), costUsedMicroUsd: 290 * USD });
    expect(result.decision.admissionAllowed).toBe(false);
    expect(result.block).toEqual({ reason: 'payg_cap_reached' });
    expect(result.overage!.capMicroUsd).toBe(50 * USD);
  });
});

describe('only usage after opting in is overage', () => {
  const optedIn = (baseline: number, month = MONTH) =>
    account({ capPercentOfPool: 200, optIn: { month, overageBaselineMicroUsd: baseline } });

  it('subtracts the overage already standing at opt-in for that month', () => {
    // Opted in at $250 spent on a $100 pool => $150 baseline. Now $260: $10 of new overage.
    const result = evaluatePaygAdmission({ ...admitting(), account: optedIn(150 * USD), costUsedMicroUsd: 260 * USD });
    expect(result.decision.admissionAllowed).toBe(true);
    expect(result.overage).toMatchObject({ overageMicroUsd: 10 * USD, capMicroUsd: 200 * USD, percentOfCap: 5 });
  });

  it('reads 0% right at the moment of opting in', () => {
    const result = evaluatePaygAdmission({ ...admitting(), account: optedIn(150 * USD), costUsedMicroUsd: 250 * USD });
    expect(result.overage).toMatchObject({ overageMicroUsd: 0, capMicroUsd: 200 * USD, percentOfCap: 0 });
  });

  it('ignores a baseline from an earlier month', () => {
    const result = evaluatePaygAdmission({ ...admitting(), account: optedIn(150 * USD, '2026-09'), costUsedMicroUsd: 260 * USD });
    expect(result.overage!.overageMicroUsd).toBe(160 * USD);
  });

  it('paygGrossOverageMicroUsd is what the baseline is recorded from', () => {
    expect(paygGrossOverageMicroUsd(250 * USD, 100 * USD)).toBe(150 * USD);
    expect(paygGrossOverageMicroUsd(80 * USD, 100 * USD)).toBe(0);
  });
});

describe('the opt-in baseline shrinks with pool growth instead of being subtracted twice', () => {
  const optIn = { month: MONTH, overageBaselineMicroUsd: 20 * USD, poolAtOptInMicroUsd: 100 * USD };

  it('upgrade: opted in at $120 on a $100 pool, pool now $200, $215 spent => 15% of a $100 cap', () => {
    // Gross overage is $15; the $100 of growth already absorbed the $20 standing at opt-in.
    expect(paygEffectiveBaselineMicroUsd({ optIn, poolHighWater: undefined, month: MONTH, poolMicroUsd: 200 * USD })).toBe(0);
    const result = evaluatePaygAdmission({
      ...admitting(),
      account: account({ optIn }),
      overageThresholdMicroUsd: 200 * USD,
      costUsedMicroUsd: 215 * USD,
    });
    expect(result.overage).toEqual({ overageMicroUsd: 15 * USD, capMicroUsd: 100 * USD, poolMicroUsd: 200 * USD, percentOfCap: 15 });
  });

  it('credits: a $50 top-up makes the pool $150, $165 spent => 20% of a $75 cap', () => {
    const result = evaluatePaygAdmission({
      ...admitting(),
      account: account({ optIn }),
      overageThresholdMicroUsd: 150 * USD,
      costUsedMicroUsd: 165 * USD,
    });
    expect(result.overage).toEqual({ overageMicroUsd: 15 * USD, capMicroUsd: 75 * USD, poolMicroUsd: 150 * USD, percentOfCap: 20 });
  });

  it('partial growth only partly absorbs the baseline', () => {
    expect(paygEffectiveBaselineMicroUsd({ optIn, poolHighWater: undefined, month: MONTH, poolMicroUsd: 110 * USD })).toBe(10 * USD);
  });

  it('a legacy opt-in (no poolAtOptIn) is read as measured against the month\'s high-water pool', () => {
    const legacy = { month: MONTH, overageBaselineMicroUsd: 20 * USD };
    expect(paygEffectiveBaselineMicroUsd({
      optIn: legacy, poolHighWater: { month: MONTH, thresholdMicroUsd: 100 * USD }, month: MONTH, poolMicroUsd: 150 * USD,
    })).toBe(0);
    // No high-water mark for the month: no growth can be established, the baseline applies whole.
    expect(paygEffectiveBaselineMicroUsd({ optIn: legacy, poolHighWater: undefined, month: MONTH, poolMicroUsd: 150 * USD })).toBe(20 * USD);
  });

  it('an opt-in from another month contributes nothing; an unreadable one is NaN (keeps the 429)', () => {
    expect(paygEffectiveBaselineMicroUsd({ optIn: { ...optIn, month: '2026-09' }, poolHighWater: undefined, month: MONTH, poolMicroUsd: 100 * USD })).toBe(0);
    expect(paygEffectiveBaselineMicroUsd({ optIn: { ...optIn, overageBaselineMicroUsd: Number.NaN }, poolHighWater: undefined, month: MONTH, poolMicroUsd: 100 * USD })).toBeNaN();
  });
});

describe('paygOverageThresholdMicroUsd — mid-month downgrade', () => {
  it('measures overage above the month\'s high-water mark when today\'s pool is lower', () => {
    expect(paygOverageThresholdMicroUsd({
      effectiveHardThresholdMicroUsd: 100 * USD,
      poolHighWater: { month: MONTH, thresholdMicroUsd: 150 * USD },
      month: MONTH,
    })).toBe(150 * USD);
  });

  it('ignores last month\'s high-water mark', () => {
    expect(paygOverageThresholdMicroUsd({
      effectiveHardThresholdMicroUsd: 100 * USD,
      poolHighWater: { month: '2026-09', thresholdMicroUsd: 150 * USD },
      month: MONTH,
    })).toBe(100 * USD);
  });

  it('uses today\'s pool when it is the higher one (an upgrade or a top-up)', () => {
    expect(paygOverageThresholdMicroUsd({
      effectiveHardThresholdMicroUsd: 200 * USD,
      poolHighWater: { month: MONTH, thresholdMicroUsd: 150 * USD },
      month: MONTH,
    })).toBe(200 * USD);
  });

  it('a downgrade creates no retroactive overage: usage inside the old pool is still admitted at 0%', () => {
    // $120 spent; the pool was $150 earlier this month and is $100 after the downgrade.
    const result = evaluatePaygAdmission({
      ...admitting(),
      costUsedMicroUsd: 120 * USD,
      overageThresholdMicroUsd: paygOverageThresholdMicroUsd({
        effectiveHardThresholdMicroUsd: 100 * USD,
        poolHighWater: { month: MONTH, thresholdMicroUsd: 150 * USD },
        month: MONTH,
      }),
    });
    expect(result.decision.admissionAllowed).toBe(true);
    expect(result.overage).toMatchObject({ overageMicroUsd: 0, capMicroUsd: 75 * USD, percentOfCap: 0 });
  });
});

describe('paygCapMicroUsd', () => {
  it('is the chosen percentage of the pool, in whole micro-USD', () => {
    expect(paygCapMicroUsd(25, 150 * USD)).toBe(37.5 * USD);
    expect(paygCapMicroUsd(200, 150 * USD)).toBe(300 * USD);
    expect(paygCapMicroUsd(50, 3)).toBe(1);
  });
});

describe('toCustomerPaygOverage', () => {
  it('keeps only the on/off state and the percentage cap', () => {
    expect(toCustomerPaygOverage({
      ...account({ capPercentOfPool: 100 }),
      poolHighWater: { month: MONTH, thresholdMicroUsd: 100 * USD },
      optIn: { month: MONTH, overageBaselineMicroUsd: 5 * USD },
    })).toEqual({ enabled: true, capPercentOfPool: 100 });
  });

  it('is absent for an account with nothing stored', () => {
    expect(toCustomerPaygOverage(undefined)).toBeUndefined();
  });
});

describe('validatePaygOverageTierConfig', () => {
  it('accepts a boolean and a markup of at least 1x', () => {
    expect(validatePaygOverageTierConfig({ allowed: true, markupBps: 10_000 })).toEqual([]);
  });

  it('does not require a markup for a tier that does not offer PAYG', () => {
    expect(validatePaygOverageTierConfig({ allowed: false })).toEqual([]);
  });

  it('requires a markup for a tier that offers PAYG', () => {
    expect(validatePaygOverageTierConfig({ allowed: true })).toEqual(['markupBps must be an integer of at least 10000 (1x)']);
  });

  it('rejects a non-boolean allowed and a below-cost or fractional markup, even on a tier that does not offer PAYG', () => {
    expect(validatePaygOverageTierConfig({ allowed: 'yes' as any, markupBps: 9_999 })).toEqual([
      'allowed must be boolean',
      'markupBps must be an integer of at least 10000 (1x)',
    ]);
    expect(validatePaygOverageTierConfig({ allowed: true, markupBps: 12_500.5 })).toHaveLength(1);
    expect(validatePaygOverageTierConfig({ allowed: false, markupBps: 5_000 })).toHaveLength(1);
  });
});

describe('createExactTrueSwitch', () => {
  const build = (getSetting: jest.Mock, clock = { t: 0 }) => ({
    clock,
    sw: createExactTrueSwitch({ getSetting, now: () => clock.t, log: jest.fn() }, PAYG_OVERAGE_SETTING),
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
  it('leaves the plain block copy exactly as it was (no reason keys)', () => {
    const plain = buildUsageBlockCopy({ month: MONTH });
    expect(plain).not.toHaveProperty('reason');
    expect(plain).not.toHaveProperty('paygInactiveReason');
    expect(buildUsageBlockCopy({ month: MONTH, paygBlock: undefined })).toEqual(plain);
    expect(buildUsageBlockCopy({ month: MONTH, paygBlock: null })).toEqual(plain);
  });

  it('says the extra usage limit was reached, with the reset date', () => {
    const copy = buildUsageBlockCopy({ month: MONTH, paygBlock: { reason: 'payg_cap_reached' } });
    expect(copy.reason).toBe('payg_cap_reached');
    expect(copy).not.toHaveProperty('paygInactiveReason');
    expect(copy.headline).toMatch(/extra usage limit/);
    // A pooled member did not set the limit: the wording must not say they did.
    expect(copy.body).toContain('your extra usage limit');
    expect(copy.body).not.toMatch(/you set/);
    expect(copy.resetDate).toBe('2026-11-01');
    expect(copy.message).toContain('November 1, 2026');
    expect(copy.message).toMatch(/extra usage limit/);
  });

  // rv5 MINOR 5: the hold says what actually lifts it. Updating the card does not pay an open invoice
  // (and does nothing for a dispute), so neither variant tells the customer to update their card.
  it('payment-failure hold: pay the open invoice', () => {
    const copy = buildUsageBlockCopy({ month: MONTH, paygBlock: { reason: 'payg_suspended', paygSuspendedReason: 'payment_failed' } });
    expect(copy.reason).toBe('payg_suspended');
    expect(copy.body).toMatch(/payment didn't go through/);
    expect(copy.message).toContain('Pay the open invoice to resume extra usage.');
    const undated = buildUsageBlockCopy({ month: null, paygBlock: { reason: 'payg_suspended', paygSuspendedReason: 'payment_failed' } });
    expect(undated.message).toContain('Pay the open invoice to resume it.');
  });

  it('dispute hold: contact us (paying or updating the card does not lift it)', () => {
    const copy = buildUsageBlockCopy({ month: MONTH, paygBlock: { reason: 'payg_suspended', paygSuspendedReason: 'dispute' } });
    expect(copy.body).toMatch(/under review/);
    expect(copy.message).toContain('Please contact us to resume extra usage.');
    expect(copy.message).not.toMatch(/invoice/);
  });

  it('unconfirmed payment hold: confirm it on the invoice (rv6 MINOR 5)', () => {
    const copy = buildUsageBlockCopy({ month: MONTH, paygBlock: { reason: 'payg_suspended', paygSuspendedReason: 'payment_unconfirmed' } });
    expect(copy.body).toMatch(/still waiting to be confirmed/);
    expect(copy.message).toContain('Open the invoice to confirm the payment and resume extra usage.');
  });

  it('lost dispute hold: never "under review" — it was decided; contact us (rv6 MINOR 4b)', () => {
    const copy = buildUsageBlockCopy({ month: MONTH, paygBlock: { reason: 'payg_suspended', paygSuspendedReason: 'dispute_lost' } });
    expect(copy.body).toMatch(/following a dispute about a recent payment/);
    expect(`${copy.body} ${copy.message}`).not.toMatch(/under review/);
    expect(copy.message).toContain('Please contact us to resume extra usage.');
  });

  it.each(['payment_failed', 'payment_unconfirmed', 'dispute', 'dispute_lost', undefined] as const)(
    'a pooled member is told the organization owner can resolve it, never to pay or contact us (%p) (rv6 MINOR 4d)', (paygSuspendedReason) => {
      for (const month of [MONTH, null]) {
        const copy = buildUsageBlockCopy({ month, paygBlock: { reason: 'payg_suspended', paygOwnerResolves: true, ...(paygSuspendedReason ? { paygSuspendedReason } : {}) } });
        expect(copy.message).toContain('Your organization owner can resolve this.');
        expect(copy.message).not.toMatch(/Pay the open invoice|contact us|Open the invoice/);
      }
    });


  it.each([undefined, 'payment_failed', 'payment_unconfirmed', 'dispute', 'dispute_lost'] as const)('never says "update your payment method" for a hold (%p)', (paygSuspendedReason) => {
    for (const month of [MONTH, null]) {
      const copy = buildUsageBlockCopy({ month, paygBlock: { reason: 'payg_suspended', ...(paygSuspendedReason ? { paygSuspendedReason } : {}) } });
      expect(`${copy.body} ${copy.message}`).not.toMatch(/update your payment method/i);
    }
  });

  it.each([
    ['no_payment_method', /payment method/],
    ['subscription_inactive', /subscription/],
  ] as const)('says PAYG is on but not covering (%s)', (paygInactiveReason, wording) => {
    const copy = buildUsageBlockCopy({ month: MONTH, paygBlock: { reason: 'payg_inactive', paygInactiveReason } });
    expect(copy.reason).toBe('payg_inactive');
    expect(copy.paygInactiveReason).toBe(paygInactiveReason);
    expect(copy.headline).toMatch(wording);
    expect(copy.message).toMatch(wording);
  });

  it('falls back to undated wording when the month is unreadable', () => {
    const copy = buildUsageBlockCopy({ month: 'garbage', paygBlock: { reason: 'payg_cap_reached' } });
    expect(copy.resetDate).toBeNull();
    expect(copy.resetSentence).toBeNull();
    expect(copy.message).not.toMatch(/resets on/);
  });

  it('never states a dollar amount', () => {
    for (const paygBlock of [
      { reason: 'payg_cap_reached' },
      { reason: 'payg_suspended' },
      { reason: 'payg_inactive', paygInactiveReason: 'no_payment_method' },
      { reason: 'payg_inactive', paygInactiveReason: 'subscription_inactive' },
    ] as const) {
      expect(JSON.stringify(buildUsageBlockCopy({ month: MONTH, paygBlock }))).not.toMatch(/\$/);
    }
  });
});
