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
  userDb: { getUserById: jest.fn(), updateUser: jest.fn() },
  orgDb: { getOrgById: jest.fn() },
}));

jest.mock('../../services/subscriptionService', () => ({
  getUserSubscriptionType: jest.fn(),
  getSubscriptionTypeConfig: jest.fn(),
}));

jest.mock('../../services/settingsService', () => ({
  settingsService: { getSetting: jest.fn() },
}));

jest.mock('../../services/stripeService', () => ({
  stripeService: { customerHasPaymentMethod: jest.fn() },
}));

jest.mock('../../services/spendEnforcementBasis', () => ({
  resolveEnforcementCostBasisMicroUsd: jest.fn(),
}));

import subscriptionRoutes from '../subscription';
import { userDb, orgDb } from '../../services/db';
import { getSubscriptionTypeConfig, getUserSubscriptionType } from '../../services/subscriptionService';
import { stripeService } from '../../services/stripeService';
import { resolveEnforcementCostBasisMicroUsd } from '../../services/spendEnforcementBasis';
import { paygOverageSwitch } from '../../services/paygOverageService';
import { getCurrentUsageMonth } from '../../services/llmUsageCreditService';

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
const mockHasPaymentMethod = stripeService.customerHasPaymentMethod as jest.Mock;
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
  // Mirrors updateUser's ALL_NEW return for the shapes the service writes.
  mockUpdateUser.mockImplementation(async (id: string, fields: any, options: any) => {
    const user = users[id];
    if (fields.paygOverage) user.paygOverage = fields.paygOverage;
    for (const { path, value } of options?.pathSets ?? []) user[path[0]] = { ...user[path[0]], [path[1]]: value };
    return user;
  });
  mockGetOrgById.mockResolvedValue({ orgId: ORG, ownerUserId: OWNER });
  mockTierName.mockResolvedValue('Pro');
  mockTierConfig.mockResolvedValue(tier());
  mockSpend.mockResolvedValue({ rawCostUsedMicroUsd: 0 });
  mockHasPaymentMethod.mockResolvedValue(true);
  switchSpy = jest.spyOn(paygOverageSwitch, 'isEnabled').mockResolvedValue(true);
  app = express();
  app.use(express.json());
  app.use('/api/subscription', subscriptionRoutes);
});

afterEach(() => switchSpy.mockRestore());

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
    });
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
      optIn: { month: getCurrentUsageMonth(), overageBaselineMicroUsd: 0 },
      updatedBy: OWNER,
      updatedAt: expect.any(String),
      version: 1,
    });
    expect(fields.paygOverage).not.toHaveProperty('capMicroUsd');
    expect(options.condition.expression).toBe('attribute_not_exists(#paygOverage)');
    expect(JSON.stringify(res.body)).not.toMatch(/MicroUsd/);
  });

  it('opting in while already past the pool records the standing overage, so it reads 0% right after', async () => {
    // $250 spent on a $100 pool (a downgrade from a bigger pool earlier this month, before opting in).
    mockSpend.mockResolvedValue({ rawCostUsedMicroUsd: 250 * USD });
    const res = await put(OWNER, { enabled: true, capPercentOfPool: 200 }).expect(200);
    expect(mockUpdateUser.mock.calls[0][1].paygOverage.optIn)
      .toEqual({ month: getCurrentUsageMonth(), overageBaselineMicroUsd: 150 * USD });
    expect(res.body.overagePercentUsed).toBe(0);
    expect((await get(OWNER).expect(200)).body.overagePercentUsed).toBe(0);

    // $20 more after opting in is 10% of the 200% cap ($200).
    mockSpend.mockResolvedValue({ rawCostUsedMicroUsd: 270 * USD });
    expect((await get(OWNER).expect(200)).body.overagePercentUsed).toBe(10);
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
