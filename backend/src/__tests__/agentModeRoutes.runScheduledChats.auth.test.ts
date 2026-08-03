/**
 * ENG-347 — route-level tests: POST /api/agent-mode/run-scheduled-chats must
 * require the x-service-secret shared secret.
 *
 * Uses the REAL router + REAL middleware + REAL controller (service deps
 * mocked, same mock set as agentModeController.scheduledChat.test.ts), so
 * these assertions cover the actual route wiring — middleware registered
 * before the handler — not a re-declaration of it.
 *
 * Behavioral contract (from the Linear issue, human-reviewed — DO NOT MODIFY):
 *   1. POST /api/agent-mode/run-scheduled-chats without a valid credential
 *      returns 401 and executes nothing.
 *   2. The agent-engine path keeps working: request with the shared secret
 *      header executes due schedules exactly as today.
 *   3. A test covers both: unauthenticated → 401 + zero schedule executions;
 *      authenticated → schedules fire.
 */

// Mock all heavy dependencies before importing the router (mirrors
// agentModeController.scheduledChat.test.ts).
jest.mock('../services/subscriptionService', () => ({
  getAllowedFunctionCalls: jest.fn(async () => ['get_marketing_tips']),
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
    generateScheduledChatSummary: jest.fn(),
    installSkills: jest.fn().mockResolvedValue({ success: true, installedSkills: [] }),
    getSkillsForDisplay: jest.fn().mockResolvedValue([]),
    getFoundationToolNames: jest.fn().mockReturnValue(new Set(['create_work_plan'])),
    getAdminToolNames: jest.fn().mockReturnValue(['list_skills']),
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
    updateSchedule: jest.fn(),
    getSchedulesByUserId: jest.fn(),
    setRunInFlight: jest.fn().mockResolvedValue('acquired'),
    attachSessionToRunInFlight: jest.fn().mockResolvedValue(true),
    heartbeatRunInFlight: jest.fn().mockResolvedValue(undefined),
    clearRunInFlight: jest.fn().mockResolvedValue(true),
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
  ...jest.requireActual('../services/tokenUsageService'),
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

jest.mock('../utils/agentModeAlerts', () => ({
  sendAgentModeOncallAlert: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../services/notionService', () => ({
  createOncallItem: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../services/skillService', () => ({
  skillService: {
    getPublishedSkills: jest.fn().mockResolvedValue([]),
  },
}));

jest.mock('../services/voiceService', () => ({
  synthesizeSpeech: jest.fn(),
}));

// ENG-359: when the env override is unset, serviceAuth consults Secrets Manager.
// Mock the SM helper to return a payload with no matching key so the "env unset"
// rollout test deterministically fails open (no real AWS call, and no false 401
// even once the real prod secret exists). Env-secret-set tests use the sync env
// path and never read SM.
jest.mock('../utils/secretsManager', () => ({
  ...jest.requireActual('../utils/secretsManager'),
  getSecret: jest.fn().mockResolvedValue('{}'),
}));

import express from 'express';
import request from 'supertest';
import agentModeRoutes from '../routes/agentMode';
import { chatbotDb } from '../services/chatbotService';
import { agentModeService } from '../services/agentModeService';
import { scheduleDb, userDb } from '../services/db';
import { generateMarketingResponseWorkerService } from '../services/generateMarketingResponseWorkerService';
import {
  SERVICE_SECRET_HEADER,
  SCHEDULED_CHATS_SERVICE_SECRET_ENV,
} from '../middleware/serviceAuth';

const mockChatbotDb = chatbotDb as jest.Mocked<typeof chatbotDb>;
const mockAgentModeService = agentModeService as jest.Mocked<typeof agentModeService>;
const mockScheduleDb = scheduleDb as jest.Mocked<typeof scheduleDb>;
const mockUserDb = userDb as jest.Mocked<typeof userDb>;
const mockWorkerService = generateMarketingResponseWorkerService as jest.Mocked<
  typeof generateMarketingResponseWorkerService
>;

const app = express();
app.use(express.json());
app.use('/api/agent-mode', agentModeRoutes);

const SECRET = 'eng-347-test-service-secret';
const ROUTE = '/api/agent-mode/run-scheduled-chats';

const baseSchedule = {
  scheduleId: 'schedule-eng-347',
  scheduleName: 'ENG-347 Schedule',
  startingMessage: 'Run the weekly report',
  keywords: [],
  requiredFunctionCalls: [],
  userId: 'user-eng-347',
  nextRunTime: new Date().toISOString(),
  frequency: 'daily',
};

const mockSession = {
  sessionId: 'session-eng-347',
  userId: 'user-eng-347',
  title: 'ENG-347 Session',
  messages: [],
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

const mockLlmResponse = {
  content: 'Report generated.',
  toolCalls: [],
  knowledgeBaseQueries: [],
  sources: [],
  responseMessages: [],
};

// Let any background schedule runs kicked off by the controller settle before
// the jest worker tears down.
const settle = () => new Promise((resolve) => setTimeout(resolve, 150));

describe('POST /api/agent-mode/run-scheduled-chats service auth (ENG-347)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env[SCHEDULED_CHATS_SERVICE_SECRET_ENV] = SECRET;

    mockAgentModeService.getDefaultModel.mockResolvedValue('gpt-5-chat-2');
    mockAgentModeService.getScheduledChatsDefaultModel.mockResolvedValue('gpt-5-chat-2');
    mockAgentModeService.getMarketingSystemPrompt.mockResolvedValue('System prompt');
    mockAgentModeService.generateSessionTitle.mockResolvedValue('Generated Title');
    mockAgentModeService.generateScheduledChatSummary.mockResolvedValue(null);
    mockWorkerService.runInWorker.mockResolvedValue(mockLlmResponse);
    mockChatbotDb.createChatSession.mockResolvedValue(mockSession);
    mockChatbotDb.getChatSession.mockResolvedValue(mockSession);
    mockChatbotDb.addMessageToSession.mockResolvedValue(undefined as any);
    (mockChatbotDb as any).getMessagesFromMessagesTable.mockResolvedValue([]);
    mockScheduleDb.getSchedulesReadyToRun.mockResolvedValue([]);
    mockScheduleDb.getScheduleById.mockResolvedValue(baseSchedule);
    mockScheduleDb.addRunResult.mockResolvedValue(undefined);
    mockScheduleDb.updateScheduleAfterRun.mockResolvedValue(undefined);
    mockUserDb.getUserById.mockResolvedValue({
      userId: 'user-eng-347',
      email: 'owner@example.com',
    } as any);
  });

  afterEach(async () => {
    delete process.env[SCHEDULED_CHATS_SERVICE_SECRET_ENV];
    await settle();
  });

  it('AC1: without any credential → 401 and zero schedule executions', async () => {
    const res = await request(app).post(ROUTE);

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'Unauthorized' });
    // "Executes nothing": the handler never ran — no schedule lookup, no runs.
    expect(mockScheduleDb.getSchedulesReadyToRun).not.toHaveBeenCalled();
    expect(mockWorkerService.runInWorker).not.toHaveBeenCalled();
    expect(mockScheduleDb.updateScheduleAfterRun).not.toHaveBeenCalled();
  });

  it('AC1: with a wrong secret → 401 and zero schedule executions', async () => {
    const res = await request(app)
      .post(ROUTE)
      .set(SERVICE_SECRET_HEADER, 'not-the-secret');

    expect(res.status).toBe(401);
    expect(mockScheduleDb.getSchedulesReadyToRun).not.toHaveBeenCalled();
    expect(mockWorkerService.runInWorker).not.toHaveBeenCalled();
  });

  it('AC2: with the shared secret header → due schedules fire exactly as today', async () => {
    mockScheduleDb.getSchedulesReadyToRun.mockResolvedValue([baseSchedule]);

    const res = await request(app).post(ROUTE).set(SERVICE_SECRET_HEADER, SECRET);

    expect(res.status).toBe(200);
    expect(res.body).toEqual(
      expect.objectContaining({
        message: 'Processed 1 scheduled chats',
        processed: 1,
        results: expect.arrayContaining([
          expect.objectContaining({
            scheduleId: baseSchedule.scheduleId,
            status: 'started',
          }),
        ]),
      })
    );
    expect(mockScheduleDb.getSchedulesReadyToRun).toHaveBeenCalledTimes(1);

    // The schedule actually fires (background run reaches the LLM worker).
    await settle();
    expect(mockWorkerService.runInWorker).toHaveBeenCalled();
  });

  it('AC2: with the shared secret and nothing due → 200, processed 0 (unchanged behavior)', async () => {
    const res = await request(app).post(ROUTE).set(SERVICE_SECRET_HEADER, SECRET);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      message: 'No scheduled chats ready to run',
      processed: 0,
      results: [],
    });
  });

  it('rollout: env secret unset → request passes through (pre-ENG-347 behavior preserved)', async () => {
    delete process.env[SCHEDULED_CHATS_SERVICE_SECRET_ENV];

    const res = await request(app).post(ROUTE);

    expect(res.status).toBe(200);
    expect(mockScheduleDb.getSchedulesReadyToRun).toHaveBeenCalledTimes(1);
  });
});
