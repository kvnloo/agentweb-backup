/**
 * FAIL-LOUD selected model. An explicit selection (a model the REQUEST carries: /generate
 * llmModel, requestedLlmModel at session creation) must run on exactly that model or not
 * run at all: resolveEffectiveModelForUser throws ModelUnavailableError instead of
 * silently swapping in the default, and the interactive handlers answer 422
 * { error, code:'model_unavailable', requestedModel, reason } with no LLM call, no
 * metering, no session write and the generation lock released. A model merely STORED
 * on a session is not explicit: it falls back to the default (allowSilentSwap).
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

jest.mock('../services/db', () => ({
  userDb: { getUserById: jest.fn() },
  scheduleDb: {},
  taskDb: {},
}));

jest.mock('../services/generateMarketingResponseWorkerService', () => ({
  generateMarketingResponseWorkerService: {
    runInWorker: jest.fn(),
    cancelSession: jest.fn(),
  },
}));

const DEFAULT_MODEL = 'gpt-5-chat-2';
const SERVED = [DEFAULT_MODEL, 'gemini-3.5-flash', 'gpt-5.5'];
const UNSERVED = 'retired-model-9';
const INTERNAL_ONLY = 'internal-judge-1';
const REGISTRY = new Set([...SERVED, INTERNAL_ONLY, 'legacy-old-alias-target']);

jest.mock('../services/agentModeService', () => ({
  agentModeService: {
    default_model: 'gpt-5-chat-2',
    getDefaultModel: jest.fn().mockResolvedValue('gpt-5-chat-2'),
    getReportsModel: jest.fn().mockResolvedValue('gpt-5-chat-2'),
    getCustomerSupportDefaultModel: jest.fn().mockResolvedValue('gpt-5-chat-2'),
    // internalOnly ids are registry keys but excluded from the supported set.
    // Like the real getSupportedModels(false): the live-voice id IS in the supported set.
    getSupportedModels: jest.fn(async () => ['gpt-5-chat-2', 'gemini-3.5-flash', 'gpt-5.5', 'live-voice-1']),
    // Mirrors the real behaviour: unknown ids fall back to the default, registry ids pass.
    resolveGenerationModel: jest.fn((model: string) => {
      const registry = new Set(['gpt-5-chat-2', 'gemini-3.5-flash', 'gpt-5.5', 'internal-judge-1', 'legacy-old-alias-target', 'live-voice-1']);
      // Like the real hasOwnProperty lookup, an array key coerces to its string form.
      const normalized = model === 'legacy-old-alias' ? 'legacy-old-alias-target' : model;
      return registry.has(String(normalized))
        ? { model: normalized, fellBack: false, requestedModel: model }
        : { model: 'gpt-5-chat-2', fellBack: true, requestedModel: model };
    }),
    isLiveModel: jest.fn((id: string) => id === 'live-voice-1'),
    getModelDisplayName: jest.fn((id: string) => (id === 'gpt-5.5' ? 'GPT-5.5' : undefined)),
    generateSessionTitle: jest.fn().mockResolvedValue('Test Title'),
    getMarketingSystemPrompt: jest.fn().mockResolvedValue('System prompt'),
    generateDiagnosticMessage: jest.fn().mockResolvedValue(null),
    getSkillsForDisplay: jest.fn().mockResolvedValue([]),
  },
  AgentModeService: jest.fn(),
}));

jest.mock('../services/llmUsagePolicyResolverService', () => ({
  getEffectiveLlmUsagePolicy: jest.fn(),
}));

jest.mock('../services/tokenUsageService', () => ({
  checkTokenUsage: jest.fn(),
  incrementUserTokenUsage: jest.fn(),
  deriveBlockedByCost: jest.fn(() => ({ blockedByCost: false })),
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
// Delegates to the real runStore unless a test overrides it (ENG-903 ordering tests).
jest.mock('../services/agentMode/runStore', () => {
  const actual = jest.requireActual('../services/agentMode/runStore');
  return {
    ...actual,
    isRunStoreEnabled: jest.fn((...a: unknown[]) => actual.isRunStoreEnabled(...a)),
    claimIdempotency: jest.fn((...a: unknown[]) => actual.claimIdempotency(...a)),
  };
});
jest.mock('../utils/agentModeAlerts', () => ({
  sendAgentModeOncallAlert: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../utils/agentModeErrors', () => ({
  // Spread the real module so new exports (e.g. isProviderUnavailableError) never leave the controller error handler calling undefined.
  ...jest.requireActual('../utils/agentModeErrors'),
  isContextLimitError: jest.fn().mockReturnValue(false),
  isSessionLimitError: jest.fn().mockReturnValue(false),
  isTransientLLMError: jest.fn().mockReturnValue(false),
  isWorkerShutdownError: jest.fn().mockReturnValue(false),
}));

import {
  agentModeController,
  activeSessionGenerations,
  resolveEffectiveModelForUser,
} from '../controllers/agentModeController';
import { ModelUnavailableError, buildModelUnavailableBody, isModelUnavailableError } from '../services/agentMode/modelUnavailable';
import { chatbotDb } from '../services/chatbotService';
import { agentModeService } from '../services/agentModeService';
import { userDb } from '../services/db';
import { generateMarketingResponseWorkerService } from '../services/generateMarketingResponseWorkerService';
import { getEffectiveLlmUsagePolicy } from '../services/llmUsagePolicyResolverService';
import { checkTokenUsage, incrementUserTokenUsage } from '../services/tokenUsageService';
import { isRunStoreEnabled, claimIdempotency } from '../services/agentMode/runStore';

const mockChatbotDb = chatbotDb as jest.Mocked<typeof chatbotDb>;
const mockWorker = generateMarketingResponseWorkerService as jest.Mocked<typeof generateMarketingResponseWorkerService>;
const mockPolicy = getEffectiveLlmUsagePolicy as jest.Mock;
const mockCheckTokenUsage = checkTokenUsage as jest.Mock;
const mockIncrementUsage = incrementUserTokenUsage as jest.Mock;
const mockUserDb = userDb as jest.Mocked<typeof userDb>;
const mockAgentModeService = agentModeService as jest.Mocked<typeof agentModeService>;

const OWNER = 'user-owner';
const SESSION_ID = 'session-1';
const FULL_CHOICE = { usageMode: 'full_choice', admissionAllowed: true, reason: 'policy_not_enforced' };

const MESSAGE = 'Please draft the launch email';


const expectedMessage = (label: string) =>
  `The model you selected (${label}) isn't available right now, so nothing was sent to a different model. Choose another model and try again.`;

const makeRes = () => {
  const res: any = { statusCode: 200, body: undefined };
  res.status = jest.fn((code: number) => { res.statusCode = code; return res; });
  res.json = jest.fn((payload: any) => { res.body = payload; return res; });
  return res as Response & { statusCode: number; body: any };
};

const generateReq = (body: Record<string, unknown>, isAdmin = false) => ({
  user: { userId: OWNER, isAdmin },
  body: { sessionId: SESSION_ID, userMessage: MESSAGE, attachments: [], ...body },
  method: 'POST',
  path: '/api/agent-mode/generate',
  ip: '127.0.0.1',
  socket: { remoteAddress: '127.0.0.1' },
  on: jest.fn(),
} as unknown as Request);

const baseSession = (llmModel?: string) => ({
  sessionId: SESSION_ID,
  userId: OWNER,
  sessionType: 'regular',
  title: 'Chat',
  messages: [],
  createdAt: '2026-07-01T00:00:00Z',
  updatedAt: '2026-07-01T00:00:00Z',
  portalType: 'agent' as const,
  pageIdentifier: 'agent-mode',
  ...(llmModel ? { llmModel } : {}),
});

const workerResult = { content: 'OK', toolCalls: [], knowledgeBaseQueries: [], sources: [], responseMessages: [] };

beforeEach(() => {
  jest.clearAllMocks();
  activeSessionGenerations.clear();
  mockPolicy.mockResolvedValue({ billingUserId: OWNER, policy: null, costUsedMicroUsd: 0, tokenUsed: 0, mode: FULL_CHOICE });
  mockCheckTokenUsage.mockResolvedValue({
    allowed: true, warning: false, used: 0, allowance: null, bonus: 0, effectiveAllowance: null, percentUsed: 0, month: '2026-07',
  });
  mockChatbotDb.getChatSession.mockResolvedValue(baseSession('gpt-5.5') as any);
  (mockChatbotDb as any).getMessagesFromMessagesTable.mockResolvedValue([]);
  mockChatbotDb.addMessageToSession.mockResolvedValue(baseSession() as any);
  mockChatbotDb.addMessagesToSession.mockResolvedValue(undefined as any);
  mockChatbotDb.updateSessionTitle.mockResolvedValue(undefined as any);
  mockChatbotDb.updateSessionLlmModel.mockResolvedValue(baseSession('gpt-5.5') as any);
  mockChatbotDb.createChatSession.mockResolvedValue(baseSession() as any);
  mockWorker.runInWorker.mockResolvedValue(workerResult as any);
  mockUserDb.getUserById.mockResolvedValue({ userId: OWNER, isAdmin: false } as any);
});

describe('resolveEffectiveModelForUser (fail-loud)', () => {
  it('throws not_served for an unserved explicit id and echoes the requested id', async () => {
    const err = await resolveEffectiveModelForUser({ userId: OWNER, requestedModel: UNSERVED }).catch((e) => e);
    expect(err).toBeInstanceOf(ModelUnavailableError);
    expect(err).toMatchObject({ code: 'model_unavailable', requestedModel: UNSERVED, reason: 'not_served' });
  });

  it('throws not_selectable for a registry id outside the supported set (internalOnly)', async () => {
    const err = await resolveEffectiveModelForUser({ userId: OWNER, requestedModel: INTERNAL_ONLY }).catch((e) => e);
    expect(isModelUnavailableError(err)).toBe(true);
    expect(err).toMatchObject({ requestedModel: INTERNAL_ONLY, reason: 'not_selectable' });
  });

  it('defaults (no throw) when no model is requested', async () => {
    const decision = await resolveEffectiveModelForUser({ userId: OWNER });
    expect(decision).toMatchObject({ effectiveModel: DEFAULT_MODEL, modelSelection: 'defaulted' });
  });

  it('returns blocked (no throw) when usage is paused, even for an unserved id', async () => {
    mockPolicy.mockResolvedValue({
      billingUserId: OWNER, policy: null, costUsedMicroUsd: 0, tokenUsed: 0,
      mode: { usageMode: 'paused', admissionAllowed: false, reason: 'hard_threshold_reached' },
    });
    const decision = await resolveEffectiveModelForUser({ userId: OWNER, requestedModel: UNSERVED });
    expect(decision).toMatchObject({ effectiveModel: null, modelSelection: 'blocked' });
  });

  it('honors a served id and a legacy alias (normalized first)', async () => {
    await expect(resolveEffectiveModelForUser({ userId: OWNER, requestedModel: 'gpt-5.5' }))
      .resolves.toMatchObject({ effectiveModel: 'gpt-5.5', modelSelection: 'honored' });
    (mockAgentModeService.getSupportedModels as jest.Mock).mockResolvedValueOnce([DEFAULT_MODEL, 'legacy-old-alias-target']);
    await expect(resolveEffectiveModelForUser({ userId: OWNER, requestedModel: 'legacy-old-alias' }))
      .resolves.toMatchObject({ effectiveModel: 'legacy-old-alias-target', modelSelection: 'honored' });
  });

  it('drops an unserved user backup instead of throwing', async () => {
    const decision = await resolveEffectiveModelForUser({
      userId: OWNER, requestedModel: 'gpt-5.5', backupModel: UNSERVED, backupSource: 'user',
    });
    expect(decision).toMatchObject({ effectiveModel: 'gpt-5.5', modelSelection: 'honored', backupModel: null });
  });

  it('gives admins and non-admins the identical result for an unserved id', async () => {
    const outcomes: unknown[] = [];
    for (const isAdmin of [false, true]) {
      mockUserDb.getUserById.mockResolvedValue({ userId: OWNER, isAdmin } as any);
      const err = await resolveEffectiveModelForUser({ userId: OWNER, requestedModel: UNSERVED }).catch((e) => e);
      outcomes.push({ code: err.code, requestedModel: err.requestedModel, reason: err.reason });
    }
    expect(outcomes[0]).toEqual(outcomes[1]);
  });

  it('allowSilentSwap (schedule caller, WP-G) keeps today\'s swap for a registry id outside the supported set', async () => {
    const decision = await resolveEffectiveModelForUser({ userId: OWNER, requestedModel: INTERNAL_ONLY, allowSilentSwap: true });
    expect(decision).toMatchObject({ effectiveModel: DEFAULT_MODEL, modelSelection: 'corrected' });
  });
});

describe('POST /generate (fail-loud)', () => {
  const assertNothingRan = () => {
    expect(mockWorker.runInWorker).not.toHaveBeenCalled();
    expect(mockChatbotDb.updateSessionLlmModel).not.toHaveBeenCalled();
    expect(mockChatbotDb.addMessageToSession).not.toHaveBeenCalled();
    expect(mockChatbotDb.addMessagesToSession).not.toHaveBeenCalled();
    expect(mockIncrementUsage).not.toHaveBeenCalled();
    expect(activeSessionGenerations.has(SESSION_ID)).toBe(false);
  };

  it('422s for an unserved request llmModel with the exact body and runs nothing', async () => {
    const res = makeRes();
    await agentModeController.generateResponse(generateReq({ llmModel: UNSERVED }), res);

    expect(res.statusCode).toBe(422);
    expect(res.body).toEqual({
      error: expectedMessage(UNSERVED),
      code: 'model_unavailable',
      requestedModel: UNSERVED,
      reason: 'not_served',
    });
    assertNothingRan();
  });

  it('releases the lock: an immediate second request is 422 again, not 409 SESSION_BUSY', async () => {
    await agentModeController.generateResponse(generateReq({ llmModel: UNSERVED }), makeRes());
    const second = makeRes();
    await agentModeController.generateResponse(generateReq({ llmModel: UNSERVED }), second);
    expect(second.statusCode).toBe(422);
    expect(second.body.code).toBe('model_unavailable');
  });

  it('a STORED retired model with NO request llmModel is not an explicit selection: runs on the default', async () => {
    mockChatbotDb.getChatSession.mockResolvedValue(baseSession(UNSERVED) as any);
    const res = makeRes();
    await agentModeController.generateResponse(generateReq({}), res);

    expect(res.statusCode).toBe(200);
    expect(mockWorker.runInWorker).toHaveBeenCalledWith(expect.objectContaining({ llmModel: DEFAULT_MODEL }), expect.anything());
    expect(res.body).toMatchObject({ effectiveModel: DEFAULT_MODEL });
  });

  describe('configured default differs from the code constant (agent_mode_default_model set)', () => {
    const CONFIGURED = 'gemini-3.5-flash'; // what getDefaultModel() (the setting) returns; DEFAULT_MODEL is the code constant
    beforeEach(() => { mockAgentModeService.getDefaultModel.mockResolvedValue(CONFIGURED); });
    afterEach(() => { mockAgentModeService.getDefaultModel.mockResolvedValue(DEFAULT_MODEL); });

    it('stored retired + no request model runs on the configured default and is reported corrected, not honored', async () => {
      mockChatbotDb.getChatSession.mockResolvedValue(baseSession(UNSERVED) as any);
      const res = makeRes();
      await agentModeController.generateResponse(generateReq({}), res);
      expect(res.statusCode).toBe(200);
      expect(mockWorker.runInWorker).toHaveBeenCalledWith(expect.objectContaining({ llmModel: CONFIGURED }), expect.anything());
      expect(res.body).toMatchObject({ effectiveModel: CONFIGURED, modelSelection: 'corrected' });
      expect(res.body.modelSelectionReason).not.toBe('requested_model_allowed');
    });

    it('no stored model + no request model gets the configured default, like a brand-new session', async () => {
      mockChatbotDb.getChatSession.mockResolvedValue(baseSession() as any);
      const res = makeRes();
      await agentModeController.generateResponse(generateReq({}), res);
      expect(mockWorker.runInWorker).toHaveBeenCalledWith(expect.objectContaining({ llmModel: CONFIGURED }), expect.anything());
    });

    it('resolver: silent-swap retired id falls to the configured default as corrected', async () => {
      const decision = await resolveEffectiveModelForUser({ userId: OWNER, requestedModel: UNSERVED, allowSilentSwap: true });
      expect(decision).toMatchObject({ effectiveModel: CONFIGURED, modelSelection: 'corrected' });
    });

    it('explicit retired id still 422s', async () => {
      const res = makeRes();
      await agentModeController.generateResponse(generateReq({ llmModel: UNSERVED }), res);
      expect(res.statusCode).toBe(422);
    });
  });

  it('a STORED internalOnly model with no request llmModel runs on the default, never the stored one', async () => {
    mockChatbotDb.getChatSession.mockResolvedValue(baseSession(INTERNAL_ONLY) as any);
    const res = makeRes();
    await agentModeController.generateResponse(generateReq({}), res);

    expect(res.statusCode).toBe(200);
    expect(mockWorker.runInWorker).toHaveBeenCalledWith(expect.objectContaining({ llmModel: DEFAULT_MODEL }), expect.anything());
  });

  it('trims a padded request llmModel and runs on it', async () => {
    const res = makeRes();
    await agentModeController.generateResponse(generateReq({ llmModel: ' gpt-5.5\n' }), res);
    expect(res.statusCode).toBe(200);
    expect(mockWorker.runInWorker).toHaveBeenCalledWith(expect.objectContaining({ llmModel: 'gpt-5.5' }), expect.anything());
  });

  it('a whitespace-only request llmModel counts as NO selection (stored retired model falls back, no 422)', async () => {
    mockChatbotDb.getChatSession.mockResolvedValue(baseSession(UNSERVED) as any);
    const res = makeRes();
    await agentModeController.generateResponse(generateReq({ llmModel: '   ' }), res);
    expect(res.statusCode).toBe(200);
  });

  it('a STORED live-voice model with NO request llmModel runs on the default in a text chat (never the live id)', async () => {
    mockChatbotDb.getChatSession.mockResolvedValue(baseSession('live-voice-1') as any);
    const res = makeRes();
    await agentModeController.generateResponse(generateReq({}), res);
    expect(res.statusCode).toBe(200);
    expect(mockWorker.runInWorker).toHaveBeenCalledWith(expect.objectContaining({ llmModel: DEFAULT_MODEL }), expect.anything());
    expect(mockWorker.runInWorker).not.toHaveBeenCalledWith(expect.objectContaining({ llmModel: 'live-voice-1' }), expect.anything());
  });

  it('resolver: allowSilentSwap + live model is corrected to the default', async () => {
    const decision = await resolveEffectiveModelForUser({ userId: OWNER, requestedModel: 'live-voice-1', allowSilentSwap: true });
    expect(decision.effectiveModel).toBe(DEFAULT_MODEL);
    expect(decision.modelSelection).toBe('corrected');
  });

  it.each([
    ['array', ['gpt-5.5']],
    ['nested array', [['gpt-5.5']]],
    ['number', 5],
    ['true', true],
    ['object', { id: 'gpt-5.5' }],
  ])('non-string llmModel (%s) is an explicit but unserved selection: 422 model_unavailable, not 500', async (_n, value) => {
    const res = makeRes();
    await agentModeController.generateResponse(generateReq({ llmModel: value }), res);
    expect(res.statusCode).toBe(422);
    expect(res.body).toMatchObject({ code: 'model_unavailable' });
    expect(typeof res.body.requestedModel).toBe('string');
    assertNothingRan();
  });

  it('null llmModel is NO selection (stored model falls back, 200)', async () => {
    mockChatbotDb.getChatSession.mockResolvedValue(baseSession(UNSERVED) as any);
    const res = makeRes();
    await agentModeController.generateResponse(generateReq({ llmModel: null }), res);
    expect(res.statusCode).toBe(200);
  });

  it('422 not_selectable for an explicit LIVE voice model, before the user message is persisted', async () => {
    const res = makeRes();
    await agentModeController.generateResponse(generateReq({ llmModel: 'live-voice-1' }), res);
    expect(res.statusCode).toBe(422);
    expect(res.body).toMatchObject({ code: 'model_unavailable', reason: 'not_selectable', requestedModel: 'live-voice-1' });
    assertNothingRan();
  });

  it('keeps the user backup model through the pre-flight decision (reported and stored unchanged)', async () => {
    const res = makeRes();
    await agentModeController.generateResponse(generateReq({ llmModel: 'gpt-5.5', llmBackupModel: 'gemini-3.5-flash' }), res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ backupModel: 'gemini-3.5-flash', backupSource: 'user' });
    expect(mockChatbotDb.updateSessionLlmModel).toHaveBeenCalledWith(
      SESSION_ID, 'gpt-5.5', expect.objectContaining({ backupModel: 'gemini-3.5-flash' }),
    );
  });

  it('422 not_selectable for an internalOnly id', async () => {
    const res = makeRes();
    await agentModeController.generateResponse(generateReq({ llmModel: INTERNAL_ONLY }), res);
    expect(res.statusCode).toBe(422);
    expect(res.body).toMatchObject({ reason: 'not_selectable', requestedModel: INTERNAL_ONLY });
    assertNothingRan();
  });

  it('admin and non-admin get the identical 422', async () => {
    const bodies: unknown[] = [];
    for (const isAdmin of [false, true]) {
      mockUserDb.getUserById.mockResolvedValue({ userId: OWNER, isAdmin } as any);
      const res = makeRes();
      await agentModeController.generateResponse(generateReq({ llmModel: UNSERVED }, isAdmin), res);
      expect(res.statusCode).toBe(422);
      bodies.push(res.body);
    }
    expect(bodies[0]).toEqual(bodies[1]);
  });

  it('paused user + unserved model gets the usage_paused 429, not 422/500', async () => {
    mockCheckTokenUsage.mockResolvedValue({
      allowed: false, warning: false, used: 1, allowance: 1, bonus: 0, effectiveAllowance: 1, percentUsed: 100,
      month: '2026-07', usagePolicyVersion: 'v1',
    });
    const res = makeRes();
    await agentModeController.generateResponse(generateReq({ llmModel: UNSERVED }), res);
    // Paused mode: resolver returns 'blocked' (policy 429). Full-choice mode with an exhausted
    // allowance: resolver throws and the plain 429 is returned. Both are 429 usage_paused.
    expect(res.statusCode).toBe(429);
    expect(res.body.code).toBe('usage_paused');
    expect(mockWorker.runInWorker).not.toHaveBeenCalled();
    expect(activeSessionGenerations.has(SESSION_ID)).toBe(false);
  });

  it('paused (cost hard cap) + unserved model gets usage_paused 429 with a blocked decision', async () => {
    mockPolicy.mockResolvedValue({
      billingUserId: OWNER, policy: null, costUsedMicroUsd: 0, tokenUsed: 0,
      mode: { usageMode: 'paused', admissionAllowed: false, reason: 'hard_threshold_reached' },
    });
    const res = makeRes();
    await agentModeController.generateResponse(generateReq({ llmModel: UNSERVED }), res);
    expect(res.statusCode).toBe(429);
    expect(res.body).toMatchObject({ code: 'usage_paused', modelSelection: 'blocked' });
  });

  it('runs the resolver pass ONCE per normal turn (pre-flight decision is reused at dispatch)', async () => {
    const res = makeRes();
    await agentModeController.generateResponse(generateReq({ llmModel: 'gpt-5.5' }), res);
    expect(res.statusCode).toBe(200);
    expect(mockPolicy).toHaveBeenCalledTimes(1);
    expect(mockAgentModeService.getDefaultModel).toHaveBeenCalledTimes(1);
  });

  it('happy path: a served model still runs on exactly that model and is stored', async () => {
    const res = makeRes();
    await agentModeController.generateResponse(generateReq({ llmModel: 'gpt-5.5' }), res);

    expect(res.statusCode).toBe(200);
    expect(mockWorker.runInWorker).toHaveBeenCalledWith(
      expect.objectContaining({ llmModel: 'gpt-5.5' }),
      expect.anything(),
    );
    expect(mockChatbotDb.updateSessionLlmModel).toHaveBeenCalledWith(SESSION_ID, 'gpt-5.5', expect.objectContaining({ modelSelection: 'honored' }));
    expect(res.body).toMatchObject({ effectiveModel: 'gpt-5.5', modelSelection: 'honored' });
  });
});

describe('shared generate (anonymous visitors select nothing)', () => {
  it.each([UNSERVED, INTERNAL_ONLY, 'live-voice-1'])('a stored %s owner model falls back to the default, no 422', async (stored) => {
    mockChatbotDb.getChatSession.mockResolvedValue({
      ...baseSession(stored),
      interactiveShareMetadata: { isActive: true, token: 'tok', sharedAt: '2026-07-01T00:00:00Z' },
    } as any);
    const res = makeRes();
    await agentModeController.generateSharedResponse({
      params: { shareId: SESSION_ID },
      query: { conversable: 'tok' },
      body: { userMessage: MESSAGE, attachments: [] },
      on: jest.fn(),
    } as unknown as Request, res);

    expect(res.statusCode).not.toBe(422);
    expect(mockWorker.runInWorker).toHaveBeenCalledWith(expect.objectContaining({ llmModel: DEFAULT_MODEL }), expect.anything());
  });
});

describe('createSession (fail-loud)', () => {
  const createReq = (body: Record<string, unknown>) => ({ user: { userId: OWNER }, body } as unknown as Request);

  it('422s for an unserved requestedLlmModel and creates no session', async () => {
    const res = makeRes();
    await agentModeController.createSession(createReq({ portalType: 'agent', llmModel: UNSERVED }), res);

    expect(res.statusCode).toBe(422);
    expect(res.body).toMatchObject({ code: 'model_unavailable', requestedModel: UNSERVED, reason: 'not_served' });
    expect(mockChatbotDb.createChatSession).not.toHaveBeenCalled();
    expect(mockChatbotDb.updateSessionLlmModel).not.toHaveBeenCalled();
  });

  it('trims a padded requestedLlmModel; blank counts as no selection', async () => {
    const padded = makeRes();
    await agentModeController.createSession(createReq({ portalType: 'agent', llmModel: ' gpt-5.5' }), padded);
    expect(padded.statusCode).toBe(201);
    expect(mockChatbotDb.updateSessionLlmModel).toHaveBeenCalledWith(SESSION_ID, 'gpt-5.5', expect.anything());

    const blank = makeRes();
    await agentModeController.createSession(createReq({ portalType: 'agent', llmModel: '   ' }), blank);
    expect(blank.statusCode).toBe(201);
  });

  it('422 not_selectable for an explicit LIVE voice model and creates no session', async () => {
    const res = makeRes();
    await agentModeController.createSession(createReq({ portalType: 'agent', llmModel: 'live-voice-1' }), res);
    expect(res.statusCode).toBe(422);
    expect(res.body).toMatchObject({ reason: 'not_selectable' });
    expect(mockChatbotDb.createChatSession).not.toHaveBeenCalled();
  });

  it('creates normally for a served model and for no model (default)', async () => {
    const served = makeRes();
    await agentModeController.createSession(createReq({ portalType: 'agent', llmModel: 'gpt-5.5' }), served);
    expect(served.statusCode).toBe(201);
    expect(mockChatbotDb.updateSessionLlmModel).toHaveBeenCalledWith(SESSION_ID, 'gpt-5.5', expect.anything());

    mockChatbotDb.updateSessionLlmModel.mockClear();
    const dflt = makeRes();
    await agentModeController.createSession(createReq({ portalType: 'agent' }), dflt);
    expect(dflt.statusCode).toBe(201);
    expect(mockChatbotDb.updateSessionLlmModel).toHaveBeenCalledWith(SESSION_ID, DEFAULT_MODEL, expect.anything());
  });

  // ENG-903: these session types run on a fixed, admin-configured model; a chat-model
  // choice is meaningless there and must be refused, never silently ignored.
  const FIXED_BODY_CODE = 'model_not_selectable_for_session_type';

  it.each([
    ['emma-sidebar portal', { portalType: 'emma-sidebar' }],
    ['report_generation', { portalType: 'agent', sessionType: 'report_generation' }],
    ['image-generation', { portalType: 'agent', sessionType: 'image-generation' }],
    ['video-generation', { portalType: 'agent', sessionType: 'video-generation' }],
    ['book-generation', { portalType: 'agent', sessionType: 'book-generation' }],
    ['scheduled', { portalType: 'agent', sessionType: 'scheduled' }],
  ])('422s an explicit llmModel for a %s session and writes nothing', async (_n, extra) => {
    for (const llmModel of ['gpt-5.5', UNSERVED]) {
      const res = makeRes();
      await agentModeController.createSession(createReq({ ...extra, llmModel }), res);
      expect(res.statusCode).toBe(422);
      expect(res.body).toMatchObject({
        code: FIXED_BODY_CODE,
        error: 'This kind of session uses a fixed model and does not accept a model choice.',
      });
    }
    expect(mockChatbotDb.createChatSession).not.toHaveBeenCalled();
    expect(mockChatbotDb.updateSessionLlmModel).not.toHaveBeenCalled();
  });

  it('422s an explicit llmModel on a skill session (before the skill is even loaded)', async () => {
    const res = makeRes();
    await agentModeController.createSession(
      { user: { userId: OWNER }, params: { skillId: 'skill-1' }, body: { llmModel: 'gpt-5.5' } } as unknown as Request,
      res,
    );
    expect(res.statusCode).toBe(422);
    expect(res.body).toMatchObject({ code: FIXED_BODY_CODE });
    expect(mockChatbotDb.createChatSession).not.toHaveBeenCalled();
  });

  it.each([
    ['emma-sidebar portal', { portalType: 'emma-sidebar' }],
    ['report_generation', { portalType: 'agent', sessionType: 'report_generation' }],
    ['image-generation', { portalType: 'agent', sessionType: 'image-generation' }],
  ])('a %s session with no / blank model still creates on the admin-configured model', async (_n, extra) => {
    for (const body of [{ ...extra }, { ...extra, llmModel: '' }, { ...extra, llmModel: '   ' }]) {
      mockChatbotDb.updateSessionLlmModel.mockClear();
      const res = makeRes();
      await agentModeController.createSession(createReq(body), res);
      expect(res.statusCode).toBe(201);
      expect(mockChatbotDb.updateSessionLlmModel).toHaveBeenCalledWith(SESSION_ID, DEFAULT_MODEL, undefined);
    }
  });

  afterEach(() => {
    (isRunStoreEnabled as jest.Mock).mockImplementation(() => jest.requireActual('../services/agentMode/runStore').isRunStoreEnabled());
  });

  it('refuses the fixed-model 422 BEFORE the idempotency claim (no claim, no session)', async () => {
    (isRunStoreEnabled as jest.Mock).mockReturnValue(true);
    (claimIdempotency as jest.Mock).mockClear();
    const res = makeRes();
    await agentModeController.createSession(
      createReq({ sessionType: 'report_generation', llmModel: 'gpt-5.5', idempotencyKey: 'k' }), res);
    expect(res.statusCode).toBe(422);
    expect(res.body).toMatchObject({ code: FIXED_BODY_CODE });
    expect(claimIdempotency).not.toHaveBeenCalled();
    expect(mockChatbotDb.createChatSession).not.toHaveBeenCalled();
  });

  it('refuses the skill-route 422 BEFORE the idempotency claim (no claim, no session)', async () => {
    (isRunStoreEnabled as jest.Mock).mockReturnValue(true);
    (claimIdempotency as jest.Mock).mockClear();
    const res = makeRes();
    await agentModeController.createSession(
      { user: { userId: OWNER }, params: { skillId: 'skill-1' }, body: { llmModel: 'gpt-5.5', idempotencyKey: 'k' } } as unknown as Request,
      res,
    );
    expect(res.statusCode).toBe(422);
    expect(res.body).toMatchObject({ code: FIXED_BODY_CODE });
    expect(claimIdempotency).not.toHaveBeenCalled();
    expect(mockChatbotDb.createChatSession).not.toHaveBeenCalled();
  });

  // Documents current behavior: sessionType is matched exactly ('regular'), as the old code
  // did. Any other spelling is a non-regular (fixed-model) type, so a model is refused.
  it.each(['Regular', ' regular', 'REGULAR'])(
    'sessionType %j is NOT "regular": 422 with a model, 201 without',
    async (sessionType) => {
      const refused = makeRes();
      await agentModeController.createSession(createReq({ portalType: 'agent', sessionType, llmModel: 'gpt-5.5' }), refused);
      expect(refused.statusCode).toBe(422);
      expect(refused.body).toMatchObject({ code: FIXED_BODY_CODE });
      expect(mockChatbotDb.createChatSession).not.toHaveBeenCalled();

      const ok = makeRes();
      await agentModeController.createSession(createReq({ portalType: 'agent', sessionType }), ok);
      expect(ok.statusCode).toBe(201);
    },
  );

  it('an explicit sessionType "regular" with a served model is still an ordinary chat session', async () => {
    const res = makeRes();
    await agentModeController.createSession(createReq({ portalType: 'agent', sessionType: 'regular', llmModel: 'gpt-5.5' }), res);
    expect(res.statusCode).toBe(201);
    expect(mockChatbotDb.updateSessionLlmModel).toHaveBeenCalledWith(SESSION_ID, 'gpt-5.5', expect.anything());
  });
});

describe('buildModelUnavailableBody (single message producer)', () => {
  it('truncates by code points: never leaves a lone surrogate, keeps the 120 cap and ellipsis', () => {
    const label = buildModelUnavailableBody(new ModelUnavailableError('😀'.repeat(130), 'not_served')).requestedModel;
    expect(Array.from(label)).toHaveLength(120);
    expect(label.endsWith('…')).toBe(true);
    expect(label).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    expect(buildModelUnavailableBody(new ModelUnavailableError('gpt-5.5', 'not_served')).requestedModel).toBe('gpt-5.5');
  });

  it('uses the display name when given, else the raw id', () => {
    const err = new ModelUnavailableError('gpt-5.5', 'not_selectable');
    expect(buildModelUnavailableBody(err, 'GPT-5.5').error).toBe(expectedMessage('GPT-5.5'));
    expect(buildModelUnavailableBody(err).error).toBe(expectedMessage('gpt-5.5'));
  });

  it('strips control characters and truncates to 120 chars', () => {
    const hostile = `evil\u0000\n\r\u2028model${'x'.repeat(300)}`;
    const body = buildModelUnavailableBody(new ModelUnavailableError(hostile, 'not_served'));
    expect(body.requestedModel).not.toMatch(/[\u0000-\u001f\u2028]/);
    expect(body.requestedModel.length).toBeLessThanOrEqual(120);
    expect(body.error).toContain(body.requestedModel);
    expect(body.error).not.toMatch(/[\u0000-\u001f\u2028]/);
  });

  it('echoes markup as inert JSON text (never HTML-rendered server side)', () => {
    const body = buildModelUnavailableBody(new ModelUnavailableError('<img src=x onerror=alert(1)>', 'not_served'));
    expect(JSON.parse(JSON.stringify(body)).requestedModel).toBe('<img src=x onerror=alert(1)>');
  });

  it('falls back to a placeholder when nothing printable remains', () => {
    expect(buildModelUnavailableBody(new ModelUnavailableError('\u0000\u0001', 'not_served')).error).toContain('(unknown model)');
  });
});
