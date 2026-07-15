/**
 * Session-creation idempotency — the exact ENG-147 storm seam.
 *
 * On 6/27 one client "send" retried into ~30 createSession+generate calls and
 * spawned 30 full agent runs. This suite is the acceptance contract for the
 * fix: with AGENT_RUN_STORE=true and a client-provided idempotencyKey,
 * N concurrent createSession calls create EXACTLY ONE session — duplicates
 * either attach to the winner's session or get a busy response.
 *
 * Deliberately uses the REAL runStore module against a conditional-put-aware
 * DynamoDB fake (no mocks on the store), so the exactly-one-wins semantics is
 * genuinely exercised, not asserted into existence.
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
    generateSessionTitle: jest.fn().mockResolvedValue('Test Title'),
    getMarketingSystemPrompt: jest.fn().mockResolvedValue('System prompt'),
    generateDiagnosticMessage: jest.fn().mockResolvedValue(null),
  },
  AgentModeService: jest.fn(),
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

jest.mock('../utils/agentModeAlerts', () => ({
  sendAgentModeOncallAlert: jest.fn().mockResolvedValue(undefined),
}));

import { agentModeController } from '../controllers/agentModeController';
import { chatbotDb } from '../services/chatbotService';
import { AGENT_RUNS_TABLE, createSessionIdempotencyKey, claimIdempotency, IDEM_TTL_INTERACTIVE_S, __setDocumentClientForTests } from '../services/agentMode/runStore';

const mockChatbotDb = chatbotDb as jest.Mocked<typeof chatbotDb>;

/** Conditional-put-aware in-memory DocumentClient fake (mirrors runStore.test.ts). */
class DdbFake {
  items = new Map<string, any>();

  put = (params: any) => ({
    promise: async () => {
      if (
        params.ConditionExpression === 'attribute_not_exists(pk)' &&
        this.items.has(params.Item.pk)
      ) {
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

const mockUserId = 'user-idem';

const makeReq = (idempotencyKey?: string, userId = mockUserId) =>
  ({
    user: { userId, email: `${userId}@example.com` },
    body: {
      portalType: 'agent',
      pageIdentifier: 'agent-mode',
      ...(idempotencyKey ? { idempotencyKey } : {}),
    },
    method: 'POST',
    path: '/api/agent-mode/sessions',
    on: jest.fn(),
  } as unknown as Request);

const makeRes = () => {
  const res: any = {
    statusCode: 200,
    body: undefined,
  };
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

describe('createSession idempotency (acceptance — ENG-147)', () => {
  let fake: DdbFake;
  let sessionCounter: number;

  beforeEach(() => {
    jest.clearAllMocks();
    fake = new DdbFake();
    __setDocumentClientForTests(fake as any);
    process.env.AGENT_RUN_STORE = 'true';
    sessionCounter = 0;

    mockChatbotDb.createChatSession.mockImplementation(async (userId: string) => {
      sessionCounter += 1;
      return {
        sessionId: `session-${sessionCounter}`,
        userId,
        title: 'New Session',
        messages: [],
        createdAt: '2026-07-15T00:00:00Z',
        updatedAt: '2026-07-15T00:00:00Z',
        portalType: 'agent',
        pageIdentifier: 'agent-mode',
      } as any;
    });
    mockChatbotDb.updateSessionLlmModel.mockImplementation(async (sessionId: string, llmModel: string) => ({
      sessionId,
      userId: mockUserId,
      llmModel,
    } as any));
    mockChatbotDb.getChatSession.mockImplementation(async (sessionId: string) => ({
      sessionId,
      userId: mockUserId,
      title: 'New Session',
      messages: [],
      llmModel: 'gpt-5-chat-2',
    } as any));
  });

  afterEach(() => {
    __setDocumentClientForTests(null);
    delete process.env.AGENT_RUN_STORE;
  });

  it('ACCEPTANCE: 8 concurrent createSession calls with the same idempotencyKey create EXACTLY ONE session; duplicates attach or get the busy response', async () => {
    const responses = Array.from({ length: 8 }, () => makeRes());
    await Promise.all(
      responses.map((res) => agentModeController.createSession(makeReq('storm-key-1'), res))
    );

    // Exactly one session hit the database — the 6/27 storm created 30.
    expect(mockChatbotDb.createChatSession).toHaveBeenCalledTimes(1);

    const statuses = responses.map((r) => r.statusCode);
    expect(statuses.filter((s) => s === 201)).toHaveLength(1);
    // Every duplicate either attached (200, winner's session) or got busy (409).
    const winner = responses.find((r) => r.statusCode === 201)!;
    for (const r of responses) {
      if (r.statusCode === 201) continue;
      expect([200, 409]).toContain(r.statusCode);
      if (r.statusCode === 200) {
        expect(r.body.sessionId).toBe(winner.body.sessionId);
      } else {
        expect(r.body.code).toBe('DUPLICATE_SUBMIT');
      }
    }
  });

  it('a duplicate AFTER the winner completes attaches to the winner\'s session (no new session)', async () => {
    const res1 = makeRes();
    await agentModeController.createSession(makeReq('storm-key-2'), res1);
    expect(res1.statusCode).toBe(201);

    const res2 = makeRes();
    await agentModeController.createSession(makeReq('storm-key-2'), res2);

    expect(mockChatbotDb.createChatSession).toHaveBeenCalledTimes(1);
    expect(res2.statusCode).toBe(200);
    expect(res2.body.sessionId).toBe(res1.body.sessionId);
    expect(res2.body.idempotentReplay).toBe(true);
  });

  it('an in-flight duplicate (claim held, session not yet created) gets the busy response', async () => {
    // Simulate the winner mid-flight: claim held, sessionId not yet recorded.
    await claimIdempotency(
      createSessionIdempotencyKey(mockUserId, 'storm-key-3'),
      'run-in-flight',
      IDEM_TTL_INTERACTIVE_S
    );

    const res = makeRes();
    await agentModeController.createSession(makeReq('storm-key-3'), res);

    expect(res.statusCode).toBe(409);
    expect(res.body.code).toBe('DUPLICATE_SUBMIT');
    expect(mockChatbotDb.createChatSession).not.toHaveBeenCalled();
  });

  it('winner\'s session-creation failure releases the claim so a retry is accepted (no permanent lockout)', async () => {
    mockChatbotDb.createChatSession.mockRejectedValueOnce(new Error('ddb write failed'));

    const res1 = makeRes();
    await agentModeController.createSession(makeReq('storm-key-4'), res1);
    expect(res1.statusCode).toBe(500);

    const res2 = makeRes();
    await agentModeController.createSession(makeReq('storm-key-4'), res2);
    expect(res2.statusCode).toBe(201);
  });

  it('the same client key from DIFFERENT users is isolated — both create their own sessions', async () => {
    const resA = makeRes();
    const resB = makeRes();
    await Promise.all([
      agentModeController.createSession(makeReq('shared-key', 'user-a'), resA),
      agentModeController.createSession(makeReq('shared-key', 'user-b'), resB),
    ]);

    expect(mockChatbotDb.createChatSession).toHaveBeenCalledTimes(2);
    expect(resA.statusCode).toBe(201);
    expect(resB.statusCode).toBe(201);
    expect(resA.body.sessionId).not.toBe(resB.body.sessionId);
  });

  it('BEHAVIOR-PRESERVING: flag off → idempotencyKey is ignored, every call creates a session (today\'s exact behavior), zero store writes', async () => {
    delete process.env.AGENT_RUN_STORE;

    const responses = Array.from({ length: 3 }, () => makeRes());
    await Promise.all(
      responses.map((res) => agentModeController.createSession(makeReq('storm-key-5'), res))
    );

    expect(mockChatbotDb.createChatSession).toHaveBeenCalledTimes(3);
    for (const r of responses) expect(r.statusCode).toBe(201);
    expect(fake.items.size).toBe(0);
  });

  it('BEHAVIOR-PRESERVING: flag on but NO idempotencyKey → today\'s exact behavior (no dedupe, zero store writes)', async () => {
    const responses = Array.from({ length: 2 }, () => makeRes());
    await Promise.all(
      responses.map((res) => agentModeController.createSession(makeReq(undefined), res))
    );

    expect(mockChatbotDb.createChatSession).toHaveBeenCalledTimes(2);
    for (const r of responses) expect(r.statusCode).toBe(201);
    expect(fake.items.size).toBe(0);
  });

  it('table sanity: the store writes land in AW-AgentRuns items keyed idem#…', async () => {
    const res = makeRes();
    await agentModeController.createSession(makeReq('storm-key-6'), res);
    expect(res.statusCode).toBe(201);
    expect(AGENT_RUNS_TABLE).toMatch(/AW-AgentRuns$/);
    const keys = [...fake.items.keys()];
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatch(/^idem#[a-f0-9]{64}$/);
    expect(fake.items.get(keys[0]).sessionId).toBe(res.body.sessionId);
  });
});
