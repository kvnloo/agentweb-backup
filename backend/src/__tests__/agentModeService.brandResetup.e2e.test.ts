/**
 * ENG-44 end-to-end (Design 2 — ask scope up front, then act).
 *
 * Per Fangfang's chosen design, when a user asks to "re-setup the brand" Emma
 * FIRST asks what to update — (1) brand only, or (2) also re-do positioning
 * (value prop / ICPs / competitors, which REPLACES the current ones) — then acts.
 * The up-front question itself is conversational (driven by the tool-description
 * instruction asserted below); it is not unit-testable. What IS asserted here, via
 * the real emmaToolRegistry against a stateful in-memory DB, is the deterministic
 * behaviour of the two branches:
 *
 *   Option 1 (brand only) -> update_brand_guidelines updates the brand and leaves
 *     the market strategy untouched (and carries no auto "offer" — the offer is
 *     front-loaded, so there is no back-loaded hint to double-ask).
 *   Option 2 (also positioning) -> update_brand_guidelines THEN
 *     regenerate_market_strategy regenerates ICPs+competitors from the NEW brand
 *     and REPLACES the stale ones (business overview preserved).
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

describe('ENG-44 e2e (Design 2): ask scope up front, then act (real tools)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    seedUser();
  });

  it('registers the new tool and wires the up-front scope question into the brand tool', () => {
    expect(emmaToolRegistry.getTool('regenerate_market_strategy')).toBeDefined();
    const brandTool = emmaToolRegistry.getTool('update_brand_guidelines');
    expect(brandTool).toBeDefined();
    // The front-loaded "ask first" instruction must be present (it is what drives
    // Design 2 — Emma asking scope before editing). Conversational, so this guards
    // that the instruction is wired even though the LLM behaviour itself isn't unit-testable.
    const desc = brandTool!.definition.description as string;
    expect(desc).toMatch(/FIRST ask/i);
    expect(desc).toContain('regenerate_market_strategy');
    expect(desc).toMatch(/single-field edit/i);
  });

  it('OPTION 1 (brand only): updates the brand, leaves market strategy untouched, no back-loaded offer', async () => {
    const r = await emmaToolRegistry.execute(
      'update_brand_guidelines',
      { brandData: { brandName: 'Acme', tagline: 'Widgets, reinvented', toneOfVoice: 'bold', valueProposition: 'Ship faster' } },
      ctx,
    );
    expect(r.success).toBe(true);
    expect(mockStore.user.brandGuidelines.brandData.tagline).toBe('Widgets, reinvented');
    // Market strategy untouched...
    expect(mockStore.user.marketStrategy.competitors.map((c: any) => c.name)).toEqual(['StaleCo', 'OldRival']);
    expect(mockStore.user.marketStrategy.icp.map((i: any) => i.title)).toEqual(['Old ICP']);
    // ...and NO auto/back-loaded offer rides on the result (the offer is front-loaded).
    expect(r.marketStrategyRefresh).toBeUndefined();
  });

  it('OPTION 2 (also positioning): brand update + regenerate replaces ICPs/competitors from the new brand', async () => {
    // User chose option 2 → Emma updates brand, then calls regenerate_market_strategy.
    await emmaToolRegistry.execute(
      'update_brand_guidelines',
      { brandData: { brandName: 'Acme', tagline: 'Widgets, reinvented', toneOfVoice: 'bold', valueProposition: 'Ship faster' } },
      ctx,
    );
    const r2 = await emmaToolRegistry.execute('regenerate_market_strategy', {}, ctx);

    expect(r2.success).toBe(true);
    expect(r2.replaced).toEqual({ competitors: 2, icps: 1 });
    expect(r2.generated).toEqual({ competitors: 2, icps: 2 });

    // Stale competitors/ICPs are GONE, replaced with ones derived from the new brand.
    expect(mockStore.user.marketStrategy.competitors.map((c: any) => c.name)).toEqual(['RivalAI', 'CompeteCo']);
    expect(mockStore.user.marketStrategy.icp.map((i: any) => i.title)).toEqual(['Series-A Founders', 'Growth Leads']);
    // Business overview is preserved (not regenerated).
    expect(mockStore.user.marketStrategy.businessOverview).toBe('Acme sells widgets.');
  });
});
