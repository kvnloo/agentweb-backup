/**
 * ENG-705 — Finding 1: the share/ishare generate routes are unauthenticated and
 * skipped the usage gate entirely.
 *
 * `routes/agentMode.ts` registers `POST /share/:shareId/generate` and
 * `POST /ishare/:shareId/generate` BEFORE `router.use(authenticateToken)`, so
 * both are reachable with nothing but a share token. `generateSharedResponse`
 * then spent LLM budget with no `checkTokenUsage` call anywhere on the path.
 *
 * These tests pin the behavioral contract from the Linear issue:
 *   AC1 — a share-token generate request is subject to a usage limit.
 *   AC2 — spend is attributed to the share's OWNER, not the platform.
 *   AC5 — an unauthenticated caller cannot cause more vendor spend than an
 *         authenticated one (the gate refuses BEFORE the worker is invoked).
 *   AC6 — legitimate share usage inside the owner's limit still works.
 *
 * The gate must fail loudly (429 naming the limit), never degrade into a
 * silent success or a generic 500 that hides an already-paid call.
 */
import { Request, Response } from 'express';

// Mock all dependencies before importing the controller
jest.mock('../services/chatbotService', () => ({
  chatbotDb: {
    getChatSession: jest.fn(),
    addMessageToSession: jest.fn(),
    addMessagesToSession: jest.fn(),
    updateSessionTitle: jest.fn(),
    updateSessionInteractiveShareMetadata: jest.fn(),
    getMessagesFromMessagesTable: jest.fn(),
  },
}));

jest.mock('../services/agentModeService', () => ({
  agentModeService: {
    default_model: 'gpt-5-chat-2',
    getDefaultModel: jest.fn(),
    getMarketingSystemPrompt: jest.fn(),
    generateSessionTitle: jest.fn(),
  },
}));

jest.mock('../services/generateMarketingResponseWorkerService', () => ({
  generateMarketingResponseWorkerService: {
    runInWorker: jest.fn(),
    cancelSession: jest.fn(),
  },
}));

jest.mock('../utils/sseProgress', () => ({
  progressStore: {
    delete: jest.fn().mockReturnValue(true),
    has: jest.fn().mockReturnValue(false),
    add: jest.fn(),
  },
  getLatestProgress: jest.fn().mockReturnValue(undefined),
  requestCancel: jest.fn(),
  clearCancel: jest.fn(),
  isCancelled: jest.fn().mockReturnValue(false),
  emitProgress: jest.fn(),
}));

jest.mock('../services/tokenUsageService', () => ({
  checkTokenUsage: jest.fn(),
  incrementUserTokenUsage: jest.fn(),
}));

import { chatbotDb } from '../services/chatbotService';
import { agentModeService } from '../services/agentModeService';
import { generateMarketingResponseWorkerService } from '../services/generateMarketingResponseWorkerService';
import { progressStore } from '../utils/sseProgress';
import { checkTokenUsage } from '../services/tokenUsageService';
import { agentModeController } from '../controllers/agentModeController';

const mockChatbotDb = chatbotDb as jest.Mocked<typeof chatbotDb>;
const mockAgentModeService = agentModeService as jest.Mocked<typeof agentModeService>;
const mockWorkerService = generateMarketingResponseWorkerService as jest.Mocked<
  typeof generateMarketingResponseWorkerService
>;
const mockProgressStore = progressStore as jest.Mocked<typeof progressStore>;
const mockCheckTokenUsage = checkTokenUsage as jest.MockedFunction<typeof checkTokenUsage>;

const SESSION_ID = 'ishare-session-eng705';
const CONVERSABLE_TOKEN = 'tok-eng705';
const OWNER_USER_ID = 'share-owner-user-id';

const baseSession = {
  sessionId: SESSION_ID,
  userId: OWNER_USER_ID,
  title: 'Shared Session',
  messages: [],
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  llmModel: 'gpt-5-chat-2',
  interactiveShareMetadata: {
    isActive: true,
    token: CONVERSABLE_TOKEN,
    sharedAt: new Date().toISOString(),
    expiresAt: '2099-01-01T00:00:00Z',
  },
};

const workerResponse = {
  content: 'Hello from AI',
  toolCalls: [],
  knowledgeBaseQueries: [],
  sources: [],
  responseMessages: [],
};

/** Usage status shaped like tokenUsageService.checkTokenUsage's return. */
function usage(percentUsed: number) {
  return {
    allowed: percentUsed < 100,
    warning: percentUsed >= 80 && percentUsed < 100,
    used: percentUsed * 1000,
    allowance: 100000,
    bonus: 0,
    effectiveAllowance: 100000,
    percentUsed,
    month: '2026-07',
  };
}

function makeReq(overrides: Record<string, unknown> = {}) {
  return {
    params: { shareId: SESSION_ID },
    query: { conversable: CONVERSABLE_TOKEN },
    body: { userMessage: 'Hello from an anonymous visitor', attachments: [] },
    ip: '203.0.113.42',
    headers: { 'user-agent': 'Mozilla/5.0 (Test Browser)' },
    ...overrides,
  } as unknown as Request;
}

function makeRes() {
  return {
    json: jest.fn(),
    status: jest.fn().mockReturnThis(),
  } as unknown as Response;
}

describe('ENG-705 — share-token generate routes are usage-gated before any spend', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockAgentModeService.getDefaultModel.mockResolvedValue('gpt-5-chat-2');
    mockAgentModeService.getMarketingSystemPrompt.mockResolvedValue('System prompt');
    mockAgentModeService.generateSessionTitle.mockResolvedValue('Title');
    mockWorkerService.runInWorker.mockResolvedValue(workerResponse);
    mockProgressStore.delete.mockReturnValue(true);
    (mockProgressStore as any).has.mockReturnValue(false);
    (mockProgressStore as any).add.mockReturnValue(undefined);
    (mockChatbotDb.getChatSession as jest.Mock).mockResolvedValue({
      ...baseSession,
      messages: [{ role: 'user', content: 'hi', metadata: { timestamp: new Date().toISOString() } }],
    });
    (mockChatbotDb.addMessageToSession as jest.Mock).mockResolvedValue(undefined);
    (mockChatbotDb.updateSessionTitle as jest.Mock).mockResolvedValue(undefined);
    (mockChatbotDb as any).getMessagesFromMessagesTable.mockResolvedValue([]);
    // Default: owner comfortably within limits.
    mockCheckTokenUsage.mockResolvedValue(usage(10) as any);
  });

  // ── AC1 + AC5 ────────────────────────────────────────────────────────────
  it('AC1/AC5: refuses with 429 and never invokes the worker when the share owner is over limit', async () => {
    mockCheckTokenUsage.mockResolvedValue(usage(100) as any);

    const res = makeRes();
    await agentModeController.generateSharedResponse(makeReq(), res);

    expect(res.status).toHaveBeenCalledWith(429);
    // The critical assertion: refused BEFORE any upstream vendor spend.
    expect(mockWorkerService.runInWorker).not.toHaveBeenCalled();
  });

  it('AC5: the refusal is loud — it names the limit and returns the usage status, not a silent success', async () => {
    mockCheckTokenUsage.mockResolvedValue(usage(100) as any);

    const res = makeRes();
    await agentModeController.generateSharedResponse(makeReq(), res);

    expect(res.status).toHaveBeenCalledWith(429);
    const body = (res.json as jest.Mock).mock.calls[0][0];
    expect(body.error).toMatch(/limit/i);
    expect(body.tokenUsage).toEqual(expect.objectContaining({ allowed: false, percentUsed: 100 }));
    // Not a degraded-but-billed path: no assistant content is returned.
    expect(body.content).toBeUndefined();
  });

  // ── AC2 ──────────────────────────────────────────────────────────────────
  it("AC2: the gate is evaluated against the share OWNER's account, not the anonymous caller", async () => {
    const res = makeRes();
    await agentModeController.generateSharedResponse(makeReq(), res);

    expect(mockCheckTokenUsage).toHaveBeenCalledWith(OWNER_USER_ID);
  });

  it('AC2: spend from a share-token request is booked to the owner — the worker runs under the owner userId', async () => {
    const res = makeRes();
    await agentModeController.generateSharedResponse(makeReq(), res);

    expect(mockWorkerService.runInWorker).toHaveBeenCalled();
    const workerArg = (mockWorkerService.runInWorker as jest.Mock).mock.calls[0][0];
    expect(JSON.stringify(workerArg)).toContain(OWNER_USER_ID);
  });

  // ── AC6 + boundary ───────────────────────────────────────────────────────
  it('AC6: a share visitor whose owner is within limits still gets a normal generation', async () => {
    const res = makeRes();
    await agentModeController.generateSharedResponse(makeReq(), res);

    expect(res.status).not.toHaveBeenCalledWith(429);
    expect(mockWorkerService.runInWorker).toHaveBeenCalledTimes(1);
    expect((res.json as jest.Mock).mock.calls[0][0]).toEqual(
      expect.objectContaining({ content: 'Hello from AI' })
    );
  });

  it('boundary: 99% used still generates, 100% used is refused', async () => {
    mockCheckTokenUsage.mockResolvedValue(usage(99) as any);
    const allowedRes = makeRes();
    await agentModeController.generateSharedResponse(makeReq(), allowedRes);
    expect(allowedRes.status).not.toHaveBeenCalledWith(429);
    expect(mockWorkerService.runInWorker).toHaveBeenCalledTimes(1);

    jest.clearAllMocks();
    mockAgentModeService.getDefaultModel.mockResolvedValue('gpt-5-chat-2');
    (mockChatbotDb.getChatSession as jest.Mock).mockResolvedValue(baseSession);
    mockCheckTokenUsage.mockResolvedValue(usage(100) as any);

    const blockedRes = makeRes();
    await agentModeController.generateSharedResponse(makeReq(), blockedRes);
    expect(blockedRes.status).toHaveBeenCalledWith(429);
    expect(mockWorkerService.runInWorker).not.toHaveBeenCalled();
  });

  // ── the gate must not leak the session lock ──────────────────────────────
  it('a 429 releases the session generation lock — the owner is not locked out of their own session', async () => {
    mockCheckTokenUsage.mockResolvedValue(usage(100) as any);
    const blockedRes = makeRes();
    await agentModeController.generateSharedResponse(makeReq(), blockedRes);
    expect(blockedRes.status).toHaveBeenCalledWith(429);

    // Owner tops up; the very next request must not be rejected as SESSION_BUSY.
    mockCheckTokenUsage.mockResolvedValue(usage(10) as any);
    const nextRes = makeRes();
    await agentModeController.generateSharedResponse(makeReq(), nextRes);

    expect(nextRes.status).not.toHaveBeenCalledWith(409);
    expect(mockWorkerService.runInWorker).toHaveBeenCalledTimes(1);
  });
});
