/**
 * Tests for admin tool access in scheduled chats.
 * Verifies that scheduled chats with admin-only required function calls
 * auto-install the __admin_tools__ skill, and that non-admin tools
 * don't trigger admin skill installation.
 */
import { Request, Response } from 'express';

// Mock subscriptionService
jest.mock('../services/subscriptionService', () => ({
  getAllowedFunctionCalls: jest.fn(async () => ['*']),
  getAllowedSkills: jest.fn(async () => ['*']),
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
    installSkills: jest.fn().mockResolvedValue({ success: true, installedSkills: [] }),
    getSkillsForDisplay: jest.fn().mockResolvedValue([]),
    getFoundationToolNames: jest.fn().mockReturnValue(new Set([
      'install_skills', 'you_search_web', 'read_file_content', 'read_page_source',
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

// Import mocked services
import { chatbotDb } from '../services/chatbotService';
import { agentModeService } from '../services/agentModeService';
import { scheduleDb, userDb } from '../services/db';
import { generateMarketingResponseWorkerService } from '../services/generateMarketingResponseWorkerService';
import { getAllowedSkills } from '../services/subscriptionService';
import { skillService } from '../services/skillService';
import { agentModeController, runScheduledChat } from '../controllers/agentModeController';

const mockChatbotDb = chatbotDb as jest.Mocked<typeof chatbotDb>;
const mockAgentModeService = agentModeService as jest.Mocked<typeof agentModeService>;
const mockScheduleDb = scheduleDb as jest.Mocked<typeof scheduleDb>;
const mockedGetAllowedSkills = getAllowedSkills as jest.MockedFunction<typeof getAllowedSkills>;
const mockedSkillService = skillService as jest.Mocked<typeof skillService>;
const mockGenerateMarketingResponseWorkerService = generateMarketingResponseWorkerService as jest.Mocked<typeof generateMarketingResponseWorkerService>;

describe('Scheduled Chat - Admin Tool Auto-Install', () => {
  const mockUserId = 'admin-user-123';
  const mockScheduleId = 'test-schedule-admin';

  const mockSession = {
    sessionId: 'test-session-admin',
    userId: mockUserId,
    title: 'Test Session',
    messages: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  const mockRes = {
    json: jest.fn(),
    status: jest.fn().mockReturnThis(),
  } as unknown as Response;

  beforeEach(() => {
    jest.clearAllMocks();

    mockChatbotDb.createChatSession.mockResolvedValue(mockSession);
    mockChatbotDb.getChatSession.mockResolvedValue(mockSession);
    mockChatbotDb.updateSessionLlmModel.mockResolvedValue(mockSession);
    mockAgentModeService.getDefaultModel.mockResolvedValue(mockAgentModeService.default_model);
    mockAgentModeService.getScheduledChatsDefaultModel.mockResolvedValue(mockAgentModeService.default_model);
    mockScheduleDb.addRunResult.mockResolvedValue(undefined);
    mockedGetAllowedSkills.mockResolvedValue(['*']);
    mockedSkillService.getPublishedSkills.mockResolvedValue([]);
    // Schedule owner must exist (and be admin, since these tests exercise admin tools)
    (userDb.getUserById as jest.Mock).mockResolvedValue({
      userId: mockUserId,
      email: 'owner@example.com',
      isAdmin: true,
    });
  });

  // ─── FAIL tests: non-admin tools should NOT install __admin_tools__ ───

  it('should NOT install __admin_tools__ when required functions are non-admin tools', async () => {
    const schedule = {
      scheduleId: mockScheduleId,
      scheduleName: 'Non-Admin Schedule',
      startingMessage: 'Run marketing analysis',
      keywords: ['marketing'],
      requiredFunctionCalls: ['you_search_web'],
      userId: mockUserId,
    };

    const publishedSkills = [
      { skillId: 'web-skill', name: 'Web', toolNames: ['you_search_web'] },
    ];
    mockedSkillService.getPublishedSkills.mockResolvedValue(publishedSkills as any);

    mockGenerateMarketingResponseWorkerService.runInWorker.mockResolvedValue({
      content: 'Done',
      toolCalls: [{ name: 'you_search_web', arguments: {} }],
      knowledgeBaseQueries: [],
      sources: [],
      responseMessages: [],
    });

    await runScheduledChat(schedule, mockUserId, true);

    const installedIds = (mockAgentModeService.installSkills as jest.Mock).mock.calls[0]?.[0] || [];
    expect(installedIds).not.toContain('__admin_tools__');
  });

  it('should NOT install __admin_tools__ when no required functions are specified', async () => {
    const schedule = {
      scheduleId: mockScheduleId,
      scheduleName: 'Simple Schedule',
      startingMessage: 'Hello',
      keywords: [],
      requiredFunctionCalls: [],
      userId: mockUserId,
    };

    mockGenerateMarketingResponseWorkerService.runInWorker.mockResolvedValue({
      content: 'Hello!',
      toolCalls: [],
      knowledgeBaseQueries: [],
      sources: [],
      responseMessages: [],
    });

    await runScheduledChat(schedule, mockUserId, true);

    expect(mockAgentModeService.installSkills).not.toHaveBeenCalled();
  });

  it('should NOT install __admin_tools__ when required functions are only in __other_skills__', async () => {
    const schedule = {
      scheduleId: mockScheduleId,
      scheduleName: 'Other Tools Schedule',
      startingMessage: 'Run some tasks',
      keywords: [],
      requiredFunctionCalls: ['some_custom_tool'],
      userId: mockUserId,
    };

    // No published skills have this tool
    mockedSkillService.getPublishedSkills.mockResolvedValue([]);

    mockGenerateMarketingResponseWorkerService.runInWorker.mockResolvedValue({
      content: 'Done',
      toolCalls: [{ name: 'some_custom_tool', arguments: {} }],
      knowledgeBaseQueries: [],
      sources: [],
      responseMessages: [],
    });

    await runScheduledChat(schedule, mockUserId, true);

    const installedIds = (mockAgentModeService.installSkills as jest.Mock).mock.calls[0][0];
    expect(installedIds).toContain('__other_skills__');
    expect(installedIds).not.toContain('__admin_tools__');
  });

  // ─── SUCCESS tests: admin tools should install __admin_tools__ ───

  it('should install __admin_tools__ when required functions include an admin tool', async () => {
    const schedule = {
      scheduleId: mockScheduleId,
      scheduleName: 'Admin Schedule',
      startingMessage: 'Get chat history',
      keywords: [],
      requiredFunctionCalls: ['get_chat_history'],
      userId: mockUserId,
    };

    mockGenerateMarketingResponseWorkerService.runInWorker.mockResolvedValue({
      content: 'Here is the chat history.',
      toolCalls: [{ name: 'get_chat_history', arguments: {} }],
      knowledgeBaseQueries: [],
      sources: [],
      responseMessages: [],
    });

    await runScheduledChat(schedule, mockUserId, true);

    expect(mockAgentModeService.installSkills).toHaveBeenCalled();
    const installedIds = (mockAgentModeService.installSkills as jest.Mock).mock.calls[0][0];
    expect(installedIds).toContain('__admin_tools__');
  });

  it('should install __admin_tools__ alongside other skills when both admin and non-admin tools are required', async () => {
    const schedule = {
      scheduleId: mockScheduleId,
      scheduleName: 'Mixed Schedule',
      startingMessage: 'Manage skills and analyze',
      keywords: [],
      requiredFunctionCalls: ['list_skills', 'analyze_competitors'],
      userId: mockUserId,
    };

    const publishedSkills = [
      { skillId: 'research-skill', name: 'Research', toolNames: ['analyze_competitors'] },
    ];
    mockedSkillService.getPublishedSkills.mockResolvedValue(publishedSkills as any);

    mockGenerateMarketingResponseWorkerService.runInWorker.mockResolvedValue({
      content: 'Done with skills and analysis.',
      toolCalls: [
        { name: 'list_skills', arguments: {} },
        { name: 'analyze_competitors', arguments: {} },
      ],
      knowledgeBaseQueries: [],
      sources: [],
      responseMessages: [],
    });

    await runScheduledChat(schedule, mockUserId, true);

    expect(mockAgentModeService.installSkills).toHaveBeenCalled();
    const installedIds = (mockAgentModeService.installSkills as jest.Mock).mock.calls[0][0];
    expect(installedIds).toContain('__admin_tools__');
    expect(installedIds).toContain('research-skill');
  });

  it('should not classify admin tools as __other_skills__', async () => {
    const schedule = {
      scheduleId: mockScheduleId,
      scheduleName: 'Admin-Only Schedule',
      startingMessage: 'Manage work plans',
      keywords: [],
      requiredFunctionCalls: ['manage_predefined_work_plan'],
      userId: mockUserId,
    };

    // No published skills
    mockedSkillService.getPublishedSkills.mockResolvedValue([]);

    mockGenerateMarketingResponseWorkerService.runInWorker.mockResolvedValue({
      content: 'Work plans managed.',
      toolCalls: [{ name: 'manage_predefined_work_plan', arguments: {} }],
      knowledgeBaseQueries: [],
      sources: [],
      responseMessages: [],
    });

    await runScheduledChat(schedule, mockUserId, true);

    expect(mockAgentModeService.installSkills).toHaveBeenCalled();
    const installedIds = (mockAgentModeService.installSkills as jest.Mock).mock.calls[0][0];
    // Admin tools go to __admin_tools__, not __other_skills__
    expect(installedIds).toContain('__admin_tools__');
    expect(installedIds).not.toContain('__other_skills__');
  });
});
