// ENG-844: A scheduled run that legitimately short-circuits on a conditional
// guard (e.g. a "publish only Mon/Wed/Fri" schedule running on a non-publishing
// day) must exit cleanly as a SUCCESSFUL skip — not be retried against unmet
// write-call minimums (post_on_connected_account / generate_image), which pressures
// irreversible publishing and eventually trips the anti-loop override.

// Mock all dependencies before importing the controller (mirrors the
// minFunctionCalls test harness so runScheduledChat can run fully mocked).
jest.mock('../services/subscriptionService', () => ({
  getAllowedFunctionCalls: jest.fn(async () => [
    'generate_image',
    'post_on_connected_account',
    'read_brand_guidelines',
    'read_market_strategy',
    'create_work_plan',
    'modify_work_plan',
    'set_work_plan_status',
  ]),
}));

jest.mock('../services/chatbotService', () => ({
  chatbotDb: {
    createChatSession: jest.fn(),
    getChatSession: jest.fn(),
    addMessageToSession: jest.fn(),
    addMessagesToSession: jest.fn(),
    updateSessionTitle: jest.fn(),
    updateSessionLlmModel: jest.fn(),
    getMessagesFromMessagesTable: jest.fn(),
  },
}));

jest.mock('../services/agentModeService', () => ({
  agentModeService: {
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
    createSchedule: jest.fn(),
    updateSchedule: jest.fn(),
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

import { chatbotDb } from '../services/chatbotService';
import { agentModeService } from '../services/agentModeService';
import { scheduleDb } from '../services/db';
import { generateMarketingResponseWorkerService } from '../services/generateMarketingResponseWorkerService';
import {
  runScheduledChat,
  scheduledRunSignalsConditionalSkip,
} from '../controllers/agentModeController';

const mockChatbotDb = chatbotDb as jest.Mocked<typeof chatbotDb>;
const mockAgentModeService = agentModeService as jest.Mocked<typeof agentModeService>;
const mockScheduleDb = scheduleDb as jest.Mocked<typeof scheduleDb>;
const mockWorker = generateMarketingResponseWorkerService as jest.Mocked<typeof generateMarketingResponseWorkerService>;

describe('scheduledRunSignalsConditionalSkip', () => {
  it('detects explicit non-publishing-day / whole-run skip declarations', () => {
    const positives = [
      'Today is Sunday, a non-publishing day. Skipping — no post created.',
      'This is not a publishing day, so I am skipping today.',
      'Nothing to publish today per the Mon/Wed/Fri cadence.',
      'No post today; the schedule only publishes Monday, Wednesday, and Friday.',
      'Per the guardrail I am creating and publishing nothing this run.',
      'Today is a rest day for this schedule.',
    ];
    positives.forEach((c) => expect(scheduledRunSignalsConditionalSkip(c)).toBe(true));
  });

  it('does NOT fire on a normal publishing turn or a partial-progress admission', () => {
    const negatives = [
      'I published today\'s LinkedIn post and generated the accompanying image.',
      'Here is the drafted post for review before publishing.',
      'I skipped the remaining three leads and will continue next run.', // partial, not whole-run skip
      'I could not access LinkedIn, so the post was not published.',
      '',
      undefined as unknown as string,
    ];
    negatives.forEach((c) => expect(scheduledRunSignalsConditionalSkip(c)).toBe(false));
  });
});

describe('runScheduledChat — conditional skip day', () => {
  const mockUserId = 'test-user-123';
  const mockScheduleId = 'test-schedule-lucas';

  // A daily schedule that publishes only Mon/Wed/Fri and requires write calls.
  const publishSchedule = {
    scheduleId: mockScheduleId,
    scheduleName: 'LUCAS — LinkedIn Thought Leadership (Mon/Wed/Fri)',
    startingMessage: 'Publish today\'s thought-leadership post only on Mon/Wed/Fri.',
    keywords: [],
    requiredFunctionCalls: ['generate_image', 'post_on_connected_account'],
    functionCallMinCalls: {
      generate_image: 1,
      post_on_connected_account: 1,
    },
    userId: mockUserId,
  };

  const mockSession = {
    sessionId: 'test-session-lucas',
    userId: mockUserId,
    title: 'Scheduled: LUCAS',
    messages: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockChatbotDb.createChatSession.mockResolvedValue(mockSession);
    mockChatbotDb.getChatSession.mockResolvedValue(mockSession);
    (mockChatbotDb as any).getMessagesFromMessagesTable.mockResolvedValue([]);
    mockChatbotDb.updateSessionLlmModel.mockResolvedValue(mockSession);
    mockAgentModeService.getDefaultModel.mockResolvedValue(mockAgentModeService.default_model);
    mockAgentModeService.getScheduledChatsDefaultModel.mockResolvedValue(mockAgentModeService.default_model);
    mockAgentModeService.getMarketingSystemPrompt.mockResolvedValue('System prompt');
    mockAgentModeService.generateSessionTitle.mockResolvedValue('Generated Title');
    mockScheduleDb.addRunResult.mockResolvedValue(undefined);
    mockScheduleDb.getScheduleById.mockResolvedValue(publishSchedule);
    mockScheduleDb.getSchedulesReadyToRun.mockResolvedValue([]);
    mockScheduleDb.updateScheduleAfterRun.mockResolvedValue(undefined);
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it('records a SUCCESSFUL skip without retrying for the unmet write calls', async () => {
    // The agent correctly identifies a non-publishing day and produces zero write calls.
    mockWorker.runInWorker.mockResolvedValue({
      content: 'Today is Sunday, a non-publishing day. Skipping today — no image generated and nothing published.',
      toolCalls: [],
      knowledgeBaseQueries: [],
      sources: [],
      responseMessages: [],
    });

    const result = await runScheduledChat(publishSchedule, mockUserId, true);

    // The run must NOT be retried 20 times pressing for post_on_connected_account /
    // generate_image — it should exit on the first attempt as a clean skip.
    expect(mockWorker.runInWorker).toHaveBeenCalledTimes(1);
    expect(result).toEqual(
      expect.objectContaining({
        scheduleId: mockScheduleId,
        status: 'success',
        passed: true,
        attempt: 1,
        functionCallMisses: [],
      })
    );
  });

  it('still retries when the run does NOT signal a skip (write calls genuinely missing)', async () => {
    // No skip language: the run just failed to make its required write calls. This
    // must retain the existing retry-until-maxAttempts behavior (failure), proving
    // the skip carve-out does not swallow genuinely-incomplete runs.
    mockWorker.runInWorker.mockResolvedValue({
      content: 'Here is a draft of the LinkedIn post for today.',
      toolCalls: [],
      knowledgeBaseQueries: [],
      sources: [],
      responseMessages: [],
    });

    const result = await runScheduledChat(publishSchedule, mockUserId, true);

    expect(mockWorker.runInWorker).toHaveBeenCalledTimes(20);
    expect(result).toEqual(
      expect.objectContaining({
        scheduleId: mockScheduleId,
        status: 'failure',
        passed: false,
        attempt: 20,
      })
    );
  });
});
