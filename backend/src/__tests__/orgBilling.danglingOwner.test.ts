/**
 * ENG-1215 — an org that names an owner who does not resolve must not take the
 * member down with it.
 *
 * Found by a read-only production/preview verification pass on 2026-08-31.
 * `GET /api/subscription/usage-runway` returned a hard 500 for one account. The
 * account itself was healthy; its ORG was not.
 *
 * Two shapes were observed in real data, and both are covered here:
 *
 *   1. `ownerUserId` names a user that no longer exists (owner deleted while
 *      members remained). This is the one that produced the 500.
 *   2. `ownerUserId` is absent from the org row entirely.
 *
 * In both, `resolveBillingUserId` returned an id nothing could resolve, and
 * `getUserTokenUsage` then threw `User not found: <id>`. That is NOT limited to
 * the usage surfaces where it was first seen — this function also resolves the
 * billing subject for `checkTokenUsage`, the gate on the chat path, so the
 * member was locked out of the product by a defect in a row they cannot see or
 * repair.
 *
 * The invariant these tests pin is deliberately stronger than "does not throw":
 * whatever id comes back MUST resolve to a real user, because every caller
 * immediately treats it as one.
 */

import { userDb, orgDb } from '../services/db';
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

// Modelled on the real Dev rows, not invented: an org whose `ownerUserId` is a
// placeholder that was never a user, and a second org missing the field.
const MEMBER = { userId: 'u-member', orgId: 'org-dangling', orgRole: 'member' };
const HEALTHY_MEMBER = { userId: 'u-member2', orgId: 'org-healthy', orgRole: 'member' };
const REAL_OWNER = { userId: 'u-owner', orgId: 'org-healthy', orgRole: 'owner', subscriptionType: 'Pro' };

const ORG_DANGLING = { orgId: 'org-dangling', ownerUserId: 'placeholder-owner', name: 'Dangling' };
const ORG_NO_OWNER = { orgId: 'org-no-owner', name: 'Ownerless' } as any;
const ORG_HEALTHY  = { orgId: 'org-healthy', ownerUserId: 'u-owner', name: 'Healthy' };

const USERS: Record<string, any> = {
  'u-member': MEMBER,
  'u-member2': HEALTHY_MEMBER,
  'u-owner': REAL_OWNER,
  // 'placeholder-owner' deliberately absent — that is the defect.
};

const ORGS: Record<string, any> = {
  'org-dangling': ORG_DANGLING,
  'org-no-owner': ORG_NO_OWNER,
  'org-healthy': ORG_HEALTHY,
};

beforeEach(() => {
  jest.clearAllMocks();
  mockUserDb.getUserById.mockImplementation(async (id: string) => USERS[id] ?? null);
  mockOrgDb.getOrgById.mockImplementation(async (id: string) => (ORGS[id] ?? null) as any);
});

describe('ENG-1215 — billing resolution survives an unresolvable org owner', () => {
  it('falls back to the member when ownerUserId names a user that does not exist', async () => {
    const billingUserId = await resolveBillingUserId('u-member');

    expect(billingUserId).toBe('u-member');
    // The real assertion: the id is usable. Returning 'placeholder-owner' is
    // what made getUserTokenUsage throw.
    expect(await mockUserDb.getUserById(billingUserId)).not.toBeNull();
  });

  it('falls back to the member when the org row has no ownerUserId at all', async () => {
    mockUserDb.getUserById.mockImplementation(async (id: string) =>
      (id === 'u-orphan' ? { userId: 'u-orphan', orgId: 'org-no-owner', orgRole: 'member' } : USERS[id]) ?? null);

    const billingUserId = await resolveBillingUserId('u-orphan');

    expect(billingUserId).toBe('u-orphan');
    expect(await mockUserDb.getUserById(billingUserId)).not.toBeNull();
  });

  it('still pools onto a healthy owner — the guard must not break normal orgs', async () => {
    // Without this, "return userId always" would pass both cases above while
    // silently un-pooling every real org onto individual members' quotas.
    const billingUserId = await resolveBillingUserId('u-member2');

    expect(billingUserId).toBe('u-owner');
  });

  it('never returns an id that cannot be resolved, across every org shape', async () => {
    const table: Record<string, string> = {
      'u-member': 'org-dangling',
      'u-member2': 'org-healthy',
    };

    for (const memberId of Object.keys(table)) {
      const billingUserId = await resolveBillingUserId(memberId);
      expect(billingUserId).toBeTruthy();
      expect(await mockUserDb.getUserById(billingUserId)).not.toBeNull();
    }
  });
});
