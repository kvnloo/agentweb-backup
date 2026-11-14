import { Request, Response } from 'express';

// Mock all dependencies before importing the controller
// Mock subscriptionService so subscription checks always pass in tests
jest.mock('../services/subscriptionService', () => ({
  getAllowedFunctionCalls: jest.fn(async () => [
    'get_marketing_tips',
    'analyze_competitors',
    'create_work_plan',
    'modify_work_plan',
    'set_work_plan_status',
  ]),
  isSubscriptionFeatureEnabled: jest.fn(async () => true),
}));

jest.mock('../services/chatbotService', () => ({
  chatbotDb: {
    createChatSession: jest.fn(),
    getChatSession: jest.fn(),
    addMessageToSession: jest.fn(),
    addMessagesToSession: jest.fn(),
    updateSessionTitle: jest.fn(),
    updateSessionLlmModel: jest.fn(),
    updateSessionWorkPlan: jest.fn(),
    getMessagesFromMessagesTable: jest.fn(),
  },
}));

jest.mock('../services/agentModeService', () => ({
  agentModeService: {
    // ENG-892: model resolution is orthogonal to what this suite asserts —
    // pass the requested id through unchanged.
    resolveGenerationModel: jest.fn((model: string) => ({ model, fellBack: false, requestedModel: model })),
    default_model: 'gpt-5-chat-2',
    getDefaultModel: jest.fn(),
    getScheduledChatsDefaultModel: jest.fn(),
    getMarketingSystemPrompt: jest.fn(),
    generateSessionTitle: jest.fn(),
    generateMarketingResponse: jest.fn(),
    getFoundationToolNames: jest.fn().mockReturnValue(new Set([
      'install_skills', 'search_web', 'read_file_content', 'read_page_source',
      'search_knowledge_base', 'list_knowledge_base_files', 'read_knowledge_base_files',
      'create_work_plan', 'modify_work_plan', 'set_work_plan_status',
      'save_file', 'describe_image',
    ])),
    getAdminToolNames: jest.fn().mockReturnValue([
      'list_predefined_work_plans', 'manage_predefined_work_plan',
      'list_skills', 'manage_skill', 'get_chat_history',
    ]),
  },
}));

jest.mock('../services/generateMarketingResponseWorkerService', () => ({
  generateMarketingResponseWorkerService: {
    runInWorker: jest.fn(),
    releaseSessionClients: jest.fn(),
  },
}));

jest.mock('../services/db', () => ({
  scheduleDb: {
    addRunResult: jest.fn(),
    getScheduleById: jest.fn(),
    getSchedulesReadyToRun: jest.fn(),
    updateScheduleAfterRun: jest.fn(),
    setRunInFlight: jest.fn().mockResolvedValue('acquired'),
    heartbeatRunInFlight: jest.fn().mockResolvedValue(undefined),
    clearRunInFlight: jest.fn().mockResolvedValue(true),
    getInFlightSchedules: jest.fn().mockResolvedValue([]),
    claimAbandonedRun: jest.fn().mockResolvedValue(true),
    updateSchedule: jest.fn(),
  },
  taskDb: {
    getTaskExecutionById: jest.fn(),
    createTaskExecution: jest.fn(),
    updateTaskExecution: jest.fn(),
  },
  userDb: {
    getUserById: jest.fn().mockResolvedValue({ userId: 'test-user-1', email: 'test@example.com', isAdmin: false }),
  },
}));

jest.mock('uuid', () => ({
  v4: jest.fn(() => 'mock-run-id-123'),
}));

jest.mock('../services/emailService', () => ({
  emailService: {
    sendScheduledChatResultEmail: jest.fn(),
    sendDailyDigestEmail: jest.fn(),
    sendScheduledChatVariableRequestEmail: jest.fn(),
    sendScheduledChatErrorEmail: jest.fn(),
    sendScheduledChatTokenLimitEmail: jest.fn(),
  },
}));

jest.mock('../services/tokenUsageService', () => ({
  checkTokenUsage: jest.fn(async () => ({
    allowed: true,
    warning: false,
    used: 100000,
    allowance: 1000000,
    bonus: 0,
    effectiveAllowance: 1000000,
    percentUsed: 10,
    month: '2026-04',
  })),
}));

// Import mocked services
import { chatbotDb } from '../services/chatbotService';
import { agentModeService } from '../services/agentModeService';
import { scheduleDb, taskDb } from '../services/db';
import { generateMarketingResponseWorkerService } from '../services/generateMarketingResponseWorkerService';
import { agentModeController, runScheduledChat, runVerifiedChat } from '../controllers/agentModeController';

const mockChatbotDb = chatbotDb as jest.Mocked<typeof chatbotDb>;
const mockAgentModeService = agentModeService as jest.Mocked<typeof agentModeService>;
const mockScheduleDb = scheduleDb as jest.Mocked<typeof scheduleDb>;
const mockTaskDb = taskDb as jest.Mocked<typeof taskDb>;
const mockGenerateMarketingResponseWorkerService = generateMarketingResponseWorkerService as jest.Mocked<typeof generateMarketingResponseWorkerService>;

describe('AgentModeController - Scheduled Chat with Work Plan', () => {
  const mockUserId = 'test-user-123';
  const mockScheduleId = 'test-schedule-123';
  
  const baseSchedule = {
    scheduleId: mockScheduleId,
    scheduleName: 'Test Schedule',
    startingMessage: 'Hello, please help me with marketing',
    keywords: ['marketing', 'strategy'],
    requiredFunctionCalls: ['get_marketing_tips', 'analyze_competitors'],
    userId: mockUserId,
  };

  const mockSession = {
    sessionId: 'test-session-123',
    userId: mockUserId,
    title: 'Test Session',
    messages: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  const mockResponse = {
    content: 'Here are some marketing strategies and tips for your business.',
    toolCalls: [
      { name: 'get_marketing_tips', arguments: {} },
      { name: 'analyze_competitors', arguments: {} },
    ],
    knowledgeBaseQueries: [],
    sources: [],
    responseMessages: [],
  };

  beforeEach(() => {
    jest.clearAllMocks();
    
    // Setup default mocks
    mockChatbotDb.createChatSession.mockResolvedValue(mockSession);
    mockChatbotDb.getChatSession.mockResolvedValue(mockSession);
    (mockChatbotDb as any).getMessagesFromMessagesTable.mockResolvedValue([]);
    mockChatbotDb.updateSessionLlmModel.mockResolvedValue(mockSession);
    mockAgentModeService.getDefaultModel.mockResolvedValue(mockAgentModeService.default_model);
    mockAgentModeService.getScheduledChatsDefaultModel.mockResolvedValue(mockAgentModeService.default_model);
    mockAgentModeService.getMarketingSystemPrompt.mockResolvedValue('System prompt');
    mockAgentModeService.generateSessionTitle.mockResolvedValue('Generated Title');
    // Use worker service instead of direct generateMarketingResponse
    mockGenerateMarketingResponseWorkerService.runInWorker.mockResolvedValue(mockResponse);
    mockScheduleDb.addRunResult.mockResolvedValue(undefined);
    mockScheduleDb.getScheduleById.mockResolvedValue(baseSchedule);
    mockScheduleDb.getSchedulesReadyToRun.mockResolvedValue([]);
    mockScheduleDb.updateScheduleAfterRun.mockResolvedValue(undefined);
  });

  afterEach(() => {
    // Clean up to prevent memory leaks
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  describe('Work Plan Integration', () => {
    it('should focus on next pending step when work plan exists and is not completed', async () => {
      const workPlan = {
        title: 'Onboarding Plan',
        steps: [
          { stepCount: 1, title: 'Step 1', status: 'completed' as const },
          { stepCount: 2, title: 'Step 2', status: 'pending' as const },
          { stepCount: 3, title: 'Step 3', status: 'pending' as const },
        ],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      const sessionWithWorkPlan = {
        ...mockSession,
        workPlan,
      };

      mockChatbotDb.getChatSession.mockResolvedValue(sessionWithWorkPlan);

      const responseWithWorkPlan = {
        ...mockResponse,
        workPlan,
      };

      let callCount = 0;
      mockGenerateMarketingResponseWorkerService.runInWorker.mockImplementation(() => {
        callCount++;
        return Promise.resolve(responseWithWorkPlan);
      });

      const result = await runScheduledChat(baseSchedule, mockUserId, true);

      // Should have been called multiple times (work plan not completed)
      expect(mockGenerateMarketingResponseWorkerService.runInWorker).toHaveBeenCalledTimes(20);

      // Check that retry messages focus on work plan steps
      const calls = mockGenerateMarketingResponseWorkerService.runInWorker.mock.calls;
      // First call uses starting message
      expect(calls[0][0].messageContent).toBe(baseSchedule.startingMessage);
      // Subsequent calls should remind to complete pending steps
      for (let i = 1; i < calls.length; i++) {
        expect(calls[i][0].messageContent).toContain('Please perform the work on pending steps');
        expect(calls[i][0].messageContent).toContain('set_work_plan_status');
      }

      expect(result).toEqual(
        expect.objectContaining({
          scheduleId: mockScheduleId,
          status: 'failure', // Work plan not completed
          passed: false,
        })
      );
    });

    it.each([
      ['all blocked', ['blocked', 'blocked', 'blocked']],
      ['completed then blocked', ['completed', 'blocked']],
      ['skipped then blocked', ['skipped', 'blocked']],
    ])('stops a terminal %s plan without pressing unavailable prerequisites twenty times', async (_name, statuses) => {
      // Sanitized ENG-2998 trace: no_key prevented guest extraction; downstream
      // steps were blocked too. These are not valid zero-result completions.
      const workPlan = {
        autocomplete: true,
        title: 'Guest extraction fixture',
        steps: statuses.map((status, i) => ({
          stepCount: i + 1, title: 'Repeated step', status,
          notes: status === 'blocked' ? 'connected=false; nothing_pulled=true; reason=no_key' : '',
        })),
      };
      mockChatbotDb.getChatSession.mockResolvedValue({ ...mockSession, workPlan } as any);
      mockGenerateMarketingResponseWorkerService.runInWorker.mockResolvedValue({
        ...mockResponse, workPlan,
        content: 'Guest extraction blocked: no_key. No outreach sent.',
      } as any);
      const result = await runScheduledChat({ ...baseSchedule, keywords: [], requiredFunctionCalls: [] }, mockUserId, true);
      expect(mockGenerateMarketingResponseWorkerService.runInWorker).toHaveBeenCalledTimes(1);
      expect(result).toMatchObject({ status: 'failure', passed: false, attempt: 1 });
      expect(JSON.stringify(result)).toContain('no_key');
      const verified = await runVerifiedChat({
        sessionId: mockSession.sessionId, userId: mockUserId, startingMessage: 'Extract guests',
        keywords: [], requiredFunctions: [], isUnattendedRun: true,
      });
      statuses.forEach((status, i) => {
        if (status === 'blocked') expect(verified.workPlanBlockReason).toContain(`${i + 1} Repeated step:`);
      });
    });

    it.each([
      ['reason: no_key'],
      [['connected=false', 'nothing_pulled=true', 'reason=no_key']],
      [['connected=false', null, 'reason: no_key']],
    ])('stops missing-key prerequisites across observed note shapes: %j', async (notes) => {
      const workPlan = { steps: [{ stepCount: 1, title: 'Extract guests', status: 'blocked', notes }] };
      mockChatbotDb.getChatSession.mockResolvedValue({ ...mockSession, workPlan } as any);
      mockGenerateMarketingResponseWorkerService.runInWorker.mockResolvedValue({ ...mockResponse, content: 'Guest extraction blocked.', workPlan } as any);
      const result = await runScheduledChat({ ...baseSchedule, keywords: [], requiredFunctionCalls: [] }, mockUserId, true);
      expect(mockGenerateMarketingResponseWorkerService.runInWorker).toHaveBeenCalledTimes(1);
      expect(result).toMatchObject({ status: 'failure', passed: false, attempt: 1 });
    });

    it.each(['reason=no_key', 'connected=false; reason=no_key', 'reason: no_key'])(
      'stops from the real schema-valid status writer: %s', async (notes) => {
        const { setWorkPlanStatus } = await import('../emma/impl/workPlans');
        const session = {
          ...mockSession,
          workPlan: { steps: [{ stepCount: 1, title: 'Extract guests', status: 'pending' }] },
        };
        mockChatbotDb.getChatSession.mockResolvedValue(session as any);
        mockChatbotDb.updateSessionWorkPlan.mockImplementation(async (_id, plan) => {
          session.workPlan = plan as any;
          return undefined as any;
        });

        const written = await setWorkPlanStatus([
          { stepCount: 1, status: 'pending', notes },
        ], mockSession.sessionId);
        expect(written.success).toBe(true);
        // A repeated status-only update must not erase the prerequisite before
        // the scheduler reads the real producer's persisted plan.
        const retried = await setWorkPlanStatus([
          { stepCount: 1, status: 'pending' },
        ], mockSession.sessionId);
        expect(retried.success).toBe(true);
        expect(mockChatbotDb.updateSessionWorkPlan).toHaveBeenCalled();
        expect(session.workPlan.steps[0]).toMatchObject({ status: 'pending', notes });
        mockGenerateMarketingResponseWorkerService.runInWorker.mockResolvedValue({
          ...mockResponse, content: 'Guest extraction unavailable.', workPlan: session.workPlan,
        } as any);

        const result = await runScheduledChat({ ...baseSchedule, keywords: [], requiredFunctionCalls: [] }, mockUserId, true);
        expect(result).toMatchObject({ status: 'failure', passed: false, attempt: 1 });
        expect(mockGenerateMarketingResponseWorkerService.runInWorker).toHaveBeenCalledTimes(1);
        const verified = await runVerifiedChat({
          sessionId: mockSession.sessionId, userId: mockUserId, startingMessage: 'Extract guests',
          keywords: [], requiredFunctions: [], isUnattendedRun: true,
        });
        expect(verified.workPlanBlockReason).toContain('1 Extract guests:');
        expect(verified.workPlanBlockReason).toContain('no_key');
      },
    );

    it.each(['reason=no_key; token=private-secret', ['reason=no_key', 'private-secret'], `reason=no_key ${'private-secret'.repeat(1000)}`])(
      'does not forward raw prerequisite notes into failure diagnostics: %j', async notes => {
        const workPlan = { steps: [{ stepCount: 1, title: 'Extract guests', status: 'pending', notes }] };
        mockChatbotDb.getChatSession.mockResolvedValue({ ...mockSession, workPlan } as any);
        mockGenerateMarketingResponseWorkerService.runInWorker.mockResolvedValue({ ...mockResponse, content: 'Unavailable.', workPlan } as any);
        const verified = await runVerifiedChat({ sessionId: mockSession.sessionId, userId: mockUserId,
          startingMessage: 'Extract guests', keywords: [], requiredFunctions: [], isUnattendedRun: true });
        expect(verified.workPlanBlockReason).toBe('1 Extract guests: reason=no_key');
        expect(verified.workPlanBlockReason).not.toContain('private-secret');
      },
    );

    it('scores keyword evidence without crediting a terminal blocked plan as success', async () => {
      const workPlan = { steps: [{ stepCount: 1, title: 'Extract guests', status: 'blocked', notes: 'reason=no_key' }] };
      mockChatbotDb.getChatSession.mockResolvedValue({ ...mockSession, workPlan } as any);
      mockGenerateMarketingResponseWorkerService.runInWorker.mockResolvedValue({ ...mockResponse, content: 'Guest REPORT blocked: reason=no_key.', workPlan } as any);
      const result = await runScheduledChat({ ...baseSchedule, keywords: ['report', 'absent'], requiredFunctionCalls: [] }, mockUserId, true);
      expect(result).toMatchObject({ status: 'failure', passed: false, attempt: 1, keywordMatches: ['report'], keywordMisses: ['absent'] });
      expect(mockGenerateMarketingResponseWorkerService.runInWorker).toHaveBeenCalledTimes(1);
    });

    it.each(['Tool returned 429 rate limited, retry', 'Temporary timeout; retry', 'Blocked; cause unknown'])('retries a blocked step without a proven terminal prerequisite: %s', async (notes) => {
      const blockedPlan = { steps: [{ stepCount: 1, title: 'Extract guests', status: 'blocked', notes }] };
      const completedPlan = { steps: [{ stepCount: 1, title: 'Extract guests', status: 'completed' }] };
      let calls = 0;
      mockChatbotDb.getChatSession.mockImplementation(async () => ({
        ...mockSession, workPlan: calls >= 2 ? completedPlan : blockedPlan,
      } as any));
      mockGenerateMarketingResponseWorkerService.runInWorker.mockImplementation(async () => {
        calls++;
        return { ...mockResponse, content: 'Guest extraction report.', workPlan: calls >= 2 ? completedPlan : blockedPlan } as any;
      });
      const result = await runScheduledChat({ ...baseSchedule, keywords: [], requiredFunctionCalls: [] }, mockUserId, true);
      expect(calls).toBe(2);
      expect(result).toMatchObject({ status: 'success', passed: true, attempt: 2 });
    });

    it.each(['Blocked', ' BLOCKED ', 'pending', ' PENDING ', 'Pending'])('stops a terminal prerequisite with normalized status %s', async (status) => {
      const workPlan = { steps: [{ stepCount: 1, title: 'Extract guests', status, notes: 'reason=no_key' }] };
      mockChatbotDb.getChatSession.mockResolvedValue({ ...mockSession, workPlan } as any);
      mockGenerateMarketingResponseWorkerService.runInWorker.mockResolvedValue({ ...mockResponse, content: 'Guest extraction blocked: reason=no_key.', workPlan } as any);
      const result = await runScheduledChat({ ...baseSchedule, keywords: [], requiredFunctionCalls: [] }, mockUserId, true);
      expect(mockGenerateMarketingResponseWorkerService.runInWorker).toHaveBeenCalledTimes(1);
      expect(result).toMatchObject({ status: 'failure', passed: false, attempt: 1 });
      expect(JSON.stringify(result)).toContain('no_key');
    });

    it.each(['completed', ' COMPLETED ', 'skipped', '\tSkipped\n'])(
      'completes a terminal plan with normalized status %j without mutating it', async (status) => {
        const step = Object.freeze({ stepCount: 1, title: 'Inspect guests', status });
        const workPlan = Object.freeze({ steps: Object.freeze([step]) });
        mockChatbotDb.getChatSession.mockResolvedValue({ ...mockSession, workPlan } as any);
        mockGenerateMarketingResponseWorkerService.runInWorker.mockResolvedValue({
          ...mockResponse, content: 'Guest report.', toolCalls: [], workPlan,
        } as any);

        const result = await runScheduledChat({ ...baseSchedule, keywords: [], requiredFunctionCalls: [] }, mockUserId, true);

        expect(result).toMatchObject({ status: 'success', passed: true, attempt: 1 });
        expect(mockGenerateMarketingResponseWorkerService.runInWorker).toHaveBeenCalledTimes(1);
        expect(workPlan.steps[0].status).toBe(status);
      },
    );

    it('does not waive required-function debt for normalized terminal statuses', async () => {
      const workPlan = {
        steps: [{ stepCount: 1, title: 'Inspect guests', status: ' COMPLETED ' },
          { stepCount: 2, title: 'Optional work', status: ' SKIPPED ' }],
        pendingRequiredFunctionCalls: ['list_html_templates'],
      };
      mockChatbotDb.getChatSession.mockResolvedValue({ ...mockSession, workPlan, calledFunctions: {} } as any);
      mockGenerateMarketingResponseWorkerService.runInWorker.mockResolvedValue({
        ...mockResponse, content: 'Guest report.', toolCalls: [], workPlan, calledFunctions: {},
      } as any);

      const result = await runScheduledChat({ ...baseSchedule, keywords: [], requiredFunctionCalls: [] }, mockUserId, true);

      expect(result).toMatchObject({ status: 'failure', passed: false, attempt: 20 });
      expect(mockGenerateMarketingResponseWorkerService.runInWorker).toHaveBeenCalledTimes(20);
    });

    it('fails when the completion-gate continuation discovers a blocked prerequisite', async () => {
      const donePlan = { steps: [{ stepCount: 1, title: 'Inspect guests', status: 'completed' }] };
      const blockedPlan = { steps: [{ stepCount: 1, title: 'Inspect guests', status: 'blocked', notes: 'reason=no_key' }] };
      let calls = 0;
      mockChatbotDb.getChatSession.mockImplementation(async () => ({
        ...mockSession, workPlan: calls >= 2 ? blockedPlan : donePlan,
      } as any));
      mockGenerateMarketingResponseWorkerService.runInWorker.mockImplementation(async () => {
        calls++;
        return {
          ...mockResponse, toolCalls: [],
          content: calls === 1 ? 'Event 1 done. I did not complete Step 3 for Events 2 and 3.' : 'Guest extraction blocked: no_key.',
          workPlan: calls >= 2 ? blockedPlan : donePlan,
        } as any;
      });
      const result = await runScheduledChat({ ...baseSchedule, keywords: [], requiredFunctionCalls: [] }, mockUserId, true);
      expect(calls).toBe(2);
      expect(result).toMatchObject({ status: 'failure', passed: false, attempt: 2 });
      expect(JSON.stringify(result)).toContain('no_key');
    });

    it.each(['Tool returned 429 rate limited, retry', 'Temporary timeout; retry', 'Blocked; cause unknown'])('does not credit an incomplete completion-gate continuation: %s', async (notes) => {
      const donePlan = { steps: [{ stepCount: 1, title: 'Inspect guests', status: 'completed' }] };
      const blockedPlan = { steps: [{ stepCount: 1, title: 'Inspect guests', status: 'blocked', notes }] };
      let calls = 0;
      mockChatbotDb.getChatSession.mockImplementation(async () => ({
        ...mockSession, workPlan: calls === 2 ? blockedPlan : donePlan,
      } as any));
      mockGenerateMarketingResponseWorkerService.runInWorker.mockImplementation(async () => {
        calls++;
        return {
          ...mockResponse, toolCalls: [],
          content: calls === 1 ? 'Event 1 done. I did not complete Step 3 for Events 2 and 3.' : 'Guest extraction report.',
          workPlan: calls === 2 ? blockedPlan : donePlan,
        } as any;
      });
      const result = await runScheduledChat({ ...baseSchedule, keywords: [], requiredFunctionCalls: [] }, mockUserId, true);
      expect(calls).toBe(3);
      expect(result).toMatchObject({ status: 'success', passed: true, attempt: 3 });
    });

    it('auto-converges an unattended run when a deferred (pending) step finishes on a later attempt', async () => {
      // Models the media-generation time-budget deferral on a scheduled (unattended) run:
      // a long image step leaves step 2 pending for the first couple of attempts (budget
      // deferred mid-batch), then completes once the remaining images are generated. The
      // existing runVerifiedChat retry loop must carry it to completion WITHOUT a human —
      // i.e. no new orchestration is needed for the deferral fix on unattended runs.
      const now = new Date().toISOString();
      const pendingPlan = {
        title: 'Image Batch Plan',
        steps: [
          { stepCount: 1, title: 'Step 1', status: 'completed' as const },
          { stepCount: 2, title: 'Generate images', status: 'pending' as const },
        ],
        createdAt: now,
        updatedAt: now,
      };
      const donePlan = {
        ...pendingPlan,
        steps: [
          { stepCount: 1, title: 'Step 1', status: 'completed' as const },
          { stepCount: 2, title: 'Generate images', status: 'completed' as const },
        ],
      };
      // No keyword / function requirements so success hinges only on the work plan.
      const sched = { ...baseSchedule, keywords: [], requiredFunctionCalls: [] };
      mockScheduleDb.getScheduleById.mockResolvedValue(sched);

      // Pending for the first two attempts (budget deferred mid-batch), completed on the
      // third. The plan status is read back via getChatSession (generateSessionResponse
      // overlays finalSession.workPlan), so drive both the worker and the session off the
      // same counter.
      let call = 0;
      mockGenerateMarketingResponseWorkerService.runInWorker.mockImplementation(() => {
        call++;
        return Promise.resolve({ ...mockResponse, toolCalls: [], workPlan: call >= 3 ? donePlan : pendingPlan });
      });
      mockChatbotDb.getChatSession.mockImplementation(() =>
        Promise.resolve({ ...mockSession, workPlan: call >= 3 ? donePlan : pendingPlan })
      );

      const result = await runScheduledChat(sched, mockUserId, true);

      // Converged on attempt 3 — did NOT exhaust the 20-attempt cap, and no human "continue" was needed.
      expect(call).toBe(3);
      expect(result).toEqual(
        expect.objectContaining({ scheduleId: mockScheduleId, status: 'success', passed: true })
      );
      // Retries used the pending-step continuation message (the unattended auto-continue).
      const calls = mockGenerateMarketingResponseWorkerService.runInWorker.mock.calls;
      expect(calls[1][0].messageContent).toContain('Please perform the work on pending steps');
    });

    it('should check keywords and function calls after work plan is completed', async () => {
      const workPlan = {
        title: 'Onboarding Plan',
        steps: [
          { stepCount: 1, title: 'Step 1', status: 'completed' as const },
          { stepCount: 2, title: 'Step 2', status: 'completed' as const },
          { stepCount: 3, title: 'Step 3', status: 'completed' as const },
        ],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      const sessionWithWorkPlan = {
        ...mockSession,
        workPlan,
      };

      mockChatbotDb.getChatSession.mockResolvedValue(sessionWithWorkPlan);

      const responseWithWorkPlan = {
        ...mockResponse,
        workPlan,
        content: 'Here are some marketing strategy and tips for your business.',
        toolCalls: [
          { name: 'get_marketing_tips', arguments: {} },
          { name: 'analyze_competitors', arguments: {} },
        ],
      };

      mockGenerateMarketingResponseWorkerService.runInWorker.mockResolvedValue(responseWithWorkPlan);

      const result = await runScheduledChat(baseSchedule, mockUserId, true);

      expect(result).toEqual(
        expect.objectContaining({
          scheduleId: mockScheduleId,
          status: 'success',
          passed: true,
          attempt: 1,
          keywordMatches: ['marketing', 'strategy'],
          keywordMisses: [],
          functionCallMatches: ['get_marketing_tips', 'analyze_competitors'],
          functionCallMisses: [],
        })
      );
    });

    it('ENG-1811: does not falsely report a work plan completed when every step is terminal but debt from a removed step is unresolved', async () => {
      // Round-4 fresh-eyes review of PR #2808 found: workPlanCompletedWithoutDebt
      // (the local, controller-side twin of AgentModeService.isWorkPlanFullyResolved,
      // used by this exact scheduled-chat retry loop) was only tested indirectly
      // via the service-level function -- never through this loop itself. This
      // exercises the real regression scenario end-to-end: a plan whose steps all
      // look terminal (the bare .every(...) check the pre-fix code used would say
      // "done"), but pendingRequiredFunctionCalls still lists a function that
      // genuinely never succeeded.
      const debtedWorkPlan = {
        title: 'Onboarding Plan',
        steps: [
          { stepCount: 1, title: 'Step 1', status: 'completed' as const },
        ],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        pendingRequiredFunctionCalls: ['list_html_templates'],
      };

      const sessionWithDebt = {
        ...mockSession,
        workPlan: debtedWorkPlan,
        calledFunctions: {}, // list_html_templates never actually succeeded
      };

      mockChatbotDb.getChatSession.mockResolvedValue(sessionWithDebt);

      const responseWithDebt = {
        ...mockResponse,
        workPlan: debtedWorkPlan,
      };
      mockGenerateMarketingResponseWorkerService.runInWorker.mockResolvedValue(responseWithDebt);

      // No keyword / function requirements so success hinges only on the debt ledger,
      // not on the base schedule's unrelated keyword/function gate.
      const sched = { ...baseSchedule, keywords: [], requiredFunctionCalls: [] };
      mockScheduleDb.getScheduleById.mockResolvedValue(sched);

      const result = await runScheduledChat(sched, mockUserId, true);

      // Must NOT converge early like the fully-completed-plan test above --
      // the outstanding debt keeps workPlanCompleted false for the whole run.
      expect(mockGenerateMarketingResponseWorkerService.runInWorker).toHaveBeenCalledTimes(20);
      expect(result).toEqual(
        expect.objectContaining({
          scheduleId: mockScheduleId,
          status: 'failure',
          passed: false,
        })
      );
    });

    it('ENG-1811: converges once the previously-unresolved debt function genuinely succeeds', async () => {
      const debtedWorkPlan = {
        title: 'Onboarding Plan',
        steps: [
          { stepCount: 1, title: 'Step 1', status: 'completed' as const },
        ],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        pendingRequiredFunctionCalls: ['list_html_templates'],
      };
      // No keyword / function requirements so success hinges only on the debt ledger.
      const sched = { ...baseSchedule, keywords: [], requiredFunctionCalls: [] };
      mockScheduleDb.getScheduleById.mockResolvedValue(sched);

      // The plan's own steps never change -- only calledFunctions does, mirroring
      // a later, separate turn where the model genuinely calls the debt function.
      let call = 0;
      mockGenerateMarketingResponseWorkerService.runInWorker.mockImplementation(() => {
        call++;
        return Promise.resolve({ ...mockResponse, toolCalls: [], workPlan: debtedWorkPlan });
      });
      mockChatbotDb.getChatSession.mockImplementation(() =>
        Promise.resolve({
          ...mockSession,
          workPlan: debtedWorkPlan,
          calledFunctions: (call >= 3 ? { list_html_templates: 1 } : {}) as Record<string, number>,
        })
      );

      const result = await runScheduledChat(sched, mockUserId, true);

      expect(call).toBe(3);
      expect(result).toEqual(
        expect.objectContaining({ scheduleId: mockScheduleId, status: 'success', passed: true })
      );
    });

    it('should progress through work plan steps sequentially', async () => {
      const workPlanStep1 = {
        title: 'Onboarding Plan',
        steps: [
          { stepCount: 1, title: 'Step 1', status: 'pending' as const },
          { stepCount: 2, title: 'Step 2', status: 'pending' as const },
          { stepCount: 3, title: 'Step 3', status: 'pending' as const },
        ],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      const workPlanStep2 = {
        ...workPlanStep1,
        steps: [
          { stepCount: 1, title: 'Step 1', status: 'completed' as const },
          { stepCount: 2, title: 'Step 2', status: 'pending' as const },
          { stepCount: 3, title: 'Step 3', status: 'pending' as const },
        ],
      };

      const workPlanStep3 = {
        ...workPlanStep1,
        steps: [
          { stepCount: 1, title: 'Step 1', status: 'completed' as const },
          { stepCount: 2, title: 'Step 2', status: 'completed' as const },
          { stepCount: 3, title: 'Step 3', status: 'pending' as const },
        ],
      };

      // Track getChatSession calls
      // getChatSession is called: once per attempt for retry message check, and once in generateSessionResponse
      let getChatSessionCallCount = 0;
      mockChatbotDb.getChatSession.mockImplementation(() => {
        getChatSessionCallCount++;
        // For retry message (odd calls after first two): check work plan state
        // For generateSessionResponse (even calls): get session
        if (getChatSessionCallCount === 1) {
          // First call in generateSessionResponse for attempt 1
          return Promise.resolve({ ...mockSession, workPlan: workPlanStep1 });
        } else if (getChatSessionCallCount === 2) {
          // Second call for retry message check (attempt 2)
          // Work plan should be updated from previous response
          return Promise.resolve({ ...mockSession, workPlan: workPlanStep2 });
        } else if (getChatSessionCallCount === 3) {
          // Third call in generateSessionResponse for attempt 2
          return Promise.resolve({ ...mockSession, workPlan: workPlanStep2 });
        } else if (getChatSessionCallCount === 4) {
          // Fourth call for retry message check (attempt 3)
          return Promise.resolve({ ...mockSession, workPlan: workPlanStep3 });
        } else {
          return Promise.resolve({ ...mockSession, workPlan: workPlanStep3 });
        }
      });

      let responseCallCount = 0;
      mockGenerateMarketingResponseWorkerService.runInWorker.mockImplementation(() => {
        responseCallCount++;
        if (responseCallCount === 1) {
          return Promise.resolve({ ...mockResponse, workPlan: workPlanStep2 });
        } else if (responseCallCount === 2) {
          return Promise.resolve({ ...mockResponse, workPlan: workPlanStep3 });
        } else {
          return Promise.resolve({ ...mockResponse, workPlan: workPlanStep3 });
        }
      });

      await runScheduledChat(baseSchedule, mockUserId, true);

      const calls = mockGenerateMarketingResponseWorkerService.runInWorker.mock.calls;
      // First call uses starting message
      expect(calls[0][0].messageContent).toBe(baseSchedule.startingMessage);
      // Second call should remind to complete pending steps
      expect(calls[1][0].messageContent).toContain('Please perform the work on pending steps');
      expect(calls[1][0].messageContent).toContain('set_work_plan_status');
    });

    it('should skip completed and skipped steps to find next pending step', async () => {
      const workPlan = {
        title: 'Onboarding Plan',
        steps: [
          { stepCount: 1, title: 'Step 1', status: 'completed' as const },
          { stepCount: 2, title: 'Step 2', status: 'skipped' as const },
          { stepCount: 3, title: 'Step 3', status: 'pending' as const },
          { stepCount: 4, title: 'Step 4', status: 'pending' as const },
        ],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      const sessionWithWorkPlan = {
        ...mockSession,
        workPlan,
      };

      mockChatbotDb.getChatSession.mockResolvedValue(sessionWithWorkPlan);

      const responseWithWorkPlan = {
        ...mockResponse,
        workPlan,
      };

      mockGenerateMarketingResponseWorkerService.runInWorker.mockResolvedValue(responseWithWorkPlan);

      await runScheduledChat(baseSchedule, mockUserId, true);

      const calls = mockGenerateMarketingResponseWorkerService.runInWorker.mock.calls;
      // Second call should remind to complete pending steps
      expect(calls[1][0].messageContent).toContain('Please perform the work on pending steps');
      expect(calls[1][0].messageContent).toContain('set_work_plan_status');
    });

    it('should work normally when no work plan exists', async () => {
      mockChatbotDb.getChatSession.mockResolvedValue(mockSession);

      const successfulResponse = {
        ...mockResponse,
        content: 'Here are some marketing strategy and tips for your business.',
        toolCalls: [
          { name: 'get_marketing_tips', arguments: {} },
          { name: 'analyze_competitors', arguments: {} },
        ],
      };

      mockGenerateMarketingResponseWorkerService.runInWorker.mockResolvedValue(successfulResponse);

      const result = await runScheduledChat(baseSchedule, mockUserId, true);

      expect(result).toEqual(
        expect.objectContaining({
          scheduleId: mockScheduleId,
          status: 'success',
          passed: true,
          attempt: 1,
          keywordMatches: ['marketing', 'strategy'],
          functionCallMatches: ['get_marketing_tips', 'analyze_competitors'],
        })
      );
    });

    it('should complete successfully when work plan is completed and all requirements are met', async () => {
      const workPlan = {
        title: 'Onboarding Plan',
        steps: [
          { stepCount: 1, title: 'Step 1', status: 'completed' as const },
          { stepCount: 2, title: 'Step 2', status: 'completed' as const },
        ],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      const sessionWithWorkPlan = {
        ...mockSession,
        workPlan,
      };

      mockChatbotDb.getChatSession.mockResolvedValue(sessionWithWorkPlan);

      const responseWithWorkPlan = {
        ...mockResponse,
        workPlan,
        content: 'Here are some marketing strategy and tips for your business.',
        toolCalls: [
          { name: 'get_marketing_tips', arguments: {} },
          { name: 'analyze_competitors', arguments: {} },
        ],
      };

      mockGenerateMarketingResponseWorkerService.runInWorker.mockResolvedValue(responseWithWorkPlan);

      const result = await runScheduledChat(baseSchedule, mockUserId, true);

      expect(result).toEqual(
        expect.objectContaining({
          scheduleId: mockScheduleId,
          status: 'success',
          passed: true,
          attempt: 1,
        })
      );
    });

    it('should fail when work plan is completed but requirements are not met', async () => {
      const workPlan = {
        title: 'Onboarding Plan',
        steps: [
          { stepCount: 1, title: 'Step 1', status: 'completed' as const },
          { stepCount: 2, title: 'Step 2', status: 'completed' as const },
        ],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      const sessionWithWorkPlan = {
        ...mockSession,
        workPlan,
      };

      mockChatbotDb.getChatSession.mockResolvedValue(sessionWithWorkPlan);

      const responseWithWorkPlan = {
        ...mockResponse,
        workPlan,
        content: 'Here are some general business tips.',
        toolCalls: [{ name: 'get_marketing_tips', arguments: {} }], // Missing analyze_competitors
      };

      mockGenerateMarketingResponseWorkerService.runInWorker.mockResolvedValue(responseWithWorkPlan);

      const result = await runScheduledChat(baseSchedule, mockUserId, true);

      // Should retry because requirements not met
      expect(mockGenerateMarketingResponseWorkerService.runInWorker).toHaveBeenCalledTimes(20);

      expect(result).toEqual(
        expect.objectContaining({
          scheduleId: mockScheduleId,
          status: 'failure',
          passed: false,
          attempt: 20,
        })
      );
    });

    it('should handle work plan completion during scheduled chat', async () => {
      const workPlanIncomplete = {
        title: 'Onboarding Plan',
        steps: [
          { stepCount: 1, title: 'Step 1', status: 'pending' as const },
          { stepCount: 2, title: 'Step 2', status: 'pending' as const },
        ],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      const workPlanComplete = {
        ...workPlanIncomplete,
        steps: [
          { stepCount: 1, title: 'Step 1', status: 'completed' as const },
          { stepCount: 2, title: 'Step 2', status: 'completed' as const },
        ],
      };

      let getChatSessionCallCount = 0;
      mockChatbotDb.getChatSession.mockImplementation(() => {
        getChatSessionCallCount++;
        if (getChatSessionCallCount === 1) {
          // First call in generateSessionResponse for attempt 1
          return Promise.resolve({ ...mockSession, workPlan: workPlanIncomplete });
        } else if (getChatSessionCallCount === 2) {
          // Second call for retry message check (attempt 2)
          // Work plan is now complete from previous response
          return Promise.resolve({ ...mockSession, workPlan: workPlanComplete });
        } else {
          return Promise.resolve({ ...mockSession, workPlan: workPlanComplete });
        }
      });

      let responseCallCount = 0;
      mockGenerateMarketingResponseWorkerService.runInWorker.mockImplementation(() => {
        responseCallCount++;
        if (responseCallCount === 1) {
          return Promise.resolve({ 
            ...mockResponse, 
            workPlan: workPlanComplete,
            content: 'Step 1 completed',
          });
        } else {
          return Promise.resolve({ 
            ...mockResponse, 
            workPlan: workPlanComplete,
            content: 'Here are some marketing strategy and tips for your business.',
            toolCalls: [
              { name: 'get_marketing_tips', arguments: {} },
              { name: 'analyze_competitors', arguments: {} },
            ],
          });
        }
      });

      await runScheduledChat(baseSchedule, mockUserId, true);

      const calls = mockGenerateMarketingResponseWorkerService.runInWorker.mock.calls;
      // First call uses starting message
      expect(calls[0][0].messageContent).toBe(baseSchedule.startingMessage);
      // Second call should check keywords and function calls (work plan completed)
      expect(calls[1][0].messageContent).toContain('Please try again');
      expect(calls[1][0].messageContent).toContain('marketing');
    });

    it('should handle empty work plan steps array', async () => {
      const workPlan = {
        title: 'Onboarding Plan',
        steps: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      const sessionWithWorkPlan = {
        ...mockSession,
        workPlan,
      };

      mockChatbotDb.getChatSession.mockResolvedValue(sessionWithWorkPlan);

      const responseWithWorkPlan = {
        ...mockResponse,
        workPlan,
        content: 'Here are some marketing strategy and tips for your business.',
        toolCalls: [
          { name: 'get_marketing_tips', arguments: {} },
          { name: 'analyze_competitors', arguments: {} },
        ],
      };

      mockGenerateMarketingResponseWorkerService.runInWorker.mockResolvedValue(responseWithWorkPlan);

      const result = await runScheduledChat(baseSchedule, mockUserId, true);

      // Empty steps array means work plan is completed (all steps completed)
      expect(result).toEqual(
        expect.objectContaining({
          scheduleId: mockScheduleId,
          status: 'success',
          passed: true,
        })
      );
    });

    it('should handle work plan with all steps skipped', async () => {
      const workPlan = {
        title: 'Onboarding Plan',
        steps: [
          { stepCount: 1, title: 'Step 1', status: 'skipped' as const },
          { stepCount: 2, title: 'Step 2', status: 'skipped' as const },
        ],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      const sessionWithWorkPlan = {
        ...mockSession,
        workPlan,
      };

      mockChatbotDb.getChatSession.mockResolvedValue(sessionWithWorkPlan);

      const responseWithWorkPlan = {
        ...mockResponse,
        workPlan,
        content: 'Here are some marketing strategy and tips for your business.',
        toolCalls: [
          { name: 'get_marketing_tips', arguments: {} },
          { name: 'analyze_competitors', arguments: {} },
        ],
      };

      mockGenerateMarketingResponseWorkerService.runInWorker.mockResolvedValue(responseWithWorkPlan);

      const result = await runScheduledChat(baseSchedule, mockUserId, true);

      // All steps skipped means work plan is completed
      expect(result).toEqual(
        expect.objectContaining({
          scheduleId: mockScheduleId,
          status: 'success',
          passed: true,
        })
      );
    });
  });
});
