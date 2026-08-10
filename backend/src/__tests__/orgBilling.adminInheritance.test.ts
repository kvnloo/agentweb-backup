/**
 * ENG-954 — regression guard for the silent-downgrade trap.
 *
 * Billing used to key on `orgRole === "member"` as a stand-in for "not the org
 * owner". That held only because exactly two roles existed. Introducing `admin`
 * breaks it in the worst possible way: an admin is neither "member" nor the
 * billing root, so `getUserSubscriptionType` fell through to the user's own
 * (empty) record and `resolveBillingUserId` returned their own id — the promoted
 * teammate silently became Free tier on their own quota, with no error and no log.
 *
 * These tests fail against the pre-ENG-954 predicates and pass after. They are the
 * reason the union widening could not ship on its own.
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

// xCures: Filipe is the billing root on a paid plan; Eric and Tyler are admins;
// Georgia is a plain member. Nobody but Filipe holds a subscription of their own.
const XCURES = { orgId: 'org-xcures', ownerUserId: 'u-filipe', name: 'xCures' };

const FILIPE  = { userId: 'u-filipe',  orgId: 'org-xcures', orgRole: 'owner',  subscriptionType: 'Pro' };
const ERIC    = { userId: 'u-eric',    orgId: 'org-xcures', orgRole: 'admin' };
const TYLER   = { userId: 'u-tyler',   orgId: 'org-xcures', orgRole: 'admin' };
const GEORGIA = { userId: 'u-georgia', orgId: 'org-xcures', orgRole: 'member' };
const ERIC_OWNER = { userId: 'u-eric', orgId: 'org-xcures', orgRole: 'owner' };

const USERS: Record<string, any> = {
  'u-filipe': FILIPE, 'u-eric': ERIC, 'u-tyler': TYLER, 'u-georgia': GEORGIA,
};

function wire(overrides: Record<string, any> = {}) {
  const table = { ...USERS, ...overrides };
  mockUserDb.getUserById.mockImplementation(async (id: string) => table[id] ?? null);
  mockOrgDb.getOrgById.mockImplementation(async (id: string) =>
    (id === 'org-xcures' ? XCURES : null) as any);
}

beforeEach(() => {
  jest.clearAllMocks();
  wire();
});

describe('subscription tier resolves through the billing root, not through a role', () => {
  it('an ADMIN inherits the org plan (this is the bug the old predicate shipped)', async () => {
    await expect(getUserSubscriptionType('u-eric')).resolves.toBe('Pro');
    await expect(getUserSubscriptionType('u-tyler')).resolves.toBe('Pro');
  });

  it('a plain member still inherits, exactly as before', async () => {
    await expect(getUserSubscriptionType('u-georgia')).resolves.toBe('Pro');
  });

  it('a SECOND OWNER inherits too — the role is not the signal, ownerUserId is', async () => {
    wire({ 'u-eric': ERIC_OWNER });
    await expect(getUserSubscriptionType('u-eric')).resolves.toBe('Pro');
  });

  it('the billing root resolves to its own plan and does not walk to itself', async () => {
    await expect(getUserSubscriptionType('u-filipe')).resolves.toBe('Pro');
  });

  it('an admin paying independently keeps their own live tier over the org plan', async () => {
    wire({ 'u-eric': { ...ERIC, subscriptionType: 'Starter', subscription_status: 'active' } });
    await expect(getUserSubscriptionType('u-eric')).resolves.toBe('Starter');
  });

  it('a user with no org is unaffected', async () => {
    wire({ 'u-solo': { userId: 'u-solo', subscriptionType: 'Starter' } });
    await expect(getUserSubscriptionType('u-solo')).resolves.toBe('Starter');
  });
});

describe('pooled quota lands on the billing root for every non-root role', () => {
  it('an ADMIN bills to the org owner, not to themselves', async () => {
    await expect(resolveBillingUserId('u-eric')).resolves.toBe('u-filipe');
    await expect(resolveBillingUserId('u-tyler')).resolves.toBe('u-filipe');
  });

  it('a plain member bills to the org owner, as before', async () => {
    await expect(resolveBillingUserId('u-georgia')).resolves.toBe('u-filipe');
  });

  it('a SECOND OWNER bills to the billing root, not to themselves', async () => {
    wire({ 'u-eric': ERIC_OWNER });
    await expect(resolveBillingUserId('u-eric')).resolves.toBe('u-filipe');
  });

  it('the billing root bills to itself', async () => {
    await expect(resolveBillingUserId('u-filipe')).resolves.toBe('u-filipe');
  });

  it('a solo user bills to themselves', async () => {
    wire({ 'u-solo': { userId: 'u-solo' } });
    await expect(resolveBillingUserId('u-solo')).resolves.toBe('u-solo');
  });

  it('falls back to the user when the org record cannot be read', async () => {
    mockOrgDb.getOrgById.mockResolvedValue(null as any);
    await expect(resolveBillingUserId('u-eric')).resolves.toBe('u-eric');
  });
});

describe('no cross-org leakage', () => {
  it('a user whose orgId points at a different org does not inherit xCures billing', async () => {
    wire({ 'u-juan': { userId: 'u-juan', orgId: 'org-haven', orgRole: 'owner' } });
    await expect(resolveBillingUserId('u-juan')).resolves.toBe('u-juan');
    await expect(getUserSubscriptionType('u-juan')).resolves.toBe('Free');
  });
});
