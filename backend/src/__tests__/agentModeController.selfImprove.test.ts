import { Request, Response } from 'express';

// Mock all dependencies before importing the controller
jest.mock('../services/subscriptionService', () => ({
  getAllowedFunctionCalls: jest.fn(async () => [
    'get_marketing_tips',
    'analyze_competitors',
  ]),
  getAllowedSkills: jest.fn(async () => ['*']),
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
    updateSessionError: jest.fn(),
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
    generateScheduledChatSummary: jest.fn(),
    getFoundationToolNames: jest.fn().mockReturnValue(new Set([
      'install_skills', 'search_web',
    ])),
    getAdminToolNames: jest.fn().mockReturnValue([]),
  },
}));

jest.mock('../services/generateMarketingResponseWorkerService', () => ({
  generateMarketingResponseWorkerService: {
    runInWorker: jest.fn(),
  },
}));

jest.mock('../services/db', () => ({
  scheduleDb: {
    createSchedule: jest.fn(),
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
    getSchedulesByUserId: jest.fn(),
  },
  userDb: {
    getUserById: jest.fn(),
  },
  taskDb: {
    getTaskExecutionById: jest.fn(),
    createTaskExecution: jest.fn(),
    updateTaskExecution: jest.fn(),
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

jest.mock('../services/skillService', () => ({
  skillService: {
    getPublishedSkills: jest.fn().mockResolvedValue([]),
  },
}));

import { chatbotDb } from '../services/chatbotService';
import { agentModeService } from '../services/agentModeService';
import { scheduleDb, userDb } from '../services/db';
import { generateMarketingResponseWorkerService } from '../services/generateMarketingResponseWorkerService';
import {
  agentModeController,
  runScheduledChat,
  runScheduleSelfImprovement,
  SCHEDULE_PROMPT_REVISION_LIMIT,
} from '../controllers/agentModeController';

const mockChatbotDb = chatbotDb as jest.Mocked<typeof chatbotDb>;
const mockAgentModeService = agentModeService as jest.Mocked<typeof agentModeService>;
const mockScheduleDb = scheduleDb as jest.Mocked<typeof scheduleDb>;
const mockUserDb = userDb as jest.Mocked<typeof userDb>;
const mockWorker = generateMarketingResponseWorkerService as jest.Mocked<typeof generateMarketingResponseWorkerService>;

describe('runScheduleSelfImprovement', () => {
  const baseSchedule = {
    scheduleId: 'sched-1',
    scheduleName: 'Test',
    startingMessage: 'Original prompt',
    selfImprove: true,
    userId: 'user-1',
  };
  const baseSession = {
    sessionId: 'sess-1',
    userId: 'user-1',
    messages: [],
    portalType: 'agent',
    sessionType: 'scheduled',
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockChatbotDb.getChatSession.mockResolvedValue(baseSession as any);
    (mockChatbotDb as any).getMessagesFromMessagesTable.mockResolvedValue([]);
    mockChatbotDb.addMessageToSession.mockResolvedValue(undefined as any);
    mockChatbotDb.addMessagesToSession.mockResolvedValue(undefined as any);
    mockAgentModeService.getMarketingSystemPrompt.mockResolvedValue('System prompt');
    mockWorker.runInWorker.mockResolvedValue({
      content: 'Reflected. No change needed.',
      toolCalls: [],
      knowledgeBaseQueries: [],
      sources: [],
      responseMessages: [],
    } as any);
  });

  // SUCCESS: sends a reflection turn referencing the update tool and this schedule id.
  // It does NOT write the prompt itself — Emma does that via manage_scheduled_chat.
  it('sends a reflection message that tells Emma to use manage_scheduled_chat for this schedule', async () => {
    await runScheduleSelfImprovement({
      schedule: baseSchedule,
      sessionId: 'sess-1',
      userId: 'user-1',
      llmModel: 'gpt-5-chat-2',
    });

    expect(mockWorker.runInWorker).toHaveBeenCalledTimes(1);
    const sentMessage = mockWorker.runInWorker.mock.calls[0][0].messageContent as string;
    expect(sentMessage).toContain('manage_scheduled_chat');
    expect(sentMessage).toContain('sched-1');
    expect(sentMessage).toContain('{{variables}}');
  });
});

describe('runScheduledChat self-improve trigger', () => {
  const mockUserId = 'test-user-123';
  const mockScheduleId = 'test-schedule-123';

  const baseSchedule = {
    scheduleId: mockScheduleId,
    scheduleName: 'Test Schedule',
    startingMessage: 'Hello, please help me with marketing',
    keywords: ['marketing', 'strategy'],
    requiredFunctionCalls: ['get_marketing_tips', 'analyze_competitors'],
    userId: mockUserId,
    nextRunTime: new Date().toISOString(),
  };

  const mockSession = {
    sessionId: 'test-session-123',
    userId: mockUserId,
    title: 'Test Session',
    messages: [],
    portalType: 'agent',
    sessionType: 'scheduled',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  const mockResponse = {
    content: 'Here are some marketing strategy tips.',
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
    mockAgentModeService.getScheduledChatsDefaultModel.mockResolvedValue('gpt-5-chat-2');
    mockChatbotDb.createChatSession.mockResolvedValue(mockSession as any);
    mockChatbotDb.getChatSession.mockResolvedValue(mockSession as any);
    (mockChatbotDb as any).getMessagesFromMessagesTable.mockResolvedValue([]);
    mockChatbotDb.updateSessionLlmModel.mockResolvedValue(mockSession as any);
    mockChatbotDb.addMessageToSession.mockResolvedValue(undefined as any);
    mockChatbotDb.addMessagesToSession.mockResolvedValue(undefined as any);
    mockAgentModeService.getMarketingSystemPrompt.mockResolvedValue('System prompt');
    mockAgentModeService.generateScheduledChatSummary.mockResolvedValue('Summary' as any);
    mockWorker.runInWorker.mockResolvedValue(mockResponse as any);
    mockScheduleDb.addRunResult.mockResolvedValue(undefined as any);
    mockUserDb.getUserById.mockResolvedValue({ userId: mockUserId, email: 'owner@example.com' } as any);
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  // The number of worker turns the main run itself consumes (the verified-chat attempt).
  // With keywords+functions satisfied on attempt 1, the main run uses exactly one turn,
  // so a reflection turn shows up as one ADDITIONAL worker call.
  const expectReflectionMessageSent = () => {
    const reflectionCall = mockWorker.runInWorker.mock.calls.find(
      (c) => typeof c[0]?.messageContent === 'string' && c[0].messageContent.includes('manage_scheduled_chat')
    );
    return reflectionCall;
  };

  // SUCCESS: real run with selfImprove on sends a reflection turn
  it('runs the reflection turn on a real run when selfImprove is on', async () => {
    await runScheduledChat({ ...baseSchedule, selfImprove: true }, mockUserId, false);
    expect(expectReflectionMessageSent()).toBeDefined();
  });

  // SUCCESS: test runs ALSO self-improve so the feature is easy to try
  it('runs the reflection turn on a test run when selfImprove is on', async () => {
    await runScheduledChat({ ...baseSchedule, selfImprove: true }, mockUserId, true);
    expect(expectReflectionMessageSent()).toBeDefined();
  });

  // FAIL: selfImprove off → never reflect
  it('does not run the reflection turn when selfImprove is off', async () => {
    await runScheduledChat({ ...baseSchedule, selfImprove: false }, mockUserId, false);
    expect(expectReflectionMessageSent()).toBeUndefined();
  });
});

describe('updateScheduledChat prompt revision history', () => {
  const mockUserId = 'rev-user-1';

  const makeRes = () => {
    const res: Partial<Response> = {};
    res.status = jest.fn().mockReturnValue(res) as any;
    res.json = jest.fn().mockReturnValue(res) as any;
    return res as Response;
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockScheduleDb.updateSchedule.mockResolvedValue(undefined as any);
  });

  // SUCCESS: changing the prompt snapshots the PREVIOUS prompt into promptRevisions
  it('records the previous prompt when startingMessage changes', async () => {
    mockScheduleDb.getScheduleById.mockResolvedValue({
      scheduleId: 'sched-rev',
      userId: mockUserId,
      scheduleName: 'S',
      startingMessage: 'old prompt',
      frequency: 'daily',
      emailNotifications: ['owner@example.com'],
    } as any);

    const req = {
      user: { userId: mockUserId, email: 'owner@example.com' },
      params: { scheduleId: 'sched-rev' },
      body: { startingMessage: 'new prompt' },
    } as unknown as Request;

    await agentModeController.updateScheduledChat(req, makeRes());

    const updates = mockScheduleDb.updateSchedule.mock.calls[0][1] as any;
    expect(updates.startingMessage).toBe('new prompt');
    expect(updates.promptRevisions).toEqual([
      { startingMessage: 'old prompt', updatedAt: expect.any(String) },
    ]);
  });

  // FAIL: no prompt change → no revision recorded
  it('does not record a revision when the prompt is unchanged', async () => {
    mockScheduleDb.getScheduleById.mockResolvedValue({
      scheduleId: 'sched-rev',
      userId: mockUserId,
      scheduleName: 'S',
      startingMessage: 'same prompt',
      frequency: 'daily',
      emailNotifications: ['owner@example.com'],
    } as any);

    const req = {
      user: { userId: mockUserId, email: 'owner@example.com' },
      params: { scheduleId: 'sched-rev' },
      body: { description: 'just a description change' },
    } as unknown as Request;

    await agentModeController.updateScheduledChat(req, makeRes());

    const updates = mockScheduleDb.updateSchedule.mock.calls[0][1] as any;
    expect(updates.promptRevisions).toBeUndefined();
  });

  // SUCCESS: revisions are capped at the most recent SCHEDULE_PROMPT_REVISION_LIMIT
  it('keeps only the most recent revisions when over the limit', async () => {
    // Pre-fill with exactly the limit so adding one more must drop the oldest.
    const existingRevisions = Array.from({ length: SCHEDULE_PROMPT_REVISION_LIMIT }, (_, i) => ({
      startingMessage: `rev ${i}`,
      updatedAt: new Date(2026, 0, i + 1).toISOString(),
    }));

    mockScheduleDb.getScheduleById.mockResolvedValue({
      scheduleId: 'sched-rev',
      userId: mockUserId,
      scheduleName: 'S',
      startingMessage: 'current prompt',
      frequency: 'daily',
      emailNotifications: ['owner@example.com'],
      promptRevisions: existingRevisions,
    } as any);

    const req = {
      user: { userId: mockUserId, email: 'owner@example.com' },
      params: { scheduleId: 'sched-rev' },
      body: { startingMessage: 'newest prompt' },
    } as unknown as Request;

    await agentModeController.updateScheduledChat(req, makeRes());

    const updates = mockScheduleDb.updateSchedule.mock.calls[0][1] as any;
    expect(updates.promptRevisions).toHaveLength(SCHEDULE_PROMPT_REVISION_LIMIT);
    // Oldest ("rev 0") dropped; newest entry is the just-replaced "current prompt".
    expect(updates.promptRevisions[0].startingMessage).toBe('rev 1');
    expect(updates.promptRevisions[SCHEDULE_PROMPT_REVISION_LIMIT - 1].startingMessage).toBe('current prompt');
  });
});

describe('createScheduledChat / updateScheduledChat selfImprove persistence', () => {
  const mockUserId = 'user-create-1';

  const makeRes = () => {
    const res: Partial<Response> = {};
    res.status = jest.fn().mockReturnValue(res) as any;
    res.json = jest.fn().mockReturnValue(res) as any;
    return res as Response;
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockScheduleDb.createSchedule.mockResolvedValue(undefined as any);
    mockScheduleDb.updateSchedule.mockResolvedValue(undefined as any);
  });

  // SUCCESS: create persists selfImprove === true
  it('persists selfImprove=true on create', async () => {
    const req = {
      user: { userId: mockUserId, email: 'owner@example.com' },
      body: {
        scheduleName: 'S',
        startingMessage: 'do the thing',
        scheduleFrequency: 'daily',
        selfImprove: true,
        emailNotifications: ['owner@example.com'],
      },
    } as unknown as Request;

    await agentModeController.createScheduledChat(req, makeRes());

    expect(mockScheduleDb.createSchedule).toHaveBeenCalledWith(
      expect.objectContaining({ selfImprove: true })
    );
  });

  // SUCCESS: create defaults selfImprove to false when omitted
  it('defaults selfImprove to false on create when omitted', async () => {
    const req = {
      user: { userId: mockUserId, email: 'owner@example.com' },
      body: {
        scheduleName: 'S',
        startingMessage: 'do the thing',
        scheduleFrequency: 'daily',
        emailNotifications: ['owner@example.com'],
      },
    } as unknown as Request;

    await agentModeController.createScheduledChat(req, makeRes());

    expect(mockScheduleDb.createSchedule).toHaveBeenCalledWith(
      expect.objectContaining({ selfImprove: false })
    );
  });

  // SUCCESS: update toggles selfImprove on
  it('persists selfImprove on update', async () => {
    mockScheduleDb.getScheduleById.mockResolvedValue({
      scheduleId: 'sched-x',
      userId: mockUserId,
      scheduleName: 'S',
      startingMessage: 'do the thing',
      frequency: 'daily',
      emailNotifications: ['owner@example.com'],
      selfImprove: false,
    } as any);

    const req = {
      user: { userId: mockUserId, email: 'owner@example.com' },
      params: { scheduleId: 'sched-x' },
      body: { selfImprove: true },
    } as unknown as Request;

    await agentModeController.updateScheduledChat(req, makeRes());

    expect(mockScheduleDb.updateSchedule).toHaveBeenCalledWith(
      'sched-x',
      expect.objectContaining({ selfImprove: true })
    );
  });

  // SUCCESS: update preserves existing selfImprove when omitted
  it('preserves existing selfImprove on update when omitted', async () => {
    mockScheduleDb.getScheduleById.mockResolvedValue({
      scheduleId: 'sched-y',
      userId: mockUserId,
      scheduleName: 'S',
      startingMessage: 'do the thing',
      frequency: 'daily',
      emailNotifications: ['owner@example.com'],
      selfImprove: true,
    } as any);

    const req = {
      user: { userId: mockUserId, email: 'owner@example.com' },
      params: { scheduleId: 'sched-y' },
      body: { description: 'updated desc' },
    } as unknown as Request;

    await agentModeController.updateScheduledChat(req, makeRes());

    expect(mockScheduleDb.updateSchedule).toHaveBeenCalledWith(
      'sched-y',
      expect.objectContaining({ selfImprove: true })
    );
  });
});

describe('createScheduledChat / updateScheduledChat fullAutonomy persistence (ENG-396)', () => {
  const mockUserId = 'user-create-2';

  const makeRes = () => {
    const res: Partial<Response> = {};
    res.status = jest.fn().mockReturnValue(res) as any;
    res.json = jest.fn().mockReturnValue(res) as any;
    return res as Response;
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockScheduleDb.createSchedule.mockResolvedValue(undefined as any);
    mockScheduleDb.updateSchedule.mockResolvedValue(undefined as any);
  });

  it('persists fullAutonomy=true on create', async () => {
    const req = {
      user: { userId: mockUserId, email: 'owner@example.com' },
      body: {
        scheduleName: 'S', startingMessage: 'do the thing', scheduleFrequency: 'daily',
        fullAutonomy: true, emailNotifications: ['owner@example.com'],
      },
    } as unknown as Request;

    await agentModeController.createScheduledChat(req, makeRes());

    expect(mockScheduleDb.createSchedule).toHaveBeenCalledWith(
      expect.objectContaining({ fullAutonomy: true })
    );
  });

  it('defaults fullAutonomy to false on create when omitted (safe default)', async () => {
    const req = {
      user: { userId: mockUserId, email: 'owner@example.com' },
      body: {
        scheduleName: 'S', startingMessage: 'do the thing', scheduleFrequency: 'daily',
        emailNotifications: ['owner@example.com'],
      },
    } as unknown as Request;

    await agentModeController.createScheduledChat(req, makeRes());

    expect(mockScheduleDb.createSchedule).toHaveBeenCalledWith(
      expect.objectContaining({ fullAutonomy: false })
    );
  });

  it('persists fullAutonomy on update', async () => {
    mockScheduleDb.getScheduleById.mockResolvedValue({
      scheduleId: 'sched-a', userId: mockUserId, scheduleName: 'S', startingMessage: 'do the thing',
      frequency: 'daily', emailNotifications: ['owner@example.com'], fullAutonomy: false,
    } as any);

    const req = {
      user: { userId: mockUserId, email: 'owner@example.com' },
      params: { scheduleId: 'sched-a' },
      body: { fullAutonomy: true },
    } as unknown as Request;

    await agentModeController.updateScheduledChat(req, makeRes());

    expect(mockScheduleDb.updateSchedule).toHaveBeenCalledWith(
      'sched-a',
      expect.objectContaining({ fullAutonomy: true })
    );
  });

  it('preserves existing fullAutonomy on update when omitted', async () => {
    mockScheduleDb.getScheduleById.mockResolvedValue({
      scheduleId: 'sched-b', userId: mockUserId, scheduleName: 'S', startingMessage: 'do the thing',
      frequency: 'daily', emailNotifications: ['owner@example.com'], fullAutonomy: true,
    } as any);

    const req = {
      user: { userId: mockUserId, email: 'owner@example.com' },
      params: { scheduleId: 'sched-b' },
      body: { description: 'updated desc' },
    } as unknown as Request;

    await agentModeController.updateScheduledChat(req, makeRes());

    expect(mockScheduleDb.updateSchedule).toHaveBeenCalledWith(
      'sched-b',
      expect.objectContaining({ fullAutonomy: true })
    );
  });
});
