import { settingsService } from '../services/settingsService';
import { userDb, orgDb } from '../services/db';
import { CUSTOMER_PORTAL_PAGES } from '../services/customerPortalPages';
import {
  getUserSubscriptionType,
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
  });

  it('getUserSubscriptionType returns user.subscriptionType or Free by default', async () => {
    mockedUserDb.getUserById.mockResolvedValueOnce({ userId: 'u1', subscriptionType: 'Pro' } as any);
    const t1 = await getUserSubscriptionType('u1');
    expect(t1).toBe('Pro');

    mockedUserDb.getUserById.mockResolvedValueOnce({ userId: 'u2' } as any);
    const t2 = await getUserSubscriptionType('u2');
    expect(t2).toBe('Free');
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

  it('denies a feature when an admin explicitly omits it', async () => {
    mockedUserDb.getUserById.mockResolvedValue({ userId: 'u1', subscriptionType: 'Community' } as any);
    mockedSettingsService.getSetting.mockResolvedValue({
      settingValue: JSON.stringify([{
        name: 'Community', allowedPages: ['/'], allowedSkills: [], allowedFeatures: [],
      }]),
    } as any);

    expect(await getAllowedFeatures('u1')).toEqual([]);
  });

  it('keeps legacy subscription rows permissive until an admin saves feature settings', async () => {
    mockedUserDb.getUserById.mockResolvedValue({ userId: 'u1', subscriptionType: 'Legacy' } as any);
    mockedSettingsService.getSetting.mockResolvedValue({
      settingValue: JSON.stringify([{ name: 'Legacy', allowedPages: ['/'], allowedSkills: [] }]),
    } as any);

    expect(await getAllowedFeatures('u1')).toEqual(['scheduled_chats']);
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

  it('findTiersAllowingSkill: tier missing allowedSkills is treated as wildcard (backward compat)', async () => {
    mockedSettingsService.getSetting.mockResolvedValueOnce(tiersSetting([
      { name: 'Legacy', allowedPages: [], allowedFunctionCalls: ['x'] },
    ]) as any);

    const res = await findTiersAllowingSkill('skill-x');
    expect(res.reachable).toBe(true);
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

  it('getAllowedSkills returns wildcard for "*" or empty', async () => {
    const base = {
      name: 'Pro',
      allowedPages: ['/tasks'],
    };

    // "*"
    mockedUserDb.getUserById.mockResolvedValueOnce({ userId: 'u1', subscriptionType: 'Pro' } as any);
    mockedSettingsService.getSetting.mockResolvedValueOnce({
      settingName: 'subscription_types',
      settingValue: JSON.stringify([{ ...base, allowedSkills: ['*'] }]),
    } as any);

    const skills1 = await getAllowedSkills('u1');
    expect(skills1).toEqual(['*']);

    // empty array
    mockedUserDb.getUserById.mockResolvedValueOnce({ userId: 'u2', subscriptionType: 'Pro' } as any);
    mockedSettingsService.getSetting.mockResolvedValueOnce({
      settingName: 'subscription_types',
      settingValue: JSON.stringify([{ ...base, allowedSkills: [] }]),
    } as any);

    const skills2 = await getAllowedSkills('u2');
    expect(skills2).toEqual(['*']);
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
    expect(tools.sort()).toEqual(['generate_image', 'generate_video'].sort());
  });

  it('resolveSkillsToToolNames handles __other_skills__', async () => {
    const tools = await resolveSkillsToToolNames(['__other_skills__']);
    expect(tools).toContain('generate_image');
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

  it('getAllowedFunctionCalls returns wildcard when skills are wildcard', async () => {
    mockedUserDb.getUserById.mockResolvedValueOnce({ userId: 'u1', subscriptionType: 'Basic' } as any);
    mockedSettingsService.getSetting.mockResolvedValueOnce(null as any);

    const calls = await getAllowedFunctionCalls('u1');
    expect(calls).toEqual(['*']);
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
    ]) {
      expect(accounts).toContain(platform);
    }
  });
});
