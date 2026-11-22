/**
 * ENG-110: GET /api/agent-mode/generating and the owner-only `isGenerating` flag on GET /session/:id.
 * In-memory, per instance, caller-scoped. Cleared on release even after a throw.
 */
import { Request, Response } from 'express';
import { settingsService } from '../services/settingsService';
import { __resetConcurrentGenerationCapForTests, acquireInteractiveGenerationSlot } from '../services/agentMode/concurrentGenerationCap';
import { agentModeController, activeSessionGenerations, tryClaimSessionGeneration, releaseSessionGeneration } from '../controllers/agentModeController';
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
const worker = generateMarketingResponseWorkerService as jest.Mocked<typeof generateMarketingResponseWorkerService>;
const getSetting = settingsService.getSetting as jest.Mock;

const makeRes = () => ({ json: jest.fn(), status: jest.fn().mockReturnThis(), setHeader: jest.fn() } as unknown as Response);
const callGenerating = async (user?: any) => {
  const res = makeRes();
  await agentModeController.getGeneratingSessions({ user } as any, res);
  return res;
};
const bodyOf = (res: Response) => (res.json as jest.Mock).mock.calls[0][0];

/** Claim the lock + slot the way /generate does. */
async function claim(userId: string, sessionId: string) {
  expect(tryClaimSessionGeneration(sessionId)).toBe(true);
  const slot = await acquireInteractiveGenerationSlot(userId, sessionId);
  if (!slot.ok) throw new Error('slot refused');
  return () => { slot.release(); releaseSessionGeneration(sessionId); };
}

describe('GET /api/agent-mode/generating (ENG-110)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    activeSessionGenerations.clear();
    __resetConcurrentGenerationCapForTests();
    getSetting.mockResolvedValue(null);
  });

  it('401 without a user', async () => {
    const res = await callGenerating(undefined);
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it('is empty when nothing is running', async () => {
    expect(bodyOf(await callGenerating({ userId: 'A' }))).toEqual({ sessionIds: [] });
  });

  it("returns only the caller's sessions: user A never sees user B's ids", async () => {
    const relA = await claim('A', 'a1');
    const relB1 = await claim('B', 'b1');
    const relB2 = await claim('B', 'b2');
    expect(bodyOf(await callGenerating({ userId: 'A' }))).toEqual({ sessionIds: ['a1'] });
    expect(bodyOf(await callGenerating({ userId: 'B' })).sessionIds.sort()).toEqual(['b1', 'b2']);
    expect(bodyOf(await callGenerating({ userId: 'C' }))).toEqual({ sessionIds: [] });
    relA(); relB1(); relB2();
  });

  it('a slot without the session lock is never reported (stale entries cannot show as running)', async () => {
    const slot = await acquireInteractiveGenerationSlot('A', 'ghost');
    expect(slot.ok).toBe(true);
    expect(bodyOf(await callGenerating({ userId: 'A' }))).toEqual({ sessionIds: [] });
    if (slot.ok) slot.release();
  });

  it('is cleared on release', async () => {
    const rel = await claim('A', 'a1');
    expect(bodyOf(await callGenerating({ userId: 'A' }))).toEqual({ sessionIds: ['a1'] });
    rel();
    expect(bodyOf(await callGenerating({ userId: 'A' }))).toEqual({ sessionIds: [] });
  });

  it('is cleared even when the real /generate handler throws mid-run', async () => {
    mockDb.getChatSession.mockResolvedValue({ sessionId: 'a1', userId: 'A', title: 't', messages: [], portalType: 'agent', llmModel: 'gpt-5-chat-2' } as any);
    (mockDb as any).getMessagesFromMessagesTable.mockResolvedValue([]);
    mockDb.addMessageToSession.mockResolvedValue({} as any);
    mockDb.addMessagesToSession.mockResolvedValue(undefined as any);
    let seenDuring: string[] | undefined;
    worker.runInWorker.mockImplementationOnce(async () => {
      seenDuring = bodyOf(await callGenerating({ userId: 'A' })).sessionIds;
      throw new Error('boom');
    });
    const req = {
      user: { userId: 'A', email: 'a@x.com' }, body: { sessionId: 'a1', userMessage: 'hi', llmModel: 'gpt-5-chat-2', attachments: [] },
      method: 'POST', path: '/generate', ip: '1', socket: { remoteAddress: '1' }, on: jest.fn(),
    } as unknown as Request;
    await agentModeController.generateResponse(req, makeRes());
    expect(seenDuring).toEqual(['a1']);
    const after = await callGenerating({ userId: 'A' });
    expect(bodyOf(after)).toEqual({ sessionIds: [] });
  });
});

describe('GET /session/:id isGenerating (ENG-110)', () => {
  const session = { sessionId: 's1', userId: 'A', title: 't', messages: [], portalType: 'agent', llmModel: 'gpt-5-chat-2' };
  const get = async (user: any, extra: any = {}) => {
    mockDb.getChatSession.mockResolvedValue(session as any);
    const res = makeRes();
    await agentModeController.getSession({ params: { sessionId: 's1' }, user, ...extra } as unknown as Request, res);
    return bodyOf(res);
  };
  beforeEach(() => {
    jest.clearAllMocks();
    activeSessionGenerations.clear();
  });

  it('owner sees isGenerating true while the lock is held and false otherwise', async () => {
    expect((await get({ userId: 'A' })).isGenerating).toBe(false);
    activeSessionGenerations.add('s1');
    expect((await get({ userId: 'A' })).isGenerating).toBe(true);
  });

  it('an admin or delegate viewing another user\'s session never gets the flag', async () => {
    activeSessionGenerations.add('s1');
    expect(await get({ userId: 'admin', isAdmin: true })).not.toHaveProperty('isGenerating');
    expect(await get({ userId: 'A' }, { delegateInfo: { isDelegated: true } })).not.toHaveProperty('isGenerating');
  });

  it('the public/shared view of a generating session never exposes isGenerating', async () => {
    activeSessionGenerations.add('s1');
    mockDb.getChatSession.mockResolvedValue({ ...session, shareMetadata: { isShared: true } } as any);
    const res = makeRes();
    await agentModeController.getSharedConversation({ params: { shareId: 's1' }, query: {} } as unknown as Request, res);
    expect(res.status).toHaveBeenCalledWith(200);
    const body = (res.json as jest.Mock).mock.calls[0][0];
    expect(body.session).toBeDefined();
    expect(JSON.stringify(body)).not.toContain('isGenerating');
  });

  it('a non-owner is refused (403) and nothing is leaked', async () => {
    activeSessionGenerations.add('s1');
    mockDb.getChatSession.mockResolvedValue(session as any);
    const res = makeRes();
    await agentModeController.getSession({ params: { sessionId: 's1' }, user: { userId: 'B' } } as unknown as Request, res);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(JSON.stringify((res.json as jest.Mock).mock.calls)).not.toContain('isGenerating');
  });
});
