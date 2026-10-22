/**
 * ENG-668 — the customer surfaces around the PAYG gate.
 *
 *   - Usage runway: while PAYG is covering usage past the pool, the allowance is spent but nothing is
 *     about to stop, so the runway must not forecast an exhaustion (`onTrack: false`, 0 days) — it says
 *     `paygCovering: true` instead.
 *   - /api/auth/me (and every other response built with `sanitizeUserForResponse`): the stored opt-in
 *     carries micro-USD that must never reach a customer.
 *   - The scheduled-chat run result: a PAYG block is named, never a >100% plan percentage.
 */
jest.mock('../services/llmUsagePolicyResolverService', () => ({
  getEffectiveLlmUsagePolicy: jest.fn(),
}));
jest.mock('../services/llmUsageLedgerReader', () => ({
  readBilledLedgerRows: jest.fn(),
  hasInferredAttribution: jest.fn(() => false),
}));
jest.mock('../services/llmUsageTelemetry', () => {
  const actual = jest.requireActual('../services/llmUsageTelemetry');
  return { ...actual, recordUsageTelemetry: jest.fn(async () => {}) };
});

import { computeUsageRunway, toCustomerRunway } from '../services/llmUsageForecastService';
import { resolveUsageRunway } from '../services/llmUsageRunwayResolverService';
import { getEffectiveLlmUsagePolicy } from '../services/llmUsagePolicyResolverService';
import { readBilledLedgerRows } from '../services/llmUsageLedgerReader';
import { recordUsageTelemetry, USAGE_TELEMETRY_EVENTS } from '../services/llmUsageTelemetry';
import { sanitizeUserForResponse } from '../utils/accountSecretRedaction';
import { buildScheduledChatBlockMessage } from '../utils/usageBlockCopy';

const USD = 1_000_000;
const mockPolicy = getEffectiveLlmUsagePolicy as jest.Mock;
const mockRows = readBilledLedgerRows as jest.Mock;
const mockTelemetry = recordUsageTelemetry as jest.Mock;

/** $120 spent on a $100 pool by the 19th, at ~$6.7/day. */
const overPool = {
  costUsedMicroUsd: 120 * USD,
  hardThresholdMicroUsd: 100 * USD,
  attributionInferred: false,
  dailyCostMicroUsd: Array.from({ length: 18 }, (_, i) => ({
    date: `2026-10-${String(i + 1).padStart(2, '0')}`,
    costMicroUsd: Math.round((120 / 18) * USD),
  })),
  cycleStartDate: '2026-10-01',
  cycleResetDate: '2026-11-01',
  today: '2026-10-19',
};

describe('usage runway while PAYG is covering', () => {
  it('without PAYG, a spent pool forecasts exhaustion today (the behaviour PAYG must not inherit)', () => {
    const runway = computeUsageRunway(overPool);
    expect(runway.onTrack).toBe(false);
    expect(runway.estimatedDaysRemaining).toBe(0);
    expect(runway).not.toHaveProperty('paygCovering');
  });

  it('with PAYG covering, it claims no exhaustion and says paygCovering: true', () => {
    const runway = computeUsageRunway({ ...overPool, paygCovering: true });
    expect(runway.paygCovering).toBe(true);
    expect(runway.onTrack).toBeNull();
    expect(runway.estimatedDaysRemaining).toBeNull();
    expect(runway.estimatedExhaustionDate).toBeNull();
    // Still a true account of the plan pool.
    expect(runway.percentUsed).toBe(100);
    const customer = toCustomerRunway(runway);
    expect(customer.paygCovering).toBe(true);
    expect(customer).not.toHaveProperty('diagnostics');
  });

  it('the resolver sets paygCovering exactly when the gates admitted on PAYG, and scores no forecast', async () => {
    mockRows.mockResolvedValue(overPool.dailyCostMicroUsd.map((r) => ({ ...r, userId: 'owner-1' })));
    const policy = {
      version: 'v', enforcementState: 'hard_only', optimizationCostThresholdMicroUsd: 50 * USD,
      hardCostThresholdMicroUsd: 100 * USD, optimizedModelIds: ['m'], optimizedDefaultModel: 'm',
    };
    mockPolicy.mockResolvedValue({
      billingUserId: 'owner-1', policy, costUsedMicroUsd: 120 * USD, creditsApplied: false,
      mode: { usageMode: 'full_choice', admissionAllowed: true, reason: 'payg_overage' },
      overage: { overageMicroUsd: 20 * USD, capMicroUsd: 50 * USD, poolMicroUsd: 100 * USD, percentOfCap: 40 },
    });
    const covered = await resolveUsageRunway('owner-1', { today: '2026-10-19' });
    expect(covered.runway!.paygCovering).toBe(true);
    expect(covered.runway!.onTrack).toBeNull();
    expect(mockTelemetry.mock.calls.map(([, event]) => event)).not.toContain(USAGE_TELEMETRY_EVENTS.forecastAccuracy);

    mockPolicy.mockResolvedValue({
      billingUserId: 'owner-1', policy, costUsedMicroUsd: 120 * USD, creditsApplied: false,
      mode: { usageMode: 'paused', admissionAllowed: false, reason: 'hard_threshold_reached' },
    });
    const blocked = await resolveUsageRunway('owner-1', { today: '2026-10-19' });
    expect(blocked.runway).not.toHaveProperty('paygCovering');
    expect(blocked.runway!.onTrack).toBe(false);
  });
});

describe('usage runway when PAYG admits with nothing billable yet', () => {
  it('is not paygCovering, and forecasts against the month\'s (high-water) pool instead of declaring exhaustion', async () => {
    // A downgrade to a $100 pool after the month had a $150 pool; $120 spent: admitted at 0% billable.
    mockRows.mockResolvedValue(overPool.dailyCostMicroUsd.map((r) => ({ ...r, userId: 'owner-1' })));
    mockPolicy.mockResolvedValue({
      billingUserId: 'owner-1',
      policy: {
        version: 'v', enforcementState: 'hard_only', optimizationCostThresholdMicroUsd: 50 * USD,
        hardCostThresholdMicroUsd: 100 * USD, optimizedModelIds: ['m'], optimizedDefaultModel: 'm',
      },
      costUsedMicroUsd: 120 * USD,
      creditsApplied: false,
      mode: { usageMode: 'full_choice', admissionAllowed: true, reason: 'payg_overage' },
      overage: { overageMicroUsd: 0, capMicroUsd: 75 * USD, poolMicroUsd: 150 * USD, percentOfCap: 0 },
    });
    const { runway } = await resolveUsageRunway('owner-1', { today: '2026-10-19' });
    expect(runway).not.toHaveProperty('paygCovering');
    expect(runway!.percentUsed).toBe(80);
    expect(runway!.estimatedDaysRemaining).toBeGreaterThan(0);
  });
});

describe('usage runway right after opting in with overage standing', () => {
  it('is paygCovering (no exhaustion claimed) even though the billable overage is 0', async () => {
    mockRows.mockResolvedValue(overPool.dailyCostMicroUsd.map((r) => ({ ...r, userId: 'owner-1' })));
    mockPolicy.mockResolvedValue({
      billingUserId: 'owner-1',
      policy: {
        version: 'v', enforcementState: 'hard_only', optimizationCostThresholdMicroUsd: 50 * USD,
        hardCostThresholdMicroUsd: 100 * USD, optimizedModelIds: ['m'], optimizedDefaultModel: 'm',
      },
      costUsedMicroUsd: 120 * USD,
      creditsApplied: false,
      mode: { usageMode: 'full_choice', admissionAllowed: true, reason: 'payg_overage' },
      // $20 standing at opt-in is the baseline: nothing billable yet.
      overage: { overageMicroUsd: 0, capMicroUsd: 50 * USD, poolMicroUsd: 100 * USD, percentOfCap: 0 },
    });
    const { runway } = await resolveUsageRunway('owner-1', { today: '2026-10-19' });
    expect(runway!.paygCovering).toBe(true);
    expect(runway!.onTrack).toBeNull();
    expect(runway!.estimatedDaysRemaining).toBeNull();
  });
});

describe('sanitizeUserForResponse strips PAYG money fields (/api/auth/me)', () => {
  it('passes only the on/off state and the percentage cap', () => {
    const out = sanitizeUserForResponse({
      userId: 'u',
      password: 'x',
      paygOverage: {
        enabled: true,
        capPercentOfPool: 50,
        poolHighWater: { month: '2026-10', thresholdMicroUsd: 100 * USD },
        optIn: { month: '2026-10', overageBaselineMicroUsd: 5 * USD },
        updatedBy: 'u',
        updatedAt: '2026-10-01T00:00:00.000Z',
        version: 3,
      },
    });
    expect(out!.paygOverage).toEqual({ enabled: true, capPercentOfPool: 50 });
    expect(JSON.stringify(out)).not.toMatch(/MicroUsd/);
  });

  it('adds nothing for a user who never opted in', () => {
    expect(sanitizeUserForResponse({ userId: 'u' })).not.toHaveProperty('paygOverage');
  });

  it('never sends settlement records or the closed-month ledger (PR-2: provider cost and markup)', () => {
    const out = sanitizeUserForResponse({
      userId: 'u',
      paygSettlements: { '2026-09': { status: 'paid', overageCostMicroUsd: 30 * USD, billedMicroUsd: 45 * USD, markupBps: 15_000 } },
      llmUsageCreditsClosed: { month: '2026-09', totalPurchasedMicroUsd: 20 * USD },
    });
    expect(out).not.toHaveProperty('paygSettlements');
    expect(out).not.toHaveProperty('llmUsageCreditsClosed');
  });
});

describe('scheduled-chat block text', () => {
  it('is unchanged for a plain block', () => {
    expect(buildScheduledChatBlockMessage({ usageMode: 'paused', limitPercent: 100, month: '2026-10' })).toBe(
      'Scheduled chat cannot run: AI usage is paused. Your included usage resets on November 1, 2026. '
        + 'Add usage or upgrade your plan to keep working before then.',
    );
    expect(buildScheduledChatBlockMessage({ usageMode: 'full_choice', limitPercent: 104, month: null })).toBe(
      "Scheduled chat cannot run: you've reached your monthly usage limit (104% used). "
        + 'Add usage or upgrade your plan to keep working before then.',
    );
  });

  it.each([
    [{ reason: 'payg_cap_reached' }, /extra usage limit/],
    [{ reason: 'payg_suspended' }, /on hold/],
    [{ reason: 'payg_inactive', paygInactiveReason: 'no_payment_method' }, /payment method/],
    [{ reason: 'payg_inactive', paygInactiveReason: 'subscription_inactive' }, /subscription/],
  ] as const)('names the PAYG reason (%j) and never a plan percentage', (paygBlock, wording) => {
    const text = buildScheduledChatBlockMessage({ usageMode: 'full_choice', limitPercent: 180, month: '2026-10', paygBlock });
    expect(text).toMatch(/^Scheduled chat cannot run: /);
    expect(text).toMatch(wording);
    expect(text).toContain('November 1, 2026');
    expect(text).not.toMatch(/%/);
  });
});
