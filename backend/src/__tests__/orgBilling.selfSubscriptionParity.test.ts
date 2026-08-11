/**
 * ENG-1084 — entitlement and quota must answer "whose plan is this?" identically.
 *
 * `getUserSubscriptionType` already carved out a member riding their OWN live
 * Stripe subscription: accepting an org invite touches no billing state, so a
 * member can independently pay for a tier that differs from their owner's, and
 * their own tier governs. `resolveBillingUserId` had no equivalent escape hatch —
 * it pooled everyone but the billing root onto `Organization.ownerUserId`.
 *
 * The result: that member read their own tier's entitlements while their usage
 * was metered onto the org owner's counter and their allowance was computed from
 * the owner's tier. Wrong in both directions, and silent.
 *
 * These tests fail before the fix (case 1) and pin the no-regression cases.
 */

import { userDb, orgDb } from '../services/db';
import { getUserSubscriptionType } from '../services/subscriptionService';
import { resolveBillingUserId } from '../services/tokenUsageService';

jest.mock('../services/settingsService', () => ({
  settingsService: { getSetting: jest.fn() },
}));

jest.mock('../services/db', () => ({
  userDb: { getUserById: jest.fn() },
  orgDb: { getOrgById: jest.fn() },
}));

const mockUserDb = userDb as jest.Mocked<typeof userDb>;
const mockOrgDb = orgDb as jest.Mocked<typeof orgDb>;

const ORG = { orgId: 'org-acme', ownerUserId: 'u-owner', name: 'Acme' };

const OWNER = {
  userId: 'u-owner', orgId: 'org-acme', orgRole: 'owner',
  subscriptionType: 'Pro', subscription_status: 'active',
};
/** Non-billing-root member paying for their own plan. */
const SELF_PAYER = {
  userId: 'u-selfpayer', orgId: 'org-acme', orgRole: 'member',
  subscriptionType: 'Growth', subscription_status: 'active',
};
/** Same, on a trial rather than a paid subscription. */
const TRIALER = {
  userId: 'u-trialer', orgId: 'org-acme', orgRole: 'admin',
  subscriptionType: 'Growth', subscription_status: 'trialing',
};
/** Ordinary inheriting member — no subscription of their own. */
const INHERITOR = { userId: 'u-inheritor', orgId: 'org-acme', orgRole: 'member' };
/** Member whose own subscription has lapsed — must fall back to the org. */
const LAPSED = {
  userId: 'u-lapsed', orgId: 'org-acme', orgRole: 'member',
  subscriptionType: 'Growth', subscription_status: 'canceled',
};
const SOLO = { userId: 'u-solo', subscriptionType: 'Starter', subscription_status: 'active' };

const USERS: Record<string, any> = {
  'u-owner': OWNER,
  'u-selfpayer': SELF_PAYER,
  'u-trialer': TRIALER,
  'u-inheritor': INHERITOR,
  'u-lapsed': LAPSED,
  'u-solo': SOLO,
};

beforeEach(() => {
  jest.clearAllMocks();
  mockUserDb.getUserById.mockImplementation(async (id: string) => USERS[id] ?? null);
  mockOrgDb.getOrgById.mockImplementation(async (id: string) =>
    (id === 'org-acme' ? ORG : null) as any);
});

describe('AC1 — entitlement and quota resolve to the same user for a self-paying member', () => {
  it('meters a self-paying member onto their OWN counter, matching their own tier', async () => {
    await expect(getUserSubscriptionType('u-selfpayer')).resolves.toBe('Growth');
    await expect(resolveBillingUserId('u-selfpayer')).resolves.toBe('u-selfpayer');
  });

  it('treats a trialing member the same way (trialing entitles, per stripeService convention)', async () => {
    await expect(getUserSubscriptionType('u-trialer')).resolves.toBe('Growth');
    await expect(resolveBillingUserId('u-trialer')).resolves.toBe('u-trialer');
  });
});

describe('AC2 — a member WITHOUT their own subscription still resolves to the billing root', () => {
  it('an inheriting member reads and spends the org owner plan', async () => {
    await expect(getUserSubscriptionType('u-inheritor')).resolves.toBe('Pro');
    await expect(resolveBillingUserId('u-inheritor')).resolves.toBe('u-owner');
  });

  it('a member whose own subscription lapsed falls back to the org, both sides', async () => {
    await expect(getUserSubscriptionType('u-lapsed')).resolves.toBe('Pro');
    await expect(resolveBillingUserId('u-lapsed')).resolves.toBe('u-owner');
  });

  it('the billing root and a solo user are unchanged', async () => {
    await expect(getUserSubscriptionType('u-owner')).resolves.toBe('Pro');
    await expect(resolveBillingUserId('u-owner')).resolves.toBe('u-owner');
    await expect(getUserSubscriptionType('u-solo')).resolves.toBe('Starter');
    await expect(resolveBillingUserId('u-solo')).resolves.toBe('u-solo');
  });
});

describe('failure/edge handling', () => {
  it('an unknown user bills to themselves rather than throwing', async () => {
    await expect(resolveBillingUserId('u-missing')).resolves.toBe('u-missing');
  });

  it('an unresolvable org bills the user to themselves rather than a phantom root', async () => {
    mockOrgDb.getOrgById.mockResolvedValue(null as any);
    await expect(resolveBillingUserId('u-inheritor')).resolves.toBe('u-inheritor');
  });
});
