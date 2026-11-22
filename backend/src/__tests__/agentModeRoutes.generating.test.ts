/**
 * ENG-110: router-level coverage for GET /api/agent-mode/generating. Goes through the real router, the real
 * authenticateToken middleware and the real controller, so deleting the route registration (or its auth)
 * fails here: 401 without a token, 200 with only the caller's own ids.
 */
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { __resetConcurrentGenerationCapForTests, acquireInteractiveGenerationSlot } from '../services/agentMode/concurrentGenerationCap';
import { activeSessionGenerations, tryClaimSessionGeneration, releaseSessionGeneration } from '../controllers/agentModeController';
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

function asUser(userId: string) {
  (userDb.getUserById as jest.Mock).mockResolvedValue({ userId, email: `${userId}@example.com`, isAdmin: false });
  const token = jwt.sign({ userId, email: `${userId}@example.com` }, process.env.JWT_SECRET!);
  return request(app).get('/api/agent-mode/generating').set('Authorization', `Bearer ${token}`);
}

async function claim(userId: string, sessionId: string) {
  expect(tryClaimSessionGeneration(sessionId)).toBe(true);
  const slot = await acquireInteractiveGenerationSlot(userId, sessionId);
  if (!slot.ok) throw new Error('slot refused');
  return () => { slot.release(); releaseSessionGeneration(sessionId); };
}

describe('GET /api/agent-mode/generating through the router (ENG-110)', () => {
  beforeEach(() => {
    process.env.JWT_SECRET = 'eng-110-test-only-secret';
    activeSessionGenerations.clear();
    __resetConcurrentGenerationCapForTests();
  });
  afterAll(() => {
    if (originalSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = originalSecret;
  });

  it('401 without a token', async () => {
    const res = await request(app).get('/api/agent-mode/generating');
    expect(res.status).toBe(401);
    expect(res.body.sessionIds).toBeUndefined();
  });

  it("200 with only the caller's session ids, never another user's, and no-store", async () => {
    const relA = await claim('A', 'a1');
    const relB = await claim('B', 'b1');
    const resA = await asUser('A');
    expect(resA.status).toBe(200);
    expect(resA.headers['cache-control']).toBe('no-store');
    expect(resA.body).toEqual({ sessionIds: ['a1'] });
    expect(JSON.stringify(resA.body)).not.toContain('b1');
    const resB = await asUser('B');
    expect(resB.body).toEqual({ sessionIds: ['b1'] });
    expect(JSON.stringify(resB.body)).not.toContain('a1');
    expect((await asUser('C')).body).toEqual({ sessionIds: [] });
    relA(); relB();
    expect((await asUser('A')).body).toEqual({ sessionIds: [] });
  });
});
