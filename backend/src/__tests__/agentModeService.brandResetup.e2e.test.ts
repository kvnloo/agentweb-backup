/**
 * ENG-44 end-to-end: broad brand re-setup refreshes brand + market strategy.
 *
 * When a user asks Emma to "re-setup the brand" from /market-strategy, the
 * market strategy cannot stay stale. Assert the deterministic tool behavior via
 * the real emmaToolRegistry against a stateful in-memory DB:
 *
 *   - Full brand re-setup -> update_brand_guidelines updates the brand AND
 *     refreshes market strategy when refreshMarketStrategy is true.
 *   - Brand-only/single-field edits remain brand-only.
 *
 * Only the LLM call is canned; brand-context extraction, mappers, persistence,
 * tool registration and registry dispatch are all real.
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

// Real module EXCEPT the LLM-backed generators (which would hit a live model).
jest.mock('../services/onboardingIcpService', () => {
  const actual = jest.requireActual('../services/onboardingIcpService');
  return {
    ...actual,
    generateIcpsForUser: jest.fn(async () => [
      { name: 'Series-A Founders', pain: 'no GTM bandwidth', desire: 'automate outbound', meta_targeting_brief: 'founders 25-45' },
      { name: 'Growth Leads', pain: 'manual campaigns', desire: 'scale content', meta_targeting_brief: 'growth marketers' },
    ]),
  };
});
jest.mock('../services/onboardingCompetitorService', () => {
  const actual = jest.requireActual('../services/onboardingCompetitorService');
  return {
    ...actual,
    generateCompetitorStrategyForUser: jest.fn(async () => ({
      per_icp: [
        { icp_id: 'Series-A Founders', competitor_names: ['RivalAI', 'CompeteCo'], offer_angles: ['faster setup', 'cheaper'] },
      ],
    })),
  };
});

import { emmaToolRegistry } from '../emma/registry';
import '../emma/tools'; // registers the real tools (incl. regenerate_market_strategy)

const ctx = { userId: 'u1', sessionId: 'sess-1' };

function seedUser() {
  mockStore.user = {
    userId: 'u1',
    email: 'founder@acme.com',
    brandGuidelines: {
      brandData: { brandName: 'Acme', tagline: 'old tagline' },
      attachments: [],
      createdAt: 't0',
      updatedAt: 't0',
    },
    marketStrategy: {
      businessOverview: 'Acme sells widgets.',
      competitors: [
        { name: 'StaleCo', description: 'old' },
        { name: 'OldRival', description: 'old' },
      ],
      icp: [{ title: 'Old ICP', description: 'old', valueProposition: 'old', buyerPersonas: [] }],
      createdAt: 't0',
      updatedAt: 't0',
    },
  };
}

describe('ENG-44 e2e: brand re-setup refreshes market strategy (real tools)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    seedUser();
  });

  it('registers the regeneration tool and exposes the one-shot brand re-setup switch', () => {
    expect(emmaToolRegistry.getTool('regenerate_market_strategy')).toBeDefined();
    const brandTool = emmaToolRegistry.getTool('update_brand_guidelines');
    expect(brandTool).toBeDefined();
    const desc = brandTool!.definition.description as string;
    expect(desc).toContain('refreshMarketStrategy');
    expect(desc).toMatch(/single-field edit/i);
    expect((brandTool!.definition as any).inputSchema.properties.refreshMarketStrategy).toBeDefined();
  });

  it('full re-setup: one update_brand_guidelines call updates brand and replaces ICPs/competitors from the new brand', async () => {
    const r = await emmaToolRegistry.execute(
      'update_brand_guidelines',
      {
        brandData: { brandName: 'Acme', tagline: 'Widgets, reinvented', toneOfVoice: 'bold', valueProposition: 'Ship faster' },
        refreshMarketStrategy: true,
      },
      ctx,
    );
    expect(r.success).toBe(true);
    expect(r.marketStrategyRefresh).toEqual({
      success: true,
      replaced: { competitors: 2, icps: 1 },
      generated: { competitors: 2, icps: 2 },
    });
    expect(mockStore.user.brandGuidelines.brandData.tagline).toBe('Widgets, reinvented');
    expect(mockStore.user.marketStrategy.competitors.map((c: any) => c.name)).toEqual(['RivalAI', 'CompeteCo']);
    expect(mockStore.user.marketStrategy.icp.map((i: any) => i.title)).toEqual(['Series-A Founders', 'Growth Leads']);
    expect(mockStore.user.marketStrategy.businessOverview).toBe('Acme sells widgets.');
  });

  it('brand-only edit: updates the brand and leaves market strategy untouched', async () => {
    const r = await emmaToolRegistry.execute(
      'update_brand_guidelines',
      { brandData: { tagline: 'Widgets, reinvented' } },
      ctx,
    );
    expect(r.success).toBe(true);
    expect(mockStore.user.brandGuidelines.brandData.tagline).toBe('Widgets, reinvented');
    expect(mockStore.user.marketStrategy.competitors.map((c: any) => c.name)).toEqual(['StaleCo', 'OldRival']);
    expect(mockStore.user.marketStrategy.icp.map((i: any) => i.title)).toEqual(['Old ICP']);
    expect(r.marketStrategyRefresh).toBeUndefined();
  });
});
