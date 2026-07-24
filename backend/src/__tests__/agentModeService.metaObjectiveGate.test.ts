/**
 * ENG-400: the Meta campaign-objective write gate at callMetaMarketingApi
 * (CAMPAIGN CREATE). This is the load-bearing consumer of the ENG-396
 * AskUserQuestion primitive — the RankAI incident (Emma defaulted an immutable
 * objective and self-approved via a model-controlled confirm flag) is exactly
 * what this gate exists to make impossible. Covers the three acceptable
 * objective sources: explicit-statement quote, prior answered ask, and the
 * auto-emitted blocking ask (static OUTCOME_LEADS recommendation, per the
 * 80/20 design) when neither exists.
 */

jest.mock('../mcp/client/mcpClientService', () => ({
  McpClientService: jest.fn().mockImplementation(() => ({ isReady: jest.fn().mockReturnValue(true) })),
}));

jest.mock('../services/metaService', () => {
  const actual = jest.requireActual('../services/metaService');
  return {
    ...actual,
    metaService: {
      createCampaign: jest.fn(),
    },
  };
});

jest.mock('../services/db', () => ({
  userDb: { getUserById: jest.fn() },
}));

jest.mock('../utils/secretsManager', () => ({
  getMetaAccessToken: jest.fn().mockResolvedValue('mock-access-token'),
}));

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
    { platform: 'meta', account_id: '123456789', account_name: 'Test', config: { account_type: 'ad_account', access_token: 'tok', ad_account_id: '123456789' } },
  ],
};

const callApi = (service: AgentModeService, params: any, sessionId?: string) =>
  (service as any).callMetaMarketingApi('user123', 'CAMPAIGN', 'CREATE', '123456789', undefined, undefined, undefined, params, sessionId);

describe('ENG-400: Meta campaign-objective write gate', () => {
  let service: AgentModeService;

  beforeEach(() => {
    service = new AgentModeService();
    jest.clearAllMocks();
    (userDb.getUserById as jest.Mock).mockResolvedValue(mockUser);
    (chatbotDb.getMessagesFromMessagesTable as jest.Mock).mockResolvedValue([]);
    (chatbotDb.getChatSession as jest.Mock).mockResolvedValue(null);
    (chatbotDb.updateSessionAskUserQuestion as jest.Mock).mockResolvedValue({});
    (chatbotDb.createChatSession as jest.Mock).mockResolvedValue({ sessionId: 'auto-created-session' });
    (metaService.createCampaign as jest.Mock).mockResolvedValue({ id: 'camp_1', name: 'Test' });
  });

  const validParams = (extra: any = {}) => ({
    name: 'Test',
    special_ad_categories: ['NONE'],
    confirm: true,
    ...extra,
  });

  it('auto-provisions a session and PARKS (never dead-ends) with no session — an anomaly, not a silent create', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await callApi(service, validParams({ objective: 'OUTCOME_LEADS' }));
    expect(chatbotDb.createChatSession).toHaveBeenCalledWith(
      'user123', undefined, 'agent', 'meta-objective-gate-auto-session',
      undefined, undefined, undefined, undefined, 'result-endpoint',
    );
    expect(result.success).toBe(true);
    expect(result.awaitingUserConfirmation).toBe(true);
    expect(result.type).toBe('ask_user_question');
    expect(result.sessionId).toBe('auto-created-session');
    expect(metaService.createCampaign).not.toHaveBeenCalled();
    // Loud, not silent — an unknown/untracked caller hitting this path should be
    // immediately visible in logs, not just quietly recovered from.
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('NO sessionId'));
    warnSpy.mockRestore();
  });

  describe('Path 1 — explicit statement (objective_quote)', () => {
    it('ALLOWS when the quote genuinely appears in the last user message', async () => {
      (chatbotDb.getMessagesFromMessagesTable as jest.Mock).mockResolvedValue([
        { role: 'user', content: 'Create a leads campaign for our new offer.' },
      ]);
      const result = await callApi(
        service,
        validParams({ objective: 'OUTCOME_LEADS', objective_quote: 'leads campaign' }),
        'session-1',
      );
      expect(result.success).toBe(true);
      expect(metaService.createCampaign).toHaveBeenCalled();
    });

    it('REJECTS a quote that does not actually appear in the message (falls through to the ask gate)', async () => {
      (chatbotDb.getMessagesFromMessagesTable as jest.Mock).mockResolvedValue([
        { role: 'user', content: 'Just make me a campaign, whatever works.' },
      ]);
      const result = await callApi(
        service,
        validParams({ objective: 'OUTCOME_LEADS', objective_quote: 'leads campaign' }),
        'session-1',
      );
      expect(result.success).toBe(true);
      expect(result.awaitingUserConfirmation).toBe(true);
      expect(result.type).toBe('ask_user_question');
      expect(metaService.createCampaign).not.toHaveBeenCalled();
    });

    it('REJECTS an unverifiable claim even with a real-looking quote if there is no user message at all', async () => {
      (chatbotDb.getMessagesFromMessagesTable as jest.Mock).mockResolvedValue([]);
      const result = await callApi(
        service,
        validParams({ objective: 'OUTCOME_LEADS', objective_quote: 'leads campaign' }),
        'session-1',
      );
      expect(result.awaitingUserConfirmation).toBe(true);
      expect(metaService.createCampaign).not.toHaveBeenCalled();
    });

    // Greptile P1 ("Quote does not bind objective"): a genuine quote proves it's
    // real transcript text, but says nothing about WHICH objective it names. A
    // model could pair a real "traffic campaign" quote with a totally different
    // claimed objective (OUTCOME_LEADS) and both checks would pass under the old
    // logic — silently creating a Leads campaign the user never chose. Each
    // claimed objective must have ITS OWN keyword present in the quote.
    it('REJECTS a genuine quote that describes a DIFFERENT objective than the one claimed', async () => {
      (chatbotDb.getMessagesFromMessagesTable as jest.Mock).mockResolvedValue([
        { role: 'user', content: 'Please set up a traffic campaign for our launch.' },
      ]);
      const result = await callApi(
        service,
        // The quote is 100% real text — but it describes Traffic, not Leads.
        validParams({ objective: 'OUTCOME_LEADS', objective_quote: 'traffic campaign' }),
        'session-1',
      );
      expect(result.awaitingUserConfirmation).toBe(true);
      expect(result.type).toBe('ask_user_question');
      expect(metaService.createCampaign).not.toHaveBeenCalled();
    });

    it('ALLOWS Sales when the quote genuinely names a sales/purchase/conversion funnel', async () => {
      (chatbotDb.getMessagesFromMessagesTable as jest.Mock).mockResolvedValue([
        { role: 'user', content: 'We need a campaign optimized for purchases on our checkout page.' },
      ]);
      const result = await callApi(
        service,
        validParams({ objective: 'OUTCOME_SALES', objective_quote: 'optimized for purchases on our checkout page' }),
        'session-1',
      );
      expect(result.success).toBe(true);
      expect(metaService.createCampaign).toHaveBeenCalled();
    });

    it('an invalid objective value with nothing settled surfaces the real ask card (gate runs BEFORE param validation)', async () => {
      // ENG-400 reorder: the gate must run before validateMetaActionParams, so
      // a model that supplies a bogus objective still gets the real blocking
      // card instead of a generic param-validation error — the gate always
      // resolves to a valid objective (or blocks) before validation ever sees it.
      const result = await callApi(
        service,
        validParams({ objective: 'NOT_REAL', objective_quote: 'NOT_REAL' }),
        'session-1',
      );
      expect(result.success).toBe(true);
      expect(result.awaitingUserConfirmation).toBe(true);
      expect(result.type).toBe('ask_user_question');
      expect(metaService.createCampaign).not.toHaveBeenCalled();
    });
  });

  describe('Path 2 — prior answered ask_user_question (kind: meta_objective)', () => {
    function answeredQuestion(objective: string, overrides: any = {}) {
      return {
        questionId: 'q-1',
        question: 'Which objective?',
        options: [{ id: 'x', label: 'X', consequence: 'x', recommended: true, why: 'y', payload: { objective } }],
        recommendedOptionId: 'x',
        immutable: true,
        allowEmmaDecide: true,
        kind: 'meta_objective',
        status: 'answered',
        createdAt: '2026-07-24T00:00:00.000Z',
        answer: { optionId: 'x', delegated: false, answeredBy: 'user', at: '2026-07-24T00:01:00.000Z' },
        ...overrides,
      };
    }

    it('ALLOWS via the LIVE pendingUserQuestion slot and applies the gate-resolved objective VERBATIM', async () => {
      (chatbotDb.getChatSession as jest.Mock).mockResolvedValue({
        sessionId: 'session-1',
        pendingUserQuestion: answeredQuestion('OUTCOME_SALES'),
      });

      const result = await callApi(service, validParams({ objective: 'OUTCOME_TRAFFIC' /* model's guess, ignored */ }), 'session-1');

      expect(result.success).toBe(true);
      expect(metaService.createCampaign).toHaveBeenCalled();
      expect((metaService.createCampaign as jest.Mock).mock.calls[0][2].objective).toBe('OUTCOME_SALES');
    });

    it('ALLOWS via the ARCHIVE when a LATER question has taken the live slot', async () => {
      (chatbotDb.getChatSession as jest.Mock).mockResolvedValue({
        sessionId: 'session-1',
        pendingUserQuestion: { ...answeredQuestion('OUTCOME_LEADS'), questionId: 'q-later', kind: 'some_other_kind' },
        answeredQuestions: { 'q-1': answeredQuestion('OUTCOME_SALES') },
      });

      const result = await callApi(service, validParams({ objective: 'OUTCOME_TRAFFIC' }), 'session-1');

      expect(result.success).toBe(true);
      expect((metaService.createCampaign as jest.Mock).mock.calls[0][2].objective).toBe('OUTCOME_SALES');
    });

    it('does NOT allow a DELEGATED answer to be treated any differently — still applies verbatim', async () => {
      (chatbotDb.getChatSession as jest.Mock).mockResolvedValue({
        sessionId: 'session-1',
        pendingUserQuestion: answeredQuestion('OUTCOME_LEADS', {
          answer: { optionId: 'x', delegated: true, answeredBy: 'delegation', rationale: 'r', at: 't' },
        }),
      });

      const result = await callApi(service, validParams({ objective: 'OUTCOME_TRAFFIC' }), 'session-1');
      expect(result.success).toBe(true);
      expect((metaService.createCampaign as jest.Mock).mock.calls[0][2].objective).toBe('OUTCOME_LEADS');
    });

    it('BLOCKS when the pending question is still AWAITING (same-turn [ask, create] bundle refused)', async () => {
      (chatbotDb.getChatSession as jest.Mock).mockResolvedValue({
        sessionId: 'session-1',
        pendingUserQuestion: { ...answeredQuestion('OUTCOME_LEADS'), status: 'awaiting', answer: undefined },
      });

      const result = await callApi(service, validParams({ objective: 'OUTCOME_LEADS' }), 'session-1');
      expect(result.awaitingUserConfirmation).toBe(true);
      expect(metaService.createCampaign).not.toHaveBeenCalled();
    });
  });

  describe('Path 3 — auto-emitted blocking ask (nothing settled)', () => {
    it('emits a card with OUTCOME_LEADS recommended by default (static per the 80/20 design)', async () => {
      const result = await callApi(service, validParams({ objective: 'OUTCOME_TRAFFIC' }), 'session-1');

      expect(result.success).toBe(true);
      expect(result.awaitingUserConfirmation).toBe(true);
      expect(result.type).toBe('ask_user_question');
      expect(result.recommendedOptionId).toBe('leads');
      const leadsOption = result.options.find((o: any) => o.id === 'leads');
      expect(leadsOption.recommended).toBe(true);
      expect(leadsOption.payload).toEqual({ objective: 'OUTCOME_LEADS' });
      // Sales stays present and selectable but non-default.
      const salesOption = result.options.find((o: any) => o.id === 'sales');
      expect(salesOption.recommended).toBeFalsy();
      expect(chatbotDb.updateSessionAskUserQuestion).toHaveBeenCalled();
      const persisted = (chatbotDb.updateSessionAskUserQuestion as jest.Mock).mock.calls[0][1];
      expect(persisted.kind).toBe('meta_objective');
      expect(persisted.immutable).toBe(true);
    });

    it('does NOT create the campaign when a question is already awaiting (one-live-question guard)', async () => {
      (chatbotDb.updateSessionAskUserQuestion as jest.Mock).mockResolvedValue(null); // refused: already awaiting
      const result = await callApi(service, validParams({ objective: 'OUTCOME_TRAFFIC' }), 'session-1');

      expect(result.success).toBe(false);
      expect(result.error).toBe('ASK_USER_QUESTION_ALREADY_PENDING');
      expect(metaService.createCampaign).not.toHaveBeenCalled();
    });

    // Regression (found live, 2026-07-24): a model that correctly OMITS an
    // objective it doesn't know — the safest thing it can do — must still get
    // the real ask card. Before the gate-before-validation reorder,
    // validateMetaActionParams required objective to be PRESENT and threw
    // PARAM_VALIDATION_ERROR before the gate ever ran, so the model never saw
    // a real card and (live) started fabricating fake HTML "cards" in prose
    // instead — the exact failure mode this whole gate exists to prevent.
    it('emits the real ask card when objective is OMITTED entirely (not just invalid) — the gate runs before param validation', async () => {
      const result = await callApi(service, validParams(), 'session-1'); // no objective key at all

      expect(result.success).toBe(true);
      expect(result.awaitingUserConfirmation).toBe(true);
      expect(result.type).toBe('ask_user_question');
      expect(metaService.createCampaign).not.toHaveBeenCalled();
    });
  });
});
