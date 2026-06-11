import { AgentModeService } from '../services/agentModeService';
import { chatbotDb } from '../services/chatbotService';
import { workPlanService } from '../services/workPlanService';

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

    it('does not change the model when the plan default is unsupported', async () => {
      const planWithBadModel = { ...systemTemplate, defaultModel: 'not-a-real-model' };
      mockWorkPlanService.getWorkPlansByVisibility.mockImplementation(async (v: any) =>
        v === 'system' ? [planWithBadModel] : []
      );

      await service.applyPredefinedWorkPlan('Client Onboarding', sessionId, 'user-1');

      expect(chatbotDb.updateSessionLlmModel).not.toHaveBeenCalled();
    });

    it('returns not-found for an unknown template', async () => {
      const result = await service.applyPredefinedWorkPlan('Nonexistent Plan', sessionId, 'user-1');

      expect(result.success).toBe(false);
      expect(result.message).toContain('not found');
      expect(chatbotDb.updateSessionWorkPlan).not.toHaveBeenCalled();
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
  });
});
