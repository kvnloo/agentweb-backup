import {
  changeClientSubscription,
  grantClientCostCredit,
  inspectClientAllowance,
} from '../clientAllowanceAdminService';

const user = {
  userId: 'client-1', email: 'client@example.com', subscriptionType: 'Starter',
  tokenAllowanceBonus: 25,
};

function makeDeps(overrides: Record<string, any> = {}) {
  return {
    getUserByEmail: jest.fn().mockResolvedValue(user),
    getUserById: jest.fn().mockResolvedValue({ ...user, llmUsageCredits: {
      month: '2026-08', totalPurchasedMicroUsd: 1_000_000, totalAdminGrantedMicroUsd: 2_000_000,
      totalMigrationOffsetMicroUsd: 500_000, grantIds: [], grants: [],
    } }),
    resolveBillingUserId: jest.fn().mockResolvedValue('billing-1'),
    getUserSubscriptionType: jest.fn().mockResolvedValue('Starter'),
    getUserTokenUsage: jest.fn().mockResolvedValue({ month: '2026-08', totalTokens: 75, totalCost: 1.25, bonus: 25 }),
    getUserTokenAllowance: jest.fn().mockResolvedValue({ allowance: 100, bonus: 25, effectiveAllowance: 125, costAllowance: 5, llmUsagePolicy: null }),
    checkTokenUsage: jest.fn().mockResolvedValue({ allowed: true, warning: false, used: 75, allowance: 100, bonus: 25, effectiveAllowance: 125, percentUsed: 75, month: '2026-08', costUsed: 1.25, costAllowance: 5, costPercentUsed: 25, costEnforced: true, alertThresholds: {} }),
    getSubscriptionTypeConfig: jest.fn().mockResolvedValue({ name: 'Pro' }),
    updateUser: jest.fn().mockResolvedValue({ ...user, subscriptionType: 'Pro' }),
    grantMonthlyLlmUsageCredit: jest.fn().mockResolvedValue({
      granted: true, billingUserId: 'billing-1', ledger: { month: '2026-08', totalAdminGrantedMicroUsd: 4_500_000 },
    }),
    recordAdminAudit: jest.fn(),
    ...overrides,
  };
}

describe('clientAllowanceAdminService', () => {
  it('returns an exact-email allowance snapshot without secrets', async () => {
    const deps = makeDeps();

    await expect(inspectClientAllowance('CLIENT@example.com', deps)).resolves.toEqual(expect.objectContaining({
      email: 'client@example.com', billingUserId: 'billing-1', subscriptionType: 'Starter',
      currentMonthUsage: { tokens: 75, costUsd: 1.25 },
      baseAllowance: 100, bonusAllowance: 25, effectiveAllowance: 125,
      resetMonth: '2026-08', blocked: false,
      ledgerReconciliation: expect.objectContaining({
        legacyCostUsd: 1.25, migrationOffsetUsd: 0.5, effectivePolicyCostUsd: 0.75,
        purchasedCreditUsd: 1, adminCreditUsd: 2,
      }),
    }));
    expect(deps.getUserByEmail).toHaveBeenCalledWith('client@example.com');
  });

  it('conditionally changes a subscription and records before/after audit data', async () => {
    const deps = makeDeps({
      getUserSubscriptionType: jest.fn().mockResolvedValueOnce('Starter').mockResolvedValueOnce('Pro'),
    });

    const result = await changeClientSubscription({
      email: 'client@example.com', subscriptionType: 'Pro', actor: { userId: 'admin-1', email: 'admin@example.com' }, reason: 'Support correction',
    }, deps);

    expect(deps.updateUser).toHaveBeenCalledWith('billing-1', { subscriptionType: 'Pro' }, expect.objectContaining({ condition: expect.objectContaining({ expression: expect.stringContaining('subscriptionType') }) }));
    expect(deps.recordAdminAudit).toHaveBeenCalledWith(expect.objectContaining({
      actorUserId: 'admin-1', targetUserId: 'billing-1', action: 'client_allowance_subscription_change',
      before: expect.objectContaining({ subscriptionType: 'Starter' }),
      after: expect.objectContaining({ subscriptionType: 'Pro' }), reason: 'Support correction',
    }));
    expect(result.after.subscriptionType).toBe('Pro');
  });

  it('detects a concurrent subscription change instead of overwriting it', async () => {
    const conditionalFailure = Object.assign(new Error('conditional'), { code: 'ConditionalCheckFailedException' });
    const deps = makeDeps({ updateUser: jest.fn().mockRejectedValue(conditionalFailure) });

    await expect(changeClientSubscription({
      email: 'client@example.com', subscriptionType: 'Pro', actor: { userId: 'admin-1' }, reason: 'Support correction',
    }, deps)).rejects.toMatchObject({ code: 'CLIENT_ALLOWANCE_CONFLICT' });
    expect(deps.recordAdminAudit).not.toHaveBeenCalled();
  });

  it('rejects an unknown subscription before attempting a write', async () => {
    const deps = makeDeps({ getSubscriptionTypeConfig: jest.fn().mockResolvedValue(null) });

    await expect(changeClientSubscription({
      email: 'client@example.com', subscriptionType: 'Unknown', actor: { userId: 'admin-1' }, reason: 'Support correction',
    }, deps)).rejects.toMatchObject({ code: 'UNKNOWN_SUBSCRIPTION_TYPE' });
    expect(deps.updateUser).not.toHaveBeenCalled();
  });

  it('grants a whole-cent current-month cost credit idempotently and audit-logs before/after', async () => {
    const deps = makeDeps();

    const result = await grantClientCostCredit({
      email: 'client@example.com', amountUsd: 2.5, idempotencyKey: 'support-20260823',
      actor: { userId: 'admin-1', email: 'admin@example.com' }, reason: 'Support correction',
    }, deps);

    expect(deps.grantMonthlyLlmUsageCredit).toHaveBeenCalledWith(expect.objectContaining({
      billingUserId: 'billing-1', amountMicroUsd: 2_500_000,
      grantId: 'admin:billing-1:support-20260823', source: 'admin',
      grantedBy: 'admin@example.com', reason: 'Support correction',
    }));
    expect(deps.recordAdminAudit).toHaveBeenCalledWith(expect.objectContaining({
      actorUserId: 'admin-1', targetUserId: 'billing-1', action: 'client_allowance_cost_credit_grant',
      before: expect.any(Object), after: expect.any(Object), reason: 'Support correction',
    }));
    expect(result.granted).toBe(true);
  });

  it('rejects sub-cent credits before they reach the usage-credit service', async () => {
    const deps = makeDeps();

    await expect(grantClientCostCredit({
      email: 'client@example.com', amountUsd: 0.001, idempotencyKey: 'support-20260823',
      actor: { userId: 'admin-1' }, reason: 'Support correction',
    }, deps)).rejects.toMatchObject({ code: 'INVALID_CREDIT_AMOUNT' });
    expect(deps.grantMonthlyLlmUsageCredit).not.toHaveBeenCalled();
  });
});
