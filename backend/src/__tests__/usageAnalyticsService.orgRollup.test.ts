/**
 * Tests for getUserOrgUsageRollup — the org-aware cost rollup that reconciles
 * per-member shadow burn against the org OWNER's quota counter (ENG-200 follow-up).
 *
 * The bug this guards against: the admin cost modal compared one user's gross
 * burn (keyed on the acting user) against that same user's quota counter — but
 * member spend is deducted onto the org OWNER (resolveBillingUserId), so members
 * showed burn>0 / counted=$0 (false "leak") and owners showed counted >> own burn.
 * The rollup fixes the denominator: burn is summed across ALL org members and
 * compared to the owner's counter.
 */

jest.mock('../services/usageRecordDb', () => ({
  usageRecordDb: {
    queryByUserDateRange: jest.fn(),
    scanByDateRange: jest.fn(),
  },
  // Real semantics: a per-unit vendor row has BOTH provider and unit.
  isVendorEntry: (r: any) => !!(r && r.provider && r.unit),
}));

jest.mock('../services/db', () => ({
  userDb: { getUserById: jest.fn() },
  orgDb: { getOrgById: jest.fn(), getOrgMembers: jest.fn() },
}));

import { usageRecordDb } from '../services/usageRecordDb';
import { userDb, orgDb } from '../services/db';
import { getUserOrgUsageRollup } from '../services/usageAnalyticsService';

const mockQuery = usageRecordDb.queryByUserDateRange as jest.Mock;
const mockGetUser = userDb.getUserById as jest.Mock;
const mockGetOrg = orgDb.getOrgById as jest.Mock;
const mockGetMembers = orgDb.getOrgMembers as jest.Mock;

/** A minimal shadow row. cost in integer microdollars. */
const row = (overrides: any = {}) => ({
  userId: 'u',
  sk: '2026-07-02#anthropic.claude-opus-4-8#agent-chat',
  date: '2026-07-02',
  model: 'anthropic.claude-opus-4-8',
  feature: 'agent-chat',
  inputTokens: 1000,
  outputTokens: 100,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  totalTokens: 1100,
  costMicroUsd: 1_000_000, // $1.00
  callCount: 1,
  billingUserId: 'u',
  updatedAt: '2026-07-02T01:00:00.000Z',
  ttl: 1790000000,
  ...overrides,
});

const user = (overrides: any = {}) => ({
  userId: 'u',
  email: 'u@example.com',
  ...overrides,
});

describe('getUserOrgUsageRollup', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockQuery.mockResolvedValue([]);
    mockGetUser.mockResolvedValue(null);
    mockGetOrg.mockResolvedValue(null);
    mockGetMembers.mockResolvedValue([]);
  });

  it('rejects a malformed month', async () => {
    await expect(getUserOrgUsageRollup('u', '2026-7')).rejects.toThrow('YYYY-MM');
  });

  it('throws when the user does not exist', async () => {
    mockGetUser.mockResolvedValue(null);
    await expect(getUserOrgUsageRollup('missing', '2026-07')).rejects.toThrow('User not found');
  });

  it('fails loud (does NOT silently zero a member) when a member burn query rejects', async () => {
    // A DynamoDB throttle on one member must reject the whole rollup rather than
    // return an incomplete-but-successful payload that understates org burn (Greptile).
    const owner = user({ userId: 'owner', orgId: 'org1', orgRole: 'owner', tokenUsage: { month: '2026-07', totalTokens: 0, totalCost: 5, resetDate: '' } });
    const member = user({ userId: 'member', orgId: 'org1', orgRole: 'member' });
    mockGetUser.mockImplementation(async (id: string) => (id === 'owner' ? owner : member));
    mockGetOrg.mockResolvedValue({ orgId: 'org1', name: 'Org', ownerUserId: 'owner' });
    mockGetMembers.mockResolvedValue([owner, member]);
    mockQuery.mockImplementation(async (id: string) => {
      if (id === 'member') throw new Error('ProvisionedThroughputExceeded');
      return [row({ userId: 'owner', costMicroUsd: 1_000_000 })];
    });

    await expect(getUserOrgUsageRollup('owner', '2026-07')).rejects.toThrow(
      'ProvisionedThroughputExceeded'
    );
  });

  it('solo user: rolls up only their own burn against their own counter', async () => {
    mockGetUser.mockResolvedValue(
      user({ userId: 'solo', tokenUsage: { month: '2026-07', totalTokens: 0, totalCost: 4, resetDate: '' } })
    );
    mockQuery.mockResolvedValue([row({ userId: 'solo', costMicroUsd: 3_000_000 })]); // $3 burn

    const r = await getUserOrgUsageRollup('solo', '2026-07');

    expect(r.isOrg).toBe(false);
    expect(r.ownerUserId).toBe('solo');
    expect(r.grossBurnUsd).toBeCloseTo(3, 6);
    expect(r.countedUsd).toBeCloseTo(4, 6); // solo user's own counter
    expect(r.unchargedUsd).toBe(0); // counted >= burn → nothing uncharged
    expect(r.members).toHaveLength(1);
    expect(r.members[0].isSelected).toBe(true);
    // Only the solo user is queried.
    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(mockGetMembers).not.toHaveBeenCalled();
  });

  it('org MEMBER clicked: counted comes from the OWNER counter, not the member', async () => {
    const owner = user({
      userId: 'owner',
      email: 'owner@org.com',
      orgId: 'org1',
      orgRole: 'owner',
      subscriptionType: 'Pro',
      tokenUsage: { month: '2026-07', totalTokens: 0, totalCost: 100, resetDate: '' },
    });
    const member = user({
      userId: 'member',
      email: 'member@org.com',
      orgId: 'org1',
      orgRole: 'member',
      // Member has a stale counter from a prior solo month — must be IGNORED.
      tokenUsage: { month: '2026-04', totalTokens: 0, totalCost: 48, resetDate: '' },
    });
    mockGetUser.mockImplementation(async (id: string) =>
      id === 'owner' ? owner : id === 'member' ? member : null
    );
    mockGetOrg.mockResolvedValue({ orgId: 'org1', name: 'Org', ownerUserId: 'owner' });
    mockGetMembers.mockResolvedValue([owner, member]);
    mockQuery.mockImplementation(async (id: string) =>
      id === 'owner'
        ? [row({ userId: 'owner', costMicroUsd: 10_000_000 })] // $10
        : [row({ userId: 'member', costMicroUsd: 30_000_000 })] // $30
    );

    const r = await getUserOrgUsageRollup('member', '2026-07');

    expect(r.isOrg).toBe(true);
    expect(r.ownerUserId).toBe('owner');
    expect(r.ownerEmail).toBe('owner@org.com');
    expect(r.ownerSubscriptionType).toBe('Pro'); // org cap keyed on the OWNER's tier
    expect(r.selectedIsOwner).toBe(false);
    expect(r.selectedRole).toBe('member');
    // Org gross burn = owner $10 + member $30 = $40.
    expect(r.grossBurnUsd).toBeCloseTo(40, 6);
    // Counted comes from the OWNER's July counter ($100), NOT the member's stale $48.
    expect(r.countedUsd).toBeCloseTo(100, 6);
    expect(r.unchargedUsd).toBe(0); // counted ($100) > burn ($40)
    // Per-member breakdown preserved, sorted by burn desc.
    expect(r.members.map((m) => m.userId)).toEqual(['member', 'owner']);
    expect(r.members.find((m) => m.userId === 'member')!.burnUsd).toBeCloseTo(30, 6);
    expect(r.members.find((m) => m.userId === 'member')!.isSelected).toBe(true);
  });

  it('org OWNER clicked: uncharged burn surfaces when gross > counted (burn-only spend)', async () => {
    const owner = user({
      userId: 'owner',
      email: 'owner@org.com',
      orgId: 'org1',
      orgRole: 'owner',
      tokenUsage: { month: '2026-07', totalTokens: 0, totalCost: 20, resetDate: '' },
    });
    const member = user({ userId: 'member', email: 'm@org.com', orgId: 'org1', orgRole: 'member' });
    mockGetUser.mockImplementation(async (id: string) => (id === 'owner' ? owner : member));
    mockGetOrg.mockResolvedValue({ orgId: 'org1', name: 'Org', ownerUserId: 'owner' });
    mockGetMembers.mockResolvedValue([owner, member]);
    mockQuery.mockImplementation(async (id: string) =>
      id === 'owner'
        ? [row({ userId: 'owner', model: 'anthropic.claude-opus-4-8', costMicroUsd: 40_000_000 })]
        : [row({ userId: 'member', model: 'gemini-3.5-flash', costMicroUsd: 10_000_000 })]
    );

    const r = await getUserOrgUsageRollup('owner', '2026-07');

    expect(r.selectedIsOwner).toBe(true);
    expect(r.grossBurnUsd).toBeCloseTo(50, 6); // $40 + $10
    expect(r.countedUsd).toBeCloseTo(20, 6);
    expect(r.unchargedUsd).toBeCloseTo(30, 6); // $50 gross − $20 counted
    expect(r.coveragePct).toBeCloseTo(40, 3); // 20/50
    // Org-wide per-model cut, sorted by spend desc.
    expect(r.byModel.map((m) => m.model)).toEqual([
      'anthropic.claude-opus-4-8',
      'gemini-3.5-flash',
    ]);
    expect(r.byModel[0].costUsd).toBeCloseTo(40, 6);
  });

  it('counter ahead of tracked burn: uncharged clamps to 0, coverage can exceed 100%', async () => {
    mockGetUser.mockResolvedValue(
      user({ userId: 'solo', tokenUsage: { month: '2026-07', totalTokens: 0, totalCost: 100, resetDate: '' } })
    );
    mockQuery.mockResolvedValue([row({ userId: 'solo', costMicroUsd: 60_000_000 })]); // $60 burn < $100 counted

    const r = await getUserOrgUsageRollup('solo', '2026-07');

    expect(r.grossBurnUsd).toBeCloseTo(60, 6);
    expect(r.countedUsd).toBeCloseTo(100, 6);
    expect(r.unchargedUsd).toBe(0);
    expect(r.coveragePct).toBeGreaterThan(100);
  });

  it('gross burn of zero does not divide by zero', async () => {
    mockGetUser.mockResolvedValue(user({ userId: 'solo' }));
    mockQuery.mockResolvedValue([]);

    const r = await getUserOrgUsageRollup('solo', '2026-07');

    expect(r.grossBurnUsd).toBe(0);
    expect(r.coveragePct).toBe(0);
    expect(r.unchargedUsd).toBe(0);
    expect(r.countedSource).toBe('none');
  });

  it('orphaned orgId (org not found) falls back to solo rollup', async () => {
    mockGetUser.mockResolvedValue(
      user({ userId: 'u', orgId: 'ghost', tokenUsage: { month: '2026-07', totalTokens: 0, totalCost: 5, resetDate: '' } })
    );
    mockGetOrg.mockResolvedValue(null); // org vanished
    mockQuery.mockResolvedValue([row({ userId: 'u', costMicroUsd: 2_000_000 })]);

    const r = await getUserOrgUsageRollup('u', '2026-07');

    expect(r.isOrg).toBe(false);
    expect(r.ownerUserId).toBe('u');
    expect(r.grossBurnUsd).toBeCloseTo(2, 6);
    expect(r.countedUsd).toBeCloseTo(5, 6);
  });

  it('reads the counter from history for a past month', async () => {
    mockGetUser.mockResolvedValue(
      user({
        userId: 'solo',
        tokenUsage: { month: '2026-07', totalTokens: 0, totalCost: 999, resetDate: '' },
        tokenUsageHistory: [{ month: '2026-06', totalTokens: 0, totalCost: 12 }],
      })
    );
    mockQuery.mockResolvedValue([row({ userId: 'solo', date: '2026-06-02', costMicroUsd: 8_000_000 })]);

    const r = await getUserOrgUsageRollup('solo', '2026-06');

    expect(r.countedUsd).toBeCloseTo(12, 6); // from history, not the current $999
    expect(r.countedSource).toBe('history');
  });
});

describe('LLM-only: vendor rows excluded from the rollup (ENG-664)', () => {
  it('does not let X (per-unit vendor) spend inflate gross burn / depress coverage', async () => {
    // Solo user: one $1 LLM row + one $5 X row (provider+unit → vendor entry).
    mockGetUser.mockResolvedValue(user({ userId: 'u', orgId: undefined }));
    mockQuery.mockResolvedValue([
      row({ costMicroUsd: 1_000_000 }), // LLM $1
      row({
        sk: '2026-07-02#twitter:search_tweets#x-account:acc-1',
        model: 'twitter:search_tweets',
        feature: 'x-account:acc-1',
        provider: 'twitter',
        unit: 'post',
        quantity: 1000,
        costMicroUsd: 5_000_000, // X $5 — must be excluded
      }),
    ]);

    const r = await getUserOrgUsageRollup('u', '2026-07');

    // Gross burn is the LLM $1 only; the $5 X row is not counted here.
    expect(r.grossBurnUsd).toBeCloseTo(1, 6);
    // byModel contains the LLM model, never the twitter one.
    expect(r.byModel.map((m) => m.model)).toContain('anthropic.claude-opus-4-8');
    expect(r.byModel.map((m) => m.model)).not.toContain('twitter:search_tweets');
  });
});
