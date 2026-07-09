import { AgentModeService } from '../services/agentModeService';

// ── Mocks ──────────────────────────────────────────────────────────────────
jest.mock('../services/db', () => ({
  userDb: {
    getUserById: jest.fn(),
    updateUser: jest.fn(),
  },
  orgDb: {
    getOrgById: jest.fn(),
    updateOrg: jest.fn(),
  },
}));

// regenerateMarketStrategy composes the existing onboarding generators/mappers
// via dynamic import — mock them so the test is deterministic and offline.
jest.mock('../services/onboardingIcpService', () => ({
  extractIcpBrandContext: (u: any) => ({
    companyName: u?.brandGuidelines?.brandData?.brandName || u?.companyName || undefined,
    companyUrl: u?.brandGuidelines?.brandData?.domain || undefined,
  }),
  generateIcpsForUser: jest.fn(async () => [
    { name: 'Growth Marketers', pain: 'hard to scale content', desire: 'scale fast' },
    { name: 'Founders', pain: 'no time', desire: 'automate GTM' },
  ]),
  mapIcpResultToMarketStrategy: (personas: any[]) =>
    (personas || []).map((p) => ({
      title: p.name,
      description: p.pain || '',
      valueProposition: p.desire || '',
      buyerPersonas: [],
    })),
}));

jest.mock('../services/onboardingCompetitorService', () => ({
  generateCompetitorStrategyForUser: jest.fn(async () => ({
    per_icp: [{ competitor_names: ['Acme', 'Globex'], offer_angles: ['cheaper'] }],
  })),
  mapCompetitorResultToMarketStrategy: (r: any) =>
    (r?.per_icp?.[0]?.competitor_names || []).map((n: string) => ({ name: n, description: 'desc' })),
}));

const userDb = require('../services/db').userDb;

// ── replace option: regeneration REPLACES, default still MERGES ───────────────
describe('AgentModeService.updateMarketStrategy replace option', () => {
  let svc: AgentModeService;
  beforeEach(() => {
    svc = new AgentModeService();
    jest.clearAllMocks();
  });

  const userWithMS = {
    userId: 'u1',
    email: 'u@x.com',
    marketStrategy: {
      businessOverview: 'We do X',
      competitors: [
        { name: 'Old1', description: 'd' },
        { name: 'Old2', description: 'd' },
      ],
      icp: [{ title: 'OldICP', description: 'd', valueProposition: 'v', buyerPersonas: [] }],
      createdAt: '2023-01-01T00:00:00.000Z',
      updatedAt: '2023-01-01T00:00:00.000Z',
    },
  };

  it('REPLACES competitors/icp when replace:true (drops old entries, preserves businessOverview)', async () => {
    userDb.getUserById.mockResolvedValue(userWithMS);
    userDb.updateUser.mockResolvedValue({});
    const res = await svc.updateMarketStrategy(
      {
        competitors: [{ name: 'New1', description: 'd' }],
        icp: [{ title: 'NewICP', description: 'd', valueProposition: 'v', buyerPersonas: [] }],
      },
      'u1',
      { replace: true },
    );
    expect(res.success).toBe(true);
    const written = userDb.updateUser.mock.calls[0][1].marketStrategy;
    expect(written.competitors.map((c: any) => c.name)).toEqual(['New1']); // old dropped
    expect(written.icp.map((i: any) => i.title)).toEqual(['NewICP']);
    expect(written.businessOverview).toBe('We do X'); // preserved
  });

  it('MERGES (default behavior preserved) when replace is not set', async () => {
    userDb.getUserById.mockResolvedValue(userWithMS);
    userDb.updateUser.mockResolvedValue({});
    const res = await svc.updateMarketStrategy({ competitors: [{ name: 'New1', description: 'd' }] }, 'u1');
    expect(res.success).toBe(true);
    const written = userDb.updateUser.mock.calls[0][1].marketStrategy;
    expect(written.competitors.map((c: any) => c.name).sort()).toEqual(['New1', 'Old1', 'Old2']); // merged
  });
});

// ── regenerate from brand context, replace, report counts ────────────────────
describe('AgentModeService.regenerateMarketStrategy', () => {
  let svc: AgentModeService;
  beforeEach(() => {
    svc = new AgentModeService();
    jest.clearAllMocks();
  });

  const user = {
    userId: 'u1',
    email: 'u@x.com',
    brandGuidelines: { brandData: { brandName: 'Acme', domain: 'acme.com' } },
    marketStrategy: {
      businessOverview: 'overview',
      competitors: [
        { name: 'C1', description: 'd' },
        { name: 'C2', description: 'd' },
      ],
      icp: [{ title: 'I1', description: 'd', valueProposition: 'v', buyerPersonas: [] }],
    },
  };

  it('regenerates ICPs+competitors from brand and REPLACES existing, returning replaced+generated counts', async () => {
    userDb.getUserById.mockResolvedValue(user);
    userDb.updateUser.mockResolvedValue({});
    const res = await svc.regenerateMarketStrategy('u1');
    expect(res.success).toBe(true);
    expect(res.replaced).toEqual({ competitors: 2, icps: 1 });
    expect(res.generated).toEqual({ competitors: 2, icps: 2 });
    const written = userDb.updateUser.mock.calls.at(-1)![1].marketStrategy;
    expect(written.icp.map((i: any) => i.title)).toEqual(['Growth Marketers', 'Founders']);
    expect(written.competitors.map((c: any) => c.name)).toEqual(['Acme', 'Globex']);
    expect(written.businessOverview).toBe('overview'); // preserved, not regenerated
  });

  it('returns error when user is not found', async () => {
    userDb.getUserById.mockResolvedValue(null);
    const res = await svc.regenerateMarketStrategy('missing');
    expect(res.success).toBe(false);
    expect(userDb.updateUser).not.toHaveBeenCalled();
  });

  it('returns error when there is no brand context to base the strategy on', async () => {
    userDb.getUserById.mockResolvedValue({ userId: 'u1', email: 'u@x.com' }); // no brandGuidelines
    const res = await svc.regenerateMarketStrategy('u1');
    expect(res.success).toBe(false);
    expect(userDb.updateUser).not.toHaveBeenCalled();
  });
});
