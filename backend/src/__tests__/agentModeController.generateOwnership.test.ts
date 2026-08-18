/**
 * POST /api/agent-mode/generate — session-ownership contract (ENG-346).
 *
 * Pre-existing gap: generateResponse fetched the session without ever
 * comparing session.userId to req.user (unlike getSession, which does),
 * so any authenticated user who learned another user's sessionId could
 * generate on that session — spend the owner's tokens, append to their
 * history — and, with AGENT_RUN_STORE=true, squat the interactive
 * idempotency claim for the owner's predicted messages (spurious 409s).
 *
 * Behavioral contract from the Linear issue (HUMAN-WRITTEN — do not modify):
 *   1. An authenticated user POSTing /generate with another user's sessionId
 *      gets 403 (or 404), no generation runs, no tokens consumed.
 *   2. The session owner and a delegated admin (token targeting the owner)
 *      can still generate — existing delegation tests stay green.
 *   3. With AGENT_RUN_STORE=true, a non-owner cannot create or hold an idem
 *      claim for another user's session.
 *
 * AC-3 deliberately uses the REAL runStore module against a
 * conditional-put-aware DynamoDB fake (no mocks on the store), mirroring
 * agentModeController.sessionIdempotency.test.ts, so "no claim was ever
 * created" is genuinely observed in the store, not asserted into existence.
 */
import { Request, Response } from 'express';

jest.mock('../services/chatbotService', () => ({
  chatbotDb: {
    createChatSession: jest.fn(),
    getChatSession: jest.fn(),
    updateSessionLlmModel: jest.fn(),
    addMessageToSession: jest.fn(),
    addMessagesToSession: jest.fn(),
    updateSessionTitle: jest.fn(),
    getMessagesFromMessagesTable: jest.fn(),
  },
  updateTaskExecutionStatus: jest.fn(),
}));

jest.mock('../services/emailService', () => ({
  emailService: { sendOncallAlert: jest.fn().mockResolvedValue(undefined) },
}));

jest.mock('../services/generateMarketingResponseWorkerService', () => ({
  generateMarketingResponseWorkerService: {
    runInWorker: jest.fn(),
    cancelSession: jest.fn(),
  },
}));

jest.mock('../services/agentModeService', () => ({
  agentModeService: {
    default_model: 'gpt-5-chat-2',
    getDefaultModel: jest.fn().mockResolvedValue('gpt-5-chat-2'),
    getReportsModel: jest.fn().mockResolvedValue('gpt-5-chat-2'),
    getCustomerSupportDefaultModel: jest.fn().mockResolvedValue('gpt-5-chat-2'),
    getSupportedModels: jest.fn().mockResolvedValue(['gpt-5-chat-2']),
    resolveGenerationModel: jest.fn((model: string) => ({
      model,
      fellBack: false,
      requestedModel: model,
    })),
    generateSessionTitle: jest.fn().mockResolvedValue('Test Title'),
    getMarketingSystemPrompt: jest.fn().mockResolvedValue('System prompt'),
    generateDiagnosticMessage: jest.fn().mockResolvedValue(null),
  },
  AgentModeService: jest.fn(),
}));

jest.mock('../services/llmUsagePolicyResolverService', () => ({
  getEffectiveLlmUsagePolicy: jest.fn().mockResolvedValue({
    billingUserId: 'user-owner',
    policy: null,
    costUsedMicroUsd: 0,
    tokenUsed: 0,
    mode: { usageMode: 'full_choice', reason: 'no_policy' },
  }),
}));

jest.mock('../services/tokenUsageService', () => ({
  checkTokenUsage: jest.fn().mockResolvedValue({
    allowed: true, warning: false, used: 0, allowance: null,
    bonus: 0, effectiveAllowance: null, percentUsed: 0, month: '2026-07',
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
  markProgressComplete: jest.fn(),
}));

jest.mock('../services/workPlanService', () => ({
  workPlanService: { getWorkPlan: jest.fn().mockResolvedValue(null) },
}));

jest.mock('../services/skillService', () => ({
  skillService: { getInstalledSkills: jest.fn().mockResolvedValue([]) },
}));

jest.mock('../services/subscriptionService', () => ({
  getAllowedSkills: jest.fn().mockResolvedValue([]),
}));

jest.mock('../services/usageBlockMessageService', () => ({
  buildUsageBlockInfoForUser: jest.fn().mockResolvedValue({
    exhausted: 'cost',
    usedLabel: '$60.00 of your $60.00 monthly AI budget',
    resetsAt: '2026-09-01T00:00:00.000Z',
    resetsAutomatically: true,
    hasNextTier: false,
    upgradeUrl: null,
    supportUrl: 'https://www.hireemma.ai/support',
  }),
}));

jest.mock('../utils/agentModeAlerts', () => ({
  sendAgentModeOncallAlert: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../utils/agentModeErrors', () => ({
  isContextLimitError: jest.fn().mockReturnValue(false),
  isSessionLimitError: jest.fn().mockReturnValue(false),
  isTransientLLMError: jest.fn().mockReturnValue(false),
  isWorkerShutdownError: jest.fn().mockReturnValue(false),
}));

import { agentModeController, activeSessionGenerations } from '../controllers/agentModeController';
import { chatbotDb } from '../services/chatbotService';
import { generateMarketingResponseWorkerService } from '../services/generateMarketingResponseWorkerService';
import { checkTokenUsage } from '../services/tokenUsageService';
import { getEffectiveLlmUsagePolicy } from '../services/llmUsagePolicyResolverService';
import { __setDocumentClientForTests } from '../services/agentMode/runStore';

const mockChatbotDb = chatbotDb as jest.Mocked<typeof chatbotDb>;
const mockWorkerService = generateMarketingResponseWorkerService as jest.Mocked<typeof generateMarketingResponseWorkerService>;
const mockGetEffectiveLlmUsagePolicy = getEffectiveLlmUsagePolicy as jest.Mock;
const mockCheckTokenUsage = checkTokenUsage as jest.Mock;

/** Conditional-put-aware in-memory DocumentClient fake (mirrors sessionIdempotency.test.ts). */
class DdbFake {
  items = new Map<string, any>();

  private putConditionFails(params: any): boolean {
    const cond = params.ConditionExpression;
    if (!cond) return false;
    const existing = this.items.get(params.Item.pk);
    if (cond === 'attribute_not_exists(pk)') return existing !== undefined;
    if (cond === 'attribute_not_exists(pk) OR #ttl < :now') {
      if (existing === undefined) return false;
      const now = params.ExpressionAttributeValues?.[':now'];
      return !(typeof existing.ttl === 'number' && existing.ttl < now);
    }
    throw new Error(`DdbFake: unsupported put ConditionExpression: ${cond}`);
  }

  put = (params: any) => ({
    promise: async () => {
      if (this.putConditionFails(params)) {
        const err: any = new Error('The conditional request failed');
        err.code = 'ConditionalCheckFailedException';
        throw err;
      }
      this.items.set(params.Item.pk, params.Item);
      return {};
    },
  });

  get = (params: any) => ({
    promise: async () => ({ Item: this.items.get(params.Key.pk) }),
  });

  update = (params: any) => ({
    promise: async () => {
      if (
        params.ConditionExpression === 'attribute_exists(pk)' &&
        !this.items.has(params.Key.pk)
      ) {
        const err: any = new Error('The conditional request failed');
        err.code = 'ConditionalCheckFailedException';
        throw err;
      }
      const item = this.items.get(params.Key.pk) || { pk: params.Key.pk };
      for (const [placeholder, value] of Object.entries(params.ExpressionAttributeValues || {})) {
        const name = placeholder.replace(':', '');
        const attrName = params.ExpressionAttributeNames?.[`#${name}`] || name;
        item[attrName] = value;
      }
      this.items.set(params.Key.pk, item);
      return {};
    },
  });

  delete = (params: any) => ({
    promise: async () => {
      this.items.delete(params.Key.pk);
      return {};
    },
  });
}

const ownerId = 'user-owner';
const attackerId = 'user-attacker';
const sessionId = 'session-owned-by-owner';

const ownedSession = {
  sessionId,
  userId: ownerId,
  title: 'Owner Session',
  messages: [],
  createdAt: '2026-07-01T00:00:00Z',
  updatedAt: '2026-07-01T00:00:00Z',
  portalType: 'agent' as const,
  pageIdentifier: 'agent-mode',
  llmModel: 'gpt-5-chat-2',
};

const workerResult = {
  content: 'OK',
  toolCalls: [],
  knowledgeBaseQueries: [],
  sources: [],
  responseMessages: [],
};

type ReqUser = { userId: string; email?: string; isAdmin?: boolean };

const makeReq = (
  user: ReqUser,
  overrides: { delegateInfo?: any; message?: string } = {}
) =>
  ({
    user,
    ...(overrides.delegateInfo ? { delegateInfo: overrides.delegateInfo } : {}),
    body: {
      sessionId,
      userMessage: overrides.message ?? 'Hello',
      llmModel: 'gpt-5-chat-2',
      attachments: [],
    },
    method: 'POST',
    path: '/api/agent-mode/generate',
    ip: '127.0.0.1',
    socket: { remoteAddress: '127.0.0.1' },
    on: jest.fn(),
  } as unknown as Request);

const makeRes = () => {
  const res: any = { statusCode: 200, body: undefined };
  res.status = jest.fn((code: number) => {
    res.statusCode = code;
    return res;
  });
  res.json = jest.fn((payload: any) => {
    res.body = payload;
    return res;
  });
  return res as Response & { statusCode: number; body: any };
};

describe('generateResponse session ownership (acceptance — ENG-346)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    activeSessionGenerations.clear();
    mockChatbotDb.getChatSession.mockResolvedValue(ownedSession as any);
    (mockChatbotDb as any).getMessagesFromMessagesTable.mockResolvedValue([]);
    mockChatbotDb.addMessageToSession.mockResolvedValue(ownedSession as any);
    mockChatbotDb.addMessagesToSession.mockResolvedValue(undefined as any);
    mockChatbotDb.updateSessionTitle.mockResolvedValue(undefined as any);
    mockChatbotDb.updateSessionLlmModel.mockResolvedValue(ownedSession as any);
    mockWorkerService.runInWorker.mockResolvedValue(workerResult as any);
    mockGetEffectiveLlmUsagePolicy.mockResolvedValue({
      billingUserId: ownerId,
      policy: null,
      costUsedMicroUsd: 0,
      tokenUsed: 0,
      mode: { usageMode: 'full_choice', reason: 'no_policy' },
    });
    mockCheckTokenUsage.mockResolvedValue({
      allowed: true,
      warning: false,
      used: 0,
      allowance: null,
      bonus: 0,
      effectiveAllowance: null,
      percentUsed: 0,
      month: '2026-07',
    });
  });

  describe('run store OFF (default lane)', () => {
    it('ACCEPTANCE 1: an authenticated non-owner gets 403 — no generation runs, nothing is appended to the session', async () => {
      const res = makeRes();
      await agentModeController.generateResponse(makeReq({ userId: attackerId }), res);

      expect(res.statusCode).toBe(403);
      expect(res.body).toEqual({ error: 'Unauthorized access to session' });
      // No generation ran → no worker call, so no tokens could be consumed.
      expect(mockWorkerService.runInWorker).not.toHaveBeenCalled();
      // Nothing was written into the owner's history.
      expect(mockChatbotDb.addMessageToSession).not.toHaveBeenCalled();
      expect(mockChatbotDb.addMessagesToSession).not.toHaveBeenCalled();
    });

    it('the rejection happens before the token-usage read and leaves the session lock free for the owner', async () => {
      const attackerRes = makeRes();
      await agentModeController.generateResponse(makeReq({ userId: attackerId }), attackerRes);

      expect(attackerRes.statusCode).toBe(403);
      // Unauthorized requests do no further work (fail fast, touch no shared state).
      expect(checkTokenUsage).not.toHaveBeenCalled();
      expect(activeSessionGenerations.has(sessionId)).toBe(false);

      const ownerRes = makeRes();
      await agentModeController.generateResponse(makeReq({ userId: ownerId }), ownerRes);
      expect(ownerRes.statusCode).not.toBe(409);
      expect(ownerRes.body).toEqual(expect.objectContaining({ content: 'OK' }));
    });

    it('ACCEPTANCE 2: the session owner can generate', async () => {
      const res = makeRes();
      await agentModeController.generateResponse(makeReq({ userId: ownerId }), res);

      expect(res.statusCode).toBe(200);
      expect(res.body).toEqual(expect.objectContaining({ content: 'OK' }));
      expect(mockWorkerService.runInWorker).toHaveBeenCalledTimes(1);
      expect(mockChatbotDb.updateSessionLlmModel).toHaveBeenCalledWith(
        sessionId,
        'gpt-5-chat-2',
        expect.objectContaining({
          requestedModel: 'gpt-5-chat-2',
          effectiveModel: 'gpt-5-chat-2',
          modelSelection: 'honored',
          usageMode: 'full_choice',
        }),
      );
      expect(res.body).toEqual(expect.objectContaining({
        requestedModel: 'gpt-5-chat-2',
        effectiveModel: 'gpt-5-chat-2',
        modelSelection: 'honored',
        usageMode: 'full_choice',
      }));
    });

    it('records a blocked hard-cap decision without invoking the provider', async () => {
      mockCheckTokenUsage.mockResolvedValue({
        allowed: false,
        warning: false,
        used: 1,
        allowance: null,
        bonus: 0,
        effectiveAllowance: null,
        percentUsed: 0,
        month: '2026-07',
        usageMode: 'paused',
        usagePolicyVersion: 'policy-v1',
      });
      mockGetEffectiveLlmUsagePolicy.mockResolvedValue({
        billingUserId: ownerId,
        policy: {
          version: 'policy-v1',
          enforcementState: 'enforce',
          optimizationCostThresholdMicroUsd: 30_000_000,
          hardCostThresholdMicroUsd: 60_000_000,
          optimizedModelIds: ['gemini-3.1-flash-lite'],
          optimizedDefaultModel: 'gemini-3.1-flash-lite',
        },
        costUsedMicroUsd: 60_000_000,
        tokenUsed: 1,
        mode: { usageMode: 'paused', reason: 'hard_cost_cap_reached' },
      });

      const res = makeRes();
      await agentModeController.generateResponse(makeReq({ userId: ownerId }), res);

      expect(res.statusCode).toBe(429);
      expect(mockWorkerService.runInWorker).not.toHaveBeenCalled();
      expect(mockChatbotDb.updateSessionLlmModel).toHaveBeenCalledWith(
        sessionId,
        'gpt-5-chat-2',
        expect.objectContaining({
          effectiveModel: null,
          modelSelection: 'blocked',
          usageMode: 'paused',
          usagePolicyVersion: 'policy-v1',
        }),
      );
    });

    it('ACCEPTANCE 2: a delegated admin (token targeting the owner) can generate — req.user is already the target user', async () => {
      const res = makeRes();
      await agentModeController.generateResponse(
        makeReq(
          { userId: ownerId, email: 'owner@example.com' },
          {
            delegateInfo: {
              adminUserId: 'admin-1',
              adminEmail: 'admin@example.com',
              isDelegated: true,
            },
          }
        ),
        res
      );

      expect(res.statusCode).toBe(200);
      expect(res.body).toEqual(expect.objectContaining({ content: 'OK' }));
      expect(mockWorkerService.runInWorker).toHaveBeenCalledTimes(1);
    });

    it('a non-delegated admin retains access (parity with getSession/updateSessionTitle)', async () => {
      const res = makeRes();
      await agentModeController.generateResponse(
        makeReq({ userId: 'admin-raw', isAdmin: true }),
        res
      );

      expect(res.statusCode).toBe(200);
      expect(res.body).toEqual(expect.objectContaining({ content: 'OK' }));
    });

    it('BEHAVIOR-PRESERVING: a missing session is still a plain 404', async () => {
      mockChatbotDb.getChatSession.mockResolvedValue(null as any);

      const res = makeRes();
      await agentModeController.generateResponse(makeReq({ userId: attackerId }), res);

      expect(res.statusCode).toBe(404);
      expect(res.body).toEqual({ error: 'Session not found' });
      expect(mockWorkerService.runInWorker).not.toHaveBeenCalled();
    });

    it('BEHAVIOR-PRESERVING: missing sessionId/userMessage is still a 400 before any session read', async () => {
      const res = makeRes();
      const req = makeReq({ userId: ownerId });
      (req as any).body = { sessionId: '', userMessage: '' };
      await agentModeController.generateResponse(req, res);

      expect(res.statusCode).toBe(400);
      expect(mockChatbotDb.getChatSession).not.toHaveBeenCalled();
    });
  });

  describe('AGENT_RUN_STORE=true — idem-claim scoping (AC-3, real runStore)', () => {
    let fake: DdbFake;

    beforeEach(() => {
      fake = new DdbFake();
      __setDocumentClientForTests(fake as any);
      process.env.AGENT_RUN_STORE = 'true';
    });

    afterEach(() => {
      __setDocumentClientForTests(null);
      delete process.env.AGENT_RUN_STORE;
    });

    it('ACCEPTANCE 3: a non-owner request never creates an idem claim — the 403 fires before the claim', async () => {
      const res = makeRes();
      await agentModeController.generateResponse(makeReq({ userId: attackerId }), res);

      expect(res.statusCode).toBe(403);
      // Nothing was ever written to the run store: no idem# claim, no run# record.
      expect(fake.items.size).toBe(0);
      expect(mockWorkerService.runInWorker).not.toHaveBeenCalled();
    });

    it('ACCEPTANCE 3: after a non-owner attempt, the owner submitting the SAME message is accepted — no squatted claim, no spurious 409', async () => {
      const message = 'predicted message';

      const attackerRes = makeRes();
      await agentModeController.generateResponse(
        makeReq({ userId: attackerId }, { message }),
        attackerRes
      );
      expect(attackerRes.statusCode).toBe(403);

      const ownerRes = makeRes();
      await agentModeController.generateResponse(
        makeReq({ userId: ownerId }, { message }),
        ownerRes
      );

      expect(ownerRes.statusCode).toBe(200);
      expect(ownerRes.body).toEqual(expect.objectContaining({ content: 'OK' }));
      expect(mockWorkerService.runInWorker).toHaveBeenCalledTimes(1);
    });
  });
});
