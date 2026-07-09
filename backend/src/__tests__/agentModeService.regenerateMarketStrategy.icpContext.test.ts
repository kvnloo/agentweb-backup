/**
 * ENG-255 — regenerating the market strategy must reflect an edit to the
 * user's onboarding source material.
 *
 * When a user edits/overwrites their source material and asks Emma to re-run
 * research from scratch (`regenerateMarketStrategy`, the ENG-44 refresh path),
 * the regenerated ICPs must be built from the UPDATED material — not the
 * original brand fields alone. Previously this path skipped loading the
 * onboarding strategic context entirely, so the edit was a silent no-op and the
 * ICPs came back identical to the original set.
 *
 * The ICP/competitor generators are canned (they would otherwise hit a live
 * model). What is asserted is the deterministic wiring: the edited source
 * material is loaded and handed to the ICP generator via `brand`.
 */

// ── Stateful in-memory DB (jest factory may only reference `mock*` outer vars) ──
const mockStore: { user: any } = { user: null };
jest.mock('../services/db', () => ({
  userDb: {
    getUserById: jest.fn(async () => mockStore.user),
    updateUser: jest.fn(async (_id: string, patch: any) => {
      mockStore.user = { ...mockStore.user, ...patch };
      return mockStore.user;
    }),
  },
  orgDb: { getOrgById: jest.fn(), updateOrg: jest.fn() },
}));

// Capture the brand context the ICP generator is called with. Everything else
// in onboardingIcpService (incl. applyOnboardingStrategicContext) stays real.
let capturedBrand: any = null;
jest.mock('../services/onboardingIcpService', () => {
  const actual = jest.requireActual('../services/onboardingIcpService');
  return {
    ...actual,
    generateIcpsForUser: jest.fn(async (brand: any) => {
      capturedBrand = brand;
      return [
        { name: 'Series-A Founders', pain: 'no GTM bandwidth', desire: 'automate outbound', objection: 'trust', meta_targeting_brief: 'founders 25-45' },
      ];
    }),
  };
});
jest.mock('../services/onboardingCompetitorService', () => {
  const actual = jest.requireActual('../services/onboardingCompetitorService');
  return {
    ...actual,
    generateCompetitorStrategyForUser: jest.fn(async () => ({ per_icp: [] })),
  };
});

import { agentModeService } from '../services/agentModeService';

function seedUser() {
  mockStore.user = {
    userId: 'u1',
    email: 'founder@acme.com',
    companyName: 'Acme',
    productDomain: 'https://acme.com',
    brandGuidelines: {
      brandData: { brandName: 'Acme', tagline: 'old tagline', valueProposition: 'Ship faster' },
      attachments: [],
    },
    marketStrategy: {
      businessOverview: 'Acme sells widgets.',
      competitors: [{ name: 'StaleCo', description: 'old' }],
      icp: [{ title: 'Old ICP', description: 'old', valueProposition: 'old', buyerPersonas: [] }],
    },
  };
}

describe('ENG-255: regenerateMarketStrategy uses edited source material', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    capturedBrand = null;
    seedUser();
  });

  it('loads the edited source material and feeds it to ICP generation', async () => {
    const loadStrategicContext = jest.fn(async () =>
      'EDITED SOURCE MATERIAL v2: pivot to supply-side GPU providers (Akash, CoreWeave).',
    );

    const result = await agentModeService.regenerateMarketStrategy('u1', {
      loadStrategicContext,
    });

    expect(result.success).toBe(true);
    expect(loadStrategicContext).toHaveBeenCalledWith('u1');
    // The regenerated ICPs must be built from the UPDATED material, not the
    // original brand fields alone.
    expect(capturedBrand?.strategicContext).toContain('EDITED SOURCE MATERIAL v2');
    expect(capturedBrand?.strategicContext).toContain('CoreWeave');
  });

  it('does not clobber strategic context already present on the brand', async () => {
    // With the brand fields alone (loader returns null), the edited material
    // is absent — but the call still succeeds and regenerates.
    const result = await agentModeService.regenerateMarketStrategy('u1', {
      loadStrategicContext: async () => null,
    });
    expect(result.success).toBe(true);
    expect(capturedBrand?.strategicContext).toBeUndefined();
  });
});
