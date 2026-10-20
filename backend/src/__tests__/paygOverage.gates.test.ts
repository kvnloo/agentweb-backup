/**
 * ENG-668 — both admission gates reach the same PAYG answer.
 *
 * Gate 1 is `checkTokenUsage` (the 429 /generate, chat, MCP and the socket return before any work).
 * Gate 2 is `getEffectiveLlmUsagePolicy` as `resolveEffectiveModelForUser` consumes it — a `paused`
 * mode there becomes a `blocked` model decision, i.e. /generate's second 429 and a scheduled run's
 * `usage_paused`. Both run for real here over mocked storage; if PAYG reached only one of them, a turn
 * gate 1 admitted would be refused by gate 2 (or the reverse), and these tests would split.
 *
 * Also the dark-launch invariant: with the switch off, or for an account that never opted in, both
 * gates return exactly what they returned before PAYG existed — and a non-PAYG account never even
 * reads the switch.
 */
jest.mock('../services/subscriptionService', () => ({
  getAllowedFunctionCalls: jest.fn(async () => []),
  isSubscriptionFeatureEnabled: jest.fn(async () => true),
  getUserSubscriptionType: jest.fn(),
  getSubscriptionTypeConfig: jest.fn(),
}));

jest.mock('../services/chatbotService', () => ({
  chatbotDb: {
    createChatSession: jest.fn(),
    getChatSession: jest.fn(),
    addMessageToSession: jest.fn(),
    updateSessionLlmModel: jest.fn(),
    getUserSessions: jest.fn(),
  },
}));

const DEFAULT_MODEL = 'gpt-5-chat-2';
const CHOSEN_MODEL = 'anthropic.claude-opus-5';

jest.mock('../services/agentModeService', () => ({
  agentModeService: {
    default_model: 'gpt-5-chat-2',
    getDefaultModel: jest.fn(async () => 'gpt-5-chat-2'),
    getSupportedModels: jest.fn(async () => ['gpt-5-chat-2', 'anthropic.claude-opus-5']),
    resolveGenerationModel: jest.fn((model: string) => ({ model, fellBack: false, requestedModel: model })),
    getFoundationToolNames: jest.fn().mockReturnValue(new Set()),
    getAdminToolNames: jest.fn().mockReturnValue([]),
  },
}));

jest.mock('../services/generateMarketingResponseWorkerService', () => ({
  generateMarketingResponseWorkerService: { runInWorker: jest.fn(), releaseSessionClients: jest.fn() },
}));

jest.mock('../services/db', () => ({
  scheduleDb: {},
  taskDb: {},
  userDb: { getUserById: jest.fn(), getUserByIdConsistent: jest.fn(), updateUser: jest.fn() },
  orgDb: { getOrgById: jest.fn() },
}));

jest.mock('../utils/agentModeAlerts', () => ({
  sendAgentModeOncallAlert: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../services/emailService', () => ({ emailService: {} }));

// Spend is an input here, not the subject: the basis module has its own suite.
jest.mock('../services/spendEnforcementBasis', () => ({
  resolveEnforcementCostBasisMicroUsd: jest.fn(),
}));

// The switch reader's cache is unit-tested in paygOverage.test.ts; here it is a plain input.
jest.mock('../services/paygOverageService', () => ({
  paygOverageSwitch: { isEnabled: jest.fn() },
}));

import { userDb } from '../services/db';
import { getSubscriptionTypeConfig, getUserSubscriptionType } from '../services/subscriptionService';
import { resolveEnforcementCostBasisMicroUsd } from '../services/spendEnforcementBasis';
import { paygOverageSwitch } from '../services/paygOverageService';
import { checkTokenUsage, getCurrentMonth, toCustomerTokenUsage } from '../services/tokenUsageService';
import { getEffectiveLlmUsagePolicy } from '../services/llmUsagePolicyResolverService';
import { resolveEffectiveModelForUser } from '../controllers/agentModeController';
import { getCurrentUsageMonth } from '../services/llmUsageCreditService';
import type { PaygOverageSettings } from '../services/paygOverage';

const USD = 1_000_000;
const OWNER = 'owner-1';

const mockGetUserById = userDb.getUserById as jest.Mock;
const mockGetUserByIdConsistent = (userDb as any).getUserByIdConsistent as jest.Mock;
const mockUpdateUser = (userDb as any).updateUser as jest.Mock;
const mockTierName = getUserSubscriptionType as jest.Mock;
const mockTierConfig = getSubscriptionTypeConfig as jest.Mock;
const mockSpend = resolveEnforcementCostBasisMicroUsd as jest.Mock;
const mockSwitch = paygOverageSwitch.isEnabled as jest.Mock;

const policy = {
  version: 'pro-2026-10',
  enforcementState: 'hard_only' as const,
  optimizationCostThresholdMicroUsd: 50 * USD,
  hardCostThresholdMicroUsd: 100 * USD,
  optimizedModelIds: [DEFAULT_MODEL],
  optimizedDefaultModel: DEFAULT_MODEL,
};

const payg = (over: Partial<PaygOverageSettings> = {}): PaygOverageSettings => ({
  enabled: true,
  capPercentOfPool: 50,
  // Already at today's pool, so the high-water write is not part of every case.
  poolHighWater: { month: getCurrentUsageMonth(), thresholdMicroUsd: 100 * USD },
  updatedBy: OWNER,
  updatedAt: '2026-10-01T00:00:00.000Z',
  version: 1,
  ...over,
});

function setup(input: {
  spendUsd: number;
  switchOn?: boolean;
  tierPayg?: { allowed: boolean; markupBps: number } | undefined;
  user?: Record<string, unknown>;
  tierPolicy?: typeof policy;
}) {
  mockSpend.mockResolvedValue({ rawCostUsedMicroUsd: input.spendUsd * USD });
  mockSwitch.mockResolvedValue(input.switchOn ?? true);
  mockTierName.mockResolvedValue('Pro');
  mockTierConfig.mockResolvedValue({
    name: 'Pro',
    allowedPages: [],
    allowedSkills: [],
    llmUsagePolicy: input.tierPolicy ?? policy,
    ...('tierPayg' in input ? (input.tierPayg ? { paygOverage: input.tierPayg } : {}) : { paygOverage: { allowed: true, markupBps: 25_000 } }),
  });
  const user = {
    userId: OWNER,
    email: 'owner@example.com',
    subscription_status: 'active',
    has_payment_method: true,
    paygOverage: payg(),
    ...input.user,
  };
  // The index snapshot and the strongly consistent row agree unless a case says otherwise.
  mockGetUserById.mockResolvedValue(user);
  mockGetUserByIdConsistent.mockResolvedValue(user);
}

/** Both gates, the way /generate runs them: checkTokenUsage, then the model resolver. */
async function bothGates() {
  const status = await checkTokenUsage(OWNER);
  const decision = await resolveEffectiveModelForUser({ userId: OWNER, requestedModel: CHOSEN_MODEL });
  return { status, decision };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockUpdateUser.mockResolvedValue({});
});

describe('ENG-668 PAYG — both gates agree', () => {
  it('admits past the pool through BOTH gates when PAYG is on, on the model the customer chose', async () => {
    setup({ spendUsd: 120 });
    const { status, decision } = await bothGates();

    expect(status.allowed).toBe(true);
    expect(status.usageMode).toBe('full_choice');
    expect(status.overage).toEqual({ active: true, percentOfCap: 40 });
    // costPercentUsed stays the plan-pool percentage.
    expect(status.costPercentUsed).toBe(120);
    expect(status.warning).toBe(false);

    expect(decision.usageMode).toBe('full_choice');
    expect(decision.effectiveModel).toBe(CHOSEN_MODEL);
    expect(decision.modelSelection).toBe('honored');
  });

  it.each<[string, Parameters<typeof setup>[0]]>([
    ['the switch is off', { spendUsd: 120, switchOn: false }],
    ['the tier has no PAYG config', { spendUsd: 120, tierPayg: undefined }],
    ['the tier disallows PAYG', { spendUsd: 120, tierPayg: { allowed: false, markupBps: 25_000 } }],
    ['the owner turned PAYG off', { spendUsd: 120, user: { paygOverage: payg({ enabled: false }) } }],
    ['the owner never opted in', { spendUsd: 120, user: { paygOverage: undefined } }],
    ['PAYG is suspended', { spendUsd: 120, user: { paygOverage: payg({ suspended: { reason: 'payment_failed', at: '2026-10-05T00:00:00.000Z' } }) } }],
    ['no payment method is on file', { spendUsd: 120, user: { has_payment_method: false } }],
    ['the subscription is past due', { spendUsd: 120, user: { subscription_status: 'past_due' } }],
    ['the cap is reached', { spendUsd: 150 }],
  ])('blocks in BOTH gates when %s', async (_label, input) => {
    setup(input);
    const { status, decision } = await bothGates();

    expect(status.allowed).toBe(false);
    expect(status.usageMode).toBe('paused');
    expect(decision.usageMode).toBe('paused');
    expect(decision.effectiveModel).toBeNull();
    expect(decision.modelSelection).toBe('blocked');
  });

  it('a reached cap is a 429 that says so, without dollars', async () => {
    setup({ spendUsd: 150 });
    const status = await checkTokenUsage(OWNER);
    expect(status.paygBlock).toEqual({ reason: 'payg_cap_reached' });
    expect(status.overage).toEqual({ active: false, percentOfCap: 100 });

    const customer = toCustomerTokenUsage(status);
    expect(customer.usageBlock.reason).toBe('payg_cap_reached');
    expect(customer.usageBlock.headline).toMatch(/pay-as-you-go limit/);
    expect(customer).not.toHaveProperty('paygBlock');

    const usage = await getEffectiveLlmUsagePolicy(OWNER);
    expect(usage.paygBlock).toEqual({ reason: 'payg_cap_reached' });
  });

  it('a suspension is a 429 with the payment-problem variant', async () => {
    setup({ spendUsd: 120, user: { paygOverage: payg({ suspended: { reason: 'dispute', at: '2026-10-05T00:00:00.000Z' } }) } });
    const status = await checkTokenUsage(OWNER);
    expect(status.allowed).toBe(false);
    expect(toCustomerTokenUsage(status).usageBlock.reason).toBe('payg_suspended');
  });

  it('turning PAYG off takes effect on the very next check, with no extra read', async () => {
    setup({ spendUsd: 120, user: { paygOverage: undefined } });
    await checkTokenUsage(OWNER);
    const readsWithoutPayg = mockGetUserById.mock.calls.length;

    setup({ spendUsd: 120 });
    mockGetUserById.mockClear();
    expect((await checkTokenUsage(OWNER)).allowed).toBe(true);
    expect(mockGetUserById).toHaveBeenCalledTimes(readsWithoutPayg);

    setup({ spendUsd: 120, user: { paygOverage: payg({ enabled: false }) } });
    mockGetUserById.mockClear();
    expect((await checkTokenUsage(OWNER)).allowed).toBe(false);
    expect(mockGetUserById).toHaveBeenCalledTimes(readsWithoutPayg);
  });

  it.each([
    ['no payment method is on file', { has_payment_method: false }, 'no_payment_method'],
    ['the subscription is not live', { subscription_status: 'past_due' }, 'subscription_inactive'],
  ] as const)('PAYG on but not covering (%s) is a 429 that says why, not the plain block', async (_label, user, paygInactiveReason) => {
    setup({ spendUsd: 120, user });
    const status = await checkTokenUsage(OWNER);
    expect(status.allowed).toBe(false);
    expect(status.paygBlock).toEqual({ reason: 'payg_inactive', paygInactiveReason });
    const block = toCustomerTokenUsage(status).usageBlock;
    expect(block.reason).toBe('payg_inactive');
    expect(block.paygInactiveReason).toBe(paygInactiveReason);
  });

  it('customer projection exposes only percentages for PAYG', async () => {
    setup({ spendUsd: 120 });
    const customer = toCustomerTokenUsage(await checkTokenUsage(OWNER));
    expect(customer.overage).toEqual({ active: true, percentOfCap: 40 });
    const json = JSON.stringify(customer);
    expect(json).not.toMatch(/MicroUsd/);
    expect(customer).not.toHaveProperty('costUsed');
    expect(customer).not.toHaveProperty('costAllowance');
  });
});

describe('ENG-668 PAYG — mid-month downgrade (pool high-water)', () => {
  it('measures overage above the higher pool seen earlier this month, so no retroactive overage', async () => {
    // Pool was $150 this month; a downgrade dropped it to $100; $140 spent.
    setup({ spendUsd: 140, user: { paygOverage: payg({ poolHighWater: { month: getCurrentUsageMonth(), thresholdMicroUsd: 150 * USD } }) } });
    const { status, decision } = await bothGates();
    expect(status.allowed).toBe(true);
    // Admitted, but nothing is billable yet: PAYG is not "covering" anything, so it is not active.
    expect(status.overage).toEqual({ active: false, percentOfCap: 0 });
    expect(decision.effectiveModel).toBe(CHOSEN_MODEL);
    // Never lowered.
    expect(mockUpdateUser).not.toHaveBeenCalled();
  });

  it('without the high-water mark the same spend would already be 80% of the cap', async () => {
    setup({ spendUsd: 140, user: { paygOverage: payg({ poolHighWater: undefined }) } });
    const status = await checkTokenUsage(OWNER);
    expect(status.overage).toEqual({ active: true, percentOfCap: 80 });
  });

  it('records a rising pool with a conditional write on the high-water mark only', async () => {
    setup({ spendUsd: 10, user: { paygOverage: payg({ poolHighWater: { month: '2000-01', thresholdMicroUsd: 999 * USD } }) } });
    await checkTokenUsage(OWNER);

    expect(mockUpdateUser).toHaveBeenCalledTimes(1);
    const [userId, fields, options] = mockUpdateUser.mock.calls[0];
    expect(userId).toBe(OWNER);
    expect(fields).toEqual({});
    expect(options.pathSets).toEqual([{
      path: ['paygOverage', 'poolHighWater'],
      value: { month: getCurrentUsageMonth(), thresholdMicroUsd: 100 * USD },
    }]);
    expect(options.condition.expression).toContain('#payg.#hw.#threshold < :hwThreshold');
    expect(options.condition.values).toEqual({ ':hwMonth': getCurrentUsageMonth(), ':hwThreshold': 100 * USD });
  });

  it('a lost high-water race or a failed write never fails the check', async () => {
    setup({ spendUsd: 120, user: { paygOverage: payg({ poolHighWater: undefined }) } });
    mockUpdateUser.mockRejectedValueOnce(Object.assign(new Error('cond'), { code: 'ConditionalCheckFailedException' }));
    expect((await checkTokenUsage(OWNER)).allowed).toBe(true);
    mockUpdateUser.mockRejectedValueOnce(new Error('throttled'));
    const spy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    expect((await checkTokenUsage(OWNER)).allowed).toBe(true);
    spy.mockRestore();
  });
});

describe('ENG-668 PAYG — dark: switch off is byte-identical to before', () => {
  /** The same account with no PAYG anywhere: what both gates returned before ENG-668. */
  async function baseline(spendUsd: number) {
    setup({ spendUsd, tierPayg: undefined, user: { paygOverage: undefined } });
    const status = await checkTokenUsage(OWNER);
    const usage = await getEffectiveLlmUsagePolicy(OWNER);
    const decision = await resolveEffectiveModelForUser({ userId: OWNER, requestedModel: CHOSEN_MODEL });
    return { status, usage, decision };
  }

  it.each([10, 99.99, 100, 120, 400])('with $%p spent, an opted-in account on a PAYG tier gets exactly the baseline while the switch is off', async (spendUsd) => {
    const before = await baseline(spendUsd);
    setup({ spendUsd, switchOn: false });
    const status = await checkTokenUsage(OWNER);
    const usage = await getEffectiveLlmUsagePolicy(OWNER);
    const decision = await resolveEffectiveModelForUser({ userId: OWNER, requestedModel: CHOSEN_MODEL });

    expect(JSON.stringify(status)).toBe(JSON.stringify(before.status));
    expect(JSON.stringify(usage)).toBe(JSON.stringify(before.usage));
    expect(JSON.stringify(decision)).toBe(JSON.stringify(before.decision));
    expect(JSON.stringify(toCustomerTokenUsage(status))).toBe(JSON.stringify(toCustomerTokenUsage(before.status)));
    expect(mockUpdateUser).not.toHaveBeenCalled();
  });

  it('an account that never opted in does not read the switch, the tier PAYG config, or write anything', async () => {
    setup({ spendUsd: 120, user: { paygOverage: undefined } });
    await checkTokenUsage(OWNER);
    await getEffectiveLlmUsagePolicy(OWNER);
    expect(mockSwitch).not.toHaveBeenCalled();
    expect(mockUpdateUser).not.toHaveBeenCalled();
    // Gate 1 reads the tier config once for its allowance, exactly as before (no PAYG re-read).
    // Gate 2 reads it once for its policy.
    expect(mockTierConfig).toHaveBeenCalledTimes(2);
  });

  it('a tier with no enforced policy has no pool to go past: PAYG is never consulted', async () => {
    setup({ spendUsd: 500, tierPolicy: { ...policy, enforcementState: 'observe' as any } });
    const status = await checkTokenUsage(OWNER);
    expect(status).not.toHaveProperty('overage');
    expect(mockSwitch).not.toHaveBeenCalled();
  });
});

describe('ENG-668 PAYG — review regressions', () => {
  it('an opt-in after a pre-opt-in downgrade bills none of the usage the old, larger pool included', async () => {
    // Earlier this month on a $400 pool, $250 spent; downgraded to $100; THEN opted in at 200%. No
    // high-water mark existed before opting in, so the opt-in baseline is what protects that $150.
    setup({
      spendUsd: 250,
      user: {
        paygOverage: payg({
          capPercentOfPool: 200,
          poolHighWater: undefined,
          optIn: { month: getCurrentUsageMonth(), overageBaselineMicroUsd: 150 * USD, poolAtOptInMicroUsd: 100 * USD },
        }),
      },
    });
    const { status, decision } = await bothGates();
    expect(status.allowed).toBe(true);
    // Past the pool and admitted on PAYG: PAYG is covering, even though nothing is billable yet.
    expect(status.overage).toEqual({ active: true, percentOfCap: 0 });
    expect(decision.modelSelection).toBe('honored');
  });

  it('the cap follows this month\'s pool, not the pool it was chosen against', async () => {
    // 50% chosen when the pool was $400; the pool is now $100, so the cap is $50 and $190 over is blocked.
    setup({ spendUsd: 290, user: { paygOverage: payg({ capPercentOfPool: 50, poolHighWater: undefined }) } });
    const { status, decision } = await bothGates();
    expect(status.allowed).toBe(false);
    expect(status.paygBlock).toEqual({ reason: 'payg_cap_reached' });
    expect(status.overage).toEqual({ active: false, percentOfCap: 380 });
    expect(decision.modelSelection).toBe('blocked');
  });
});

describe('ENG-668 PAYG — opt-in baseline after the pool grows (counted once, not twice)', () => {
  it('upgrade: opted in at $120 on $100, upgraded to a $200 pool, $215 spent => 15% of a $100 cap', async () => {
    setup({
      spendUsd: 215,
      tierPolicy: { ...policy, optimizationCostThresholdMicroUsd: 150 * USD, hardCostThresholdMicroUsd: 200 * USD },
      user: {
        paygOverage: payg({
          poolHighWater: { month: getCurrentUsageMonth(), thresholdMicroUsd: 200 * USD },
          optIn: { month: getCurrentUsageMonth(), overageBaselineMicroUsd: 20 * USD, poolAtOptInMicroUsd: 100 * USD },
        }),
      },
    });
    const { status, decision } = await bothGates();
    expect(status.allowed).toBe(true);
    expect(status.overage).toEqual({ active: true, percentOfCap: 15 });
    expect(decision.effectiveModel).toBe(CHOSEN_MODEL);
  });

  it('credits: a $50 top-up after opting in makes the pool $150; $165 spent => 20% of a $75 cap', async () => {
    setup({
      spendUsd: 165,
      user: {
        llmUsageCredits: {
          month: getCurrentMonth(),
          totalPurchasedMicroUsd: 50 * USD, totalMigrationOffsetMicroUsd: 0, grantIds: [], grants: [],
        },
        paygOverage: payg({
          poolHighWater: { month: getCurrentUsageMonth(), thresholdMicroUsd: 150 * USD },
          optIn: { month: getCurrentUsageMonth(), overageBaselineMicroUsd: 20 * USD, poolAtOptInMicroUsd: 100 * USD },
        }),
      },
    });
    const status = await checkTokenUsage(OWNER);
    expect(status.allowed).toBe(true);
    expect(status.overage).toEqual({ active: true, percentOfCap: 20 });
  });
});

describe('ENG-668 PAYG — opting in with overage already standing', () => {
  it('$120 on a $100 pool, $20 baseline: admitted, PAYG covering (active), 0% of the cap', async () => {
    setup({
      spendUsd: 120,
      user: {
        paygOverage: payg({
          optIn: { month: getCurrentUsageMonth(), overageBaselineMicroUsd: 20 * USD, poolAtOptInMicroUsd: 100 * USD },
        }),
      },
    });
    const { status, decision } = await bothGates();
    expect(status.allowed).toBe(true);
    expect(status.overage).toEqual({ active: true, percentOfCap: 0 });
    expect(decision.effectiveModel).toBe(CHOSEN_MODEL);
  });
});

describe('ENG-668 PAYG — a stale index snapshot never decides admission past the pool', () => {
  const owner = (paygOverage: PaygOverageSettings) => ({
    userId: OWNER, email: 'owner@example.com', subscription_status: 'active', has_payment_method: true, paygOverage,
  });

  it('measures against the high-water mark the consistent row holds, not the stale snapshot\'s', async () => {
    // Saved high-water 150, then a downgrade to 100; $140 spent at a 25% cap. The UserIdIndex snapshot
    // predates the mark: against it, $40 over a $25 cap would be payg_cap_reached.
    setup({ spendUsd: 140, user: { paygOverage: payg({ capPercentOfPool: 25, poolHighWater: undefined }) } });
    mockGetUserByIdConsistent.mockResolvedValue(owner(payg({
      capPercentOfPool: 25,
      poolHighWater: { month: getCurrentUsageMonth(), thresholdMicroUsd: 150 * USD },
    })));
    const { status, decision } = await bothGates();
    expect(status.allowed).toBe(true);
    expect(status.paygBlock).toBeUndefined();
    expect(decision.effectiveModel).toBe(CHOSEN_MODEL);
    // Never lowered: the consistent mark is already higher than today's pool.
    expect(mockUpdateUser).not.toHaveBeenCalled();
  });

  it('a lost high-water write uses the higher mark that beat it', async () => {
    // Both reads show no mark; another instance stores 150 before our 100 lands, so our write loses.
    setup({ spendUsd: 140, user: { paygOverage: payg({ capPercentOfPool: 25, poolHighWater: undefined }) } });
    const raced = owner(payg({ capPercentOfPool: 25, poolHighWater: { month: getCurrentUsageMonth(), thresholdMicroUsd: 150 * USD } }));
    let stored = owner(payg({ capPercentOfPool: 25, poolHighWater: undefined }));
    mockGetUserByIdConsistent.mockImplementation(async () => stored);
    mockUpdateUser.mockImplementation(async () => {
      stored = raced;
      throw Object.assign(new Error('cond'), { code: 'ConditionalCheckFailedException' });
    });
    const status = await checkTokenUsage(OWNER);
    expect(status.allowed).toBe(true);
    expect(status.paygBlock).toBeUndefined();
  });

  it('an opt-out the snapshot has not seen yet is respected', async () => {
    setup({ spendUsd: 120 });
    mockGetUserByIdConsistent.mockResolvedValue(owner(payg({ enabled: false })));
    const { status, decision } = await bothGates();
    expect(status.allowed).toBe(false);
    expect(decision.modelSelection).toBe('blocked');
  });

  it('a failed consistent read falls back to the snapshot rather than failing the check', async () => {
    setup({ spendUsd: 120 });
    mockGetUserByIdConsistent.mockRejectedValue(new Error('throttled'));
    const spy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const status = await checkTokenUsage(OWNER);
    spy.mockRestore();
    expect(status.allowed).toBe(true);
  });

  it('below the pool it costs nothing: no consistent read', async () => {
    setup({ spendUsd: 60 });
    await bothGates();
    expect(mockGetUserByIdConsistent).not.toHaveBeenCalled();
  });
});
