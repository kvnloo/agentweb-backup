import fs from 'fs';
import path from 'path';

jest.mock('../mcp/client/mcpClientService', () => ({
  McpClientService: jest.fn().mockImplementation(() => ({
    isReady: jest.fn().mockReturnValue(true)
  }))
}));

jest.mock('../services/metaService', () => {
  const actual = jest.requireActual('../services/metaService');
  return {
    ...actual,
    metaService: {
      getCampaign: jest.fn(),
      createAdSet: jest.fn(),
      getAdSet: jest.fn(),
      // ENG-2277: createMetaAdsAdSet reads the ad account's currency to normalise money.
      getAdAccountCurrency: jest.fn().mockResolvedValue('USD'),
      // createMetaAdsAdSet's pre-flight token-freshness check
      // (ensureFreshMetaAdAccountToken) calls this before every ad-set
      // operation; without a mock it throws "not a function" on any
      // fixture whose token looks like it needs a refresh.
      extendAccessToken: jest.fn().mockResolvedValue({
        access_token: 'mock-refreshed-token',
        expires_in: 5184000
      })
    }
  };
});

jest.mock('../services/db', () => ({
  // getUserByIdConsistent: same token-refresh pre-flight
  // (ensureFreshMetaAdAccountToken) that needs metaService.extendAccessToken
  // mocked above also reads the user consistently to persist a refreshed
  // token; without it the refresh warns and no-ops rather than throwing, but
  // an unmocked call still logs a misleading "Failed to refresh token" line.
  userDb: { getUserById: jest.fn(), getUserByIdConsistent: jest.fn(), updateUser: jest.fn() }
}));

jest.mock('../utils/secretsManager', () => ({
  getMetaAccessToken: jest.fn().mockResolvedValue('mock-access-token')
}));

jest.mock('../services/chatbotService', () => ({
  chatbotDb: {
    getMessagesFromMessagesTable: jest.fn().mockResolvedValue([]),
    getChatSession: jest.fn().mockResolvedValue(null),
    updateSessionAskUserQuestion: jest.fn().mockResolvedValue({}),
    createChatSession: jest.fn().mockResolvedValue({ sessionId: 'auto-created-session' }),
  }
}));

import { AgentModeService } from '../services/agentModeService';
import { metaService } from '../services/metaService';
import { userDb } from '../services/db';

/**
 * ENG-838 — ad deployment silently applies platform defaults.
 * ENG-842 — dayparting (adset_schedule/pacing_type) implemented with the
 *           lifetime-budget rule, replacing the #2244 fail-loud guard.
 *
 * Two defects, both invisible after the fact because nothing reads the entity back:
 *
 *  A. `agentModeService.createMetaAdsAdSet` resolves bid strategy as
 *     `args.bid_strategy || 'LOWEST_COST_WITHOUT_CAP'`, and the model-facing
 *     AD_SET CREATE contract in `emma/metaTools.ts` never lists bid_strategy as
 *     writable on create. So the model omits it and the silent default lands.
 *
 *  B. Dayparting has no representation anywhere in the backend. A caller asking
 *     for scheduled delivery is ignored and the ad set ships 24/7.
 *
 * Real-world cost: Open Future Forum spent $1,000 for 2 sign-ups because ads
 * ran at inefficient times (2026-07-29 sync, fathom 765808581).
 */
// Lifetime-budget ad sets must run at least 24h (createMetaAdsAdSet's own
// enforcement, below) — a fixed calendar date expires as wall-clock time
// closes in on it. Computed relative to "now" so this suite never time-bombs.
const FUTURE_END_TIME = new Date(Date.now() + 72 * 60 * 60 * 1000).toISOString();

const mockUser = {
  id: 'user123',
  connected_accounts: [
    {
      platform: 'meta',
      account_id: '123456789',
      account_name: 'Test Business',
      config: {
        account_type: 'ad_account',
        access_token: 'mock-access-token',
        ad_account_id: '123456789'
      }
    }
  ]
};

describe('ENG-838/ENG-842 — ad set bid strategy and dayparting must not silently default', () => {
  let service: AgentModeService;

  const baseAdSetParams = {
    name: 'Ad Set',
    campaign_id: 'camp_123',
    billing_event: 'IMPRESSIONS',
    optimization_goal: 'LINK_CLICKS',
    daily_budget: 10,
    targeting: { geo_locations: { countries: ['US'] } }
  };

  // Dayparting requires a lifetime budget (no daily_budget) plus end_time.
  // end_time must stay >24h ahead of whatever "now" is when the test runs
  // (createMetaAdsAdSet defaults start_time to `new Date()` when unset, and
  // enforces a 24h minimum lifetime-budget duration) — a fixed calendar date
  // eventually stops being far enough in the future and the test starts
  // failing for a reason that has nothing to do with the behavior under test.
  const daypartingAdSetParams = {
    name: 'Ad Set',
    campaign_id: 'camp_123',
    billing_event: 'IMPRESSIONS',
    optimization_goal: 'LINK_CLICKS',
    lifetime_budget: 500,
    end_time: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
    targeting: { geo_locations: { countries: ['US'] } }
  };

  beforeEach(() => {
    service = new AgentModeService();
    jest.clearAllMocks();
    (userDb.getUserById as jest.Mock).mockResolvedValue(mockUser);
    (userDb.getUserByIdConsistent as jest.Mock).mockResolvedValue(mockUser);
    (metaService.getCampaign as jest.Mock).mockResolvedValue({
      id: 'camp_123',
      objective: 'OUTCOME_TRAFFIC'
    });
    (metaService.createAdSet as jest.Mock).mockResolvedValue({ id: 'adset_new', name: 'Ad Set' });
    (metaService.getAdSet as jest.Mock).mockResolvedValue({ id: 'adset_new', name: 'Ad Set' });
  });

  describe('B — dayparting requires a lifetime budget, and is rejected without one', () => {
    it('rejects adset_schedule combined with daily_budget and does not create the ad set', async () => {
      const result = await service.createMetaAdsAdSet('user123', {
        ...baseAdSetParams,
        adset_schedule: [{ start_minute: 540, end_minute: 1020, days: [1, 2, 3, 4, 5] }]
      });

      expect(result.success).toBe(false);
      expect(String(result.error)).toMatch(/dayparting|adset_schedule/i);
      expect(String(result.error)).toMatch(/lifetime_budget/i);
      // The critical assertion: nothing reached Meta. A silently-24/7 ad set is
      // worse than no ad set, because it spends money against a schedule the
      // caller did not choose.
      expect(metaService.createAdSet).not.toHaveBeenCalled();
    });

    it('rejects adset_schedule with no budget at all', async () => {
      const { daily_budget, ...noBudget } = baseAdSetParams as any;
      const result = await service.createMetaAdsAdSet('user123', {
        ...noBudget,
        adset_schedule: [{ start_minute: 540, end_minute: 1020, days: [1, 2, 3, 4, 5] }]
      });

      expect(result.success).toBe(false);
      expect(String(result.error)).toMatch(/lifetime_budget/i);
      expect(metaService.createAdSet).not.toHaveBeenCalled();
    });

    it('rejects a pacing_type day_parting request combined with daily_budget', async () => {
      const result = await service.createMetaAdsAdSet('user123', {
        ...baseAdSetParams,
        pacing_type: ['day_parting']
      });

      expect(result.success).toBe(false);
      expect(String(result.error)).toMatch(/dayparting|pacing_type|lifetime_budget/i);
      expect(metaService.createAdSet).not.toHaveBeenCalled();
    });

    it('rejects adset_schedule with a lifetime_budget but no end_time', async () => {
      const result = await service.createMetaAdsAdSet('user123', {
        ...baseAdSetParams,
        daily_budget: undefined,
        lifetime_budget: 500,
        adset_schedule: [{ start_minute: 540, end_minute: 1020, days: [1, 2, 3, 4, 5] }]
      });

      expect(result.success).toBe(false);
      expect(String(result.error)).toMatch(/end_time/i);
      expect(metaService.createAdSet).not.toHaveBeenCalled();
    });

    it('still rejects an invalid daily-budget dayparting request when the account is connected', async () => {
      // Superseded by the CBO fix below (CodeRabbit finding on PR #2755): the
      // lifetime-vs-daily rejection can no longer run before credential
      // resolution, because under Advantage Campaign Budget (CBO) the
      // ad-set-level args are irrelevant and the real answer depends on the
      // CAMPAIGN's budget, which is only knowable after fetching the campaign
      // (which itself requires credentials). A dummy lifetime_budget on a CBO
      // ad set backed by a real daily-budget campaign must still be rejected —
      // see the CBO describe block below — this case just confirms the
      // ordinary (non-CBO) rejection is unchanged when credentials resolve fine.
      const result = await service.createMetaAdsAdSet('user123', {
        ...baseAdSetParams,
        adset_schedule: [{ start_minute: 540, end_minute: 1020, days: [1, 2, 3, 4, 5] }]
      });

      expect(result.success).toBe(false);
      expect(String(result.error)).toMatch(/lifetime_budget/i);
      expect(metaService.createAdSet).not.toHaveBeenCalled();
    });
  });

  describe('B — dayparting under Advantage Campaign Budget (CBO) validates the CAMPAIGN budget, not the ad set args (CodeRabbit finding, PR #2755)', () => {
    it('rejects dayparting on a CBO campaign whose own budget is a daily_budget, even with a dummy ad-set lifetime_budget', async () => {
      (metaService.getCampaign as jest.Mock).mockResolvedValue({
        id: 'camp_123',
        objective: 'OUTCOME_TRAFFIC',
        daily_budget: 5000
      });

      const result = await service.createMetaAdsAdSet('user123', {
        ...baseAdSetParams,
        daily_budget: undefined,
        lifetime_budget: 500, // dummy — irrelevant under CBO, stripped before send
        end_time: FUTURE_END_TIME,
        adset_schedule: [{ start_minute: 540, end_minute: 1020, days: [1, 2, 3, 4, 5] }]
      });

      // Before this fix this reached Meta with the schedule silently ignored
      // (24/7 delivery against a daily-budget campaign) — exactly the ENG-838
      // failure mode through the CBO path.
      expect(result.success).toBe(false);
      expect(String(result.error)).toMatch(/lifetime_budget/i);
      expect(metaService.createAdSet).not.toHaveBeenCalled();
    });

    it('accepts dayparting on a CBO campaign whose own budget is a lifetime_budget', async () => {
      (metaService.getCampaign as jest.Mock).mockResolvedValue({
        id: 'camp_123',
        objective: 'OUTCOME_TRAFFIC',
        lifetime_budget: 5000
      });

      const result = await service.createMetaAdsAdSet('user123', {
        ...baseAdSetParams,
        daily_budget: undefined,
        end_time: FUTURE_END_TIME,
        adset_schedule: [{ start_minute: 540, end_minute: 1020, days: [1, 2, 3, 4, 5] }]
      });

      expect(result.success).toBe(true);
      expect(metaService.createAdSet).toHaveBeenCalled();
      const calledWith = (metaService.createAdSet as jest.Mock).mock.calls[0][2];
      // CBO strips ad-set-level budget regardless.
      expect(calledWith.daily_budget).toBeUndefined();
      expect(calledWith.lifetime_budget).toBeUndefined();
      expect(calledWith.adset_schedule).toEqual([
        { start_minute: 540, end_minute: 1020, days: [1, 2, 3, 4, 5] }
      ]);
      expect(calledWith.pacing_type).toEqual(['day_parting']);
    });
  });

  describe('B — a valid dayparting request (lifetime budget + end_time) creates the ad set', () => {
    it('sends adset_schedule and auto-sets pacing_type to day_parting', async () => {
      const result = await service.createMetaAdsAdSet('user123', {
        ...daypartingAdSetParams,
        adset_schedule: [{ start_minute: 540, end_minute: 1020, days: [1, 2, 3, 4, 5] }]
      });

      expect(result.success).toBe(true);
      expect(metaService.createAdSet).toHaveBeenCalled();
      const calledWith = (metaService.createAdSet as jest.Mock).mock.calls[0][2];
      expect(calledWith.adset_schedule).toEqual([
        { start_minute: 540, end_minute: 1020, days: [1, 2, 3, 4, 5] }
      ]);
      expect(calledWith.pacing_type).toEqual(['day_parting']);
    });

    it('honours an explicitly provided pacing_type instead of overriding it', async () => {
      const result = await service.createMetaAdsAdSet('user123', {
        ...daypartingAdSetParams,
        adset_schedule: [{ start_minute: 540, end_minute: 1020, days: [1, 2, 3, 4, 5] }],
        pacing_type: ['day_parting', 'no_pacing']
      });

      expect(result.success).toBe(true);
      const calledWith = (metaService.createAdSet as jest.Mock).mock.calls[0][2];
      expect(calledWith.pacing_type).toEqual(['day_parting', 'no_pacing']);
    });
  });

  describe('A — an ad set with no schedule behaves exactly as today', () => {
    it('sends no schedule field and leaves pacing_type unset', async () => {
      const result = await service.createMetaAdsAdSet('user123', { ...baseAdSetParams });

      expect(result.success).toBe(true);
      const calledWith = (metaService.createAdSet as jest.Mock).mock.calls[0][2];
      expect(calledWith.adset_schedule).toBeUndefined();
      expect(calledWith.pacing_type).toBeUndefined();
    });
  });

  describe('A — the applied bid strategy is surfaced, not silent', () => {
    it('reports the applied bid strategy when the caller did not choose one', async () => {
      const result = await service.createMetaAdsAdSet('user123', { ...baseAdSetParams });

      expect(result.success).toBe(true);
      expect(metaService.createAdSet).toHaveBeenCalled();
      // The default still applies (changing it would break existing callers),
      // but it must be visible in the result so a wrong strategy is detectable
      // rather than silent. ENG-838 AC 4.
      expect(result.appliedBidStrategy).toBe('LOWEST_COST_WITHOUT_CAP');
      expect(result.bidStrategyWasDefaulted).toBe(true);
    });

    it('honours an explicitly chosen bid strategy (control — passes before the fix)', async () => {
      const result = await service.createMetaAdsAdSet('user123', {
        ...baseAdSetParams,
        bid_strategy: 'COST_CAP',
        bid_amount: 5
      });

      expect(result.success).toBe(true);
      const calledWith = (metaService.createAdSet as jest.Mock).mock.calls[0][2];
      expect(calledWith.bid_strategy).toBe('COST_CAP');
      expect(calledWith.bid_amount).toBe(500); // dollars converted to cents
    });
  });

  describe('A — the model-facing contract lists every field the handler accepts', () => {
    it('documents bid_strategy on AD_SET CREATE so the model knows it is writable', () => {
      const toolsSrc = fs.readFileSync(
        // The Meta tool definitions moved out of emma/tools.ts into emma/metaTools.ts (ENG-2282).
        path.join(__dirname, '..', 'emma', 'metaTools.ts'),
        'utf8'
      );
      const lines = toolsSrc.split('\n');
      const startIdx = lines.findIndex(l => l.includes('AD_SET CREATE:'));
      expect(startIdx).toBeGreaterThan(-1);

      // The AD_SET CREATE entry runs until the next "<ENTITY> <ACTION>:" heading.
      const endIdx = lines.findIndex(
        (l, i) => i > startIdx && /^\s{2}[A-Z_]+ [A-Z_]+:/.test(l)
      );
      const block = lines.slice(startIdx, endIdx > -1 ? endIdx : startIdx + 8).join('\n');

      // Without this, the model is taught bid_strategy is a read-only LIST field
      // and never sets it, which is precisely how the silent default lands.
      expect(block).toMatch(/bid_strategy/);
      expect(block).toMatch(/bid_amount/);
      // And it must know dayparting requires a lifetime budget, not that it's unsupported.
      expect(block).toMatch(/adset_schedule/i);
      expect(block).toMatch(/lifetime_budget/i);
      expect(block).not.toMatch(/NOT SUPPORTED/i);
    });
  });
});
