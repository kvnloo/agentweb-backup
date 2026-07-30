/**
 * Tests for getUserXOrgRollup — the org-aware X (Twitter) rollup that sums
 * allocated X spend across all org members (ENG-664). The X sibling of
 * getUserOrgUsageRollup: same org resolution + fail-loud semantics, but filtered
 * to twitter:* rows and with NO quota reconciliation (X is observe-only).
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
import { getUserXOrgRollup } from '../services/usageAnalyticsService';

const mockQuery = usageRecordDb.queryByUserDateRange as jest.Mock;
const mockGetUser = userDb.getUserById as jest.Mock;
const mockGetOrg = orgDb.getOrgById as jest.Mock;
const mockGetMembers = orgDb.getOrgMembers as jest.Mock;

/** A minimal X vendor row. cost in integer microdollars. */
const xRow = (model: string, over: any = {}) => ({
  userId: 'u',
  sk: `2026-07-10#${model}#x-account:acc-1`,
  date: '2026-07-10',
  model,
  feature: 'x-account:acc-1',
  callCount: 1,
  quantity: 1,
  costMicroUsd: 0,
  provider: 'twitter',
  unit: 'post',
  ...over,
});

/** A non-twitter (LLM) row — must be excluded from the X rollup. */
const llmRow = (over: any = {}) => ({
  userId: 'u',
  sk: '2026-07-10#anthropic.claude-opus-4-8#agent-chat',
  date: '2026-07-10',
  model: 'anthropic.claude-opus-4-8',
  feature: 'agent-chat',
  callCount: 1,
  totalTokens: 1000,
  costMicroUsd: 9_000_000,
  ...over,
});

const user = (overrides: any = {}) => ({
  userId: 'u',
  email: 'u@example.com',
  ...overrides,
});

describe('getUserXOrgRollup', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockQuery.mockResolvedValue([]);
    mockGetUser.mockResolvedValue(null);
    mockGetOrg.mockResolvedValue(null);
    mockGetMembers.mockResolvedValue([]);
  });

  it('rejects a malformed month', async () => {
    await expect(getUserXOrgRollup('u', '2026-7')).rejects.toThrow('YYYY-MM');
  });

  it('throws when the user does not exist', async () => {
    mockGetUser.mockResolvedValue(null);
    await expect(getUserXOrgRollup('missing', '2026-07')).rejects.toThrow('User not found');
  });

  it('solo user: rolls up only their own X spend, no org', async () => {
    mockGetUser.mockResolvedValue(user({ userId: 'solo' }));
    mockQuery.mockResolvedValue([
      xRow('twitter:search_tweets', { userId: 'solo', costMicroUsd: 50_000, quantity: 10 }), // $0.05
      xRow('twitter:post', { userId: 'solo', costMicroUsd: 15_000 }),                        // $0.015
      // An LLM row for the same user must NOT inflate the X total.
      llmRow({ userId: 'solo' }),
    ]);

    const r = await getUserXOrgRollup('solo', '2026-07');
    expect(r.isOrg).toBe(false);
    expect(r.totalCostUsd).toBeCloseTo(0.065, 6);
    expect(r.totalCallCount).toBe(2); // LLM row excluded
    expect(r.members).toHaveLength(1);
    expect(r.members[0].isSelected).toBe(true);
    expect(r.members[0].costUsd).toBeCloseTo(0.065, 6);
    // Per-tool cut, sorted by spend desc.
    expect(r.byOperation[0].operation).toBe('search_tweets');
  });

  it('org: sums X spend across owner + members and splits per member', async () => {
    const owner = user({ userId: 'owner', orgId: 'org1', orgRole: 'owner' });
    const member = user({ userId: 'member', email: 'm@example.com', orgId: 'org1', orgRole: 'member' });
    mockGetUser.mockImplementation(async (id: string) => (id === 'owner' ? owner : member));
    mockGetOrg.mockResolvedValue({ orgId: 'org1', name: 'Org', ownerUserId: 'owner' });
    mockGetMembers.mockResolvedValue([owner, member]);
    mockQuery.mockImplementation(async (id: string) =>
      id === 'owner'
        ? [xRow('twitter:post', { userId: 'owner', costMicroUsd: 20_000 })] // $0.02
        : [xRow('twitter:search_tweets', { userId: 'member', costMicroUsd: 50_000, quantity: 10 })] // $0.05
    );

    // Click the member — the whole org still rolls up.
    const r = await getUserXOrgRollup('member', '2026-07');
    expect(r.isOrg).toBe(true);
    expect(r.ownerUserId).toBe('owner');
    expect(r.selectedRole).toBe('member');
    expect(r.totalCostUsd).toBeCloseTo(0.07, 6); // 0.02 + 0.05
    expect(r.members.map((m) => m.userId)).toEqual(['member', 'owner']); // sorted by spend desc
    expect(r.members.find((m) => m.userId === 'member')!.isSelected).toBe(true);
    expect(r.members.find((m) => m.userId === 'owner')!.costUsd).toBeCloseTo(0.02, 6);
  });

  it('fails loud (does NOT silently zero a member) when a member X query rejects', async () => {
    const owner = user({ userId: 'owner', orgId: 'org1', orgRole: 'owner' });
    const member = user({ userId: 'member', orgId: 'org1', orgRole: 'member' });
    mockGetUser.mockImplementation(async (id: string) => (id === 'owner' ? owner : member));
    mockGetOrg.mockResolvedValue({ orgId: 'org1', name: 'Org', ownerUserId: 'owner' });
    mockGetMembers.mockResolvedValue([owner, member]);
    mockQuery.mockImplementation(async (id: string) => {
      if (id === 'member') throw new Error('ProvisionedThroughputExceeded');
      return [xRow('twitter:post', { userId: 'owner', costMicroUsd: 20_000 })];
    });

    await expect(getUserXOrgRollup('owner', '2026-07')).rejects.toThrow(
      'ProvisionedThroughputExceeded'
    );
  });
});
