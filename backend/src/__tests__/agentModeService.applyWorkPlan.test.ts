import { AgentModeService } from '../services/agentModeService';
import { chatbotDb } from '../services/chatbotService';
import { workPlanService } from '../services/workPlanService';
import * as predefinedWorkPlanResolver from '../services/predefinedWorkPlanResolver';

// Mock heavy/external dependencies so the service loads in isolation.
jest.mock('aws-sdk');
jest.mock('../services/db', () => ({
  getSession: jest.fn(),
  saveMessage: jest.fn(),
  updateSession: jest.fn(),
  getTask: jest.fn(),
  getTaskExecution: jest.fn(),
  getUserById: jest.fn(),
  userDb: { getUserById: jest.fn().mockResolvedValue(null) },
  taskTemplateDb: { listTemplates: jest.fn().mockResolvedValue([]) },
}));
jest.mock('../services/chatbotService');
jest.mock('../services/settingsService');
jest.mock('../utils/secretsManager');
jest.mock('../services/workPlanService', () => ({
  workPlanService: {
    getWorkPlansByVisibility: jest.fn().mockResolvedValue([]),
    getWorkPlansByOwner: jest.fn().mockResolvedValue([]),
    getWorkPlansByOrg: jest.fn().mockResolvedValue([]),
    getPublicPlansForAgentMode: jest.fn().mockResolvedValue([]),
  },
}));

const mockWorkPlanService = workPlanService as jest.Mocked<typeof workPlanService>;

describe('AgentModeService - predefined work plan templates', () => {
  let service: AgentModeService;
  const sessionId = 'sess-1';

  const systemTemplate: any = {
    planId: 'plan-onboard',
    title: 'Client Onboarding',
    description: 'Get a new client set up',
    category: 'onboarding',
    visibility: 'system',
    isBuiltIn: true,
    welcomeMessage: '  Welcome aboard!  ',
    autocomplete: true,
    defaultModel: 'anthropic.claude-sonnet-4-6',
    steps: [
      { stepCount: 1, title: 'Analyze website', description: 'Gather info', requiredFunctionCalls: ['read_brand_guidelines'], skillIds: ['skill-a'] },
      { stepCount: 2, title: 'Update brand guidelines', userInstructions: 'Confirm tone', skillIds: ['skill-a', 'skill-b'] },
    ],
  };

  const templateWithInputRequest: any = {
    ...systemTemplate,
    planId: 'plan-input',
    title: 'Prospect Decode',
    steps: [
      {
        stepCount: 1,
        title: 'Intake',
        inputRequest: {
          title: 'Who and why',
          prompt: 'Tell us who to decode.',
          fields: [{ id: 'prospect', label: 'Prospect', type: 'text', required: true }],
        },
      },
      { stepCount: 2, title: 'Research' },
    ],
  };

  beforeEach(() => {
    service = new AgentModeService();
    jest.clearAllMocks();
    mockWorkPlanService.getWorkPlansByVisibility.mockResolvedValue([]);
    mockWorkPlanService.getWorkPlansByOwner.mockResolvedValue([]);
    mockWorkPlanService.getWorkPlansByOrg.mockResolvedValue([]);
    mockWorkPlanService.getPublicPlansForAgentMode.mockResolvedValue([]);
    (chatbotDb.getChatSession as jest.Mock).mockResolvedValue({ sessionId, messages: [] });
    (chatbotDb.updateSessionWorkPlan as jest.Mock).mockResolvedValue({});
    (chatbotDb.addAssociatedSkills as jest.Mock).mockResolvedValue(undefined);
    (chatbotDb.updateSessionLlmModel as jest.Mock).mockResolvedValue(undefined);
    (chatbotDb.updateSessionWorkPlanInputRequest as jest.Mock).mockResolvedValue(undefined);
    // Avoid real model registry/secret lookups.
    jest.spyOn(service, 'getSupportedModels').mockResolvedValue(['anthropic.claude-sonnet-4-6']);
  });

  it('exposes the listing/launch tools as foundation tools so Emma can always call them', () => {
    expect(AgentModeService.FOUNDATION_TOOLS.has('list_predefined_work_plans')).toBe(true);
    expect(AgentModeService.FOUNDATION_TOOLS.has('launch_predefined_work_plan')).toBe(true);
  });

  describe('applyPredefinedWorkPlan', () => {
    it('instantiates the template steps as pending and applies welcome/autocomplete', async () => {
      mockWorkPlanService.getWorkPlansByVisibility.mockImplementation(async (v: any) =>
        v === 'system' ? [systemTemplate] : []
      );

      const result = await service.applyPredefinedWorkPlan('Client Onboarding', sessionId, 'user-1');

      expect(result.success).toBe(true);
      expect(chatbotDb.updateSessionWorkPlan).toHaveBeenCalledWith(
        sessionId,
        expect.objectContaining({
          title: 'Client Onboarding',
          autocomplete: true,
          welcomeMessage: 'Welcome aboard!', // trimmed
          steps: expect.arrayContaining([
            expect.objectContaining({ stepCount: 1, title: 'Analyze website', status: 'pending' }),
            expect.objectContaining({ stepCount: 2, title: 'Update brand guidelines', status: 'pending', userInstructions: 'Confirm tone' }),
          ]),
        })
      );
    });

    it('ENG-2058: forces autocomplete true on a scheduled session even when the template requests false', async () => {
      const interactiveTemplate = { ...systemTemplate, planId: 'plan-interactive', title: 'Interactive Plan', autocomplete: false };
      mockWorkPlanService.getWorkPlansByVisibility.mockImplementation(async (v: any) =>
        v === 'system' ? [interactiveTemplate] : []
      );
      (chatbotDb.getChatSession as jest.Mock).mockResolvedValue({ sessionId, sessionType: 'scheduled', messages: [] });

      await service.applyPredefinedWorkPlan('Interactive Plan', sessionId, 'user-1');

      expect(chatbotDb.updateSessionWorkPlan).toHaveBeenCalledWith(
        sessionId,
        expect.objectContaining({ autocomplete: true })
      );
    });

    it('leaves autocomplete as the template requests on a non-scheduled session (zero regression)', async () => {
      const interactiveTemplate = { ...systemTemplate, planId: 'plan-interactive', title: 'Interactive Plan', autocomplete: false };
      mockWorkPlanService.getWorkPlansByVisibility.mockImplementation(async (v: any) =>
        v === 'system' ? [interactiveTemplate] : []
      );

      await service.applyPredefinedWorkPlan('Interactive Plan', sessionId, 'user-1');

      expect(chatbotDb.updateSessionWorkPlan).toHaveBeenCalledWith(
        sessionId,
        expect.objectContaining({ autocomplete: false })
      );
    });

    it('ENG-2072: does NOT force autocomplete when a scheduled session is reopened for a live, attended turn (isUnattendedRun: false)', async () => {
      const interactiveTemplate = { ...systemTemplate, planId: 'plan-interactive', title: 'Interactive Plan', autocomplete: false };
      mockWorkPlanService.getWorkPlansByVisibility.mockImplementation(async (v: any) =>
        v === 'system' ? [interactiveTemplate] : []
      );
      (chatbotDb.getChatSession as jest.Mock).mockResolvedValue({ sessionId, sessionType: 'scheduled', messages: [] });

      await service.applyPredefinedWorkPlan('Interactive Plan', sessionId, 'user-1', { isUnattendedRun: false });

      expect(chatbotDb.updateSessionWorkPlan).toHaveBeenCalledWith(
        sessionId,
        expect.objectContaining({ autocomplete: false })
      );
    });

    it('ENG-2072: falls back to sessionType when isUnattendedRun is not threaded by the caller (zero regression for un-migrated callers)', async () => {
      const interactiveTemplate = { ...systemTemplate, planId: 'plan-interactive', title: 'Interactive Plan', autocomplete: false };
      mockWorkPlanService.getWorkPlansByVisibility.mockImplementation(async (v: any) =>
        v === 'system' ? [interactiveTemplate] : []
      );
      (chatbotDb.getChatSession as jest.Mock).mockResolvedValue({ sessionId, sessionType: 'scheduled', messages: [] });

      await service.applyPredefinedWorkPlan('Interactive Plan', sessionId, 'user-1');

      expect(chatbotDb.updateSessionWorkPlan).toHaveBeenCalledWith(
        sessionId,
        expect.objectContaining({ autocomplete: true })
      );
    });

    it('ENG-1765: copies inputRequest onto the instantiated step instead of dropping it', async () => {
      mockWorkPlanService.getWorkPlansByVisibility.mockImplementation(async (v: any) =>
        v === 'system' ? [templateWithInputRequest] : []
      );

      await service.applyPredefinedWorkPlan('Prospect Decode', sessionId, 'user-1');

      expect(chatbotDb.updateSessionWorkPlan).toHaveBeenCalledWith(
        sessionId,
        expect.objectContaining({
          steps: expect.arrayContaining([
            expect.objectContaining({
              stepCount: 1,
              inputRequest: expect.objectContaining({
                title: 'Who and why',
                fields: expect.arrayContaining([expect.objectContaining({ id: 'prospect' })]),
              }),
            }),
          ]),
        })
      );
    });

    it('ENG-1765: surfaces the launched plan\'s first pending inputRequest step immediately, not just reactively', async () => {
      mockWorkPlanService.getWorkPlansByVisibility.mockImplementation(async (v: any) =>
        v === 'system' ? [templateWithInputRequest] : []
      );

      await service.applyPredefinedWorkPlan('Prospect Decode', sessionId, 'user-1');

      expect(chatbotDb.updateSessionWorkPlanInputRequest).toHaveBeenCalledWith(
        sessionId,
        expect.objectContaining({ stepCount: 1 }),
        { failIfAwaitingExists: true }
      );
    });

    it('ENG-1765: does not call updateSessionWorkPlanInputRequest when no step has an inputRequest', async () => {
      mockWorkPlanService.getWorkPlansByVisibility.mockImplementation(async (v: any) =>
        v === 'system' ? [systemTemplate] : []
      );

      await service.applyPredefinedWorkPlan('Client Onboarding', sessionId, 'user-1');

      expect(chatbotDb.updateSessionWorkPlanInputRequest).not.toHaveBeenCalled();
    });

    it('ENG-1765: a guard failure (a genuinely still-awaiting prior input request) does not fail the launch', async () => {
      // chatbotService returns null (not a throw) when failIfAwaitingExists guards
      // the write off -- the launch must not surface a new card in that case, but
      // must still succeed rather than clobbering the still-active prior request.
      mockWorkPlanService.getWorkPlansByVisibility.mockImplementation(async (v: any) =>
        v === 'system' ? [templateWithInputRequest] : []
      );
      (chatbotDb.updateSessionWorkPlanInputRequest as jest.Mock).mockResolvedValue(null);

      const result = await service.applyPredefinedWorkPlan('Prospect Decode', sessionId, 'user-1');

      expect(result.success).toBe(true);
      expect(chatbotDb.updateSessionWorkPlanInputRequest).toHaveBeenCalledWith(
        sessionId,
        expect.objectContaining({ stepCount: 1 }),
        { failIfAwaitingExists: true }
      );
      // ENG-1765 follow-up: a silent server log isn't enough -- the model must
      // be told so it can ask conversationally instead of nobody ever asking.
      expect(result.message).toContain('Who and why');
      expect(result.message).toContain('ask the user for this information directly');
    });

    it('ENG-1765: a real error surfacing the input request is logged and swallowed, not thrown, and the model is told', async () => {
      mockWorkPlanService.getWorkPlansByVisibility.mockImplementation(async (v: any) =>
        v === 'system' ? [templateWithInputRequest] : []
      );
      (chatbotDb.updateSessionWorkPlanInputRequest as jest.Mock).mockRejectedValue(new Error('transient dynamo error'));
      const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);

      const result = await service.applyPredefinedWorkPlan('Prospect Decode', sessionId, 'user-1');

      expect(result.success).toBe(true);
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        'AgentMode: Error surfacing input request for launched work plan:',
        expect.any(Error)
      );
      expect(result.message).toContain('ask the user for this information directly');
      consoleErrorSpy.mockRestore();
    });

    it('ENG-1765: does not add the not-surfaced note when the input request surfaces successfully', async () => {
      mockWorkPlanService.getWorkPlansByVisibility.mockImplementation(async (v: any) =>
        v === 'system' ? [templateWithInputRequest] : []
      );
      (chatbotDb.updateSessionWorkPlanInputRequest as jest.Mock).mockResolvedValue({ sessionId });

      const result = await service.applyPredefinedWorkPlan('Prospect Decode', sessionId, 'user-1');

      expect(result.message).not.toContain('ask the user for this information directly');
    });

    it('auto-installs the union of all step skills upfront', async () => {
      mockWorkPlanService.getWorkPlansByVisibility.mockImplementation(async (v: any) =>
        v === 'system' ? [systemTemplate] : []
      );

      await service.applyPredefinedWorkPlan('Client Onboarding', sessionId, 'user-1');

      expect(chatbotDb.addAssociatedSkills).toHaveBeenCalledTimes(1);
      const [, skillsArg] = (chatbotDb.addAssociatedSkills as jest.Mock).mock.calls[0];
      expect([...skillsArg].sort()).toEqual(['skill-a', 'skill-b']);
    });

    it('applies the plan default model when supported', async () => {
      mockWorkPlanService.getWorkPlansByVisibility.mockImplementation(async (v: any) =>
        v === 'system' ? [systemTemplate] : []
      );

      await service.applyPredefinedWorkPlan('Client Onboarding', sessionId, 'user-1');

      expect(chatbotDb.updateSessionLlmModel).toHaveBeenCalledWith(sessionId, 'anthropic.claude-sonnet-4-6');
    });

    it('ENG-1698: resets calledFunctions so a predefined-plan launch does not inherit stale tool-call credit', async () => {
      mockWorkPlanService.getWorkPlansByVisibility.mockImplementation(async (v: any) =>
        v === 'system' ? [systemTemplate] : []
      );
      (chatbotDb.getChatSession as jest.Mock).mockResolvedValue({
        sessionId,
        messages: [],
        // Leftover credit from a completely unrelated earlier plan/run on this session.
        calledFunctions: { read_brand_guidelines: 3 },
      });
      (chatbotDb.updateCalledFunctions as jest.Mock).mockResolvedValue(undefined);

      await service.applyPredefinedWorkPlan('Client Onboarding', sessionId, 'user-1');

      expect(chatbotDb.updateCalledFunctions).toHaveBeenCalledWith(sessionId, {});
    });

    it('ENG-903: refuses the launch (nothing applied) when the plan default is unsupported', async () => {
      const planWithBadModel = { ...systemTemplate, defaultModel: 'not-a-real-model' };
      mockWorkPlanService.getWorkPlansByVisibility.mockImplementation(async (v: any) =>
        v === 'system' ? [planWithBadModel] : []
      );

      const result = await service.applyPredefinedWorkPlan('Client Onboarding', sessionId, 'user-1');

      expect(result.success).toBe(false);
      expect(result.errorType).toBe('model_unavailable');
      expect(chatbotDb.updateSessionWorkPlan).not.toHaveBeenCalled();
      expect(chatbotDb.updateSessionLlmModel).not.toHaveBeenCalled();
    });

    it('returns not-found for an unknown template', async () => {
      const result = await service.applyPredefinedWorkPlan('Nonexistent Plan', sessionId, 'user-1');

      expect(result.success).toBe(false);
      expect(result.message).toContain('not found');
      expect(chatbotDb.updateSessionWorkPlan).not.toHaveBeenCalled();
    });

    // ENG-1993: not-found must be recoverable (suggestions + list tool pointer)
    // and must never auto-launch a guessed template.
    it('returns planId suggestions for a near-miss name without launching anything', async () => {
      mockWorkPlanService.getWorkPlansByVisibility.mockImplementation(async (v: any) =>
        v === 'system' ? [systemTemplate] : []
      );
      const result = await service.applyPredefinedWorkPlan('Onboarding for new client', sessionId, 'user-1');

      expect(result.success).toBe(false);
      expect(result.errorType).toBe('not_found');
      expect(result.suggestions).toEqual([{ planId: 'plan-onboard', title: 'Client Onboarding' }]);
      expect(result.message).toContain('plan-onboard');
      expect(result.message).toContain('Do not retry with the same name');
      expect(chatbotDb.updateSessionWorkPlan).not.toHaveBeenCalled();
    });

    it('points at list_predefined_work_plans when nothing is similar', async () => {
      mockWorkPlanService.getWorkPlansByVisibility.mockImplementation(async (v: any) =>
        v === 'system' ? [systemTemplate] : []
      );
      const result = await service.applyPredefinedWorkPlan('Zzz Qqq', sessionId, 'user-1');

      expect(result.suggestions).toEqual([]);
      expect(result.message).toContain('list_predefined_work_plans');
    });

    it('refuses to overwrite an active work plan without force', async () => {
      (chatbotDb.getChatSession as jest.Mock).mockResolvedValue({
        sessionId,
        messages: [],
        workPlan: { title: 'In Progress', steps: [{ stepCount: 1, title: 'x', status: 'pending' }] },
      });
      mockWorkPlanService.getWorkPlansByVisibility.mockImplementation(async (v: any) =>
        v === 'system' ? [systemTemplate] : []
      );

      const result = await service.applyPredefinedWorkPlan('Client Onboarding', sessionId, 'user-1');

      expect(result.success).toBe(false);
      expect(result.requiresConfirmation).toBe(true);
      expect(chatbotDb.updateSessionWorkPlan).not.toHaveBeenCalled();
    });

    it('overwrites an active work plan when force=true', async () => {
      (chatbotDb.getChatSession as jest.Mock).mockResolvedValue({
        sessionId,
        messages: [],
        workPlan: { title: 'In Progress', steps: [{ stepCount: 1, title: 'x', status: 'pending' }] },
      });
      mockWorkPlanService.getWorkPlansByVisibility.mockImplementation(async (v: any) =>
        v === 'system' ? [systemTemplate] : []
      );

      const result = await service.applyPredefinedWorkPlan('Client Onboarding', sessionId, 'user-1', { force: true });

      expect(result.success).toBe(true);
      expect(chatbotDb.updateSessionWorkPlan).toHaveBeenCalled();
    });

    // ENG-1974: "Keep chatting" leaves no backend signal at all that a
    // recommendation was declined, so the LLM could self-launch it via
    // launch_predefined_work_plan on an ordinary next message (live-confirmed
    // on env1, twice). This is the deterministic backstop — recommendationId
    // is sha256(sessionId:planId), so it's recomputed here for the RESOLVED
    // planId and checked against the session's declinedWorkPlanRecommendations
    // map, correlating exactly regardless of whether the tool call used a
    // title or a planId.
    describe('ENG-1974: declined-recommendation gate', () => {
      // sha256('sess-1:plan-onboard').slice(0, 32) — the exact value
      // recommendPredefinedWorkPlan computes for this sessionId/planId pair.
      const declinedRecommendationId = '3f2882e76b0fdaca653d4df08fc53874';

      beforeEach(() => {
        mockWorkPlanService.getWorkPlansByVisibility.mockImplementation(async (v: any) =>
          v === 'system' ? [systemTemplate] : []
        );
      });

      it('blocks launching a plan the user already declined, asking for confirmation instead', async () => {
        (chatbotDb.getChatSession as jest.Mock).mockResolvedValue({
          sessionId,
          messages: [],
          declinedWorkPlanRecommendations: {
            [declinedRecommendationId]: { planId: 'plan-onboard', planTitle: 'Client Onboarding', declinedAt: '2026-09-17T00:00:00.000Z' },
          },
        });

        const result = await service.applyPredefinedWorkPlan('Client Onboarding', sessionId, 'user-1');

        expect(result.success).toBe(false);
        expect(result.requiresConfirmation).toBe(true);
        expect(chatbotDb.updateSessionWorkPlan).not.toHaveBeenCalled();
      });

      it('the SAME declined plan resolved by planId (not title) is blocked identically — the hash correlates on the resolved planId, not the tool argument form', async () => {
        (chatbotDb.getChatSession as jest.Mock).mockResolvedValue({
          sessionId,
          messages: [],
          declinedWorkPlanRecommendations: {
            [declinedRecommendationId]: { planId: 'plan-onboard', planTitle: 'Client Onboarding', declinedAt: '2026-09-17T00:00:00.000Z' },
          },
        });

        const result = await service.applyPredefinedWorkPlan('plan-onboard', sessionId, 'user-1');

        expect(result.success).toBe(false);
        expect(result.requiresConfirmation).toBe(true);
        expect(chatbotDb.updateSessionWorkPlan).not.toHaveBeenCalled();
      });

      it('unblocked when confirmedDeclinedPlan=true', async () => {
        (chatbotDb.getChatSession as jest.Mock).mockResolvedValue({
          sessionId,
          messages: [],
          declinedWorkPlanRecommendations: {
            [declinedRecommendationId]: { planId: 'plan-onboard', planTitle: 'Client Onboarding', declinedAt: '2026-09-17T00:00:00.000Z' },
          },
        });

        const result = await service.applyPredefinedWorkPlan('Client Onboarding', sessionId, 'user-1', { confirmedDeclinedPlan: true });

        expect(result.success).toBe(true);
        expect(chatbotDb.updateSessionWorkPlan).toHaveBeenCalled();
      });

      // The accept endpoint's own explicit click must never be blocked by an
      // earlier decline of any recommendation.
      it('unaffected when skipDeclineGate=true (the accept-endpoint path)', async () => {
        (chatbotDb.getChatSession as jest.Mock).mockResolvedValue({
          sessionId,
          messages: [],
          declinedWorkPlanRecommendations: {
            [declinedRecommendationId]: { planId: 'plan-onboard', planTitle: 'Client Onboarding', declinedAt: '2026-09-17T00:00:00.000Z' },
          },
        });

        const result = await service.applyPredefinedWorkPlan('Client Onboarding', sessionId, 'user-1', { skipDeclineGate: true });

        expect(result.success).toBe(true);
        expect(chatbotDb.updateSessionWorkPlan).toHaveBeenCalled();
      });

      it('a genuinely undeclined plan launches normally even when the map has an unrelated entry', async () => {
        (chatbotDb.getChatSession as jest.Mock).mockResolvedValue({
          sessionId,
          messages: [],
          declinedWorkPlanRecommendations: {
            'some-other-hash': { planId: 'plan-other', planTitle: 'Some Other Plan', declinedAt: '2026-09-17T00:00:00.000Z' },
          },
        });

        const result = await service.applyPredefinedWorkPlan('Client Onboarding', sessionId, 'user-1');

        expect(result.success).toBe(true);
        expect(chatbotDb.updateSessionWorkPlan).toHaveBeenCalled();
      });
    });

    it('blocks anonymous users from applying a private plan', async () => {
      const privatePlan = { ...systemTemplate, planId: 'priv-1', visibility: 'private' };
      // Anonymous: only system/public are searched; force a private plan into the public list
      // to prove the visibility guard still rejects it.
      mockWorkPlanService.getWorkPlansByVisibility.mockImplementation(async (v: any) =>
        v === 'public' ? [privatePlan] : []
      );

      const result = await service.applyPredefinedWorkPlan('Client Onboarding', sessionId, 'anon_123');

      expect(result.success).toBe(false);
      expect(result.message).toContain('Not authorized');
    });

    it('returns session-not-found when the session is missing', async () => {
      (chatbotDb.getChatSession as jest.Mock).mockResolvedValue(null);

      const result = await service.applyPredefinedWorkPlan('Client Onboarding', sessionId, 'user-1');

      expect(result.success).toBe(false);
      expect(result.message).toContain('Session not found');
    });

    // ENG-1472: extraction characterization — the private/org/system/public
    // candidate-building duplication now lives in predefinedWorkPlanResolver.ts.
    // This proves applyPredefinedWorkPlan actually calls through the extracted
    // resolver (not a re-inlined copy) and that the resulting session work plan
    // is stamped with templatePlanId so future template runs are traceable
    // (also exercised via the accept endpoint, which reuses this same method).
    it('resolves candidates through the extracted predefinedWorkPlanResolver module', async () => {
      const candidatesSpy = jest.spyOn(predefinedWorkPlanResolver, 'getAccessiblePredefinedWorkPlanCandidates')
        .mockResolvedValue([systemTemplate]);

      const result = await service.applyPredefinedWorkPlan('Client Onboarding', sessionId, 'user-1');

      expect(candidatesSpy).toHaveBeenCalledWith('user-1');
      expect(result.success).toBe(true);
      candidatesSpy.mockRestore();
    });

    it('stamps templatePlanId on the instantiated session work plan', async () => {
      mockWorkPlanService.getWorkPlansByVisibility.mockImplementation(async (v: any) =>
        v === 'system' ? [systemTemplate] : []
      );

      await service.applyPredefinedWorkPlan('Client Onboarding', sessionId, 'user-1');

      expect(chatbotDb.updateSessionWorkPlan).toHaveBeenCalledWith(
        sessionId,
        expect.objectContaining({ templatePlanId: 'plan-onboard' })
      );
    });

    it('stamps templatePlanId even when launched by planId directly (the accept-endpoint path)', async () => {
      mockWorkPlanService.getWorkPlansByVisibility.mockImplementation(async (v: any) =>
        v === 'system' ? [systemTemplate] : []
      );

      await service.applyPredefinedWorkPlan('plan-onboard', sessionId, 'user-1');

      expect(chatbotDb.updateSessionWorkPlan).toHaveBeenCalledWith(
        sessionId,
        expect.objectContaining({ templatePlanId: 'plan-onboard', title: 'Client Onboarding' })
      );
    });

    // ENG-1794: two real production templates, byte-identical welcomeMessage,
    // titles differing only by the "_Eval"/"_Audit" suffix. Live-confirmed
    // production bug: asking for the Eval template's title in natural
    // (spaced, mixed-case) phrasing launched the Audit template instead, with
    // no error. Root cause was that the previous match was
    // `.toLowerCase()`-only against the stored underscore-joined title, so
    // this natural phrasing never matched on the first call at all; the
    // resulting "not found" pushed the caller into a fallback path (grepping
    // the full plan listing) where the wrong near-duplicate title could be
    // picked up and then matched exactly. See
    // normalizeWorkPlanTitleForMatch in agentModeService.ts.
    describe('ENG-1794: near-duplicate titles sharing an identical welcomeMessage', () => {
      const linkedInEval: any = {
        ...systemTemplate,
        planId: 'plan-linkedin-eval',
        title: 'Founder_Linkedin_Sales_Readiness_Eval',
        welcomeMessage: "Let's assess your LinkedIn sales readiness.",
      };
      const linkedInAudit: any = {
        ...systemTemplate,
        planId: 'plan-linkedin-audit',
        title: 'Founder_Linkedin_Sales_Readiness_Audit',
        welcomeMessage: "Let's assess your LinkedIn sales readiness.",
      };

      beforeEach(() => {
        mockWorkPlanService.getWorkPlansByVisibility.mockImplementation(async (v: any) =>
          v === 'system' ? [linkedInEval, linkedInAudit] : []
        );
      });

      // ENG-1814 (2026-09-08): title-matching correctness (this describe block's own
      // subject) is no longer sufficient by itself -- a genuinely CORRECT normalized-title
      // match can still be the WRONG template if the model picked that title while
      // confused by a near-duplicate sibling upstream (the live-reproduced ENG-1814
      // incident: asked for Audit, model's own tool argument said Eval, and the matcher
      // correctly launched exactly what it was given). These two tests used to assert a
      // direct launch; now that a same-word-count, one-word-different sibling exists in
      // the accessible set for BOTH titles, applyPredefinedWorkPlan asks for confirmation
      // instead, regardless of which of the two was requested. See the "ENG-1814" describe
      // block below for the dedicated ambiguity-guard coverage.
      it('ENG-1814: a near-duplicate sibling now blocks even a normalized-correct Eval match, asking for confirmation instead of launching', async () => {
        const result = await service.applyPredefinedWorkPlan('Founder LinkedIn Sales Readiness Eval', sessionId, 'user-1');

        expect(result.success).toBe(false);
        expect(result.requiresConfirmation).toBe(true);
        expect(chatbotDb.updateSessionWorkPlan).not.toHaveBeenCalled();
      });

      it('ENG-1814: a near-duplicate sibling now blocks even a normalized-correct Audit match, asking for confirmation instead of launching', async () => {
        const result = await service.applyPredefinedWorkPlan('Founder LinkedIn Sales Readiness Audit', sessionId, 'user-1');

        expect(result.success).toBe(false);
        expect(result.requiresConfirmation).toBe(true);
        expect(chatbotDb.updateSessionWorkPlan).not.toHaveBeenCalled();
      });

      it('ENG-1814: once disambiguated, launching by planId bypasses the ambiguity guard entirely', async () => {
        const result = await service.applyPredefinedWorkPlan('plan-linkedin-eval', sessionId, 'user-1');

        expect(result.success).toBe(true);
        expect(chatbotDb.updateSessionWorkPlan).toHaveBeenCalledWith(
          sessionId,
          expect.objectContaining({ templatePlanId: 'plan-linkedin-eval', title: 'Founder_Linkedin_Sales_Readiness_Eval' })
        );
      });
    });

    // ENG-1794 regression guard (title-matching correctness), retained: the sibling pair
    // whose welcomeMessage text DIFFERS between templates still resolves correctly via
    // normalizeWorkPlanTitleForMatch on the first call -- title-normalization itself
    // still works exactly as ENG-1794 fixed it.
    //
    // ENG-1814 update (2026-09-08): differing welcomeMessage text does NOT make this pair
    // safe from the ambiguity guard -- the model never reads welcomeMessage while
    // confusing two titles during a list/search detour, so this pair is exactly as
    // dangerous as the LinkedIn one from that specific failure mode's perspective. This
    // test's own premise (differing content = no extra disambiguation needed) no longer
    // holds and is updated accordingly, per CLAUDE.md: an invariant that no longer applies
    // is updated with the reason recorded, not quietly forced green.
    it('ENG-1794/1814: title-normalization still resolves the GTM pair correctly, but the ambiguity guard now requires confirmation before launching either one', async () => {
      const gtmEval: any = {
        ...systemTemplate,
        planId: 'plan-gtm-eval',
        title: 'AI_GTM_Position_Eval',
        welcomeMessage: "Let's evaluate your GTM positioning.",
      };
      const gtmAudit: any = {
        ...systemTemplate,
        planId: 'plan-gtm-audit',
        title: 'AI_GTM_Position_Audit',
        welcomeMessage: "Let's audit your GTM positioning.",
      };
      mockWorkPlanService.getWorkPlansByVisibility.mockImplementation(async (v: any) =>
        v === 'system' ? [gtmEval, gtmAudit] : []
      );

      const result = await service.applyPredefinedWorkPlan('AI GTM Position Eval', sessionId, 'user-1');

      expect(result.success).toBe(false);
      expect(result.requiresConfirmation).toBe(true);
      expect(chatbotDb.updateSessionWorkPlan).not.toHaveBeenCalled();

      // The retry-by-planId escape hatch still works for this pair too.
      const retried = await service.applyPredefinedWorkPlan('plan-gtm-eval', sessionId, 'user-1');
      expect(retried.success).toBe(true);
      expect(chatbotDb.updateSessionWorkPlan).toHaveBeenCalledWith(
        sessionId,
        expect.objectContaining({ templatePlanId: 'plan-gtm-eval', title: 'AI_GTM_Position_Eval' })
      );
    });

    // ENG-1814: the ambiguity guard must not over-trigger on templates that are simply
    // unrelated -- only a same-word-count, exactly-one-word-different sibling counts.
    describe('ENG-1814: ambiguity guard does not fire on genuinely distinct templates', () => {
      it('launches directly when no other accessible template has a similar title at all', async () => {
        mockWorkPlanService.getWorkPlansByVisibility.mockImplementation(async (v: any) =>
          v === 'system' ? [systemTemplate, templateWithInputRequest] : []
        );

        const result = await service.applyPredefinedWorkPlan('Client Onboarding', sessionId, 'user-1');

        expect(result.success).toBe(true);
        expect(result.requiresConfirmation).toBeUndefined();
      });

      it('does not flag two titles that differ in MORE than one word as near-duplicates', async () => {
        const planA: any = { ...systemTemplate, planId: 'plan-a', title: 'Weekly_Product_Updates_Eval' };
        const planB: any = { ...systemTemplate, planId: 'plan-b', title: 'Monthly_Sales_Report_Audit' };
        mockWorkPlanService.getWorkPlansByVisibility.mockImplementation(async (v: any) =>
          v === 'system' ? [planA, planB] : []
        );

        const result = await service.applyPredefinedWorkPlan('Weekly Product Updates Eval', sessionId, 'user-1');

        expect(result.success).toBe(true);
        expect(result.requiresConfirmation).toBeUndefined();
      });

      it('does not flag two titles with a different word count as near-duplicates', async () => {
        const planA: any = { ...systemTemplate, planId: 'plan-a', title: 'Founder_Linkedin_Sales_Readiness_Eval' };
        const planB: any = { ...systemTemplate, planId: 'plan-b', title: 'Founder_Linkedin_Readiness_Eval' };
        mockWorkPlanService.getWorkPlansByVisibility.mockImplementation(async (v: any) =>
          v === 'system' ? [planA, planB] : []
        );

        const result = await service.applyPredefinedWorkPlan('Founder Linkedin Sales Readiness Eval', sessionId, 'user-1');

        expect(result.success).toBe(true);
        expect(result.requiresConfirmation).toBeUndefined();
      });
    });

    // ENG-1814 round-2 review finding: a DIFFERENT candidate whose normalized title is
    // IDENTICAL (not just one-word-different) is at least as dangerous as a near-duplicate
    // sibling -- normalizeWorkPlanTitleForMatch resolves both equally, and the plain
    // `.find()` that resolves `predefinedPlan` silently picks whichever happens to come
    // first in the candidates array, with zero signal distinguishing intent. Nothing in
    // workPlanService.ts enforces title uniqueness across visibility scopes (e.g. a private
    // plan can share a title with a system plan), so this is a real possibility, not just
    // theoretical.
    it('ENG-1814: also blocks an EXACT-duplicate title across two different planIds, not just a near-duplicate', async () => {
      const planA: any = { ...systemTemplate, planId: 'plan-dup-a', title: 'Weekly_Content_Recap', visibility: 'system' };
      const planB: any = { ...systemTemplate, planId: 'plan-dup-b', title: 'Weekly_Content_Recap', visibility: 'private' };
      mockWorkPlanService.getWorkPlansByVisibility.mockImplementation(async (v: any) =>
        v === 'system' ? [planA] : []
      );
      mockWorkPlanService.getWorkPlansByOwner.mockResolvedValue([planB]);

      const result = await service.applyPredefinedWorkPlan('Weekly Content Recap', sessionId, 'user-1');

      expect(result.success).toBe(false);
      expect(result.requiresConfirmation).toBe(true);
      expect(chatbotDb.updateSessionWorkPlan).not.toHaveBeenCalled();

      // The retry-by-planId escape hatch still works.
      const retried = await service.applyPredefinedWorkPlan('plan-dup-a', sessionId, 'user-1');
      expect(retried.success).toBe(true);
      expect(chatbotDb.updateSessionWorkPlan).toHaveBeenCalledWith(
        sessionId,
        expect.objectContaining({ templatePlanId: 'plan-dup-a' })
      );
    });

    // Round-3 review finding: the near-duplicate half of the ambiguity check
    // already guards against an empty normalized title (areNearDuplicateWorkPlanTitles
    // returns false when both sides normalize to ''), but the exact-duplicate half
    // originally had no equivalent guard -- two unrelated, degenerately-titled
    // (blank/separator-only) templates would normalize to the same '' and falsely
    // pair up as ambiguous siblings. Nothing in workPlanService.ts rejects a blank
    // title on create, so this is reachable, not just theoretical. Fails safe either
    // way (an unwanted confirmation prompt, never a wrong launch) -- this test locks
    // in the fixed, non-blocking behavior.
    it('ENG-1814: does not treat two unrelated blank/separator-only titles as an ambiguous pair', async () => {
      const planA: any = { ...systemTemplate, planId: 'plan-blank-a', title: '   ', visibility: 'system' };
      const planB: any = { ...systemTemplate, planId: 'plan-blank-b', title: '___', visibility: 'private' };
      mockWorkPlanService.getWorkPlansByVisibility.mockImplementation(async (v: any) =>
        v === 'system' ? [planA] : []
      );
      mockWorkPlanService.getWorkPlansByOwner.mockResolvedValue([planB]);

      const result = await service.applyPredefinedWorkPlan('   ', sessionId, 'user-1');

      // Whichever candidate the resolver happens to order first is fine to launch
      // directly here -- the point of this test is that it launches at all (no
      // false "ambiguous" block), not which of the two degenerately-titled plans wins.
      expect(result.success).toBe(true);
      expect(result.requiresConfirmation).toBeUndefined();
      expect(chatbotDb.updateSessionWorkPlan).toHaveBeenCalledWith(
        sessionId,
        expect.objectContaining({ templatePlanId: expect.stringMatching(/^plan-blank-[ab]$/) })
      );
    });
  });
});
