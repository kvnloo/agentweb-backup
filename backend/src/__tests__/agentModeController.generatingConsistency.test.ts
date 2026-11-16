/**
 * ENG-110 (consistency): GET /generating and GET /session/:id isGenerating come from ONE source, the lock claim
 * and its recorded owner. A run that holds the session lock WITHOUT a concurrent-generation cap slot (media /
 * work-plan auto-continuation, approval resume, branch/compare) must be listed for its owner and reported
 * isGenerating, never for anyone else, and must vanish on release (success, throw, timeout, crash).
 */
import { Request, Response } from 'express';
import { settingsService } from '../services/settingsService';
import { __resetConcurrentGenerationCapForTests, acquireInteractiveGenerationSlot } from '../services/agentMode/concurrentGenerationCap';
import {
  agentModeController, activeSessionGenerations, tryClaimSessionGeneration, releaseSessionGeneration,
  sessionGenerationOwners, claimSessionGenerationWithRetry,
} from '../controllers/agentModeController';
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

const mockDb = chatbotDb as jest.Mocked<typeof chatbotDb>;
const makeRes = () => ({ json: jest.fn(), status: jest.fn().mockReturnThis(), setHeader: jest.fn() } as unknown as Response);
const bodyOf = (res: Response) => (res.json as jest.Mock).mock.calls[0][0];
const listFor = async (userId: string) => {
  const res = makeRes();
  await agentModeController.getGeneratingSessions({ user: { userId } } as any, res);
  return bodyOf(res).sessionIds as string[];
};
const session = { sessionId: 's1', userId: 'A', title: 't', messages: [], portalType: 'agent', llmModel: 'gpt-5-chat-2' };
const getView = async (user: any, extra: any = {}) => {
  mockDb.getChatSession.mockResolvedValue(session as any);
  const res = makeRes();
  await agentModeController.getSession({ params: { sessionId: 's1' }, user, ...extra } as unknown as Request, res);
  return bodyOf(res);
};

describe('generating signals share one source (ENG-110 consistency)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    activeSessionGenerations.clear();
    sessionGenerationOwners.clear();
    __resetConcurrentGenerationCapForTests();
  });

  it('a continuation-style claim (lock + owner, NO cap slot) is listed for the owner and isGenerating is true', async () => {
    expect(tryClaimSessionGeneration('s1', 'A')).toBe(true);
    expect(await listFor('A')).toEqual(['s1']);
    expect((await getView({ userId: 'A' })).isGenerating).toBe(true);
    releaseSessionGeneration('s1');
  });

  it('the two signals never disagree for the owner, claimed or not', async () => {
    for (const held of [false, true]) {
      if (held) tryClaimSessionGeneration('s1', 'A');
      const listed = (await listFor('A')).includes('s1');
      expect(listed).toBe(held);
      expect((await getView({ userId: 'A' })).isGenerating).toBe(listed);
      releaseSessionGeneration('s1');
    }
  });

  it("other users never see another user's claimed session", async () => {
    tryClaimSessionGeneration('s1', 'A');
    expect(await listFor('B')).toEqual([]);
    const res = makeRes();
    mockDb.getChatSession.mockResolvedValue(session as any);
    await agentModeController.getSession({ params: { sessionId: 's1' }, user: { userId: 'B' } } as unknown as Request, res);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(JSON.stringify((res.json as jest.Mock).mock.calls)).not.toContain('isGenerating');
    releaseSessionGeneration('s1');
  });

  it('admin and delegate views of the owner\'s claimed session never get the flag; the response never names the owner', async () => {
    tryClaimSessionGeneration('s1', 'A');
    expect(await getView({ userId: 'admin', isAdmin: true })).not.toHaveProperty('isGenerating');
    expect(await getView({ userId: 'A' }, { delegateInfo: { isDelegated: true } })).not.toHaveProperty('isGenerating');
    releaseSessionGeneration('s1');
  });

  it('a claim without an owner is never invisible: it falls back to the cap slot, and isGenerating stays true', async () => {
    expect(tryClaimSessionGeneration('s1')).toBe(true);
    expect(sessionGenerationOwners.has('s1')).toBe(false);
    expect(await listFor('A')).toEqual([]); // no owner, no slot: nothing to attribute (never guessed onto a user)
    const slot = await acquireInteractiveGenerationSlot('A', 's1');
    expect(slot.ok).toBe(true);
    expect(await listFor('A')).toEqual(['s1']);
    expect(await listFor('B')).toEqual([]);
    expect((await getView({ userId: 'A' })).isGenerating).toBe(true);
    if (slot.ok) slot.release();
    releaseSessionGeneration('s1');
  });

  it('release removes the owner record (no leak) and the session disappears from both signals', async () => {
    tryClaimSessionGeneration('s1', 'A');
    expect(sessionGenerationOwners.get('s1')).toBe('A');
    releaseSessionGeneration('s1');
    expect(sessionGenerationOwners.size).toBe(0);
    expect(await listFor('A')).toEqual([]);
    expect((await getView({ userId: 'A' })).isGenerating).toBe(false);
  });

  it('a failed claim does not overwrite the holder\'s owner record', () => {
    tryClaimSessionGeneration('s1', 'A');
    expect(tryClaimSessionGeneration('s1', 'B')).toBe(false);
    expect(sessionGenerationOwners.get('s1')).toBe('A');
    releaseSessionGeneration('s1');
  });

  it('an owner record whose lock is gone is ignored (stale map entry cannot show as running)', async () => {
    sessionGenerationOwners.set('s1', 'A');
    expect(await listFor('A')).toEqual([]);
    expect((await getView({ userId: 'A' })).isGenerating).toBe(false);
  });

  it('claimSessionGenerationWithRetry records the owner (runVerifiedChat / scheduled / Slack / email path)', async () => {
    expect(await claimSessionGenerationWithRetry('s1', { retries: 0, delayMs: 1 }, 'A')).toBe(true);
    expect(await listFor('A')).toEqual(['s1']);
    expect(await listFor('B')).toEqual([]);
    releaseSessionGeneration('s1');
    expect(sessionGenerationOwners.size).toBe(0);
  });

  it('the real /generate handler records the owner and releases it after a throw', async () => {
    mockDb.getChatSession.mockResolvedValue(session as any);
    (mockDb as any).getMessagesFromMessagesTable.mockResolvedValue([]);
    mockDb.addMessageToSession.mockResolvedValue({} as any);
    mockDb.addMessagesToSession.mockResolvedValue(undefined as any);
    let during: { owner?: string; list: string[] } | undefined;
    (generateMarketingResponseWorkerService.runInWorker as jest.Mock).mockImplementationOnce(async () => {
      during = { owner: sessionGenerationOwners.get('s1'), list: await listFor('A') };
      throw new Error('boom');
    });
    const req = {
      user: { userId: 'A', email: 'a@x.com' }, body: { sessionId: 's1', userMessage: 'hi', llmModel: 'gpt-5-chat-2', attachments: [] },
      method: 'POST', path: '/generate', ip: '1', socket: { remoteAddress: '1' }, on: jest.fn(),
    } as unknown as Request;
    await agentModeController.generateResponse(req, makeRes());
    expect(during).toEqual({ owner: 'A', list: ['s1'] });
    expect(sessionGenerationOwners.size).toBe(0);
    expect(activeSessionGenerations.size).toBe(0);
  });
});
