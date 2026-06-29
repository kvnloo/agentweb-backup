/**
 * ENG-44 end-to-end: drive the *real* Emma tools through emmaToolRegistry.execute
 * against a stateful in-memory DB, reproducing the exact user journey that used to
 * fail silently:
 *
 *   1. User asks Emma to "re-setup the brand"  -> update_brand_guidelines (broad).
 *      BEFORE: brand updated, market strategy left silently stale, no disclosure.
 *      AFTER:  brand updated, market strategy untouched, BUT the result now carries
 *              a marketStrategyRefresh disclosure + offer (no longer silent).
 *   2. User confirms                           -> regenerate_market_strategy.
 *      Competitors + ICPs are regenerated from the NEW brand and REPLACE the old
 *      ones (business overview preserved).
 *   3. User tweaks one field                   -> update_brand_guidelines (narrow).
 *      No offer (we don't nag on small edits).
 *
 * Only the LLM call itself is canned (generateIcpsForUser / generateCompetitorStrategyForUser);
 * the brand-context extraction, the result mappers, the persistence/merge/replace
 * logic, the tool registration, and the registry dispatch are all real.
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

describe('ENG-44 e2e: brand re-setup → offer → confirm → regenerate (real tools)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    seedUser();
  });

  it('the new tools are registered on the Emma registry', () => {
    expect(emmaToolRegistry.getTool('regenerate_market_strategy')).toBeDefined();
    expect(emmaToolRegistry.getTool('update_brand_guidelines')).toBeDefined();
  });

  it('runs the full journey: re-setup discloses + leaves MS stale, confirm regenerates + replaces', async () => {
    // ── Step 1: "re-setup my brand" → broad update_brand_guidelines ───────────
    const r1 = await emmaToolRegistry.execute(
      'update_brand_guidelines',
      { brandData: { brandName: 'Acme', tagline: 'Widgets, reinvented', toneOfVoice: 'bold', valueProposition: 'Ship faster' } },
      ctx,
    );

    // Brand guideline DID change...
    expect(r1.success).toBe(true);
    expect(mockStore.user.brandGuidelines.brandData.tagline).toBe('Widgets, reinvented');

    // ...the market strategy was NOT silently changed (the old bug)...
    expect(mockStore.user.marketStrategy.competitors.map((c: any) => c.name)).toEqual(['StaleCo', 'OldRival']);
    expect(mockStore.user.marketStrategy.icp.map((i: any) => i.title)).toEqual(['Old ICP']);

    // ...but the response now DISCLOSES that and OFFERS to fix it (no longer silent).
    expect(r1.marketStrategyRefresh).toBeDefined();
    expect(r1.marketStrategyRefresh.marketStrategyChanged).toBe(false);
    expect(r1.marketStrategyRefresh.existingCompetitors).toBe(2);
    expect(r1.marketStrategyRefresh.existingIcps).toBe(1);
    expect(r1.marketStrategyRefresh.suggestedAction).toBe('regenerate_market_strategy');

    // ── Step 2: user confirms → regenerate_market_strategy ────────────────────
    const r2 = await emmaToolRegistry.execute('regenerate_market_strategy', {}, ctx);

    expect(r2.success).toBe(true);
    expect(r2.replaced).toEqual({ competitors: 2, icps: 1 });
    expect(r2.generated).toEqual({ competitors: 2, icps: 2 });

    // The stale competitors/ICPs are GONE, replaced with ones derived from the new brand.
    expect(mockStore.user.marketStrategy.competitors.map((c: any) => c.name)).toEqual(['RivalAI', 'CompeteCo']);
    expect(mockStore.user.marketStrategy.icp.map((i: any) => i.title)).toEqual(['Series-A Founders', 'Growth Leads']);
    // Business overview is preserved (not regenerated).
    expect(mockStore.user.marketStrategy.businessOverview).toBe('Acme sells widgets.');
  });

  it('does NOT offer on a single-field brand tweak (no nagging)', async () => {
    const r = await emmaToolRegistry.execute('update_brand_guidelines', { brandData: { tagline: 'just a tweak' } }, ctx);
    expect(r.success).toBe(true);
    expect(r.marketStrategyRefresh).toBeUndefined();
    // Market strategy still untouched.
    expect(mockStore.user.marketStrategy.competitors.map((c: any) => c.name)).toEqual(['StaleCo', 'OldRival']);
  });
});
