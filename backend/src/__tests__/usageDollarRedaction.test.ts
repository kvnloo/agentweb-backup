/**
 * ENG-1212 AC4 — "No internal USD amounts are returned by customer APIs;
 * authorized admin diagnostics may include them." The ticket's own outcome
 * states the same thing more plainly: the forecast predicts whether usage lasts
 * "without exposing dollar ceilings".
 *
 * `/usage-runway` honoured this from day one via `toCustomerRunway`. `/usage`
 * did not — it returned `checkTokenUsage` verbatim, so `costUsed` and
 * `costAllowance` went out in plain USD to every authenticated customer, and
 * two chatbot 429 bodies shipped the same object.
 *
 * That was not a deliberate product decision. The portal states the opposite
 * intent in two places — SubscriptionCard renders the cost quota "ONLY as a
 * percentage bar (never the dollar figures)" and "Dollars stay admin-only; to
 * the user this is simply 'usage'" — and `costUsed` has no non-test reader in
 * the portal at all.
 *
 * These tests pin the projection itself. `costPercentUsed` must SURVIVE: a
 * percentage is not a dollar amount, it is what the bar renders, and dropping
 * it would blank the meter.
 */

import { toCustomerTokenUsage, type TokenUsageStatus } from '../services/tokenUsageService';

const status = (over: Partial<TokenUsageStatus> = {}): TokenUsageStatus => ({
  allowed: true,
  warning: false,
  used: 90_000,
  allowance: 500_000,
  bonus: 0,
  effectiveAllowance: 500_000,
  percentUsed: 18,
  month: '2026-08',
  costUsed: 214.37,
  costAllowance: 350,
  costPercentUsed: 61,
  costEnforced: true,
  alertThresholds: { warnPercent: 80, criticalPercent: 100 } as any,
  ...over,
});

describe('ENG-1212 AC4 — /usage must not ship internal dollars', () => {
  it('drops costUsed and costAllowance', () => {
    const projected = toCustomerTokenUsage(status());

    expect(projected).not.toHaveProperty('costUsed');
    expect(projected).not.toHaveProperty('costAllowance');
  });

  it('leaves no dollar figure anywhere in the serialized body', () => {
    // The blunt check, because a future field could reintroduce the leak under
    // a different name. 214.37 and 350 are the only USD values in the fixture.
    const body = JSON.stringify(toCustomerTokenUsage(status()));

    expect(body).not.toContain('214.37');
    expect(body).not.toContain('costAllowance');
    expect(body).not.toContain('costUsed');
  });

  it('keeps costPercentUsed — a percentage is not a dollar amount', () => {
    // Dropping this would blank the usage bar for every cost-enforced account.
    expect(toCustomerTokenUsage(status()).costPercentUsed).toBe(61);
  });

  it('replaces the ceiling with the single bit the client actually used', () => {
    // The portal never rendered costAllowance; it tested `!= null` to decide
    // which dimension is the quota.
    expect(toCustomerTokenUsage(status({ costAllowance: 350 })).hasCostAllowance).toBe(true);
    expect(toCustomerTokenUsage(status({ costAllowance: null })).hasCostAllowance).toBe(false);
  });

  it('preserves every non-monetary field the client depends on', () => {
    const projected = toCustomerTokenUsage(status());

    expect(projected.allowed).toBe(true);
    expect(projected.used).toBe(90_000);
    expect(projected.allowance).toBe(500_000);
    expect(projected.effectiveAllowance).toBe(500_000);
    expect(projected.percentUsed).toBe(18);
    expect(projected.costEnforced).toBe(true);
    expect(projected.month).toBe('2026-08');
    expect(projected.alertThresholds).toBeDefined();
  });

  it('does not mutate the caller’s object — internal consumers still need the dollars', () => {
    // emailService and the policy services read costUsed/costAllowance off the
    // same object. Stripping at the boundary must be a projection, not a
    // destructive edit.
    const original = status();
    toCustomerTokenUsage(original);

    expect(original.costUsed).toBe(214.37);
    expect(original.costAllowance).toBe(350);
  });
  // ENG-1250 AC7: token volume is no longer measured. The customer portal's token line renders only
  // when `typeof used === "number"`, so a 0 here would print a false "0 tokens used this month".
  it('omits `used` when no token limit applies, so the portal hides the token line (not a false 0)', () => {
    const projected = toCustomerTokenUsage(status({ used: 0, allowance: null, effectiveAllowance: null, percentUsed: 0 }));

    expect(projected).not.toHaveProperty('used');
    expect(JSON.stringify(projected)).not.toContain('"used"');
  });

  it('still reports `used` when a token limit exists', () => {
    expect(toCustomerTokenUsage(status()).used).toBe(90_000);
  });
});
