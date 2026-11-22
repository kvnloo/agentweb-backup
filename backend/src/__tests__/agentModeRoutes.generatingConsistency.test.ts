/**
 * ENG-110 (consistency), router level: a lock held WITHOUT a cap slot (auto-continuation) is listed by the real
 * GET /api/agent-mode/generating for its owner only. Original header: router-level coverage for GET /api/agent-mode/generating. Goes through the real router, the real
 * authenticateToken middleware and the real controller, so deleting the route registration (or its auth)
 * fails here: 401 without a token, 200 with only the caller's own ids.
 */
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { __resetConcurrentGenerationCapForTests } from '../services/agentMode/concurrentGenerationCap';
import { activeSessionGenerations, sessionGenerationOwners, tryClaimSessionGeneration, releaseSessionGeneration } from '../controllers/agentModeController';
import router from '../routes/agentMode';
import { userDb } from '../services/db';

jest.mock('../services/db', () => ({ userDb: { getUserById: jest.fn() } }));
jest.mock('../services/evaluationPolicy', () => ({ isEvaluationUser: () => false }));
jest.mock('../services/voiceService', () => ({ synthesizeSpeech: jest.fn() }));
jest.mock('../services/settingsService', () => ({ settingsService: { getSetting: jest.fn().mockResolvedValue(null) } }));
jest.mock('../services/chatbotService', () => ({
  chatbotDb: {
    getChatSession: jest.fn(),
    addMessageToSession: jest.fn(),
    addMessagesToSession: jest.fn(),
    updateSessionTitle: jest.fn(),
    updateSessionLlmModel: jest.fn(),
    getMessagesFromMessagesTable: jest.fn(),
  },
  updateTaskExecutionStatus: jest.fn(),
}));
jest.mock('../services/emailService', () => ({ emailService: { sendOncallAlert: jest.fn().mockResolvedValue(undefined) } }));
jest.mock('../services/generateMarketingResponseWorkerService', () => ({
  generateMarketingResponseWorkerService: { runInWorker: jest.fn(), cancelSession: jest.fn() },
}));
jest.mock('../services/agentModeService', () => ({
  agentModeService: {
    getDefaultModel: jest.fn().mockResolvedValue('gpt-5-chat-2'),
    generateSessionTitle: jest.fn().mockResolvedValue('t'),
    getMarketingSystemPrompt: jest.fn().mockResolvedValue('p'),
    generateDiagnosticMessage: jest.fn().mockResolvedValue(null),
    getSkillsForDisplay: jest.fn().mockResolvedValue([]),
  },
  AgentModeService: jest.fn(),
}));
jest.mock('../services/tokenUsageService', () => ({
  checkTokenUsage: jest.fn().mockResolvedValue({
    allowed: true, warning: false, used: 0, allowance: null, bonus: 0, effectiveAllowance: null, percentUsed: 0, month: '2026-10',
  }),
}));
jest.mock('../utils/sseProgress', () => ({
  progressStore: { delete: jest.fn() },
  emitProgress: jest.fn(),
  hasActiveProgress: jest.fn().mockReturnValue(false),
  requestCancel: jest.fn(),
  clearCancel: jest.fn(),
  isCancelled: jest.fn().mockReturnValue(false),
  registerProgressCallback: jest.fn().mockReturnValue(() => {}),
  getLatestProgress: jest.fn().mockReturnValue(null),
}));
jest.mock('../services/workPlanService', () => ({ workPlanService: { getWorkPlan: jest.fn().mockResolvedValue(null) } }));
jest.mock('../services/skillService', () => ({ skillService: { getInstalledSkills: jest.fn().mockResolvedValue([]) } }));
jest.mock('../services/subscriptionService', () => ({ getAllowedSkills: jest.fn().mockResolvedValue([]) }));
jest.mock('../utils/agentModeAlerts', () => ({ sendAgentModeOncallAlert: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../utils/agentModeErrors', () => ({
  ...jest.requireActual('../utils/agentModeErrors'),
  isContextLimitError: jest.fn().mockReturnValue(false),
  isSessionLimitError: jest.fn().mockReturnValue(false),
  isTransientLLMError: jest.fn().mockReturnValue(false),
  isWorkerShutdownError: jest.fn().mockReturnValue(false),
  isProviderNoEndpointsError: jest.fn().mockReturnValue(false),
}));


const app = express().use('/api/agent-mode', router);
const originalSecret = process.env.JWT_SECRET;

function tokenFor(userId: string) {
  (userDb.getUserById as jest.Mock).mockResolvedValue({ userId, email: `${userId}@example.com`, isAdmin: false });
  return jwt.sign({ userId, email: `${userId}@example.com` }, process.env.JWT_SECRET!);
}
const generating = (userId: string) =>
  request(app).get('/api/agent-mode/generating').set('Authorization', `Bearer ${tokenFor(userId)}`);

describe('GET /generating lists lock-only (continuation) runs through the router (ENG-110 consistency)', () => {
  beforeEach(() => {
    process.env.JWT_SECRET = 'eng-110-test-only-secret';
    activeSessionGenerations.clear();
    sessionGenerationOwners.clear();
    __resetConcurrentGenerationCapForTests();
  });
  afterAll(() => {
    if (originalSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = originalSecret;
  });

  it('owner sees the continuation session, others and anonymous callers do not, gone after release', async () => {
    expect(tryClaimSessionGeneration('c1', 'A')).toBe(true); // no cap slot, like auto-continuation
    expect((await generating('A')).body).toEqual({ sessionIds: ['c1'] });
    const other = await generating('B');
    expect(other.body).toEqual({ sessionIds: [] });
    expect(JSON.stringify(other.body)).not.toContain('c1');
    expect((await request(app).get('/api/agent-mode/generating')).status).toBe(401);
    releaseSessionGeneration('c1');
    expect((await generating('A')).body).toEqual({ sessionIds: [] });
    expect(sessionGenerationOwners.size).toBe(0);
  });

  it('is released when the holder throws in a finally (crash path), leaving nothing behind', async () => {
    const run = async () => {
      expect(tryClaimSessionGeneration('c2', 'A')).toBe(true);
      try { throw new Error('worker crashed'); } finally { releaseSessionGeneration('c2'); }
    };
    await expect(run()).rejects.toThrow('worker crashed');
    expect((await generating('A')).body).toEqual({ sessionIds: [] });
    expect(sessionGenerationOwners.size).toBe(0);
  });
});
