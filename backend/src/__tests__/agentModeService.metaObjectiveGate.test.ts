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

    // Greptile P1 ("Confirmation retry reopens objective gate"): CAMPAIGN
    // CREATE is also a write action, so the target-confirmation guardrail
    // fires AFTER a Path 1 success and asks the user to confirm the target.
    // That "yes" reply becomes the new last user message on the retry — the
    // original quote no longer appears there. A Path 1 success must persist a
    // settled record so the retry finds it via Path 2 instead of wrongly
    // re-asking (the confirmed campaign must not get blocked by a NEW
    // objective question after the user already answered it once).
    it('persists a Path 1 success so a later retry (different last message) still resolves without re-quoting', async () => {
      (chatbotDb.getMessagesFromMessagesTable as jest.Mock).mockResolvedValue([
        { role: 'user', content: 'Create a leads campaign for our new offer.' },
      ]);
      const firstCall = await callApi(
        service,
        validParams({ objective: 'OUTCOME_LEADS', objective_quote: 'leads campaign' }),
        'session-1',
      );
      expect(firstCall.success).toBe(true);
      expect(chatbotDb.updateSessionAskUserQuestion).toHaveBeenCalled();
      const persisted = (chatbotDb.updateSessionAskUserQuestion as jest.Mock).mock.calls[0][1];
      expect(persisted.status).toBe('answered');
      expect(persisted.kind).toBe('meta_objective:Test');
      expect(persisted.answer.answeredBy).toBe('user');

      // Simulate the retry: the session now reflects that persisted record,
      // and the LATEST message is the user's confirmation reply ("yes"), which
      // does NOT contain the original quote.
      (chatbotDb.getChatSession as jest.Mock).mockResolvedValue({ pendingUserQuestion: persisted });
      (chatbotDb.getMessagesFromMessagesTable as jest.Mock).mockResolvedValue([
        { role: 'user', content: 'Create a leads campaign for our new offer.' },
        { role: 'assistant', content: 'Confirm this campaign?' },
        { role: 'user', content: 'yes' },
      ]);

      const retry = await callApi(
        service,
        validParams({ objective: 'OUTCOME_TRAFFIC' /* model's retry may omit/vary the quote */, confirm: true }),
        'session-1',
      );

      expect(retry.success).toBe(true);
      expect(metaService.createCampaign).toHaveBeenCalled();
      // Applied the ORIGINALLY-confirmed objective verbatim, not the retry's own claim.
      expect((metaService.createCampaign as jest.Mock).mock.calls[0][2].objective).toBe('OUTCOME_LEADS');
    });

    // Greptile P1 ("Objective persists across campaigns"): a bare 'meta_objective'
    // kind matched ANY campaign in the session — a SECOND, different campaign
    // created later would silently inherit the FIRST campaign's answered
    // objective instead of asking/confirming its own. Scoped by campaign name.
    it('does NOT let a second, differently-named campaign inherit the first campaign\'s confirmed objective', async () => {
      (chatbotDb.getMessagesFromMessagesTable as jest.Mock).mockResolvedValue([
        { role: 'user', content: 'Create a leads campaign called Campaign One.' },
      ]);
      await callApi(
        service,
        validParams({ name: 'Campaign One', objective: 'OUTCOME_LEADS', objective_quote: 'leads campaign' }),
        'session-1',
      );
      const persistedFirst = (chatbotDb.updateSessionAskUserQuestion as jest.Mock).mock.calls[0][1];
      expect(persistedFirst.kind).toBe('meta_objective:Campaign One');

      // A second, unrelated campaign in the SAME session — session now reflects
      // Campaign One's answered objective as the live slot.
      (chatbotDb.getChatSession as jest.Mock).mockResolvedValue({ pendingUserQuestion: persistedFirst });
      (chatbotDb.getMessagesFromMessagesTable as jest.Mock).mockResolvedValue([
        { role: 'user', content: 'Now also create a second campaign called Campaign Two, no objective decided yet.' },
      ]);

      const secondResult = await callApi(
        service,
        validParams({ name: 'Campaign Two' /* no objective claimed at all */ }),
        'session-1',
      );

      // Must NOT silently inherit Campaign One's Leads objective — nothing has
      // settled Campaign Two's objective yet, so it must park/ask, not create.
      expect(secondResult.awaitingUserConfirmation).toBe(true);
      expect(secondResult.type).toBe('ask_user_question');
      expect(metaService.createCampaign).toHaveBeenCalledTimes(1); // only Campaign One
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
        kind: 'meta_objective:Test', // scoped to validParams()'s default name: 'Test'
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

  // Greptile P1 ("Invalid requests now require session storage"): fields
  // independent of objective (name, special_ad_categories shape) must be
  // rejected BEFORE the gate touches the DB — otherwise a basic, previously
  // DB-free validation failure now depends on session storage being reachable.
  describe('objective-independent validation runs BEFORE the gate touches the DB', () => {
    it('rejects missing "name" WITHOUT calling any chatbotDb method (no DB access)', async () => {
      const result = await callApi(service, { special_ad_categories: ['NONE'], confirm: true }, 'session-1');

      expect(result.success).toBe(false);
      expect(result.error).toBe('PARAM_VALIDATION_ERROR');
      expect(result.message).toContain('"name"');
      expect(chatbotDb.getChatSession).not.toHaveBeenCalled();
      expect(chatbotDb.getMessagesFromMessagesTable).not.toHaveBeenCalled();
      expect(chatbotDb.createChatSession).not.toHaveBeenCalled();
      expect(metaService.createCampaign).not.toHaveBeenCalled();
    });

    it('rejects malformed special_ad_categories WITHOUT calling any chatbotDb method', async () => {
      const result = await callApi(
        service,
        { name: 'Test', special_ad_categories: 'NONE' /* should be an array */, confirm: true },
        'session-1',
      );

      expect(result.success).toBe(false);
      expect(result.error).toBe('PARAM_VALIDATION_ERROR');
      expect(chatbotDb.getChatSession).not.toHaveBeenCalled();
      expect(metaService.createCampaign).not.toHaveBeenCalled();
    });

    it('still rejects missing "name" even with NO session — no DB access either way', async () => {
      const result = await callApi(service, { special_ad_categories: ['NONE'], confirm: true }); // no sessionId

      expect(result.success).toBe(false);
      expect(result.error).toBe('PARAM_VALIDATION_ERROR');
      expect(chatbotDb.createChatSession).not.toHaveBeenCalled();
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
      expect(persisted.kind).toBe('meta_objective:Test');
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
