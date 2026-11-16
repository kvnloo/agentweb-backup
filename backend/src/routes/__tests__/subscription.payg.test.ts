/**
 * ENG-668 — GET/PUT /api/subscription/payg.
 *
 * Billing and auth invariants: only the billing owner can opt a pool into being billed for overage;
 * enabling requires a payment method confirmed live with Stripe and never enables on a Stripe error;
 * the customer only ever sees percentages. The route, the service and billing-owner resolution run
 * for real over mocked storage, so the 403 below is the real `resolveBillingUserId` answering.
 */
import express from 'express';
import request from 'supertest';

jest.mock('../../middleware/auth', () => ({
  authenticateToken: jest.fn((req: any, _res: any, next: any) => {
    const userId = req.headers['x-test-user'];
    if (userId) req.user = { userId, email: `${userId}@example.com`, isAdmin: false };
    if (req.headers['x-test-delegate-admin']) {
      req.delegateInfo = { adminUserId: req.headers['x-test-delegate-admin'], adminEmail: 'a@x', isDelegated: true };
    }
    next();
  }),
}));

jest.mock('../../services/db', () => ({
  userDb: { getUserById: jest.fn(), getUserByIdConsistent: jest.fn(), updateUser: jest.fn() },
  orgDb: { getOrgById: jest.fn() },
}));

jest.mock('../../services/subscriptionService', () => ({
  getUserSubscriptionType: jest.fn(),
  getSubscriptionTypeConfig: jest.fn(),
}));

jest.mock('../../services/settingsService', () => ({
  settingsService: { getSetting: jest.fn() },
}));

// The service asks ENG-2571's resolveUserPaymentMethod; the tests drive its answer per Stripe customer id.
const mockHasPaymentMethod = jest.fn();
jest.mock('../../services/stripeService', () => ({
  stripeService: {
    resolveUserPaymentMethod: jest.fn(async (user: { stripe_customer_id?: string } | null) => ({
      hasPaymentMethod: await mockHasPaymentMethod(user?.stripe_customer_id),
      customerId: null,
      card: null,
      isZoma: false,
    })),
  },
}));

jest.mock('../../services/spendEnforcementBasis', () => ({
  resolveEnforcementCostBasisMicroUsd: jest.fn(),
}));

import subscriptionRoutes from '../subscription';
import { userDb, orgDb } from '../../services/db';
import { getSubscriptionTypeConfig, getUserSubscriptionType } from '../../services/subscriptionService';
import { resolveEnforcementCostBasisMicroUsd } from '../../services/spendEnforcementBasis';
import {
  LIVE_PAYMENT_METHOD_CHECK_WINDOW_MS,
  paygOverageSwitch,
  resetLivePaymentMethodChecksForTests,
} from '../../services/paygOverageService';
import { getCurrentUsageMonth } from '../../services/llmUsageCreditService';
import { evaluateCondition, type UpdateUserOptions } from '../../__tests__/helpers/userRowFake';
import { getEffectiveLlmUsagePolicy } from '../../services/llmUsagePolicyResolverService';
import { computePaygSettlementAmount, paygMonthInputsFromRow } from '../../services/paygSettlement';

const USD = 1_000_000;
const OWNER = 'owner-1';
const MEMBER = 'member-1';
const SELF_PAYING_MEMBER = 'member-2';
const ORG = 'org-1';

const mockGetUserById = userDb.getUserById as jest.Mock;
const mockUpdateUser = (userDb as any).updateUser as jest.Mock;
const mockGetOrgById = orgDb.getOrgById as jest.Mock;
const mockTierName = getUserSubscriptionType as jest.Mock;
const mockTierConfig = getSubscriptionTypeConfig as jest.Mock;
const mockSpend = resolveEnforcementCostBasisMicroUsd as jest.Mock;

const policy = {
  version: 'pro-2026-10',
  enforcementState: 'hard_only',
  optimizationCostThresholdMicroUsd: 50 * USD,
  hardCostThresholdMicroUsd: 100 * USD,
  optimizedModelIds: ['gpt-5-chat-2'],
  optimizedDefaultModel: 'gpt-5-chat-2',
};

let users: Record<string, any>;
let switchSpy: jest.SpyInstance;
let app: express.Application;

function tier(over: Record<string, unknown> = {}) {
  return { name: 'Pro', allowedPages: [], allowedSkills: [], llmUsagePolicy: policy, paygOverage: { allowed: true, markupBps: 25_000 }, ...over };
}

beforeEach(() => {
  jest.clearAllMocks();
  users = {
    [OWNER]: {
      userId: OWNER, email: 'owner@example.com', orgId: ORG, subscription_status: 'active',
      has_payment_method: true, stripe_customer_id: 'cus_owner',
    },
    [MEMBER]: { userId: MEMBER, email: 'member@example.com', orgId: ORG },
    [SELF_PAYING_MEMBER]: {
      userId: SELF_PAYING_MEMBER, email: 'm2@example.com', orgId: ORG, subscription_status: 'active',
      has_payment_method: true, stripe_customer_id: 'cus_m2',
    },
  };
  mockGetUserById.mockImplementation(async (id: string) => users[id] ?? null);
  ((userDb as any).getUserByIdConsistent as jest.Mock).mockImplementation(async (id: string) => users[id] ?? undefined);
  // Mirrors updateUser's ALL_NEW return for the shapes the service writes.
  mockUpdateUser.mockImplementation(async (id: string, fields: any, options: any) => {
    const user = users[id];
    Object.assign(user, fields);
    for (const { path, value } of options?.pathSets ?? []) user[path[0]] = { ...user[path[0]], [path[1]]: value };
    return user;
  });
  mockGetOrgById.mockResolvedValue({ orgId: ORG, ownerUserId: OWNER });
  mockTierName.mockResolvedValue('Pro');
  mockTierConfig.mockResolvedValue(tier());
  mockSpend.mockResolvedValue({ rawCostUsedMicroUsd: 0 });
  mockHasPaymentMethod.mockResolvedValue(true);
  switchSpy = jest.spyOn(paygOverageSwitch, 'isEnabled').mockResolvedValue(true);
  resetLivePaymentMethodChecksForTests();
  app = express();
  app.use(express.json());
  app.use('/api/subscription', subscriptionRoutes);
});

afterEach(() => switchSpy.mockRestore());

/** The PUT's own settings write (version- or absence-conditional), not the gate's high-water write. */
const settingsWrite = () => mockUpdateUser.mock.calls.find(([, , options]: any[]) =>
  /#payg\.#version|attribute_not_exists\(#paygOverage\)/.test(options?.condition?.expression ?? ''))!;

const put = (userId: string, body: unknown) =>
  request(app).put('/api/subscription/payg').set('x-test-user', userId).send(body as object);
const get = (userId: string) => request(app).get('/api/subscription/payg').set('x-test-user', userId);

describe('GET /api/subscription/payg', () => {
  it('describes the caller\'s pool in percentages only', async () => {
    const res = await get(OWNER).expect(200);
    expect(res.body).toEqual({
      available: true,
      eligible: true,
      enabled: false,
      capPercentOfPool: null,
      overagePercentUsed: 0,
      suspended: null,
      hasPaymentMethod: true,
      openInvoiceUrl: null,
    });
  });

  it('points the owner of a suspended account at the unpaid invoice (no amount); a pooled member sees none (rvE2E MINOR 5)', async () => {
    users[OWNER].paygOverage = {
      enabled: true, capPercentOfPool: 50, updatedBy: OWNER, updatedAt: '2026-10-01T00:00:00.000Z', version: 1,
      suspended: { reason: 'payment_failed', at: '2026-10-05T00:00:00.000Z', invoiceId: 'in_sep' },
    };
    users[OWNER].paygSettlements = {
      '2026-08': { status: 'paid', invoiceId: 'in_aug', hostedInvoiceUrl: 'https://invoice.stripe.com/i/aug' },
      '2026-09': { status: 'failed', invoiceId: 'in_sep', hostedInvoiceUrl: 'https://invoice.stripe.com/i/sep', amountCents: 4500 },
    };
    const owner = await get(OWNER).expect(200);
    expect(owner.body).toMatchObject({ suspended: 'payment_failed', openInvoiceUrl: 'https://invoice.stripe.com/i/sep' });
    expect(JSON.stringify(owner.body)).not.toMatch(/4500|amount/i);
    const member = await get(MEMBER).expect(200);
    expect(member.body.openInvoiceUrl).toBeNull();
  });

  it.each([
    [{ reason: 'dispute', at: '2026-10-05T00:00:00.000Z', invoiceId: 'in_aug', disputeId: 'dp_1' }],
    [{ reason: 'dispute', at: '2026-10-05T00:00:00.000Z', invoiceId: 'in_aug', disputeId: 'dp_1', lost: true }],
  ])('under a dispute hold (%j) no invoice link, even with a month unpaid — the same rule as the 429 (rv6 MINOR 4c)', async (suspended) => {
    users[OWNER].paygOverage = {
      enabled: true, capPercentOfPool: 50, updatedBy: OWNER, updatedAt: '2026-10-01T00:00:00.000Z', version: 1, suspended,
    };
    users[OWNER].paygSettlements = {
      '2026-09': { status: 'failed', invoiceId: 'in_sep', hostedInvoiceUrl: 'https://invoice.stripe.com/i/sep' },
    };
    const owner = await get(OWNER).expect(200);
    expect(owner.body).toMatchObject({ suspended: 'dispute', openInvoiceUrl: null });
  });

  it('reports overage as a percentage of the cap, never in dollars', async () => {
    users[OWNER].paygOverage = {
      enabled: true, capPercentOfPool: 50, updatedBy: OWNER,
      updatedAt: '2026-10-01T00:00:00.000Z', version: 1,
    };
    mockSpend.mockResolvedValue({ rawCostUsedMicroUsd: 110 * USD });
    const res = await get(OWNER).expect(200);
    expect(res.body).toMatchObject({ enabled: true, capPercentOfPool: 50, overagePercentUsed: 20 });
    expect(JSON.stringify(res.body)).not.toMatch(/MicroUsd|\$/);
  });

  it('shows a pooled org member the pool, but not as theirs to change', async () => {
    const res = await get(MEMBER).expect(200);
    expect(res.body).toMatchObject({ available: true, eligible: false });
  });

  it('never shows a member the owner\'s payment-method status (false, field kept)', async () => {
    const res = await get(MEMBER).expect(200);
    expect(users[OWNER].has_payment_method).toBe(true);
    expect(res.body.hasPaymentMethod).toBe(false);
  });

  describe('repairs a stale cached payment-method flag for an owner with PAYG on', () => {
    beforeEach(() => {
      users[OWNER].has_payment_method = false;
      users[OWNER].paygOverage = {
        enabled: true, capPercentOfPool: 50, updatedBy: OWNER, updatedAt: '2026-10-01T00:00:00.000Z', version: 1,
      };
    });

    it('asks Stripe once, sets the flag, and the gate admits again', async () => {
      mockSpend.mockResolvedValue({ rawCostUsedMicroUsd: 101 * USD });
      // Before: the gate refuses on the stale flag.
      const before = await request(app).get('/api/subscription/usage').set('x-test-user', OWNER).expect(200);
      expect(before.body.usageBlock).toMatchObject({ reason: 'payg_inactive', paygInactiveReason: 'no_payment_method' });

      const res = await get(OWNER).expect(200);
      expect(mockHasPaymentMethod).toHaveBeenCalledWith('cus_owner');
      expect(mockUpdateUser).toHaveBeenCalledWith(OWNER, { has_payment_method: true });
      expect(res.body.hasPaymentMethod).toBe(true);

      const after = await request(app).get('/api/subscription/usage').set('x-test-user', OWNER).expect(200);
      expect(after.body.allowed).toBe(true);
      expect(after.body.usageBlock).not.toHaveProperty('reason');
    });

    it('leaves the flag alone (and still answers 200) when Stripe fails', async () => {
      mockHasPaymentMethod.mockRejectedValue(new Error('stripe down'));
      const spy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
      const res = await get(OWNER).expect(200);
      spy.mockRestore();
      expect(res.body.hasPaymentMethod).toBe(false);
      expect(mockUpdateUser).not.toHaveBeenCalledWith(OWNER, { has_payment_method: true });
    });

    it('leaves the flag alone when Stripe confirms there is still no card', async () => {
      mockHasPaymentMethod.mockResolvedValue(false);
      expect((await get(OWNER).expect(200)).body.hasPaymentMethod).toBe(false);
      expect(mockUpdateUser).not.toHaveBeenCalledWith(OWNER, { has_payment_method: true });
    });

    it('does not ask Stripe when the cached flag is already true', async () => {
      users[OWNER].has_payment_method = true;
      expect((await get(OWNER).expect(200)).body.hasPaymentMethod).toBe(true);
      expect(mockHasPaymentMethod).not.toHaveBeenCalled();
    });

    it('asks Stripe at most once per owner per window, however often settings are opened', async () => {
      mockHasPaymentMethod.mockResolvedValue(false);
      const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(1_000_000);
      try {
        await get(OWNER).expect(200);
        nowSpy.mockReturnValue(1_000_000 + LIVE_PAYMENT_METHOD_CHECK_WINDOW_MS - 1);
        await get(OWNER).expect(200);
        expect(mockHasPaymentMethod).toHaveBeenCalledTimes(1);
        nowSpy.mockReturnValue(1_000_000 + LIVE_PAYMENT_METHOD_CHECK_WINDOW_MS);
        await get(OWNER).expect(200);
        expect(mockHasPaymentMethod).toHaveBeenCalledTimes(2);
      } finally {
        nowSpy.mockRestore();
      }
    });

    it('does not ask Stripe for a member, or when PAYG is off', async () => {
      await get(MEMBER).expect(200);
      expect(mockHasPaymentMethod).not.toHaveBeenCalled();
      users[OWNER].paygOverage.enabled = false;
      await get(OWNER).expect(200);
      expect(mockHasPaymentMethod).not.toHaveBeenCalled();
    });
  });

  it('is unavailable while the switch is off or the tier does not allow PAYG', async () => {
    switchSpy.mockResolvedValue(false);
    expect((await get(OWNER).expect(200)).body.available).toBe(false);
    switchSpy.mockResolvedValue(true);
    mockTierConfig.mockResolvedValue(tier({ paygOverage: { allowed: false, markupBps: 25_000 } }));
    expect((await get(OWNER).expect(200)).body.available).toBe(false);
  });

  it('401s without a user', async () => {
    await request(app).get('/api/subscription/payg').expect(401);
  });
});

describe('PUT /api/subscription/payg', () => {
  it('enables PAYG for the billing owner, storing the cap as a percentage only', async () => {
    const res = await put(OWNER, { enabled: true, capPercentOfPool: 50 }).expect(200);

    expect(mockHasPaymentMethod).toHaveBeenCalledWith('cus_owner');
    expect(res.body).toMatchObject({ enabled: true, capPercentOfPool: 50, eligible: true, overagePercentUsed: 0 });
    const [, fields, options] = mockUpdateUser.mock.calls[0];
    expect(fields.paygOverage).toEqual({
      enabled: true,
      capPercentOfPool: 50,
      optIn: { month: getCurrentUsageMonth(), overageBaselineMicroUsd: 0, poolAtOptInMicroUsd: 100 * USD },
      // Pinned at the opt-in pool so the pool cannot drop under the one the baseline was measured on.
      poolHighWater: { month: getCurrentUsageMonth(), thresholdMicroUsd: 100 * USD },
      updatedBy: OWNER,
      updatedAt: expect.any(String),
      version: 1,
    });
    expect(fields.paygOverage).not.toHaveProperty('capMicroUsd');
    expect(options.condition.expression).toBe('attribute_not_exists(#paygOverage)');
    expect(JSON.stringify(res.body)).not.toMatch(/MicroUsd/);
  });

  it('enabling with a stale cached flag records the card Stripe just confirmed, so the gate admits', async () => {
    users[OWNER].has_payment_method = false;
    mockSpend.mockResolvedValue({ rawCostUsedMicroUsd: 101 * USD });
    const res = await put(OWNER, { enabled: true, capPercentOfPool: 50 }).expect(200);

    // Same conditional write as the settings.
    const [, fields, options] = mockUpdateUser.mock.calls[0];
    expect(fields.has_payment_method).toBe(true);
    expect(options.condition.expression).toBe('attribute_not_exists(#paygOverage)');
    expect(res.body.hasPaymentMethod).toBe(true);

    const usage = await request(app).get('/api/subscription/usage').set('x-test-user', OWNER).expect(200);
    expect(usage.body.allowed).toBe(true);
    expect(usage.body.usageBlock).not.toHaveProperty('reason');
  });

  it('re-enabling an existing record also writes the confirmed flag, in the version-conditional update', async () => {
    users[OWNER].has_payment_method = false;
    users[OWNER].paygOverage = {
      enabled: false, capPercentOfPool: 50, updatedBy: OWNER, updatedAt: '2026-10-01T00:00:00.000Z', version: 2,
    };
    await put(OWNER, { enabled: true, capPercentOfPool: 50 }).expect(200);
    const [, fields, options] = settingsWrite();
    expect(fields).toEqual({ has_payment_method: true });
    expect(options.condition.expression).toContain('#payg.#version = :expectedVersion');
  });

  it('an opt-in never lowers a high-water mark the gate raised meanwhile (conflict, not a lower mark)', async () => {
    // Read: the month's pool was $100. Between that read and the write, a check raised the stored mark
    // to $300 (a top-up). The opt-in's write must not put $100 back: its guard fails and it is a 409.
    // (A mark from THIS month: rolling a previous month's mark over has its own exact-match guard, below.)
    users[OWNER].paygOverage = {
      enabled: false, capPercentOfPool: 50, updatedBy: OWNER, updatedAt: '2026-10-01T00:00:00.000Z', version: 2,
      poolHighWater: { month: getCurrentUsageMonth(), thresholdMicroUsd: 50 * USD },
    };
    const storedThreshold = 300 * USD;
    const recordWrite = mockUpdateUser.getMockImplementation()!;
    mockUpdateUser.mockImplementation(async (id: string, fields: any, options: any) => {
      // Only the settings write (version-conditional) meets the raced mark; the gate's own mark write passes.
      if (/#payg\.#version/.test(options?.condition?.expression ?? '')) {
        const guarded = /#payg\.#hw\.#hwThreshold <= :hwThreshold/.test(options.condition.expression);
        if (guarded && options.condition.values[':hwThreshold'] < storedThreshold) {
          throw Object.assign(new Error('cond'), { code: 'ConditionalCheckFailedException' });
        }
        return users[OWNER];
      }
      return recordWrite(id, fields, options);
    });

    const res = await put(OWNER, { enabled: true, capPercentOfPool: 50 }).expect(409);
    expect(res.body.error).toBe('payg_conflict');
    const [, , options] = settingsWrite();
    expect(options.condition.values).toMatchObject({ ':hwMonth': getCurrentUsageMonth(), ':hwThreshold': 100 * USD });
  });

  it('the month\'s first opt-in keeps last month\'s opt-in and mark as the closed copies settlement reads (PR-2)', async () => {
    const lastMonthOptIn = { month: '2000-01', overageBaselineMicroUsd: 7 * USD, poolAtOptInMicroUsd: 100 * USD };
    const lastMonthMark = { month: '2000-01', thresholdMicroUsd: 120 * USD };
    users[OWNER].paygOverage = {
      enabled: false, capPercentOfPool: 50, updatedBy: OWNER, updatedAt: '2026-10-01T00:00:00.000Z', version: 2,
      optIn: lastMonthOptIn, poolHighWater: lastMonthMark,
    };
    // Conditions are evaluated against the row here. The opt-in's own usage read is a read (no gate
    // write, rv4), so the settings write is the one that rolls the mark over.
    const apply = mockUpdateUser.getMockImplementation()!;
    mockUpdateUser.mockImplementation(async (id: string, fields: Record<string, unknown>, options: UpdateUserOptions | undefined) => {
      const condition = options?.condition;
      if (condition && !evaluateCondition(condition.expression, users[id], condition.names, condition.values)) {
        throw Object.assign(new Error('cond'), { code: 'ConditionalCheckFailedException' });
      }
      return apply(id, fields, options);
    });
    await put(OWNER, { enabled: true, capPercentOfPool: 50 }).expect(200);
    expect(mockUpdateUser).toHaveBeenCalledTimes(1);
    const written = users[OWNER].paygOverage;
    expect(written.optIn).toMatchObject({ month: getCurrentUsageMonth() });
    expect(written.optInClosed).toEqual(lastMonthOptIn);
    expect(written.poolHighWater).toEqual({ month: getCurrentUsageMonth(), thresholdMicroUsd: 100 * USD });
    expect(written.poolHighWaterClosed).toEqual(lastMonthMark);
    const [, , options] = settingsWrite();
    expect(options.condition.values).toMatchObject({ ':prevHwMonth': '2000-01', ':prevHwThreshold': 120 * USD });
  });

  it('...and still succeeds when a turn gate rolled the mark over between the read and the write', async () => {
    const lastMonthMark = { month: '2000-01', thresholdMicroUsd: 120 * USD };
    users[OWNER].paygOverage = {
      enabled: false, capPercentOfPool: 50, updatedBy: OWNER, updatedAt: '2026-10-01T00:00:00.000Z', version: 2,
      poolHighWater: lastMonthMark,
    };
    const apply = mockUpdateUser.getMockImplementation()!;
    mockUpdateUser.mockImplementation(async (id: string, fields: Record<string, unknown>, options: UpdateUserOptions | undefined) => {
      // A turn elsewhere rolls the mark over first, exactly as the gate does.
      users[id].paygOverage = {
        ...users[id].paygOverage,
        poolHighWater: { month: getCurrentUsageMonth(), thresholdMicroUsd: 100 * USD },
        poolHighWaterClosed: lastMonthMark,
      };
      const condition = options?.condition;
      if (condition && !evaluateCondition(condition.expression, users[id], condition.names, condition.values)) {
        throw Object.assign(new Error('cond'), { code: 'ConditionalCheckFailedException' });
      }
      return apply(id, fields, options);
    });
    await put(OWNER, { enabled: true, capPercentOfPool: 50 }).expect(200);
    expect(users[OWNER].paygOverage).toMatchObject({
      enabled: true,
      poolHighWater: { month: getCurrentUsageMonth(), thresholdMicroUsd: 100 * USD },
      poolHighWaterClosed: lastMonthMark,
    });
  });

  it('rolling last month\'s mark over still never lowers a mark the gate raised this month', async () => {
    users[OWNER].paygOverage = {
      enabled: false, capPercentOfPool: 50, updatedBy: OWNER, updatedAt: '2026-10-01T00:00:00.000Z', version: 2,
      poolHighWater: { month: '2000-01', thresholdMicroUsd: 120 * USD },
    };
    const apply = mockUpdateUser.getMockImplementation()!;
    mockUpdateUser.mockImplementation(async (id: string, fields: Record<string, unknown>, options: UpdateUserOptions | undefined) => {
      const condition = options?.condition;
      if (/#payg\.#version/.test(condition?.expression ?? '')) {
        // Between the read and this write, a check raised this month's mark to $300 (a top-up).
        users[id].paygOverage.poolHighWater = { month: getCurrentUsageMonth(), thresholdMicroUsd: 300 * USD };
      }
      if (condition && !evaluateCondition(condition.expression, users[id], condition.names, condition.values)) {
        throw Object.assign(new Error('cond'), { code: 'ConditionalCheckFailedException' });
      }
      return apply(id, fields, options);
    });
    const res = await put(OWNER, { enabled: true, capPercentOfPool: 50 }).expect(409);
    expect(res.body.error).toBe('payg_conflict');
    expect(users[OWNER].paygOverage.poolHighWater).toEqual({ month: getCurrentUsageMonth(), thresholdMicroUsd: 300 * USD });
  });

  it('off -> on after PAYG already admitted this month keeps the month\'s baseline: a toggle cannot reset the cap (review M3)', async () => {
    const month = getCurrentUsageMonth();
    const [y, m] = month.split('-').map(Number);
    const previousMonth = getCurrentUsageMonth(new Date(Date.UTC(y, m - 2, 1)));
    // Opted in last month (baseline 0 for this one) and PAYG has already admitted $45 of the $50 cap.
    const carriedOptIn = { month: previousMonth, overageBaselineMicroUsd: 0, poolAtOptInMicroUsd: 100 * USD };
    users[OWNER].paygOverage = {
      enabled: true, capPercentOfPool: 50, updatedBy: OWNER, updatedAt: '2026-10-01T00:00:00.000Z', version: 3,
      optIn: carriedOptIn,
      poolHighWater: { month, thresholdMicroUsd: 100 * USD },
      admittedMonths: [{ month, capHighWaterMicroUsd: 50 * USD, tierPoolHighWaterMicroUsd: 100 * USD, markupBps: 25_000, spendBasis: 'spend_ledger' }],
    };
    mockSpend.mockResolvedValue({ rawCostUsedMicroUsd: 145 * USD });
    await put(OWNER, { enabled: false }).expect(200);
    await put(OWNER, { enabled: true, capPercentOfPool: 50 }).expect(200);
    // No re-measured baseline: the $45 already admitted is still counted against this month's cap.
    expect(users[OWNER].paygOverage.optIn).toEqual(carriedOptIn);
    expect(users[OWNER].paygOverage.optInClosed).toBeUndefined();

    // Another $45: the gate refuses at the cap instead of admitting a second "fresh" cap's worth.
    mockSpend.mockResolvedValue({ rawCostUsedMicroUsd: 190 * USD });
    const usage = await getEffectiveLlmUsagePolicy(OWNER);
    expect(usage.mode.admissionAllowed).toBe(false);
    expect(usage.paygBlock).toEqual({ reason: 'payg_cap_reached' });
    // And settlement bills at most the cap.
    const amount = computePaygSettlementAmount({
      month,
      admitted: users[OWNER].paygOverage.admittedMonths[0],
      inputs: paygMonthInputsFromRow(users[OWNER], month, month)!,
      settledMicroUsd: 190 * USD,
    })!;
    expect(amount.overageCostMicroUsd).toBe(50 * USD);
  });

  it('the settings view is a read: past the pool with PAYG on, it writes nothing (rv4 MINOR 2)', async () => {
    users[OWNER].paygOverage = {
      enabled: true, capPercentOfPool: 50, updatedBy: OWNER, updatedAt: '2026-10-01T00:00:00.000Z', version: 3,
      poolHighWater: { month: '2000-01', thresholdMicroUsd: 1 },
    };
    mockSpend.mockResolvedValue({ rawCostUsedMicroUsd: 130 * USD, basis: 'spend_ledger' });
    const res = await get(OWNER).expect(200);
    expect(res.body.overagePercentUsed).toBe(60);
    expect(mockUpdateUser).not.toHaveBeenCalled();
    expect(users[OWNER].paygOverage.admittedMonths).toBeUndefined();
    expect(users[OWNER].paygOverage.poolHighWater).toEqual({ month: '2000-01', thresholdMicroUsd: 1 });
  });

  it('off -> on in a month PAYG has not admitted in still measures a fresh baseline', async () => {
    const month = getCurrentUsageMonth();
    users[OWNER].paygOverage = {
      enabled: false, capPercentOfPool: 50, updatedBy: OWNER, updatedAt: '2026-10-01T00:00:00.000Z', version: 3,
      optIn: { month: '2000-01', overageBaselineMicroUsd: 0 },
      poolHighWater: { month, thresholdMicroUsd: 100 * USD },
    };
    mockSpend.mockResolvedValue({ rawCostUsedMicroUsd: 130 * USD });
    await put(OWNER, { enabled: true, capPercentOfPool: 50 }).expect(200);
    expect(users[OWNER].paygOverage.optIn).toMatchObject({ month, overageBaselineMicroUsd: 30 * USD });
  });

  it('a re-enable later in the same month leaves the closed copies alone', async () => {
    const month = getCurrentUsageMonth();
    users[OWNER].paygOverage = {
      enabled: false, capPercentOfPool: 50, updatedBy: OWNER, updatedAt: '2026-10-01T00:00:00.000Z', version: 2,
      optIn: { month, overageBaselineMicroUsd: 0, poolAtOptInMicroUsd: 100 * USD },
      poolHighWater: { month, thresholdMicroUsd: 100 * USD },
      optInClosed: { month: '2000-01', overageBaselineMicroUsd: 7 * USD },
    };
    await put(OWNER, { enabled: true, capPercentOfPool: 50 }).expect(200);
    const [, , options] = settingsWrite();
    const paths = options.pathSets.map((p: { path: Array<string | number> }) => p.path[1]);
    expect(paths).not.toContain('optInClosed');
    expect(paths).not.toContain('poolHighWaterClosed');
    expect(users[OWNER].paygOverage.optInClosed).toEqual({ month: '2000-01', overageBaselineMicroUsd: 7 * USD });
  });

  it('opting in with a live top-up pins the high-water mark without it (a refund must be able to take it back)', async () => {
    users[OWNER].llmUsageCredits = {
      month: require('../../services/tokenUsageService').getCurrentMonth(),
      totalPurchasedMicroUsd: 50 * USD, totalPurchasedReversedMicroUsd: 0, totalMigrationOffsetMicroUsd: 0,
      grantIds: ['stripe:cs_1'],
      grants: [{ id: 'stripe:cs_1', source: 'purchase', amountMicroUsd: 50 * USD, grantedAt: '2026-10-02T00:00:00.000Z' }],
    };
    await put(OWNER, { enabled: true, capPercentOfPool: 50 }).expect(200);
    const written = users[OWNER].paygOverage;
    // The opt-in pool includes the live top-up; the mark does not.
    expect(written.optIn).toMatchObject({ poolAtOptInMicroUsd: 150 * USD });
    expect(written.poolHighWater).toEqual({ month: getCurrentUsageMonth(), thresholdMicroUsd: 100 * USD });
  });

  it('opting in while already past the pool records the standing overage, so it reads 0% right after', async () => {
    // $250 spent on a $100 pool (a downgrade from a bigger pool earlier this month, before opting in).
    mockSpend.mockResolvedValue({ rawCostUsedMicroUsd: 250 * USD });
    const res = await put(OWNER, { enabled: true, capPercentOfPool: 200 }).expect(200);
    expect(mockUpdateUser.mock.calls[0][1].paygOverage.optIn)
      .toEqual({ month: getCurrentUsageMonth(), overageBaselineMicroUsd: 150 * USD, poolAtOptInMicroUsd: 100 * USD });
    expect(res.body.overagePercentUsed).toBe(0);
    expect((await get(OWNER).expect(200)).body.overagePercentUsed).toBe(0);

    // $20 more after opting in is 10% of the 200% cap ($200).
    mockSpend.mockResolvedValue({ rawCostUsedMicroUsd: 270 * USD });
    expect((await get(OWNER).expect(200)).body.overagePercentUsed).toBe(10);
  });

  describe('the opt-in baseline is per month: taken on the first off->on only', () => {
    it('re-enabling later in the same month keeps the baseline, so toggling cannot reset the cap', async () => {
      // First opt-in at the pool: baseline 0. Then $30 of overage = 60% of the 50% cap ($50).
      mockSpend.mockResolvedValue({ rawCostUsedMicroUsd: 100 * USD });
      await put(OWNER, { enabled: true, capPercentOfPool: 50 }).expect(200);
      const firstOptIn = users[OWNER].paygOverage.optIn;
      expect(firstOptIn).toEqual({ month: getCurrentUsageMonth(), overageBaselineMicroUsd: 0, poolAtOptInMicroUsd: 100 * USD });
      mockSpend.mockResolvedValue({ rawCostUsedMicroUsd: 130 * USD });
      expect((await get(OWNER).expect(200)).body.overagePercentUsed).toBe(60);

      await put(OWNER, { enabled: false }).expect(200);
      mockUpdateUser.mockClear();
      mockHasPaymentMethod.mockClear();
      const res = await put(OWNER, { enabled: true, capPercentOfPool: 50 }).expect(200);

      // Not re-measured: a fresh baseline would have been $30 and read 0%.
      expect(res.body.overagePercentUsed).toBe(60);
      expect(users[OWNER].paygOverage.optIn).toEqual(firstOptIn);
      const written = Object.fromEntries(mockUpdateUser.mock.calls[0][2].pathSets.map((p: any) => [p.path[1], p.value]));
      expect(written).not.toHaveProperty('optIn');
      // Still a real re-enable: the live payment-method check runs again.
      expect(mockHasPaymentMethod).toHaveBeenCalledWith('cus_owner');
    });

    it('a baseline from an earlier month is ignored: the new month starts at baseline 0', async () => {
      users[OWNER].paygOverage = {
        enabled: true, capPercentOfPool: 200, updatedBy: OWNER, updatedAt: '2000-01-31T00:00:00.000Z', version: 1,
        optIn: { month: '2000-01', overageBaselineMicroUsd: 150 * USD },
      };
      // $150 over a $100 pool this month: all of it counts, 75% of the 200% cap ($200).
      mockSpend.mockResolvedValue({ rawCostUsedMicroUsd: 250 * USD });
      expect((await get(OWNER).expect(200)).body.overagePercentUsed).toBe(75);
    });

    it('the first re-enable of a new month takes that month\'s baseline', async () => {
      users[OWNER].paygOverage = {
        enabled: false, capPercentOfPool: 200, updatedBy: OWNER, updatedAt: '2000-01-31T00:00:00.000Z', version: 1,
        optIn: { month: '2000-01', overageBaselineMicroUsd: 150 * USD },
      };
      mockSpend.mockResolvedValue({ rawCostUsedMicroUsd: 120 * USD });
      await put(OWNER, { enabled: true, capPercentOfPool: 200 }).expect(200);
      expect(users[OWNER].paygOverage.optIn)
        .toEqual({ month: getCurrentUsageMonth(), overageBaselineMicroUsd: 20 * USD, poolAtOptInMicroUsd: 100 * USD });
    });
  });

  describe('a delegated admin acting as the customer cannot consent to charges', () => {
    const putAsDelegate = (body: unknown) => request(app).put('/api/subscription/payg')
      .set('x-test-user', OWNER).set('x-test-delegate-admin', 'admin-9').send(body as object);

    it('403s turning PAYG on, without calling Stripe or writing', async () => {
      const res = await putAsDelegate({ enabled: true, capPercentOfPool: 25 }).expect(403);
      expect(res.body.error).toBe('delegate_cannot_consent');
      expect(mockHasPaymentMethod).not.toHaveBeenCalled();
      expect(mockUpdateUser).not.toHaveBeenCalled();
    });

    describe('with PAYG already on at 50%', () => {
      beforeEach(() => {
        users[OWNER].paygOverage = {
          enabled: true, capPercentOfPool: 50, updatedBy: OWNER, updatedAt: '2026-10-01T00:00:00.000Z', version: 2,
        };
      });

      it('403s re-enabling after the owner turned it off', async () => {
        users[OWNER].paygOverage.enabled = false;
        expect((await putAsDelegate({ enabled: true, capPercentOfPool: 50 }).expect(403)).body.error)
          .toBe('delegate_cannot_consent');
        expect(mockHasPaymentMethod).not.toHaveBeenCalled();
        expect(mockUpdateUser).not.toHaveBeenCalled();
      });

      it('403s raising the cap', async () => {
        expect((await putAsDelegate({ enabled: true, capPercentOfPool: 100 }).expect(403)).body.error)
          .toBe('delegate_cannot_consent');
        expect(mockUpdateUser).not.toHaveBeenCalled();
      });

      it('allows lowering the cap, recorded as the admin', async () => {
        await putAsDelegate({ enabled: true, capPercentOfPool: 25 }).expect(200);
        const written = Object.fromEntries(mockUpdateUser.mock.calls[0][2].pathSets.map((p: any) => [p.path[1], p.value]));
        expect(written).toMatchObject({ capPercentOfPool: 25, updatedBy: 'admin-9' });
      });

      it('allows turning it off, recorded as the admin', async () => {
        await putAsDelegate({ enabled: false }).expect(200);
        expect(users[OWNER].paygOverage).toMatchObject({ enabled: false, updatedBy: 'admin-9' });
      });
    });
  });

  it('403s an org member who pools onto the owner', async () => {
    const res = await put(MEMBER, { enabled: true, capPercentOfPool: 50 }).expect(403);
    expect(res.body.error).toBe('not_billing_owner');
    expect(mockUpdateUser).not.toHaveBeenCalled();
    expect(mockHasPaymentMethod).not.toHaveBeenCalled();
  });

  it('lets a member paying for their own plan enable PAYG on their own pool', async () => {
    await put(SELF_PAYING_MEMBER, { enabled: true, capPercentOfPool: 100 }).expect(200);
    expect(mockHasPaymentMethod).toHaveBeenCalledWith('cus_m2');
    expect(mockUpdateUser.mock.calls[0][0]).toBe(SELF_PAYING_MEMBER);
  });

  it.each([
    ['the switch is off', () => switchSpy.mockResolvedValue(false)],
    ['the tier disallows PAYG', () => mockTierConfig.mockResolvedValue(tier({ paygOverage: { allowed: false, markupBps: 25_000 } }))],
    ['the tier has no PAYG config', () => mockTierConfig.mockResolvedValue(tier({ paygOverage: undefined }))],
    ['the tier has no enforced pool', () => mockTierConfig.mockResolvedValue(tier({ llmUsagePolicy: { ...policy, enforcementState: 'observe' } }))],
  ])('404s payg_unavailable when %s', async (_label, arrange) => {
    arrange();
    const res = await put(OWNER, { enabled: true, capPercentOfPool: 50 }).expect(404);
    expect(res.body.error).toBe('payg_unavailable');
    expect(mockUpdateUser).not.toHaveBeenCalled();
  });

  it.each([
    [{ enabled: true }],
    [{ enabled: true, capPercentOfPool: 75 }],
    [{ enabled: true, capPercentOfPool: '50' }],
    [{ enabled: false, capPercentOfPool: 0 }],
  ])('422s invalid_cap for %j', async (body) => {
    const res = await put(OWNER, body).expect(422);
    expect(res.body.error).toBe('invalid_cap');
    expect(mockUpdateUser).not.toHaveBeenCalled();
  });

  it('400s a non-boolean enabled', async () => {
    expect((await put(OWNER, { enabled: 'yes', capPercentOfPool: 50 }).expect(400)).body.error).toBe('invalid_request');
  });

  it('409s enabling without a payment method on file in Stripe, even if the cached flag says otherwise', async () => {
    mockHasPaymentMethod.mockResolvedValue(false);
    const res = await put(OWNER, { enabled: true, capPercentOfPool: 50 }).expect(409);
    expect(res.body.error).toBe('payment_method_required');
    expect(mockUpdateUser).not.toHaveBeenCalled();
  });

  it('409s enabling with no Stripe customer at all, without calling Stripe', async () => {
    delete users[OWNER].stripe_customer_id;
    expect((await put(OWNER, { enabled: true, capPercentOfPool: 50 }).expect(409)).body.error).toBe('payment_method_required');
    expect(mockHasPaymentMethod).not.toHaveBeenCalled();
  });

  it('503s and does not enable when the live Stripe check fails', async () => {
    mockHasPaymentMethod.mockRejectedValue(new Error('stripe down'));
    const spy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const res = await put(OWNER, { enabled: true, capPercentOfPool: 50 }).expect(503);
    spy.mockRestore();
    expect(res.body.error).toBe('payment_check_unavailable');
    expect(mockUpdateUser).not.toHaveBeenCalled();
  });

  describe('with PAYG already on', () => {
    beforeEach(() => {
      users[OWNER].paygOverage = {
        enabled: true, capPercentOfPool: 100, updatedBy: OWNER,
        updatedAt: '2026-10-01T00:00:00.000Z', version: 3,
        poolHighWater: { month: '2026-10', thresholdMicroUsd: 100 * USD },
        suspended: { reason: 'payment_failed', at: '2026-10-02T00:00:00.000Z' },
      };
    });

    it('disables without touching Stripe, conditional on the version it read, keeping the high-water mark and suspension', async () => {
      mockHasPaymentMethod.mockRejectedValue(new Error('stripe down'));
      const res = await put(OWNER, { enabled: false }).expect(200);
      expect(mockHasPaymentMethod).not.toHaveBeenCalled();
      expect(res.body).toMatchObject({ enabled: false, capPercentOfPool: 100, suspended: 'payment_failed' });

      const [, fields, options] = mockUpdateUser.mock.calls[0];
      expect(fields).toEqual({});
      const written = Object.fromEntries(options.pathSets.map((p: any) => [p.path[1], p.value]));
      expect(written).toMatchObject({ enabled: false, updatedBy: OWNER, version: 4 });
      expect(written).not.toHaveProperty('optIn');
      expect(written).not.toHaveProperty('poolHighWater');
      expect(written).not.toHaveProperty('suspended');
      expect(options.condition.values).toEqual({ ':expectedVersion': 3 });
    });

    it('lowers the cap without a Stripe call; it applies from the next check', async () => {
      const res = await put(OWNER, { enabled: true, capPercentOfPool: 25 }).expect(200);
      expect(mockHasPaymentMethod).not.toHaveBeenCalled();
      expect(res.body.capPercentOfPool).toBe(25);
      const written = Object.fromEntries(mockUpdateUser.mock.calls[0][2].pathSets.map((p: any) => [p.path[1], p.value]));
      expect(written).toEqual({ enabled: true, capPercentOfPool: 25, updatedBy: OWNER, updatedAt: expect.any(String), version: 4 });
    });

    it('lets the owner turn PAYG off even after the tier stopped offering it', async () => {
      mockTierConfig.mockResolvedValue(tier({ paygOverage: { allowed: false, markupBps: 25_000 } }));
      await put(OWNER, { enabled: false }).expect(200);
      expect(users[OWNER].paygOverage.enabled).toBe(false);
    });

    it('turning it off with a cap in the body never needs a usage pool (tier policy now observe)', async () => {
      mockTierConfig.mockResolvedValue(tier({ llmUsagePolicy: { ...policy, enforcementState: 'observe' } }));
      await put(OWNER, { enabled: false, capPercentOfPool: 100 }).expect(200);
      expect(users[OWNER].paygOverage).toMatchObject({ enabled: false, capPercentOfPool: 100 });
      expect(mockHasPaymentMethod).not.toHaveBeenCalled();
    });

    it('still 403s a pooled member trying to turn it off', async () => {
      expect((await put(MEMBER, { enabled: false }).expect(403)).body.error).toBe('not_billing_owner');
    });

    it('409s payg_conflict when the settings changed underneath (version moved)', async () => {
      mockUpdateUser.mockRejectedValueOnce(Object.assign(new Error('cond'), { code: 'ConditionalCheckFailedException' }));
      expect((await put(OWNER, { enabled: false }).expect(409)).body.error).toBe('payg_conflict');
    });
  });

  it('disabling with nothing stored is a no-op', async () => {
    const res = await put(OWNER, { enabled: false }).expect(200);
    expect(res.body.enabled).toBe(false);
    expect(mockUpdateUser).not.toHaveBeenCalled();
  });
});
