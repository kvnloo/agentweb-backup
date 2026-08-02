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
    }
  };
});

jest.mock('../services/db', () => ({
  userDb: { getUserById: jest.fn() }
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
 *
 * Two defects, both invisible after the fact because nothing reads the entity back:
 *
 *  A. `agentModeService.createMetaAdsAdSet` resolves bid strategy as
 *     `args.bid_strategy || 'LOWEST_COST_WITHOUT_CAP'`, and the model-facing
 *     AD_SET CREATE contract in `emma/tools.ts` never lists bid_strategy as
 *     writable on create. So the model omits it and the silent default lands.
 *
 *  B. Dayparting has no representation anywhere in the backend. A caller asking
 *     for scheduled delivery is ignored and the ad set ships 24/7.
 *
 * Real-world cost: Open Future Forum spent $1,000 for 2 sign-ups because ads
 * ran at inefficient times (2026-07-29 sync, fathom 765808581).
 */
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

describe('ENG-838 — ad set bid strategy and dayparting must not silently default', () => {
  let service: AgentModeService;

  const baseAdSetParams = {
    name: 'Ad Set',
    campaign_id: 'camp_123',
    billing_event: 'IMPRESSIONS',
    optimization_goal: 'LINK_CLICKS',
    daily_budget: 10,
    targeting: { geo_locations: { countries: ['US'] } }
  };

  beforeEach(() => {
    service = new AgentModeService();
    jest.clearAllMocks();
    (userDb.getUserById as jest.Mock).mockResolvedValue(mockUser);
    (metaService.getCampaign as jest.Mock).mockResolvedValue({
      id: 'camp_123',
      objective: 'OUTCOME_TRAFFIC'
    });
    (metaService.createAdSet as jest.Mock).mockResolvedValue({ id: 'adset_new', name: 'Ad Set' });
  });

  describe('B — dayparting fails loud instead of shipping a 24/7 ad set', () => {
    it('rejects an adset_schedule request and does not create the ad set', async () => {
      const result = await service.createMetaAdsAdSet('user123', {
        ...baseAdSetParams,
        adset_schedule: [{ start_minute: 540, end_minute: 1020, days: [1, 2, 3, 4, 5] }]
      });

      expect(result.success).toBe(false);
      expect(String(result.error)).toMatch(/dayparting|adset_schedule/i);
      expect(String(result.error)).toMatch(/not supported/i);
      // The critical assertion: nothing reached Meta. A silently-24/7 ad set is
      // worse than no ad set, because it spends money against a schedule the
      // caller did not choose.
      expect(metaService.createAdSet).not.toHaveBeenCalled();
    });

    it('rejects a pacing_type day_parting request and does not create the ad set', async () => {
      const result = await service.createMetaAdsAdSet('user123', {
        ...baseAdSetParams,
        pacing_type: ['day_parting']
      });

      expect(result.success).toBe(false);
      expect(String(result.error)).toMatch(/dayparting|pacing_type/i);
      expect(metaService.createAdSet).not.toHaveBeenCalled();
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
        path.join(__dirname, '..', 'emma', 'tools.ts'),
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
      // And it must know dayparting will be rejected rather than quietly dropped.
      expect(block).toMatch(/adset_schedule|dayparting/i);
    });
  });
});
