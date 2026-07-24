// Mock MCP client service first
jest.mock('../mcp/client/mcpClientService', () => ({
  McpClientService: jest.fn().mockImplementation(() => ({
    isReady: jest.fn().mockReturnValue(true)
  }))
}));

// Keep MetaService (real class with static validators) while mocking the singleton
jest.mock('../services/metaService', () => {
  const actual = jest.requireActual('../services/metaService');
  return {
    ...actual,
    metaService: {
      createCampaign: jest.fn(),
      updateCampaign: jest.fn(),
      deleteCampaign: jest.fn(),
      listCampaigns: jest.fn(),
      createAdSet: jest.fn(),
      updateAdSet: jest.fn(),
      deleteAdSet: jest.fn(),
      listAdSets: jest.fn(),
      getCampaign: jest.fn(),
      getAdSet: jest.fn(),
      getAd: jest.fn(),
      createAdCreative: jest.fn(),
      listAdCreatives: jest.fn(),
      createAd: jest.fn(),
      updateAd: jest.fn(),
      deleteAd: jest.fn(),
      listAds: jest.fn(),
      listCustomAudiences: jest.fn(),
      createCustomAudience: jest.fn(),
      uploadCustomAudienceUsers: jest.fn(),
      searchTargeting: jest.fn(),
      listPages: jest.fn()
    }
  };
});

jest.mock('../services/db', () => ({
  userDb: {
    getUserById: jest.fn()
  }
}));

jest.mock('../utils/secretsManager', () => ({
  getMetaAccessToken: jest.fn().mockResolvedValue('mock-access-token')
}));

// ENG-400: the CAMPAIGN CREATE objective gate reads the session's last user
// message (to verify an explicit-statement bypass) and pending/answered
// questions. Default to "no session context" so every pre-existing test here
// that doesn't care about the objective gate is unaffected; the one test that
// exercises a real CAMPAIGN CREATE dispatch overrides these explicitly.
jest.mock('../services/chatbotService', () => ({
  chatbotDb: {
    getMessagesFromMessagesTable: jest.fn().mockResolvedValue([]),
    getChatSession: jest.fn().mockResolvedValue(null),
    updateSessionAskUserQuestion: jest.fn().mockResolvedValue({}),
    createChatSession: jest.fn().mockResolvedValue({ sessionId: 'auto-created-session' }),
  },
}));

import { AgentModeService } from '../services/agentModeService';
import { metaService } from '../services/metaService';
import { userDb } from '../services/db';
import { chatbotDb } from '../services/chatbotService';

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

// signature: callMetaMarketingApi(userId, entity_type, action, account_id, campaign_id?, ad_set_id?, ad_id?, params, sessionId?)
const callApi = (
  service: AgentModeService,
  entity_type: string,
  action: string,
  opts: { campaign_id?: string; ad_set_id?: string; ad_id?: string; params?: any; sessionId?: string } = {}
) =>
  (service as any).callMetaMarketingApi(
    'user123',
    entity_type,
    action,
    '123456789',
    opts.campaign_id,
    opts.ad_set_id,
    opts.ad_id,
    opts.params ?? {},
    opts.sessionId
  );

describe('AgentModeService - Meta validation & error enrichment', () => {
  let service: AgentModeService;

  beforeEach(() => {
    service = new AgentModeService();
    jest.clearAllMocks();
    (userDb.getUserById as jest.Mock).mockResolvedValue(mockUser);
  });

  // ==================== Pre-validation via callMetaMarketingApi ====================
  describe('callMetaMarketingApi pre-validation', () => {
    it('returns PARAM_VALIDATION_ERROR for CAMPAIGN CREATE with missing name (objective already settled via the gate)', async () => {
      // ENG-400: the objective gate runs BEFORE param validation (a model that
      // correctly omits an unknown objective must hit the real ask card, not a
      // generic validation error — see the sibling gate test file). So this test
      // settles the objective first (a verified explicit statement) to isolate
      // the missing-name validation path specifically.
      (chatbotDb.getMessagesFromMessagesTable as jest.Mock).mockResolvedValue([
        { role: 'user', content: 'set up a traffic campaign' },
      ]);
      const result = await callApi(service, 'CAMPAIGN', 'CREATE', {
        sessionId: 'session-1',
        params: { objective: 'OUTCOME_TRAFFIC', objective_quote: 'traffic campaign' }, // missing name
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe('PARAM_VALIDATION_ERROR');
      expect(result.message).toContain('"name"');
      expect(metaService.createCampaign).not.toHaveBeenCalled();
    });

    it('an invalid objective value with nothing settled surfaces the real ask card, not a validation error', async () => {
      // ENG-400 reorder: the objective gate now runs first and ALWAYS resolves
      // to a valid objective (or blocks/asks) before validateMetaActionParams
      // ever sees the field — so a garbage objective value can no longer reach
      // the "Invalid objective" validation branch for CAMPAIGN CREATE; it's
      // subsumed by the same ask-card path as an omitted one.
      const result = await callApi(service, 'CAMPAIGN', 'CREATE', {
        sessionId: 'session-1',
        params: { name: 'My Campaign', objective: 'INVALID_OBJ' },
      });

      expect(result.success).toBe(true);
      expect(result.awaitingUserConfirmation).toBe(true);
      expect(result.type).toBe('ask_user_question');
      expect(metaService.createCampaign).not.toHaveBeenCalled();
    });

    it('returns PARAM_VALIDATION_ERROR for CAMPAIGN UPDATE without campaign_id', async () => {
      const result = await callApi(service, 'CAMPAIGN', 'UPDATE', {
        // campaign_id intentionally omitted
        params: { name: 'Updated' }
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe('PARAM_VALIDATION_ERROR');
      expect(result.message).toContain('campaign_id');
    });

    it('returns PARAM_VALIDATION_ERROR for CAMPAIGN DELETE without campaign_id', async () => {
      const result = await callApi(service, 'CAMPAIGN', 'DELETE', {});

      expect(result.success).toBe(false);
      expect(result.error).toBe('PARAM_VALIDATION_ERROR');
      expect(result.message).toContain('campaign_id');
    });

    it('returns PARAM_VALIDATION_ERROR for AD_SET CREATE without campaign_id', async () => {
      const result = await callApi(service, 'AD_SET', 'CREATE', {
        // campaign_id intentionally omitted
        params: { name: 'Ad Set' }
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe('PARAM_VALIDATION_ERROR');
      expect(result.message).toContain('campaign_id');
    });

    it('returns PARAM_VALIDATION_ERROR for AD_SET UPDATE without ad_set_id', async () => {
      const result = await callApi(service, 'AD_SET', 'UPDATE', {
        campaign_id: 'camp_123'
        // ad_set_id intentionally omitted
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe('PARAM_VALIDATION_ERROR');
      expect(result.message).toContain('ad_set_id');
    });

    it('returns PARAM_VALIDATION_ERROR for AD UPDATE without ad_id', async () => {
      const result = await callApi(service, 'AD', 'UPDATE', {
        // ad_id intentionally omitted
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe('PARAM_VALIDATION_ERROR');
      expect(result.message).toContain('ad_id');
    });

    it('returns PARAM_VALIDATION_ERROR for TARGETING SEARCH without q', async () => {
      const result = await callApi(service, 'TARGETING', 'SEARCH', {
        params: { type: 'adinterest' } // missing q
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe('PARAM_VALIDATION_ERROR');
      expect(result.message).toContain('"params.q"');
    });

    it('returns PARAM_VALIDATION_ERROR for TARGETING SEARCH without type', async () => {
      const result = await callApi(service, 'TARGETING', 'SEARCH', {
        params: { q: 'marketing' } // missing type
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe('PARAM_VALIDATION_ERROR');
      expect(result.message).toContain('"params.type"');
    });

    it('passes validation and proceeds to API for valid CAMPAIGN CREATE', async () => {
      (metaService.createCampaign as jest.Mock).mockResolvedValue({ id: 'camp_123', name: 'Test' });
      // ENG-400: the objective gate requires either a verified explicit-statement
      // quote or an answered ask_user_question. Here the user's own message names
      // the objective, so objective_quote (checked against the real transcript)
      // satisfies the gate with zero added friction.
      (chatbotDb.getMessagesFromMessagesTable as jest.Mock).mockResolvedValue([
        { role: 'user', content: 'Please set up a traffic campaign for me.' },
      ]);

      // confirm=true bypasses the target-confirmation gate so the action executes.
      const result = await callApi(service, 'CAMPAIGN', 'CREATE', {
        sessionId: 'session-1',
        params: {
          name: 'Test',
          objective: 'OUTCOME_TRAFFIC',
          objective_quote: 'traffic campaign',
          special_ad_categories: ['NONE'],
          confirm: true,
        },
      });

      expect(result.success).toBe(true);
      expect(metaService.createCampaign).toHaveBeenCalled();
    });

    it('auto-provisions a session and PARKS (does not dead-end) a valid CAMPAIGN CREATE with no session', async () => {
      const result = await callApi(service, 'CAMPAIGN', 'CREATE', {
        params: { name: 'Test', objective: 'OUTCOME_TRAFFIC', special_ad_categories: ['NONE'], confirm: true }
        // no sessionId — an anomaly for both known callers, but must still be
        // recoverable (a normal park) rather than a hard dead-end.
      });

      expect(chatbotDb.createChatSession).toHaveBeenCalled();
      expect(result.success).toBe(true);
      expect(result.awaitingUserConfirmation).toBe(true);
      expect(result.type).toBe('ask_user_question');
      expect(result.sessionId).toBe('auto-created-session');
      expect(metaService.createCampaign).not.toHaveBeenCalled();
    });

    it('BLOCKS and emits the objective ask_user_question when neither an explicit quote nor a prior answer exists', async () => {
      const result = await callApi(service, 'CAMPAIGN', 'CREATE', {
        sessionId: 'session-1',
        params: { name: 'Test', objective: 'OUTCOME_TRAFFIC', special_ad_categories: ['NONE'], confirm: true },
      });

      expect(result.success).toBe(true); // halting-card responses use success:true (see ask_user_question tool)
      expect(result.awaitingUserConfirmation).toBe(true);
      expect(result.type).toBe('ask_user_question');
      expect(result.recommendedOptionId).toBe('leads'); // OUTCOME_LEADS default, no account preference set
      expect(metaService.createCampaign).not.toHaveBeenCalled();
      expect(chatbotDb.updateSessionAskUserQuestion).toHaveBeenCalled();
    });

    it('ALLOWS a CAMPAIGN CREATE whose objective was already answered via ask_user_question (kind meta_objective)', async () => {
      (chatbotDb.getChatSession as jest.Mock).mockResolvedValue({
        sessionId: 'session-1',
        pendingUserQuestion: {
          questionId: 'q-1',
          question: 'Which objective?',
          options: [{ id: 'sales', label: 'Sales', consequence: 'x', recommended: true, why: 'y', payload: { objective: 'OUTCOME_SALES' } }],
          recommendedOptionId: 'sales',
          immutable: true,
          allowEmmaDecide: true,
          kind: 'meta_objective',
          status: 'answered',
          createdAt: '2026-07-24T00:00:00.000Z',
          answer: { optionId: 'sales', delegated: false, answeredBy: 'user', at: '2026-07-24T00:01:00.000Z' },
        },
      });
      (metaService.createCampaign as jest.Mock).mockResolvedValue({ id: 'camp_456', name: 'Test' });

      const result = await callApi(service, 'CAMPAIGN', 'CREATE', {
        sessionId: 'session-1',
        // Model's own params.objective is deliberately WRONG here — the gate must
        // apply the gate-resolved objective verbatim, never trust params.objective.
        params: { name: 'Test', objective: 'OUTCOME_TRAFFIC', special_ad_categories: ['NONE'], confirm: true },
      });

      expect(result.success).toBe(true);
      expect(metaService.createCampaign).toHaveBeenCalled();
      const passedParams = (metaService.createCampaign as jest.Mock).mock.calls[0][2];
      expect(passedParams.objective).toBe('OUTCOME_SALES');
    });
  });

  // ==================== Target-confirmation guardrail ====================
  describe('callMetaMarketingApi target-confirmation gate', () => {
    beforeEach(() => {
      (userDb.getUserById as jest.Mock).mockResolvedValue(mockUser);
    });

    it('blocks AD CREATE without confirm and returns the resolved campaign/ad set target', async () => {
      (metaService.getAdSet as jest.Mock).mockResolvedValue({ id: 'adset_1', name: 'Maintenance Ad Set', campaign_id: 'camp_maint' });
      (metaService.getCampaign as jest.Mock).mockResolvedValue({ id: 'camp_maint', name: 'Maintenance Campaign', objective: 'OUTCOME_TRAFFIC' });

      const result = await callApi(service, 'AD', 'CREATE', {
        ad_set_id: 'adset_1',
        params: { name: 'New Maintenance Ad', creative_id: 'creative_1' }
      });

      expect(result.requiresConfirmation).toBe(true);
      expect(metaService.createAd).not.toHaveBeenCalled();
      // The resolved target must name the ad set AND the campaign it belongs to.
      expect(result.message).toContain('Maintenance Ad Set');
      expect(result.message).toContain('Maintenance Campaign');
      expect(result.target.campaign).toContain('Maintenance Campaign');
      expect(result.target.ad_set).toContain('Maintenance Ad Set');
    });

    it('executes AD CREATE when confirm=true and strips the flag before dispatch', async () => {
      (metaService.createAd as jest.Mock).mockResolvedValue({ id: 'ad_new', name: 'New Maintenance Ad' });

      const result = await callApi(service, 'AD', 'CREATE', {
        ad_set_id: 'adset_1',
        params: { name: 'New Maintenance Ad', creative_id: 'creative_1', confirm: true }
      });

      expect(result.success).toBe(true);
      expect(result.requiresConfirmation).toBeUndefined();
      expect(metaService.createAd).toHaveBeenCalledTimes(1);
      // confirm must never leak into the params passed to metaService.
      const paramsArg = (metaService.createAd as jest.Mock).mock.calls[0][2];
      expect(paramsArg.confirm).toBeUndefined();
    });

    it('blocks a VALID AD UPDATE without confirm and does not call metaService.updateAd', async () => {
      (metaService.getAd as jest.Mock).mockResolvedValue({ id: 'ad_1', name: 'Spring Promo', adset_id: 'adset_1', campaign_id: 'camp_maint' });
      (metaService.getAdSet as jest.Mock).mockResolvedValue({ id: 'adset_1', name: 'Maintenance Ad Set', campaign_id: 'camp_maint' });
      (metaService.getCampaign as jest.Mock).mockResolvedValue({ id: 'camp_maint', name: 'Maintenance Campaign' });

      const result = await callApi(service, 'AD', 'UPDATE', {
        ad_id: 'ad_1',
        params: { daily_budget: 5000 }
      });

      expect(result.requiresConfirmation).toBe(true);
      expect(result.awaitingUserConfirmation).toBe(true);
      expect(metaService.updateAd).not.toHaveBeenCalled();
      // The change being made must be surfaced so the user can catch a wrong edit.
      expect(result.confirmationPrompt).toContain('Spring Promo');
      expect(result.confirmationPrompt).toContain('Maintenance Campaign');
    });

    it('blocks a VALID CAMPAIGN UPDATE without confirm and does not call metaService.updateCampaign', async () => {
      (metaService.getCampaign as jest.Mock).mockResolvedValue({ id: 'camp_maint', name: 'Maintenance Campaign' });

      const result = await callApi(service, 'CAMPAIGN', 'UPDATE', {
        campaign_id: 'camp_maint',
        params: { status: 'PAUSED' }
      });

      expect(result.requiresConfirmation).toBe(true);
      expect(result.awaitingUserConfirmation).toBe(true);
      expect(metaService.updateCampaign).not.toHaveBeenCalled();
      expect(result.confirmationPrompt).toContain('Maintenance Campaign');
    });

    it('blocks AD DELETE without confirm and does not call metaService.deleteAd', async () => {
      (metaService.getAd as jest.Mock).mockResolvedValue({ id: 'ad_1', name: 'Old Ad', adset_id: 'adset_1', campaign_id: 'camp_maint' });
      (metaService.getAdSet as jest.Mock).mockResolvedValue({ id: 'adset_1', name: 'Maintenance Ad Set', campaign_id: 'camp_maint' });
      (metaService.getCampaign as jest.Mock).mockResolvedValue({ id: 'camp_maint', name: 'Maintenance Campaign' });

      const result = await callApi(service, 'AD', 'DELETE', { ad_id: 'ad_1' });

      expect(result.requiresConfirmation).toBe(true);
      expect(result.message).toContain('Old Ad');
      expect(metaService.deleteAd).not.toHaveBeenCalled();
    });

    it('still requires confirmation when target resolution fails (degrades to raw IDs)', async () => {
      (metaService.getAdSet as jest.Mock).mockRejectedValue(new Error('Meta unreachable'));
      (metaService.getCampaign as jest.Mock).mockRejectedValue(new Error('Meta unreachable'));

      const result = await callApi(service, 'AD', 'CREATE', {
        ad_set_id: 'adset_999',
        params: { name: 'Ad', creative_id: 'creative_1' }
      });

      expect(result.requiresConfirmation).toBe(true);
      expect(metaService.createAd).not.toHaveBeenCalled();
      // Falls back to the raw ad set ID in the summary.
      expect(result.message).toContain('adset_999');
    });

    it('does NOT gate read-only AD LIST', async () => {
      (metaService.listAds as jest.Mock).mockResolvedValue([]);

      const result = await callApi(service, 'AD', 'LIST', { ad_set_id: 'adset_1' });

      expect(result.requiresConfirmation).toBeUndefined();
      expect(metaService.listAds).toHaveBeenCalled();
    });

    it('blocks AD COPY_AD without confirm and names source ad + destination campaign', async () => {
      (metaService.getAd as jest.Mock).mockResolvedValue({ id: 'ad_src', name: 'Source Ad', adset_id: 'adset_src', campaign_id: 'camp_a' });
      (metaService.getAdSet as jest.Mock).mockResolvedValue({ id: 'adset_dest', name: 'Dest Ad Set', campaign_id: 'camp_b' });
      (metaService.getCampaign as jest.Mock).mockResolvedValue({ id: 'camp_b', name: 'Leasing Campaign' });

      const result = await callApi(service, 'AD', 'COPY_AD', {
        ad_id: 'ad_src',
        params: { adset_id: 'adset_dest' }
      });

      expect(result.requiresConfirmation).toBe(true);
      expect(result.message).toContain('Source Ad');
      expect(result.message).toContain('Dest Ad Set');
      expect(result.message).toContain('Leasing Campaign');
      expect(result.target.target_ad_set).toContain('Dest Ad Set');
    });

    it('blocks CAMPAIGN DELETE without confirm and does not call metaService.deleteCampaign', async () => {
      (metaService.getCampaign as jest.Mock).mockResolvedValue({ id: 'camp_maint', name: 'Maintenance Campaign' });

      const result = await callApi(service, 'CAMPAIGN', 'DELETE', { campaign_id: 'camp_maint' });

      expect(result.requiresConfirmation).toBe(true);
      expect(result.awaitingUserConfirmation).toBe(true);
      expect(metaService.deleteCampaign).not.toHaveBeenCalled();
      expect(result.confirmationPrompt).toContain('Maintenance Campaign');
    });

    it('blocks AD_SET CREATE without confirm and names the parent campaign', async () => {
      (metaService.getCampaign as jest.Mock).mockResolvedValue({ id: 'camp_maint', name: 'Maintenance Campaign' });

      const result = await callApi(service, 'AD_SET', 'CREATE', {
        campaign_id: 'camp_maint',
        params: { name: 'New Ad Set', daily_budget: 5000 }
      });

      expect(result.requiresConfirmation).toBe(true);
      expect(result.awaitingUserConfirmation).toBe(true);
      expect(metaService.createAdSet).not.toHaveBeenCalled();
      expect(result.confirmationPrompt).toContain('New Ad Set');
      expect(result.confirmationPrompt).toContain('Maintenance Campaign');
    });

    it('blocks AD_SET UPDATE without confirm and does not call metaService.updateAdSet', async () => {
      (metaService.getAdSet as jest.Mock).mockResolvedValue({ id: 'adset_1', name: 'Maintenance Ad Set', campaign_id: 'camp_maint' });
      (metaService.getCampaign as jest.Mock).mockResolvedValue({ id: 'camp_maint', name: 'Maintenance Campaign' });

      const result = await callApi(service, 'AD_SET', 'UPDATE', {
        ad_set_id: 'adset_1',
        params: { daily_budget: 9000 }
      });

      expect(result.requiresConfirmation).toBe(true);
      expect(result.awaitingUserConfirmation).toBe(true);
      expect(metaService.updateAdSet).not.toHaveBeenCalled();
      expect(result.confirmationPrompt).toContain('Maintenance Ad Set');
    });

    it('blocks AD_SET DELETE without confirm and does not call metaService.deleteAdSet', async () => {
      (metaService.getAdSet as jest.Mock).mockResolvedValue({ id: 'adset_1', name: 'Maintenance Ad Set', campaign_id: 'camp_maint' });
      (metaService.getCampaign as jest.Mock).mockResolvedValue({ id: 'camp_maint', name: 'Maintenance Campaign' });

      const result = await callApi(service, 'AD_SET', 'DELETE', { ad_set_id: 'adset_1' });

      expect(result.requiresConfirmation).toBe(true);
      expect(result.awaitingUserConfirmation).toBe(true);
      expect(metaService.deleteAdSet).not.toHaveBeenCalled();
      expect(result.confirmationPrompt).toContain('Maintenance Ad Set');
    });

    it('blocks AD_CREATIVE CREATE without confirm and names the creative', async () => {
      const result = await callApi(service, 'AD_CREATIVE', 'CREATE', {
        params: { name: 'Spring Creative', page_id: 'p1', body: 'b', title: 't', link_url: 'https://x.com', image_hash: 'h1' }
      });

      expect(result.requiresConfirmation).toBe(true);
      expect(result.awaitingUserConfirmation).toBe(true);
      expect(metaService.createAdCreative).not.toHaveBeenCalled();
      expect(result.confirmationPrompt).toContain('Spring Creative');
    });

    it('blocks CUSTOM_AUDIENCE CREATE without confirm and names the audience', async () => {
      const result = await callApi(service, 'CUSTOM_AUDIENCE', 'CREATE', {
        params: { name: 'High Value Leads', subtype: 'CUSTOM', customer_file_source: 'USER_PROVIDED_ONLY' }
      });

      expect(result.requiresConfirmation).toBe(true);
      expect(result.awaitingUserConfirmation).toBe(true);
      expect(metaService.createCustomAudience).not.toHaveBeenCalled();
      expect(result.confirmationPrompt).toContain('High Value Leads');
    });

    it('blocks CUSTOM_AUDIENCE UPLOAD_USERS without confirm (PII upload) and names the audience ID', async () => {
      const result = await callApi(service, 'CUSTOM_AUDIENCE', 'UPLOAD_USERS', {
        params: { id: 'aud_123', schema: ['EMAIL'], payload: '[["a@b.com"]]' }
      });

      expect(result.requiresConfirmation).toBe(true);
      expect(result.awaitingUserConfirmation).toBe(true);
      expect(metaService.uploadCustomAudienceUsers).not.toHaveBeenCalled();
      expect(result.confirmationPrompt).toContain('aud_123');
      expect(result.confirmationPrompt).toContain('PII');
    });

    it('does NOT gate read-only CUSTOM_AUDIENCE LIST', async () => {
      (metaService.listCustomAudiences as jest.Mock).mockResolvedValue([]);

      const result = await callApi(service, 'CUSTOM_AUDIENCE', 'LIST', {});

      expect(result.requiresConfirmation).toBeUndefined();
      expect(result.awaitingUserConfirmation).toBeUndefined();
      expect(metaService.listCustomAudiences).toHaveBeenCalled();
    });

    // ---- Human-in-the-loop fields (consumed by the agent loop to halt the turn) ----
    it('sets awaitingUserConfirmation + a user-facing confirmationPrompt on a gated write', async () => {
      (metaService.getAdSet as jest.Mock).mockResolvedValue({ id: 'adset_1', name: 'Maintenance Ad Set', campaign_id: 'camp_maint' });
      (metaService.getCampaign as jest.Mock).mockResolvedValue({ id: 'camp_maint', name: 'Maintenance Campaign' });

      const result = await callApi(service, 'AD', 'CREATE', {
        ad_set_id: 'adset_1',
        params: { name: 'New Maintenance Ad', creative_id: 'creative_1' }
      });

      // The dedicated flag the loop breaks on (distinct from requiresConfirmation,
      // so only Meta writes halt the turn — not delete_leads / work-plan flows).
      expect(result.awaitingUserConfirmation).toBe(true);
      // The user-facing prompt must name the resolved target and ask for approval.
      expect(typeof result.confirmationPrompt).toBe('string');
      expect(result.confirmationPrompt).toContain('Maintenance Ad Set');
      expect(result.confirmationPrompt).toContain('Maintenance Campaign');
      expect(result.confirmationPrompt.toLowerCase()).toContain('confirm');
    });

    it('does NOT set awaitingUserConfirmation when confirm=true (gate bypassed, executes)', async () => {
      (metaService.createAd as jest.Mock).mockResolvedValue({ id: 'ad_new', name: 'New Maintenance Ad' });

      const result = await callApi(service, 'AD', 'CREATE', {
        ad_set_id: 'adset_1',
        params: { name: 'New Maintenance Ad', creative_id: 'creative_1', confirm: true }
      });

      expect(result.awaitingUserConfirmation).toBeUndefined();
      expect(result.confirmationPrompt).toBeUndefined();
      expect(metaService.createAd).toHaveBeenCalledTimes(1);
    });

    it('does NOT set awaitingUserConfirmation on read-only AD LIST', async () => {
      (metaService.listAds as jest.Mock).mockResolvedValue([]);

      const result = await callApi(service, 'AD', 'LIST', { ad_set_id: 'adset_1' });

      expect(result.awaitingUserConfirmation).toBeUndefined();
      expect(result.confirmationPrompt).toBeUndefined();
    });
  });

  // ==================== Minimal-result preserves the gate flag ====================
  // The frontend tool card / panel teardown read result.awaitingUserConfirmation off
  // the MINIMIZED result stored in toolCalls. extractMinimalToolResult must not strip it,
  // or the "Awaiting your confirmation" UI never fires (regardless of tool name).
  describe('extractMinimalToolResult preserves confirmation-gate fields', () => {
    const gated = {
      success: true,
      requiresConfirmation: true,
      awaitingUserConfirmation: true,
      confirmationPrompt: 'Please confirm before I proceed...',
      confirmationDetail: 'Publish ad into Maintenance Campaign',
      summary: 'Publish ad into Maintenance Campaign',
      target: { campaign: 'Maintenance Campaign' }
    };

    it('keeps awaitingUserConfirmation for call_meta_marketing_api (would otherwise hit default {})', () => {
      const out = (service as any).extractMinimalToolResult(gated, 'call_meta_marketing_api');
      expect(out.awaitingUserConfirmation).toBe(true);
      expect(out.confirmationPrompt).toContain('confirm');
    });

    it('keeps awaitingUserConfirmation for generate_image (would otherwise drop it)', () => {
      const out = (service as any).extractMinimalToolResult(gated, 'generate_image');
      expect(out.awaitingUserConfirmation).toBe(true);
      expect(out.confirmationDetail).toBeDefined();
    });

    it('does not add the flag to a normal (non-gated) result', () => {
      const out = (service as any).extractMinimalToolResult(
        { success: true, imageUrl: 'https://x/img.png', filename: 'a.png' },
        'generate_image'
      );
      expect(out.awaitingUserConfirmation).toBeUndefined();
      expect(out.imageUrl).toBe('https://x/img.png');
    });
  });

  // ==================== Agent-loop halt detection ====================
  // collectConfirmationPrompt is the seam the agent loop uses to decide whether to
  // STOP the autonomous turn and hand control back to the user. It scans the tool
  // results from one iteration and returns the user-facing prompt to surface (or null).
  describe('collectConfirmationPrompt (loop halt seam)', () => {
    const awaiting = (prompt: string) => ({
      status: 'success' as const,
      result: { success: true, awaitingUserConfirmation: true, confirmationPrompt: prompt }
    });

    it('returns null when no tool result requests user confirmation', () => {
      const out = (service as any).collectConfirmationPrompt([
        { status: 'success', result: { success: true, data: [] } },
        { status: 'error', error: new Error('boom') }
      ]);
      expect(out).toBeNull();
    });

    it('returns the confirmationPrompt of a single gated write', () => {
      const out = (service as any).collectConfirmationPrompt([
        { status: 'success', result: { success: true } },
        awaiting('Please confirm: publish ad into Maintenance Campaign?')
      ]);
      expect(out).toBe('Please confirm: publish ad into Maintenance Campaign?');
    });

    it('joins prompts when multiple writes are batched in one turn', () => {
      const out = (service as any).collectConfirmationPrompt([
        awaiting('Confirm A'),
        awaiting('Confirm B')
      ]);
      expect(out).toContain('Confirm A');
      expect(out).toContain('Confirm B');
    });

    it('batches multiple confirmations under ONE intro/footer using confirmationDetail', () => {
      const detailItem = (detail: string, prompt: string) => ({
        status: 'success' as const,
        result: { success: true, awaitingUserConfirmation: true, confirmationPrompt: prompt, confirmationDetail: detail }
      });
      const out: string = (service as any).collectConfirmationPrompt([
        detailItem('edit edited1.png\n![a](u1)', 'FULL PROMPT 1'),
        detailItem('edit edited2.png\n![b](u2)', 'FULL PROMPT 2')
      ]);

      // Per-item details are present (incl. their thumbnails)...
      expect(out).toContain('edited1.png');
      expect(out).toContain('edited2.png');
      expect(out).toContain('![a](u1)');
      expect(out).toContain('![b](u2)');
      // ...but the standalone per-item wrappers are NOT repeated.
      expect(out).not.toContain('FULL PROMPT 1');
      expect(out).not.toContain('FULL PROMPT 2');
      // Footer appears exactly once.
      expect(out.match(/Reply "yes" \/ "confirm"/g)?.length).toBe(1);
    });

    it('ignores requiresConfirmation-only results (delete_leads / work-plan stay un-halted)', () => {
      // A tool that sets requiresConfirmation but NOT awaitingUserConfirmation must not
      // halt the loop — only the dedicated flag triggers the human gate.
      const out = (service as any).collectConfirmationPrompt([
        { status: 'success', result: { success: true, requiresConfirmation: true, message: 'Call again with confirm=true' } }
      ]);
      expect(out).toBeNull();
    });
  });

  // ==================== enrichMetaError ====================
  describe('enrichMetaError (via create methods)', () => {
    const makeStructuredError = (
      message: string,
      code?: number,
      error_subcode?: number,
      error_user_msg?: string
    ) => {
      const err = new Error(message) as any;
      err.structuredError = { code, error_subcode, error_user_msg };
      return err;
    };

    it('enriches subcode 1341012 (page permission denied)', async () => {
      (metaService.createCampaign as jest.Mock).mockRejectedValue(
        makeStructuredError('Generic error', 200, 1341012)
      );

      const result = await service.createMetaAdsCampaign('user123', {
        name: 'C',
        objective: 'OUTCOME_TRAFFIC',
        special_ad_categories: []
      });

      expect(result.success).toBe(false);
      expect(result.message).toContain('page_id');
      expect(result.message).toContain('1341012');
    });

    it('enriches subcode 1443226 (missing video thumbnail)', async () => {
      (metaService.createAdCreative as jest.Mock).mockRejectedValue(
        makeStructuredError('Generic error', 100, 1443226)
      );

      const result = await service.createMetaAdsAdCreative('user123', {
        name: 'Creative',
        page_id: 'p1',
        body: 'body',
        title: 'title',
        link_url: 'https://example.com',
        video_id: 'vid_123',
        image_hash: 'hash_abc'
      });

      expect(result.success).toBe(false);
      expect(result.message).toContain('thumbnail');
      expect(result.message).toContain('1443226');
    });

    it('enriches subcode 1870227 (advantage_audience flag required)', async () => {
      // OUTCOME_TRAFFIC + LINK_CLICKS + IMPRESSIONS + default LOWEST_COST_WITHOUT_CAP is fully valid
      (metaService.getCampaign as jest.Mock).mockResolvedValue({ id: 'camp_123', objective: 'OUTCOME_TRAFFIC' });
      (metaService.createAdSet as jest.Mock).mockRejectedValue(
        makeStructuredError('Generic error', 100, 1870227)
      );

      const result = await service.createMetaAdsAdSet('user123', {
        name: 'Ad Set',
        campaign_id: 'camp_123',
        billing_event: 'IMPRESSIONS',
        optimization_goal: 'LINK_CLICKS',
        targeting: { geo_locations: { countries: ['US'] } },
        daily_budget: 10
      });

      expect(result.success).toBe(false);
      expect(result.message).toContain('advantage_audience');
      expect(result.message).toContain('1870227');
    });

    it('enriches code 10 (permission error) with entity ID guidance', async () => {
      (metaService.createAd as jest.Mock).mockRejectedValue(
        makeStructuredError('Permission error', 10, undefined, 'You do not have access')
      );

      const result = await service.createMetaAdsAd('user123', {
        name: 'My Ad',
        adset_id: 'adset_123',
        creative_id: 'creative_123'
      });

      expect(result.success).toBe(false);
      expect(result.message).toContain('Permission error');
      expect(result.message).toContain('LIST operations');
    });

    it('uses error_user_msg for unknown subcodes when present', async () => {
      (metaService.createCampaign as jest.Mock).mockRejectedValue(
        makeStructuredError('Raw error', 200, 9999, 'Budget must be at least $1')
      );

      const result = await service.createMetaAdsCampaign('user123', {
        name: 'C',
        objective: 'OUTCOME_TRAFFIC',
        special_ad_categories: []
      });

      expect(result.success).toBe(false);
      expect(result.message).toContain('Budget must be at least $1');
      expect(result.message).toContain('200'); // code included
    });

    it('falls back to original error.message for fully unknown errors', async () => {
      (metaService.createCampaign as jest.Mock).mockRejectedValue(
        new Error('Unknown API failure')
      );

      const result = await service.createMetaAdsCampaign('user123', {
        name: 'C',
        objective: 'OUTCOME_TRAFFIC',
        special_ad_categories: []
      });

      expect(result.success).toBe(false);
      expect(result.message).toBe('Unknown API failure');
    });
  });

  // ==================== advantage_audience auto-injection ====================
  describe('advantage_audience auto-injection in createMetaAdsAdSet', () => {
    const baseAdSetParams = {
      name: 'Ad Set',
      campaign_id: 'camp_123',
      billing_event: 'IMPRESSIONS',
      optimization_goal: 'LINK_CLICKS',  // compatible with OUTCOME_TRAFFIC + LOWEST_COST_WITHOUT_CAP
      daily_budget: 10
    };

    beforeEach(() => {
      (metaService.getCampaign as jest.Mock).mockResolvedValue({
        id: 'camp_123',
        objective: 'OUTCOME_TRAFFIC'  // compatible with LINK_CLICKS
      });
      (metaService.createAdSet as jest.Mock).mockResolvedValue({ id: 'adset_new', name: 'Ad Set' });
    });

    it('injects advantage_audience=0 when targeting_automation is absent', async () => {
      await service.createMetaAdsAdSet('user123', {
        ...baseAdSetParams,
        targeting: { geo_locations: { countries: ['US'] } }
      });

      const calledWith = (metaService.createAdSet as jest.Mock).mock.calls[0][2];
      expect(calledWith.targeting.targeting_automation).toEqual({ advantage_audience: 0 });
    });

    it('injects advantage_audience=0 when targeting_automation exists but advantage_audience is missing', async () => {
      await service.createMetaAdsAdSet('user123', {
        ...baseAdSetParams,
        targeting: {
          geo_locations: { countries: ['US'] },
          targeting_automation: { some_other_flag: true }
        }
      });

      const calledWith = (metaService.createAdSet as jest.Mock).mock.calls[0][2];
      expect(calledWith.targeting.targeting_automation.advantage_audience).toBe(0);
      // existing flags should be preserved
      expect(calledWith.targeting.targeting_automation.some_other_flag).toBe(true);
    });

    it('does not override advantage_audience when explicitly set to 1', async () => {
      await service.createMetaAdsAdSet('user123', {
        ...baseAdSetParams,
        targeting: {
          geo_locations: { countries: ['US'] },
          targeting_automation: { advantage_audience: 1 }
        }
      });

      const calledWith = (metaService.createAdSet as jest.Mock).mock.calls[0][2];
      expect(calledWith.targeting.targeting_automation.advantage_audience).toBe(1);
    });

    it('does not override advantage_audience when explicitly set to 0', async () => {
      await service.createMetaAdsAdSet('user123', {
        ...baseAdSetParams,
        targeting: {
          geo_locations: { countries: ['US'] },
          targeting_automation: { advantage_audience: 0 }
        }
      });

      const calledWith = (metaService.createAdSet as jest.Mock).mock.calls[0][2];
      expect(calledWith.targeting.targeting_automation.advantage_audience).toBe(0);
    });
  });

  describe('destination_type defaulting in createMetaAdsAdSet (ENG-415)', () => {
    const websiteGoalParams = {
      name: 'Ad Set',
      campaign_id: 'camp_123',
      billing_event: 'IMPRESSIONS',
      daily_budget: 10,
      targeting: { geo_locations: { countries: ['US'] } }
    };

    beforeEach(() => {
      (metaService.createAdSet as jest.Mock).mockResolvedValue({ id: 'adset_new', name: 'Ad Set' });
    });

    it('defaults destination_type=WEBSITE for a website traffic goal (LINK_CLICKS)', async () => {
      (metaService.getCampaign as jest.Mock).mockResolvedValue({ id: 'camp_123', objective: 'OUTCOME_TRAFFIC' });
      await service.createMetaAdsAdSet('user123', { ...websiteGoalParams, optimization_goal: 'LINK_CLICKS' });
      const calledWith = (metaService.createAdSet as jest.Mock).mock.calls[0][2];
      expect(calledWith.destination_type).toBe('WEBSITE');
    });

    it('defaults destination_type=WEBSITE for a website conversion goal (OFFSITE_CONVERSIONS)', async () => {
      (metaService.getCampaign as jest.Mock).mockResolvedValue({ id: 'camp_123', objective: 'OUTCOME_LEADS' });
      await service.createMetaAdsAdSet('user123', {
        ...websiteGoalParams,
        optimization_goal: 'OFFSITE_CONVERSIONS',
        promoted_object: { pixel_id: 'px_1', custom_event_type: 'LEAD' }
      });
      const calledWith = (metaService.createAdSet as jest.Mock).mock.calls[0][2];
      expect(calledWith.destination_type).toBe('WEBSITE');
    });

    it('does NOT set destination_type for a non-website goal (POST_ENGAGEMENT)', async () => {
      (metaService.getCampaign as jest.Mock).mockResolvedValue({ id: 'camp_123', objective: 'OUTCOME_ENGAGEMENT' });
      await service.createMetaAdsAdSet('user123', { ...websiteGoalParams, optimization_goal: 'POST_ENGAGEMENT' });
      const calledWith = (metaService.createAdSet as jest.Mock).mock.calls[0][2];
      expect(calledWith.destination_type).toBeUndefined();
    });

    it('respects an explicit destination_type and does not override it', async () => {
      (metaService.getCampaign as jest.Mock).mockResolvedValue({ id: 'camp_123', objective: 'OUTCOME_TRAFFIC' });
      await service.createMetaAdsAdSet('user123', {
        ...websiteGoalParams,
        optimization_goal: 'LINK_CLICKS',
        destination_type: 'ON_AD'
      });
      const calledWith = (metaService.createAdSet as jest.Mock).mock.calls[0][2];
      expect(calledWith.destination_type).toBe('ON_AD');
    });
  });
});
