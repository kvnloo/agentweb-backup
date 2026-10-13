/**
 * ENG-110: chat branching holds the source session's lock but NO cap slot, so without an owner on the claim
 * it would be invisible to GET /generating. Real controller lock + real branch service, hung dependency.
 */
import { Request, Response } from 'express';
import { settingsService } from '../services/settingsService';
import { __resetConcurrentGenerationCapForTests, acquireInteractiveGenerationSlot } from '../services/agentMode/concurrentGenerationCap';
import { agentModeController, activeSessionGenerations, sessionGenerationOwners, tryClaimSessionGeneration, releaseSessionGeneration } from '../controllers/agentModeController';
import { branchChatSession, BranchDeps } from '../services/agentMode/chatBranching';
import { chatbotDb } from '../services/chatbotService';
import { generateMarketingResponseWorkerService } from '../services/generateMarketingResponseWorkerService';

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


const makeRes = () => ({ json: jest.fn(), status: jest.fn().mockReturnThis(), setHeader: jest.fn() } as unknown as Response);
const listFor = async (userId: string) => {
  const res = makeRes();
  await agentModeController.getGeneratingSessions({ user: { userId } } as any, res);
  return (res.json as jest.Mock).mock.calls[0][0].sessionIds as string[];
};

describe('chat branching is visible to /generating for its owner (ENG-110)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    activeSessionGenerations.clear();
    sessionGenerationOwners.clear();
    __resetConcurrentGenerationCapForTests();
  });

  it('lists the source session for the owner (only) while the branch runs, then clears it', async () => {
    const ts = '2026-10-01T00:00:00.000Z';
    const source = {
      sessionId: 'src', userId: 'A', title: 'T', portalType: 'agent', pageIdentifier: 'agent-mode', sessionType: 'regular',
      llmModel: 'gpt-5.5', createdAt: ts, updatedAt: ts, messageCount: 2,
      messages: [
        { role: 'user', content: 'hi', timestamp: ts, metadata: { timestamp: ts } },
        { role: 'assistant', content: 'yo', timestamp: ts, metadata: { timestamp: ts } },
      ],
    };
    let during: { owner: string[]; other: string[] } | undefined;
    let release!: () => void;
    const hung = new Promise<number>((resolve) => { release = () => resolve(30); });
    const deps = {
      isAcceptingWork: () => true,
      isFeatureEnabled: async () => true,
      getSession: async () => source,
      tryClaim: tryClaimSessionGeneration,
      release: releaseSessionGeneration,
      resolveModel: async () => ({ ok: true, model: 'gpt-5.5' }),
      getMaxBranchesPerHour: async () => {
        during = { owner: await listFor('A'), other: await listFor('B') };
        return hung; // hold the branch run open after the observation
      },
      now: () => Date.now(),
      log: () => undefined,
      sleep: async () => undefined,
      adminToolNames: new Set<string>(),
      maxSessionMessages: 1000,
      createSession: async () => { throw new Error('stop here'); },
    } as unknown as BranchDeps;
    const p = branchChatSession(deps, { user: { userId: 'A' }, viewerIsAdmin: false, sessionId: 'src', body: { messageIndex: 0 } } as any);
    await new Promise((r) => setImmediate(r));
    expect(during).toEqual({ owner: ['src'], other: [] });
    release();
    await p.catch(() => undefined);
    expect(await listFor('A')).toEqual([]);
    expect(sessionGenerationOwners.size).toBe(0);
  });
});
