import { settingsService } from '../services/settingsService';
import { userDb, orgDb } from '../services/db';
import { CUSTOMER_PORTAL_PAGES } from '../services/customerPortalPages';
import {
  getUserSubscriptionType,
  getUserSubscriptionResolution,
  getSubscriptionTypeConfig,
  getAllAvailableFunctionCalls,
  getAllAvailablePages,
  getAllowedFunctionCalls,
  getAllowedPages,
  filterFunctionCalls,
  getAllAvailableSkills,
  getAllAvailableConnectedAccounts,
  getAllowedConnectedAccounts,
  getAllowedSkills,
  getPublicAllowedSkills,
  resolveSkillsToToolNames,
  findTiersAllowingSkill,
  getAllowedFeatures,
  getAllAvailableSubscriptionFeatures,
  getDefaultSubscriptionFeatureIds,
  isSubscriptionFeatureEnabled,
  setEntitlementDeniedSink,
  resetEntitlementDeniedSink,
  flushUnconfirmedTierObservations,
  resetLastKnownSubscriptionTypes,
} from '../services/subscriptionService';

jest.mock('../services/settingsService', () => ({
  settingsService: {
    getSetting: jest.fn(),
  },
}));

jest.mock('../services/db', () => ({
  userDb: {
    getUserById: jest.fn(),
  },
  orgDb: {
    getOrgById: jest.fn(),
  },
}));

jest.mock('../services/customerPortalPages', () => ({
  CUSTOMER_PORTAL_PAGES: [
    { path: '/tasks', label: 'Tasks' },
    { path: '/seo', label: 'SEO' },
    { path: '/paid-social', label: 'Paid Social' },
    { path: '/newsletter', label: 'Newsletter' },
  ],
}));

jest.mock('../services/agentModeService', () => ({
  AgentModeService: jest.fn().mockImplementation(() => ({
    getAvailableTools: () => [
      { type: 'function', function: { name: 'generate_image' } },
      { type: 'function', function: { name: 'generate_video' } },
      { type: 'function', function: {} },
      { type: 'function' },
      { type: 'plain', other: true },
    ],
    getUnassociatedToolNames: () => ['generate_image'],
  })),
  agentModeService: {
    getAvailableTools: () => [
      { type: 'function', function: { name: 'generate_image' } },
      { type: 'function', function: { name: 'generate_video' } },
      { type: 'function', function: {} },
      { type: 'function' },
      { type: 'plain', other: true },
    ],
    getUnassociatedToolNames: () => ['generate_image'],
  },
}));

jest.mock('../services/skillService', () => ({
  skillService: {
    getPublishedSkills: jest.fn(() => [
      { skillId: 'skill-1', name: 'Image Gen', description: 'Image generation', toolNames: ['generate_image'] },
      { skillId: 'skill-2', name: 'Video Gen', description: 'Video generation', toolNames: ['generate_video'] },
    ]),
  },
}));

const mockedSettingsService = settingsService as jest.Mocked<typeof settingsService>;
const mockedUserDb = userDb as jest.Mocked<typeof userDb>;

describe('subscriptionService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resetLastKnownSubscriptionTypes();
  });

  it('getUserSubscriptionType returns user.subscriptionType or Free by default', async () => {
    mockedUserDb.getUserById.mockResolvedValueOnce({ userId: 'u1', subscriptionType: 'Pro' } as any);
    const t1 = await getUserSubscriptionType('u1');
    expect(t1).toBe('Pro');

    mockedUserDb.getUserById.mockResolvedValueOnce({ userId: 'u2' } as any);
    const t2 = await getUserSubscriptionType('u2');
    expect(t2).toBe('Free');
  });

  it('marks a missing user as unresolved instead of a confirmed Free subscription', async () => {
    mockedUserDb.getUserById.mockResolvedValueOnce(null as any);

    await expect(getUserSubscriptionResolution('missing-user')).resolves.toEqual({
      subscriptionType: 'Free',
      resolved: false,
    });
  });

  it('uses an explicit feature entitlement without relying on the tier name', async () => {
    mockedUserDb.getUserById.mockResolvedValue({ userId: 'u1', subscriptionType: 'Community' } as any);
    mockedSettingsService.getSetting.mockResolvedValue({
      settingValue: JSON.stringify([{
        name: 'Community', allowedPages: ['/'], allowedSkills: [], allowedFeatures: ['scheduled_chats'],
      }]),
    } as any);

    expect(await getAllowedFeatures('u1')).toEqual(['scheduled_chats']);
  });

  describe('hot_lead_call is opt-in only', () => {
    const tiers = (rows: unknown[]) =>
      mockedSettingsService.getSetting.mockResolvedValue({ settingValue: JSON.stringify(rows) } as never);

    it('a legacy tier with no feature list does not get hot_lead_call, from either lookup', async () => {
      mockedUserDb.getUserById.mockResolvedValue({ userId: 'u1', subscriptionType: 'Legacy' } as never);
      tiers([{ name: 'Legacy', allowedPages: ['/'], allowedSkills: [] }]);
      expect(await isSubscriptionFeatureEnabled('u1', 'hot_lead_call')).toBe(false);
      expect(await getAllowedFeatures('u1')).not.toContain('hot_lead_call');
      expect(await getAllowedFeatures('u1')).toContain('model_compare');
    });

    it('an explicit tick or a saved "*" still grants it', async () => {
      mockedUserDb.getUserById.mockResolvedValue({ userId: 'u1', subscriptionType: 'Pro' } as never);
      tiers([{ name: 'Pro', allowedPages: ['/'], allowedSkills: [], allowedFeatures: ['hot_lead_call'] }]);
      expect(await isSubscriptionFeatureEnabled('u1', 'hot_lead_call')).toBe(true);
      tiers([{ name: 'Pro', allowedPages: ['/'], allowedSkills: [], allowedFeatures: ['*'] }]);
      expect(await isSubscriptionFeatureEnabled('u1', 'hot_lead_call')).toBe(true);
      expect(await getAllowedFeatures('u1')).toContain('hot_lead_call');
    });

    it('the default feature set and the feature metadata agree', () => {
      expect(getDefaultSubscriptionFeatureIds()).not.toContain('hot_lead_call');
      expect(getAllAvailableSubscriptionFeatures().find((f) => f.id === 'hot_lead_call')?.optInOnly).toBe(true);
      expect(getAllAvailableSubscriptionFeatures().find((f) => f.id === 'model_compare')?.optInOnly).toBe(false);
    });
  });

  describe('model_compare add-on feature', () => {
    const tiers = (rows: unknown[]) =>
      mockedSettingsService.getSetting.mockResolvedValue({ settingValue: JSON.stringify(rows) } as any);

    it('is enabled for a tier that lists it and disabled for an explicit list without it', async () => {
      mockedUserDb.getUserById.mockResolvedValue({ userId: 'u1', subscriptionType: 'Pro' } as any);
      tiers([{ name: 'Pro', allowedPages: ['/'], allowedSkills: [], allowedFeatures: ['model_compare'] }]);
      expect(await isSubscriptionFeatureEnabled('u1', 'model_compare')).toBe(true);
      tiers([{ name: 'Pro', allowedPages: ['/'], allowedSkills: [], allowedFeatures: ['scheduled_chats'] }]);
      expect(await isSubscriptionFeatureEnabled('u1', 'model_compare')).toBe(false);
    });

    it('stays enabled for a legacy tier with no allowedFeatures list', async () => {
      mockedUserDb.getUserById.mockResolvedValue({ userId: 'u1', subscriptionType: 'Legacy' } as any);
      tiers([{ name: 'Legacy', allowedPages: ['/'], allowedSkills: [] }]);
      expect(await isSubscriptionFeatureEnabled('u1', 'model_compare')).toBe(true);
    });

    it('an org member inherits the org owner tier', async () => {
      const mockedOrgDb = orgDb as jest.Mocked<typeof orgDb>;
      mockedUserDb.getUserById.mockImplementation(async (id: string) => {
        if (id === 'member-1') return { userId: 'member-1', orgId: 'org-1', orgRole: 'member', subscriptionType: 'Free' } as any;
        if (id === 'owner-1') return { userId: 'owner-1', subscriptionType: 'Pro' } as any;
        return null as any;
      });
      mockedOrgDb.getOrgById.mockResolvedValue({ orgId: 'org-1', ownerUserId: 'owner-1' } as any);
      tiers([
        { name: 'Free', allowedPages: ['/'], allowedSkills: [], allowedFeatures: [] },
        { name: 'Pro', allowedPages: ['/'], allowedSkills: [], allowedFeatures: ['model_compare'] },
      ]);
      expect(await isSubscriptionFeatureEnabled('member-1', 'model_compare')).toBe(true);
    });

    it('returns null (callers fail closed) when the tier cannot be read', async () => {
      mockedUserDb.getUserById.mockResolvedValue(null as any);
      expect(await isSubscriptionFeatureEnabled('ghost', 'model_compare')).toBeNull();
    });
  });

  it('denies a feature when an admin explicitly omits it', async () => {
    mockedUserDb.getUserById.mockResolvedValue({ userId: 'u1', subscriptionType: 'Community' } as any);
    mockedSettingsService.getSetting.mockResolvedValue({
      settingValue: JSON.stringify([{
        name: 'Community', allowedPages: ['/'], allowedSkills: [], allowedFeatures: [],
      }]),
    } as any);

    expect(await getAllowedFeatures('u1')).toEqual([]);
  });

  it('keeps legacy subscription rows permissive, except for paid-vendor features, until an admin saves feature settings', async () => {
    mockedUserDb.getUserById.mockResolvedValue({ userId: 'u1', subscriptionType: 'Legacy' } as any);
    mockedSettingsService.getSetting.mockResolvedValue({
      settingValue: JSON.stringify([{ name: 'Legacy', allowedPages: ['/'], allowedSkills: [] }]),
    } as any);

    expect(await getAllowedFeatures('u1')).toEqual(['scheduled_chats', 'model_compare']);
  });

  it('getUserSubscriptionType resolves an org member to the owner tier dynamically (ENG-288)', async () => {
    const mockedOrgDb = orgDb as jest.Mocked<typeof orgDb>;
    // Member record itself carries no paid tier — it must resolve from the owner.
    mockedUserDb.getUserById.mockImplementation(async (id: string) => {
      if (id === 'member-1') return { userId: 'member-1', orgId: 'org-1', orgRole: 'member', subscriptionType: 'Free' } as any;
      if (id === 'owner-1') return { userId: 'owner-1', subscriptionType: 'Pro' } as any;
      return null as any;
    });
    mockedOrgDb.getOrgById.mockResolvedValue({ orgId: 'org-1', ownerUserId: 'owner-1' } as any);

    const tier = await getUserSubscriptionType('member-1');
    expect(tier).toBe('Pro');
  });

  it('getUserSubscriptionType returns the member own tier once they leave the org (ENG-288 revocation)', async () => {
    const mockedOrgDb = orgDb as jest.Mocked<typeof orgDb>;
    // After leaving, orgId/orgRole are cleared — no org lookup, no inherited tier.
    mockedUserDb.getUserById.mockResolvedValueOnce({ userId: 'ex-member', subscriptionType: 'Free' } as any);

    const tier = await getUserSubscriptionType('ex-member');
    expect(tier).toBe('Free');
    expect(mockedOrgDb.getOrgById).not.toHaveBeenCalled();
  });

  it('getUserSubscriptionType falls back to the member own tier when the org lookup throws, instead of hard "Free"', async () => {
    // A transient org-lookup failure (DynamoDB throttling, network blip) must
    // not discard the already-fetched user record and its real own tier —
    // that would wrongly downgrade a paying member to Free for the duration
    // of an unrelated, transient error.
    const mockedOrgDb = orgDb as jest.Mocked<typeof orgDb>;
    mockedUserDb.getUserById.mockResolvedValueOnce({
      userId: 'member-1', orgId: 'org-1', orgRole: 'member', subscriptionType: 'Pro',
    } as any);
    mockedOrgDb.getOrgById.mockRejectedValueOnce(new Error('ProvisionedThroughputExceededException'));

    const tier = await getUserSubscriptionType('member-1');
    expect(tier).toBe('Pro');
  });

  it('keeps a transient org lookup distinct from an explicit feature denial', async () => {
    const mockedOrgDb = orgDb as jest.Mocked<typeof orgDb>;
    mockedUserDb.getUserById.mockResolvedValueOnce({
      userId: 'member-1', orgId: 'org-1', orgRole: 'member', subscriptionType: 'Free',
    } as any);
    mockedOrgDb.getOrgById.mockRejectedValueOnce(new Error('ProvisionedThroughputExceededException'));

    expect(await isSubscriptionFeatureEnabled('member-1', 'scheduled_chats')).toBeNull();
    expect(mockedSettingsService.getSetting).not.toHaveBeenCalled();
  });

  it('getUserSubscriptionType lets a member own ACTIVE subscription govern instead of the owner (regression: pvandervalk@xcures.com)', async () => {
    // A member can hold their own paid Stripe subscription independent of the
    // org — accept-invite touches no billing state. Their own tier must win
    // when their subscription is genuinely active, even under a different
    // owner tier, or a self-paying member would be silently downgraded.
    const mockedOrgDb = orgDb as jest.Mocked<typeof orgDb>;
    mockedUserDb.getUserById.mockImplementation(async (id: string) => {
      if (id === 'member-active') {
        return {
          userId: 'member-active', orgId: 'org-1', orgRole: 'member',
          subscriptionType: 'Pro', subscription_status: 'active',
        } as any;
      }
      if (id === 'owner-1') return { userId: 'owner-1', subscriptionType: 'Managed' } as any;
      return null as any;
    });
    mockedOrgDb.getOrgById.mockResolvedValue({ orgId: 'org-1', ownerUserId: 'owner-1' } as any);

    const tier = await getUserSubscriptionType('member-active');
    expect(tier).toBe('Pro');
    expect(mockedOrgDb.getOrgById).not.toHaveBeenCalled();
  });

  it('getUserSubscriptionType lets a member own TRIALING subscription govern instead of the owner', async () => {
    const mockedOrgDb = orgDb as jest.Mocked<typeof orgDb>;
    mockedUserDb.getUserById.mockImplementation(async (id: string) => {
      if (id === 'member-trial') {
        return {
          userId: 'member-trial', orgId: 'org-1', orgRole: 'member',
          subscriptionType: 'Starter', subscription_status: 'trialing',
        } as any;
      }
      if (id === 'owner-1') return { userId: 'owner-1', subscriptionType: 'Free' } as any;
      return null as any;
    });
    mockedOrgDb.getOrgById.mockResolvedValue({ orgId: 'org-1', ownerUserId: 'owner-1' } as any);

    const tier = await getUserSubscriptionType('member-trial');
    expect(tier).toBe('Starter');
  });

  it('getUserSubscriptionType still inherits the owner tier for a member with a CANCELED subscription (the Harsha case)', async () => {
    const mockedOrgDb = orgDb as jest.Mocked<typeof orgDb>;
    mockedUserDb.getUserById.mockImplementation(async (id: string) => {
      if (id === 'member-canceled') {
        return {
          userId: 'member-canceled', orgId: 'org-1', orgRole: 'member',
          subscriptionType: 'Pro', subscription_status: 'canceled',
        } as any;
      }
      if (id === 'owner-1') return { userId: 'owner-1', subscriptionType: 'Super Premium' } as any;
      return null as any;
    });
    mockedOrgDb.getOrgById.mockResolvedValue({ orgId: 'org-1', ownerUserId: 'owner-1' } as any);

    const tier = await getUserSubscriptionType('member-canceled');
    expect(tier).toBe('Super Premium');
  });

  it('getUserSubscriptionType inherits the owner tier for a member with no subscription_status at all (fresh invite)', async () => {
    const mockedOrgDb = orgDb as jest.Mocked<typeof orgDb>;
    mockedUserDb.getUserById.mockImplementation(async (id: string) => {
      if (id === 'member-fresh') {
        return { userId: 'member-fresh', orgId: 'org-1', orgRole: 'member', subscriptionType: 'Free' } as any;
      }
      if (id === 'owner-1') return { userId: 'owner-1', subscriptionType: 'Pro' } as any;
      return null as any;
    });
    mockedOrgDb.getOrgById.mockResolvedValue({ orgId: 'org-1', ownerUserId: 'owner-1' } as any);

    const tier = await getUserSubscriptionType('member-fresh');
    expect(tier).toBe('Pro');
  });

  it('getAllowedConnectedAccounts resolves an org member to the owner tier (regression: Harsha/Twitter flash-then-hide bug)', async () => {
    // Reproduces the reported symptom: member's own record is Pro (no twitter),
    // org owner is Super Premium (includes twitter). Before centralizing tier
    // resolution in getUserSubscriptionType, routes/connectedAccounts.ts called
    // getAllowedConnectedAccounts(userId) with the member's own id directly,
    // so Twitter was excluded from allowedConnectedAccounts even though the
    // owner had shared/granted it — the card would flash (from the already
    // org-aware /me response) then disappear once this endpoint's response
    // landed with the member's own, un-inherited tier.
    const mockedOrgDb = orgDb as jest.Mocked<typeof orgDb>;
    mockedUserDb.getUserById.mockImplementation(async (id: string) => {
      if (id === 'member-harsha') {
        return { userId: 'member-harsha', orgId: 'org-1', orgRole: 'member', subscriptionType: 'Pro' } as any;
      }
      if (id === 'owner-1') {
        return { userId: 'owner-1', subscriptionType: 'Super Premium' } as any;
      }
      return null as any;
    });
    mockedOrgDb.getOrgById.mockResolvedValue({ orgId: 'org-1', ownerUserId: 'owner-1' } as any);

    mockedSettingsService.getSetting.mockResolvedValue({
      settingValue: JSON.stringify([
        { name: 'Pro', allowedPages: ['/'], allowedSkills: ['*'], allowedConnectedAccounts: ['linkedin', 'gmail'] },
        { name: 'Super Premium', allowedPages: ['/'], allowedSkills: ['*'], allowedConnectedAccounts: ['linkedin', 'gmail', 'twitter'] },
      ]),
    } as any);

    const allowed = await getAllowedConnectedAccounts('member-harsha');

    expect(allowed).toContain('twitter');
    expect(allowed).toEqual(['linkedin', 'gmail', 'twitter']);
  });

  it('getAllowedConnectedAccounts uses the member own tier once they leave the org', async () => {
    const mockedOrgDb = orgDb as jest.Mocked<typeof orgDb>;
    mockedUserDb.getUserById.mockResolvedValueOnce({ userId: 'ex-member', subscriptionType: 'Pro' } as any);
    mockedSettingsService.getSetting.mockResolvedValue({
      settingValue: JSON.stringify([
        { name: 'Pro', allowedPages: ['/'], allowedSkills: ['*'], allowedConnectedAccounts: ['linkedin', 'gmail'] },
      ]),
    } as any);

    const allowed = await getAllowedConnectedAccounts('ex-member');

    expect(allowed).toEqual(['linkedin', 'gmail']);
    expect(allowed).not.toContain('twitter');
    expect(mockedOrgDb.getOrgById).not.toHaveBeenCalled();
  });

  it('getAllAvailablePages includes default pages and customer portal pages', () => {
    const pages = getAllAvailablePages();
    expect(pages).toEqual(['/', '/agent-mode', '/settings', '/guide', '/tasks', '/seo', '/paid-social', '/newsletter']);
  });

  it('getAllAvailableFunctionCalls returns all function tool names from AgentModeService', async () => {
    const calls = await getAllAvailableFunctionCalls();
    expect(calls.sort()).toEqual(['generate_image', 'generate_video'].sort());
  });

  it('getSubscriptionTypeConfig returns default Basic config when no types defined', async () => {
    mockedSettingsService.getSetting.mockResolvedValueOnce(null as any);

    const cfg = await getSubscriptionTypeConfig('Basic');
    expect(cfg).not.toBeNull();
    expect(cfg!.name).toBe('Basic');
    expect(cfg!.allowedPages).toEqual(getAllAvailablePages());
    expect(cfg!.allowedSkills).toEqual(['*']);
  });

  it('getSubscriptionTypeConfig returns Free tier fallback when no types defined', async () => {
    mockedSettingsService.getSetting.mockResolvedValueOnce(null as any);

    const cfg = await getSubscriptionTypeConfig('Free');
    expect(cfg).not.toBeNull();
    expect(cfg!.name).toBe('Free');
    expect(cfg!.allowedPages).toEqual(['/', '/agent-mode', '/settings', '/guide']);
    expect(cfg!.allowedSkills).toEqual([]);
  });

  it('getSubscriptionTypeConfig normalizes /marketing prefix in allowedPages', async () => {
    const storedTypes = [
      {
        name: 'Pro',
        allowedPages: ['/marketing/tasks', '/marketing/guide', '/seo'],
        allowedSkills: ['skill-1'],
      },
    ];

    mockedSettingsService.getSetting.mockResolvedValueOnce({
      settingName: 'subscription_types',
      settingValue: JSON.stringify(storedTypes),
    } as any);

    const cfg = await getSubscriptionTypeConfig('Pro');
    expect(cfg).not.toBeNull();
    expect(cfg!.allowedPages).toEqual(['/tasks', '/guide', '/seo']);
  });

  it('getSubscriptionTypeConfig backward compat: old config with allowedFunctionCalls but no allowedSkills gets wildcard', async () => {
    const storedTypes = [
      {
        name: 'Legacy',
        allowedPages: ['/tasks'],
        allowedFunctionCalls: ['generate_image'],
        // Note: no allowedSkills field
      },
    ];

    mockedSettingsService.getSetting.mockResolvedValueOnce({
      settingName: 'subscription_types',
      settingValue: JSON.stringify(storedTypes),
    } as any);

    const cfg = await getSubscriptionTypeConfig('Legacy');
    expect(cfg).not.toBeNull();
    expect(cfg!.allowedSkills).toEqual(['*']);
  });

  // ---- findTiersAllowingSkill (ENG-173 publish guardrail) ----

  const tiersSetting = (types: any[]) => ({
    settingName: 'subscription_types',
    settingValue: JSON.stringify(types),
  });

  it('findTiersAllowingSkill: reachable when skill is in a tier allowedSkills', async () => {
    mockedSettingsService.getSetting.mockResolvedValueOnce(tiersSetting([
      { name: 'Free', allowedPages: [], allowedSkills: ['other'] },
      { name: 'Pro', allowedPages: [], allowedSkills: ['skill-x', 'other'] },
    ]) as any);

    const res = await findTiersAllowingSkill('skill-x');
    expect(res.reachable).toBe(true);
    expect(res.allowingTiers).toContain('Pro');
    expect(res.totalTiers).toBe(2);
  });

  it('findTiersAllowingSkill: NOT reachable when skill is in no tier', async () => {
    mockedSettingsService.getSetting.mockResolvedValueOnce(tiersSetting([
      { name: 'Free', allowedPages: [], allowedSkills: ['other'] },
      { name: 'Pro', allowedPages: [], allowedSkills: ['another'] },
    ]) as any);

    const res = await findTiersAllowingSkill('skill-x');
    expect(res.reachable).toBe(false);
    expect(res.allowingTiers).toEqual([]);
    expect(res.totalTiers).toBe(2);
  });

  it('findTiersAllowingSkill: wildcard tier makes any skill reachable', async () => {
    mockedSettingsService.getSetting.mockResolvedValueOnce(tiersSetting([
      { name: 'Super', allowedPages: [], allowedSkills: ['*'] },
    ]) as any);

    const res = await findTiersAllowingSkill('skill-x');
    expect(res.reachable).toBe(true);
    expect(res.allowingTiers).toContain('Super');
  });

  it('findTiersAllowingSkill: tier missing allowedSkills reaches nothing (the runtime refuses to resolve it)', async () => {
    mockedSettingsService.getSetting.mockResolvedValueOnce(tiersSetting([
      { name: 'Legacy', allowedPages: [], allowedFunctionCalls: ['x'] },
    ]) as any);

    const res = await findTiersAllowingSkill('skill-x');
    expect(res.reachable).toBe(false);
    expect(res.allowingTiers).toEqual([]);
  });

  it('findTiersAllowingSkill: fail-open (reachable) when no subscription_types setting exists', async () => {
    mockedSettingsService.getSetting.mockResolvedValueOnce(null as any);

    const res = await findTiersAllowingSkill('skill-x');
    expect(res.reachable).toBe(true);
    expect(res.totalTiers).toBe(0);
  });

  it('findTiersAllowingSkill: fail-open when settingValue is malformed JSON', async () => {
    mockedSettingsService.getSetting.mockResolvedValueOnce({
      settingName: 'subscription_types',
      settingValue: '{ not valid json',
    } as any);

    const res = await findTiersAllowingSkill('skill-x');
    expect(res.reachable).toBe(true);
    expect(res.totalTiers).toBe(0);
  });

  it('findTiersAllowingSkill: fail-open when tiers array is empty', async () => {
    mockedSettingsService.getSetting.mockResolvedValueOnce(tiersSetting([]) as any);

    const res = await findTiersAllowingSkill('skill-x');
    expect(res.reachable).toBe(true);
    expect(res.totalTiers).toBe(0);
  });

  it('findTiersAllowingSkill: fail-open when the settings lookup throws', async () => {
    mockedSettingsService.getSetting.mockRejectedValueOnce(new Error('dynamo down'));

    const res = await findTiersAllowingSkill('skill-x');
    expect(res.reachable).toBe(true);
    expect(res.allowingTiers).toEqual([]);
    expect(res.totalTiers).toBe(0);
  });

  // ---- getAllAvailableSkills tests ----

  it('getAllAvailableSkills returns published skill IDs plus __other_skills__', async () => {
    const skills = await getAllAvailableSkills();
    expect(skills).toEqual(['skill-1', 'skill-2', '__other_skills__']);
  });

  // ---- getAllowedSkills tests ----

  it('getAllowedSkills returns explicit list when configured', async () => {
    const storedTypes = [
      {
        name: 'Pro',
        allowedPages: ['/tasks'],
        allowedSkills: ['skill-1'],
      },
    ];

    mockedUserDb.getUserById.mockResolvedValueOnce({ userId: 'u1', subscriptionType: 'Pro' } as any);
    mockedSettingsService.getSetting.mockResolvedValueOnce({
      settingName: 'subscription_types',
      settingValue: JSON.stringify(storedTypes),
    } as any);

    const skills = await getAllowedSkills('u1');
    expect(skills).toEqual(['skill-1']);
  });

  it('getAllowedSkills keeps an explicit wildcard but fixes the empty-list inversion', async () => {
    const base = {
      name: 'Pro',
      allowedPages: ['/tasks'],
    };

    // "*": an admin deliberately configured wildcard — unchanged by ENG-1978.
    mockedUserDb.getUserById.mockResolvedValueOnce({ userId: 'u1', subscriptionType: 'Pro' } as any);
    mockedSettingsService.getSetting.mockResolvedValueOnce({
      settingName: 'subscription_types',
      settingValue: JSON.stringify([{ ...base, allowedSkills: ['*'] }]),
    } as any);

    const skills1 = await getAllowedSkills('u1');
    expect(skills1).toEqual(['*']);

    // ENG-1978: empty array means NO skills, not all of them. This is the actual bug fix — an
    // empty `allowedSkills` is a resolved tier with zero skills, not an unresolved wildcard.
    mockedUserDb.getUserById.mockResolvedValueOnce({ userId: 'u2', subscriptionType: 'Pro' } as any);
    mockedSettingsService.getSetting.mockResolvedValueOnce({
      settingName: 'subscription_types',
      settingValue: JSON.stringify([{ ...base, allowedSkills: [] }]),
    } as any);

    const skills2 = await getAllowedSkills('u2');
    expect(skills2).toEqual([]);
  });

  /*
   * ENG-1978 fail-closed. These assert that a case which used to silently grant everything now
   * returns null and is recorded under `entitlement-denied` — PR #2947 shipped this same
   * instrumentation as `wildcard-grant`; renamed here because the behaviour it describes flipped.
   */
  describe('entitlement-denied fail-closed (ENG-1978)', () => {
    // resetEntitlementDeniedSink, not a silent stub: installing `() => {}` here would leave every
    // test declared after this block running with observation disabled.
    afterEach(() => resetEntitlementDeniedSink());

    it('fails closed and records when the tier name is not in the config', async () => {
      const events: any[] = [];
      setEntitlementDeniedSink((e) => events.push(e));
      mockedUserDb.getUserById.mockResolvedValueOnce({ userId: 'u1', subscriptionType: 'NoSuchTier' } as any);
      mockedSettingsService.getSetting.mockResolvedValue({
        settingName: 'subscription_types',
        settingValue: JSON.stringify([{ name: 'Pro', allowedPages: ['/tasks'], allowedSkills: ['skill-1'] }]),
      } as any);

      expect(await getAllowedSkills('u1')).toBeNull();
      expect(events.map((e) => e.reason)).toContain('subscription-type-config-unavailable');
    });

    it('resolves an empty-list tier to [] without reporting anything (no longer a wildcard case)', async () => {
      const events: any[] = [];
      setEntitlementDeniedSink((e) => events.push(e));
      mockedUserDb.getUserById.mockResolvedValueOnce({ userId: 'u2', subscriptionType: 'Pro' } as any);
      mockedSettingsService.getSetting.mockResolvedValue({
        settingName: 'subscription_types',
        settingValue: JSON.stringify([{ name: 'Pro', allowedPages: ['/tasks'], allowedSkills: [] }]),
      } as any);

      expect(await getAllowedSkills('u2')).toEqual([]);
      expect(events).toHaveLength(0);
    });

    /*
     * Review finding: an unconfirmed tier frequently produces a RESTRICTED result, not a wildcard
     * — an unreadable user row still resolves to a real Free tier with a real skill list. If that
     * were recorded as an entitlement-denied it would inflate the over-grant count and argue for the
     * fail-closed change on false evidence. Hence the separate `kind`, asserted here.
     */
    it('records an unconfirmed tier as its OWN kind, not as an entitlement-denied', async () => {
      const events: any[] = [];
      setEntitlementDeniedSink((e) => events.push(e));
      mockedUserDb.getUserById.mockResolvedValueOnce(null as any);
      mockedSettingsService.getSetting.mockResolvedValue({
        settingName: 'subscription_types',
        settingValue: JSON.stringify([{ name: 'Free', allowedPages: ['/tasks'], allowedSkills: ['skill-free'] }]),
      } as any);

      // Restricted list, NOT ["*"] — exactly as before; only the observation is new.
      expect(await getAllowedSkills('ghost')).toEqual(['skill-free']);
      // unconfirmed-tier is windowed (60s), so nothing emits until the window is flushed.
      expect(events).toHaveLength(0);
      flushUnconfirmedTierObservations(Date.now() + 61_000);

      expect(events).toHaveLength(1);
      expect(events[0].kind).toBe('unconfirmed-tier');
      expect(events[0].detail.byReason).toEqual({ 'subscription-type-unresolved': 1 });
      expect(events.filter((e) => e.kind === 'entitlement-denied')).toHaveLength(0);
    });

    /*
     * Round-2 review, finding #1: PR #2947's documented "grep WILDCARD-GRANT" instruction (now
     * "grep ENTITLEMENT-DENIED") cannot see unconfirmed-tier events at all, since they use a
     * different marker string. Both must share the `[entitlement]` prefix so a broader grep
     * catches both kinds.
     */
    it('both kinds share the [entitlement] prefix so one grep catches both', async () => {
      const lines: string[] = [];
      const origWarn = console.warn;
      console.warn = (...args: any[]) => { lines.push(args.join(' ')); };
      try {
        mockedUserDb.getUserById.mockResolvedValueOnce({ userId: 'u9', subscriptionType: 'NoSuchTier' } as any);
        mockedSettingsService.getSetting.mockResolvedValue({
          settingName: 'subscription_types',
          settingValue: JSON.stringify([{ name: 'Pro', allowedPages: ['/tasks'], allowedSkills: ['s'] }]),
        } as any);
        await getAllowedSkills('u9');
        expect(lines.some((l) => l.startsWith('[entitlement]'))).toBe(true);
      } finally {
        console.warn = origWarn;
      }
    });

    /*
     * Round-2 review, finding #7: a "Basic" fallback (no subscription_types row at all) grants
     * ["*"] with no flag, contradicting the file's own "only an explicit config wildcard is
     * deliberate" claim. Now shares the same allowedSkillsDefaulted mechanism, with its own reason
     * so it stays distinguishable from a malformed row on a real tier.
     */
    it('fails closed on the legacy Basic fallback, distinctly from a malformed real-tier row', async () => {
      const events: any[] = [];
      setEntitlementDeniedSink((e) => events.push(e));
      mockedUserDb.getUserById.mockResolvedValueOnce({ userId: 'u10', subscriptionType: 'Basic' } as any);
      mockedSettingsService.getSetting.mockResolvedValue(null as any); // setting entirely absent

      expect(await getAllowedSkills('u10')).toBeNull();
      expect(events.map((e) => e.reason)).toContain('legacy-basic-fallback-no-tier-config');
      expect(events.map((e) => e.reason)).not.toContain('tier-config-missing-allowed-skills');
    });

    /*
     * Round-2 review, finding #5: agentModeService's hottest call site (inside the agent
     * iteration loop) threads userId through so the one reason that is ALWAYS a genuine
     * full-registry grant does not end up unattributable.
     */
    it('resolveSkillsToToolNames fails closed and attributes skill-to-tool-resolution-failed to the given userId', async () => {
      const events: any[] = [];
      setEntitlementDeniedSink((e) => events.push(e));
      const skillSvc = jest.requireMock('../services/skillService').skillService;
      skillSvc.getPublishedSkills.mockImplementationOnce(() => { throw new Error('dynamo scan failed'); });

      expect(await resolveSkillsToToolNames(['skill-1'], 'u11')).toBeNull();
      const ev = events.find((e) => e.reason === 'skill-to-tool-resolution-failed');
      expect(ev?.userId).toBe('u11');
    });

    /*
     * Review finding: this previously asserted only `events.length > 0` and was named as though it
     * covered getAllowedSkills' own catch. It does not — a rejected getSetting is caught inside
     * getSubscriptionTypeConfig, so the branch taken is the config-unavailable one. Asserting the
     * reason string is what exposed the mislabel.
     */
    it('fails closed on config-unavailable (not the outer catch) when the settings lookup throws', async () => {
      const events: any[] = [];
      setEntitlementDeniedSink((e) => events.push(e));
      mockedUserDb.getUserById.mockResolvedValueOnce({ userId: 'u3', subscriptionType: 'Pro' } as any);
      mockedSettingsService.getSetting.mockRejectedValue(new Error('dynamo down'));

      expect(await getAllowedSkills('u3')).toBeNull();
      const ev = events.find((e) => e.reason === 'subscription-type-config-unavailable');
      expect(ev).toBeDefined();
      // A genuine full-registry over-grant that now fails closed — must be kind 'entitlement-denied',
      // not 'unconfirmed-tier'.
      expect(ev.kind).toBe('entitlement-denied');
    });

    /* The genuine trigger for getAllowedSkills' own catch: a non-array allowedSkills makes
     * `.includes` throw. Previously uncovered entirely. */
    it('fails closed when allowedSkills is not an array', async () => {
      const events: any[] = [];
      setEntitlementDeniedSink((e) => events.push(e));
      mockedUserDb.getUserById.mockResolvedValueOnce({ userId: 'u4', subscriptionType: 'Pro' } as any);
      mockedSettingsService.getSetting.mockResolvedValue({
        settingName: 'subscription_types',
        settingValue: JSON.stringify([{ name: 'Pro', allowedPages: ['/tasks'], allowedSkills: { nope: true } }]),
      } as any);

      expect(await getAllowedSkills('u4')).toBeNull();
      expect(events.map((e) => e.reason)).toContain('allowed-skills-lookup-failed');
    });

    /*
     * Round-2 review, finding #3. `allowedSkillsDefaulted` is the sole discriminator between "an
     * admin deliberately typed ["*"]" and "the row carried no allowedSkills and was silently
     * defaulted". Without this test a mutation that always treats the wildcard as defaulted
     * (e.g. `if (true)` in place of the flag check) turns every explicit-wildcard tier into a
     * reported over-grant on every request for every user on that tier — with no test failing.
     */
    it('does NOT emit for a tier that explicitly authored allowedSkills: ["*"]', async () => {
      const events: any[] = [];
      setEntitlementDeniedSink((e) => events.push(e));
      mockedUserDb.getUserById.mockResolvedValueOnce({ userId: 'u12', subscriptionType: 'Pro' } as any);
      mockedSettingsService.getSetting.mockResolvedValue({
        settingName: 'subscription_types',
        settingValue: JSON.stringify([{ name: 'Pro', allowedPages: ['/tasks'], allowedSkills: ['*'] }]),
      } as any);

      expect(await getAllowedSkills('u12')).toEqual(['*']);
      expect(events).toHaveLength(0);
    });

    /* A tier row missing allowedSkills entirely is rewritten to ["*"] inside
     * getSubscriptionTypeConfig, before getAllowedSkills sees it — the likeliest real
     * malformation. ENG-1978: that silent default is no longer granted either. */
    it('fails closed on a tier row that omits allowedSkills, which silently defaults to wildcard', async () => {
      const events: any[] = [];
      setEntitlementDeniedSink((e) => events.push(e));
      mockedUserDb.getUserById.mockResolvedValueOnce({ userId: 'u5', subscriptionType: 'Legacy' } as any);
      mockedSettingsService.getSetting.mockResolvedValue({
        settingName: 'subscription_types',
        settingValue: JSON.stringify([{ name: 'Legacy', allowedPages: ['/tasks'] }]),
      } as any);

      expect(await getAllowedSkills('u5')).toBeNull();
      expect(events.map((e) => e.reason)).toContain('tier-config-missing-allowed-skills');
    });

    /*
     * The report for a missing allowedSkills must fire ONLY on the skills path.
     * getSubscriptionTypeConfig has ~18 callers across unrelated subsystems (token usage, LLM
     * usage policy, unit economics, Stripe, evaluation store, allowedPages/Features/HiddenPages);
     * reporting from inside it — as an earlier revision did — turned one malformed row into an
     * event on every one of them. This pins that it does not.
     */
    it('does not emit for a malformed tier row when resolving something other than skills', async () => {
      const events: any[] = [];
      setEntitlementDeniedSink((e) => events.push(e));
      mockedUserDb.getUserById.mockResolvedValue({ userId: 'u8', subscriptionType: 'Legacy' } as any);
      mockedSettingsService.getSetting.mockResolvedValue({
        settingName: 'subscription_types',
        settingValue: JSON.stringify([{ name: 'Legacy', allowedPages: ['/tasks'] }]),
      } as any);

      await getAllowedPages('u8');
      await getAllowedFeatures('u8');

      expect(events).toHaveLength(0);
    });

    /* Observation must never be the reason the SERVER fails. An async sink is assignable to a
     * `=> void` type, and its rejection would otherwise escape as an unhandled rejection. */
    it('survives a sink that rejects asynchronously', async () => {
      setEntitlementDeniedSink((() => Promise.reject(new Error('sink blew up'))) as any);
      mockedUserDb.getUserById.mockResolvedValueOnce({ userId: 'u6', subscriptionType: 'NoSuchTier' } as any);
      mockedSettingsService.getSetting.mockResolvedValue({
        settingName: 'subscription_types',
        settingValue: JSON.stringify([{ name: 'Pro', allowedPages: ['/tasks'], allowedSkills: ['s'] }]),
      } as any);

      await expect(getAllowedSkills('u6')).resolves.toBeNull();
      await new Promise((r) => setImmediate(r)); // let any unhandled rejection surface
    });

    it('survives a sink that throws synchronously', async () => {
      setEntitlementDeniedSink(() => { throw new Error('sync boom'); });
      mockedUserDb.getUserById.mockResolvedValueOnce({ userId: 'u7', subscriptionType: 'NoSuchTier' } as any);
      mockedSettingsService.getSetting.mockResolvedValue({
        settingName: 'subscription_types',
        settingValue: JSON.stringify([{ name: 'Pro', allowedPages: ['/tasks'], allowedSkills: ['s'] }]),
      } as any);

      await expect(getAllowedSkills('u7')).resolves.toBeNull();
    });
  });

  // ---- getAllowedSkills for anonymous users ----

  it('getAllowedSkills routes anon_ users to public allowed skills', async () => {
    // Set up public skills setting
    mockedSettingsService.getSetting.mockResolvedValueOnce({
      settingName: 'public_allowed_skills',
      settingValue: JSON.stringify(['skill-1']),
    } as any);

    const skills = await getAllowedSkills('anon_abc-123');
    expect(skills).toEqual(['skill-1']);
    // Should NOT call getUserById for anonymous users
    expect(mockedUserDb.getUserById).not.toHaveBeenCalled();
  });

  it('getAllowedSkills returns empty array for anon_ users when no public config', async () => {
    mockedSettingsService.getSetting.mockResolvedValueOnce(null);

    const skills = await getAllowedSkills('anon_xyz-456');
    expect(skills).toEqual([]);
    expect(mockedUserDb.getUserById).not.toHaveBeenCalled();
  });

  // ---- getPublicAllowedSkills tests ----

  it('getPublicAllowedSkills returns empty array when no setting', async () => {
    mockedSettingsService.getSetting.mockResolvedValueOnce(null);
    const skills = await getPublicAllowedSkills();
    expect(skills).toEqual([]);
  });

  it('getPublicAllowedSkills returns stored skills list', async () => {
    mockedSettingsService.getSetting.mockResolvedValueOnce({
      settingName: 'public_allowed_skills',
      settingValue: JSON.stringify(['skill-1', '__other_skills__']),
    } as any);
    const skills = await getPublicAllowedSkills();
    expect(skills).toEqual(['skill-1', '__other_skills__']);
  });

  // ---- resolveSkillsToToolNames tests ----

  it('resolveSkillsToToolNames returns wildcard for wildcard input', async () => {
    const tools = await resolveSkillsToToolNames(['*']);
    expect(tools).toEqual(['*']);
  });

  it('resolveSkillsToToolNames resolves skill IDs to tool names', async () => {
    const tools = await resolveSkillsToToolNames(['skill-1', 'skill-2']);
    expect(tools).not.toBeNull();
    expect(tools!.sort()).toEqual(['generate_image', 'generate_video'].sort());
  });

  it('resolveSkillsToToolNames handles __other_skills__', async () => {
    const tools = await resolveSkillsToToolNames(['__other_skills__']);
    expect(tools).toContain('generate_image');
  });

  it('resolveSkillsToToolNames passes the FULL published catalog to getUnassociatedToolNames, not just the caller\'s own reachable skillIds (ENG-2299)', async () => {
    // getPublishedSkills() (mocked above) returns the FULL multi-tenant catalog:
    // skill-1 and skill-2. Even though this caller's own skillIds only reach
    // skill-1, skill-2 must still be passed through — a published skill always
    // claims its tool out of the shared __other_skills__ catch-all regardless of
    // which tier is asking, exactly like getUnassociatedTools' own isPublished
    // check (ENG-1237). Pre-filtering the catalog to the caller's own skillIds
    // before this call is what let a tier-excluded skill's tool leak back into
    // every tier's catch-all (the bug this test guards against).
    const { agentModeService } = require('../services/agentModeService');
    const seenSkillIds: string[][] = [];
    const spy = jest
      .spyOn(agentModeService, 'getUnassociatedToolNames')
      .mockImplementation((skills: any) => {
        seenSkillIds.push(skills.map((s: any) => s.skillId));
        return ['generate_image'];
      });

    await resolveSkillsToToolNames(['skill-1', '__other_skills__']);

    expect(seenSkillIds).toEqual([['skill-1', 'skill-2']]);
    spy.mockRestore();
  });

  // ---- getAllowedFunctionCalls bridge tests ----

  it('getAllowedFunctionCalls bridges through skills: returns tool names from allowed skills', async () => {
    const storedTypes = [
      {
        name: 'Pro',
        allowedPages: ['/tasks'],
        allowedSkills: ['skill-1'],
      },
    ];

    mockedUserDb.getUserById.mockResolvedValueOnce({ userId: 'u1', subscriptionType: 'Pro' } as any);
    mockedSettingsService.getSetting.mockResolvedValueOnce({
      settingName: 'subscription_types',
      settingValue: JSON.stringify(storedTypes),
    } as any);

    const calls = await getAllowedFunctionCalls('u1');
    expect(calls).toEqual(['generate_image']);
  });

  it('getAllowedFunctionCalls returns wildcard when a tier explicitly authors it', async () => {
    mockedUserDb.getUserById.mockResolvedValueOnce({ userId: 'u1', subscriptionType: 'Pro' } as any);
    mockedSettingsService.getSetting.mockResolvedValueOnce({
      settingName: 'subscription_types',
      settingValue: JSON.stringify([{ name: 'Pro', allowedPages: ['/tasks'], allowedSkills: ['*'] }]),
    } as any);

    const calls = await getAllowedFunctionCalls('u1');
    expect(calls).toEqual(['*']);
  });

  /*
   * ENG-1978: the legacy "Basic, no subscription_types row at all" bootstrap fallback is a
   * silent default, not an admin-authored wildcard — it now fails closed through the whole
   * getAllowedSkills -> resolveSkillsToToolNames -> getAllowedFunctionCalls bridge. This used to
   * assert `['*']` before the fix.
   */
  it('getAllowedFunctionCalls fails closed through the bridge on the legacy Basic fallback', async () => {
    mockedUserDb.getUserById.mockResolvedValueOnce({ userId: 'u1', subscriptionType: 'Basic' } as any);
    mockedSettingsService.getSetting.mockResolvedValueOnce(null as any);

    const calls = await getAllowedFunctionCalls('u1');
    expect(calls).toBeNull();
  });

  it('getAllowedPages returns explicit list and strips /marketing prefix', async () => {
    const storedTypes = [
      {
        name: 'Pro',
        allowedPages: ['/marketing/tasks', '/marketing/guide', '/seo'],
        allowedSkills: ['skill-1'],
      },
    ];

    mockedUserDb.getUserById.mockResolvedValueOnce({ userId: 'u1', subscriptionType: 'Pro' } as any);
    mockedSettingsService.getSetting.mockResolvedValueOnce({
      settingName: 'subscription_types',
      settingValue: JSON.stringify(storedTypes),
    } as any);

    const pages = await getAllowedPages('u1');
    expect(pages).toEqual(['/tasks', '/guide', '/seo']);
  });

  it('getAllowedPages expands "*" or empty to all available pages', async () => {
    const base = {
      name: 'Pro',
      allowedSkills: ['skill-1'],
    };

    // "*"
    mockedUserDb.getUserById.mockResolvedValueOnce({ userId: 'u1', subscriptionType: 'Pro' } as any);
    mockedSettingsService.getSetting.mockResolvedValueOnce({
      settingName: 'subscription_types',
      settingValue: JSON.stringify([{ ...base, allowedPages: ['*'] }]),
    } as any);

    const pages1 = await getAllowedPages('u1');
    expect(pages1).toEqual(getAllAvailablePages());

    // empty array
    mockedUserDb.getUserById.mockResolvedValueOnce({ userId: 'u2', subscriptionType: 'Pro' } as any);
    mockedSettingsService.getSetting.mockResolvedValueOnce({
      settingName: 'subscription_types',
      settingValue: JSON.stringify([{ ...base, allowedPages: [] }]),
    } as any);

    const pages2 = await getAllowedPages('u2');
    expect(pages2).toEqual(getAllAvailablePages());
  });

  it('filterFunctionCalls keeps only allowed function tools but keeps non-function tools', () => {
    const tools = [
      { type: 'function', function: { name: 'generate_image' } },
      { type: 'function', function: { name: 'search_web' } },
      { type: 'plain', other: true },
      { type: 'function', function: { name: undefined as any } },
    ];

    const filtered = filterFunctionCalls(tools, ['generate_image']);
    expect(filtered).toEqual([
      { type: 'function', function: { name: 'generate_image' } },
      { type: 'plain', other: true },
      { type: 'function', function: { name: undefined as any } },
    ]);
  });
});

describe('getAllAvailableConnectedAccounts', () => {
  it('includes twitter as a gateable platform', () => {
    expect(getAllAvailableConnectedAccounts()).toContain('twitter');
  });

  it('includes all known connectable platforms', () => {
    const accounts = getAllAvailableConnectedAccounts();
    for (const platform of [
      'linkedin', 'unipile', 'meta', 'gmail', 'youtube', 'fathom',
      'instagram', 'twitter', 'hubspot', 'attio', 'google_ads', 'google_drive',
      'linkedin_ads',
    ]) {
      expect(accounts).toContain(platform);
    }
  });

  // Regression: linkedin_ads has a full platform integration (catalog entry,
  // OAuth routes, its own account-selection modal, reconnect auto-resolve
  // wiring) but was missing from this master list — found live in prod, a
  // real customer connected linkedin_ads once via onboarding (a separate,
  // ungated flow) then had no way back to reconnect it through the regular
  // Settings page, since this list is what gates that page's card.
  it('includes linkedin_ads, which was missing despite having a full platform integration', () => {
    expect(getAllAvailableConnectedAccounts()).toContain('linkedin_ads');
  });
  /*
   * ENG-1978: a transient DynamoDB error on the subscription_types read must not strip a user's plan.
   * The last good read is served — bounded in age — only when the live read fails; a successful
   * read always wins, so admin edits still apply immediately.
   */
  describe('last-known subscription_types on a failed read (ENG-1978)', () => {
    const config = (skills: string[]) => ({
      settingName: 'subscription_types',
      settingValue: JSON.stringify([{ name: 'Pro', allowedPages: ['/tasks'], allowedSkills: skills }]),
    });
    let warn: jest.SpyInstance;

    beforeEach(() => {
      resetLastKnownSubscriptionTypes();
      mockedSettingsService.getSetting.mockReset();
      mockedUserDb.getUserById.mockReset();
      mockedUserDb.getUserById.mockResolvedValue({ userId: 'u1', subscriptionType: 'Pro' } as any);
      warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
      jest.spyOn(console, 'error').mockImplementation(() => {});
    });
    afterEach(() => {
      jest.restoreAllMocks();
      resetEntitlementDeniedSink();
    });

    it('keeps the user on their plan when the next read fails', async () => {
      mockedSettingsService.getSetting.mockResolvedValueOnce(config(['skill-1']) as any);
      expect(await getAllowedSkills('u1')).toEqual(['skill-1']);

      mockedSettingsService.getSetting.mockRejectedValueOnce(new Error('dynamo down'));
      expect(await getAllowedSkills('u1')).toEqual(['skill-1']);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('STALE-CONFIG'), 'dynamo down');
    });

    it('fails closed when a read fails and nothing was ever read', async () => {
      const events: any[] = [];
      setEntitlementDeniedSink((e) => events.push(e));
      mockedSettingsService.getSetting.mockRejectedValueOnce(new Error('dynamo down'));

      expect(await getAllowedSkills('u1')).toBeNull();
      expect(events.map((e) => e.reason)).toContain('subscription-type-config-unavailable');
    });

    it('a successful read always wins over the remembered one (admin edits apply at once)', async () => {
      mockedSettingsService.getSetting.mockResolvedValueOnce(config(['skill-1']) as any);
      expect(await getAllowedSkills('u1')).toEqual(['skill-1']);

      mockedSettingsService.getSetting.mockResolvedValueOnce(config(['skill-2']) as any);
      expect(await getAllowedSkills('u1')).toEqual(['skill-2']);
    });

    it('stops serving the remembered config after 15 minutes', async () => {
      const t0 = 1_800_000_000_000;
      const now = jest.spyOn(Date, 'now').mockReturnValue(t0);
      mockedSettingsService.getSetting.mockResolvedValueOnce(config(['skill-1']) as any);
      expect(await getAllowedSkills('u1')).toEqual(['skill-1']);

      now.mockReturnValue(t0 + 14 * 60_000);
      mockedSettingsService.getSetting.mockRejectedValueOnce(new Error('dynamo down'));
      expect(await getAllowedSkills('u1')).toEqual(['skill-1']);

      now.mockReturnValue(t0 + 16 * 60_000);
      mockedSettingsService.getSetting.mockRejectedValueOnce(new Error('dynamo down'));
      expect(await getAllowedSkills('u1')).toBeNull();
    });

    it('warns at most once a minute while serving stale config', async () => {
      const t0 = 1_800_000_000_000;
      const now = jest.spyOn(Date, 'now').mockReturnValue(t0);
      mockedSettingsService.getSetting.mockResolvedValueOnce(config(['skill-1']) as any);
      await getAllowedSkills('u1');

      mockedSettingsService.getSetting.mockRejectedValue(new Error('dynamo down'));
      now.mockReturnValue(t0 + 1_000);
      await getAllowedSkills('u1');
      now.mockReturnValue(t0 + 20_000);
      await getAllowedSkills('u1');
      expect(warn.mock.calls.filter((c) => String(c[0]).includes('STALE-CONFIG'))).toHaveLength(1);

      now.mockReturnValue(t0 + 61_000);
      await getAllowedSkills('u1');
      expect(warn.mock.calls.filter((c) => String(c[0]).includes('STALE-CONFIG'))).toHaveLength(2);
    });
  });
});
