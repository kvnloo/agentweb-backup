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
    // Like the real one: registry, not internalOnly, not live (no adminOnly ids in this double).
    isModelSelectableBy: jest.fn((id: string) => ['gpt-5-chat-2', 'gemini-3.5-flash', 'gpt-5.5', 'legacy-old-alias-target'].includes(id)),
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
  // ENG-669: the tier allowlist resolves the owner's tier through these two.
  getUserSubscriptionResolution: jest.fn(),
  readTierAllowedModels: jest.fn(),
}));
// ENG-669: AW-Settings rows by name (the tier-allowlist switch, subscription_types); absent = null.
const mockSettings: Record<string, string | undefined> = {};
jest.mock('../services/settingsService', () => ({
  settingsService: {
    getSetting: jest.fn(async (name: string) => (mockSettings[name] === undefined ? null : { settingName: name, settingValue: mockSettings[name] })),
  },
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
  generateSessionResponse,
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
import { modelAccess } from '../services/agentMode/modelAccessInstance';
import { workPlanStepModels } from '../services/agentMode/workPlanStepModelsInstance';
import { readTierAllowedModels, getUserSubscriptionResolution } from '../services/subscriptionService';
import { isTransientLLMError, isWorkerShutdownError, isContextLimitError, PROVIDER_UNAVAILABLE_USER_MESSAGE } from '../utils/agentModeErrors';

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
  // ENG-669: the tier allowlist is OFF unless a test turns it on (absent row = today's behaviour).
  for (const key of Object.keys(mockSettings)) delete mockSettings[key];
  modelAccess.reset();
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
      userMessageSaved: false,
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
      SESSION_ID, 'gpt-5.5', expect.objectContaining({ backupModel: 'gemini-3.5-flash' }), 'user',
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
    expect(mockChatbotDb.updateSessionLlmModel).toHaveBeenCalledWith(SESSION_ID, 'gpt-5.5', expect.objectContaining({ modelSelection: 'honored' }), 'user');
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
    expect(mockChatbotDb.updateSessionLlmModel).toHaveBeenCalledWith(SESSION_ID, 'gpt-5.5', expect.anything(), 'user');

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
    expect(mockChatbotDb.updateSessionLlmModel).toHaveBeenCalledWith(SESSION_ID, 'gpt-5.5', expect.anything(), 'user');

    mockChatbotDb.updateSessionLlmModel.mockClear();
    const dflt = makeRes();
    await agentModeController.createSession(createReq({ portalType: 'agent' }), dflt);
    expect(dflt.statusCode).toBe(201);
    expect(mockChatbotDb.updateSessionLlmModel).toHaveBeenCalledWith(SESSION_ID, DEFAULT_MODEL, expect.anything(), 'system');
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
      expect(mockChatbotDb.updateSessionLlmModel).toHaveBeenCalledWith(SESSION_ID, DEFAULT_MODEL, undefined, 'system');
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
    expect(mockChatbotDb.updateSessionLlmModel).toHaveBeenCalledWith(SESSION_ID, 'gpt-5.5', expect.anything(), 'user');
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

/**
 * ENG-669 PR-A: tier-gated model selection. The owner's tier allowlist (`allowedModels`) is checked on the
 * CANONICAL id, against the SESSION OWNER, for the requested AND the stored model, before any silent swap: a model
 * outside the plan is a 422 `model_unavailable` / `not_in_plan` (with the plan details for the owner, without them
 * for a share viewer), never swapped and never rewritten. System models (the configured default) always run.
 * Switch off => exactly the behaviour above.
 */
describe('ENG-669 tier model allowlist', () => {
  const ALLOWED = 'gemini-3.5-flash';
  const DISALLOWED = 'gpt-5.5';
  const mockResolution = getUserSubscriptionResolution as jest.Mock;
  const mockTierConfig = readTierAllowedModels as jest.Mock;
  const PLAN_FIELDS = { model: DISALLOWED, tier: 'Free', allowedModels: [ALLOWED], upgradeRequired: ['Pro'] };

  const switchOn = () => { mockSettings.model_tier_allowlist_enabled = 'true'; };

  beforeEach(() => {
    mockSettings.subscription_types = JSON.stringify([
      { name: 'Free', allowedModels: [ALLOWED] },
      { name: 'Pro', allowedModels: ['*'] },
    ]);
    mockResolution.mockResolvedValue({ subscriptionType: 'Free', resolved: true });
    mockTierConfig.mockImplementation(async (tier: string) => {
      const row = JSON.parse(mockSettings.subscription_types as string).find((t: any) => t.name === tier);
      return row ? { configured: true, allowedModels: row.allowedModels } : { configured: false };
    });
  });

  const shareReq = () => ({
    params: { shareId: SESSION_ID },
    query: { conversable: 'tok' },
    body: { userMessage: MESSAGE, attachments: [] },
    on: jest.fn(),
  } as unknown as Request);
  const sharedSession = (llmModel: string) => ({
    ...baseSession(llmModel),
    interactiveShareMetadata: { isActive: true, token: 'tok', sharedAt: '2026-07-01T00:00:00Z' },
  });

  describe('switch OFF: byte-identical to today', () => {
    it('a stored model outside the (configured) plan still runs, and no tier is read', async () => {
      mockChatbotDb.getChatSession.mockResolvedValue(baseSession(DISALLOWED) as any);
      const res = makeRes();
      await agentModeController.generateResponse(generateReq({}), res);
      expect(res.statusCode).toBe(200);
      expect(mockWorker.runInWorker).toHaveBeenCalledWith(expect.objectContaining({ llmModel: DISALLOWED }), expect.anything());
      expect(mockResolution).not.toHaveBeenCalled();
      expect(mockTierConfig).not.toHaveBeenCalled();
    });

    it('resolver: explicit and stored selections are honored exactly as before', async () => {
      await expect(resolveEffectiveModelForUser({ userId: OWNER, requestedModel: DISALLOWED }))
        .resolves.toMatchObject({ effectiveModel: DISALLOWED, modelSelection: 'honored' });
      await expect(resolveEffectiveModelForUser({ userId: OWNER, requestedModel: DISALLOWED, allowSilentSwap: true }))
        .resolves.toMatchObject({ effectiveModel: DISALLOWED, modelSelection: 'honored' });
    });

    it('the session-model PATCH keeps its pre-existing caller-based 403 / 200', async () => {
      const res = makeRes();
      await agentModeController.updateSessionLlmModel({ user: { userId: OWNER }, params: { sessionId: SESSION_ID }, body: { llmModel: DISALLOWED } } as any, res);
      expect(res.statusCode).toBe(200);
      expect(mockChatbotDb.updateSessionLlmModel).toHaveBeenCalledWith(SESSION_ID, DISALLOWED, undefined, 'user');
    });
  });

  describe('switch ON', () => {
    beforeEach(switchOn);

    describe('resolver', () => {
      it('refuses an explicit selection outside the plan with not_in_plan and the plan details', async () => {
        const err = await resolveEffectiveModelForUser({ userId: OWNER, requestedModel: DISALLOWED }).catch((e) => e);
        expect(err).toMatchObject({ code: 'model_unavailable', reason: 'not_in_plan', requestedModel: DISALLOWED, plan: PLAN_FIELDS });
      });

      it('refuses a STORED selection too (allowSilentSwap): never corrected to the default', async () => {
        const err = await resolveEffectiveModelForUser({ userId: OWNER, requestedModel: DISALLOWED, allowSilentSwap: true }).catch((e) => e);
        expect(err).toMatchObject({ reason: 'not_in_plan' });
      });

      it('matches the canonical id after alias resolution', async () => {
        mockSettings.subscription_types = JSON.stringify([{ name: 'Free', allowedModels: ['legacy-old-alias-target'] }]);
        (mockAgentModeService.getSupportedModels as jest.Mock).mockResolvedValueOnce([DEFAULT_MODEL, 'legacy-old-alias-target', DISALLOWED]);
        await expect(resolveEffectiveModelForUser({ userId: OWNER, requestedModel: 'legacy-old-alias' }))
          .resolves.toMatchObject({ effectiveModel: 'legacy-old-alias-target', modelSelection: 'honored' });
      });

      it('the only exempt paths: defaulted (nothing requested), the configured default, a system model', async () => {
        await expect(resolveEffectiveModelForUser({ userId: OWNER })).resolves.toMatchObject({ modelSelection: 'defaulted' });
        await expect(resolveEffectiveModelForUser({ userId: OWNER, requestedModel: DEFAULT_MODEL })).resolves.toMatchObject({ modelSelection: 'honored' });
        await expect(resolveEffectiveModelForUser({ userId: OWNER, requestedModel: DISALLOWED, modelSource: 'system' }))
          .resolves.toMatchObject({ effectiveModel: DISALLOWED, modelSelection: 'honored' });
      });

      it('an admin owner bypasses; a paused account keeps its plain blocked decision', async () => {
        mockUserDb.getUserById.mockResolvedValue({ userId: OWNER, isAdmin: true } as any);
        await expect(resolveEffectiveModelForUser({ userId: OWNER, requestedModel: DISALLOWED })).resolves.toMatchObject({ modelSelection: 'honored' });
        mockUserDb.getUserById.mockResolvedValue({ userId: OWNER, isAdmin: false } as any);
        modelAccess.reset();
        switchOn();
        mockPolicy.mockResolvedValue({
          billingUserId: OWNER, policy: null, costUsedMicroUsd: 0, tokenUsed: 0,
          mode: { usageMode: 'paused', admissionAllowed: false, reason: 'hard_threshold_reached' },
        });
        await expect(resolveEffectiveModelForUser({ userId: OWNER, requestedModel: DISALLOWED })).resolves.toMatchObject({ modelSelection: 'blocked' });
      });

      it('an anon_ owner gets the Free tier', async () => {
        mockResolution.mockResolvedValue({ subscriptionType: 'Pro', resolved: true });
        const err = await resolveEffectiveModelForUser({ userId: 'anon_visitor', requestedModel: DISALLOWED }).catch((e) => e);
        expect(err).toMatchObject({ reason: 'not_in_plan', plan: expect.objectContaining({ tier: 'Free' }) });
        expect(mockResolution).not.toHaveBeenCalled();
      });

      it('an unreadable tier never blocks', async () => {
        mockResolution.mockResolvedValue({ subscriptionType: 'Free', resolved: false });
        await expect(resolveEffectiveModelForUser({ userId: OWNER, requestedModel: DISALLOWED })).resolves.toMatchObject({ modelSelection: 'honored' });
      });
    });

    describe('POST /generate', () => {
      const assertNothingRan = () => {
        expect(mockWorker.runInWorker).not.toHaveBeenCalled();
        expect(mockChatbotDb.updateSessionLlmModel).not.toHaveBeenCalled();
        expect(mockChatbotDb.addMessageToSession).not.toHaveBeenCalled();
        expect(mockIncrementUsage).not.toHaveBeenCalled();
        expect(activeSessionGenerations.has(SESSION_ID)).toBe(false);
      };

      it('422s an explicit pick outside the plan with the plan details; nothing ran', async () => {
        const res = makeRes();
        await agentModeController.generateResponse(generateReq({ llmModel: DISALLOWED }), res);
        expect(res.statusCode).toBe(422);
        expect(res.body).toEqual({
          error: "The model you selected (GPT-5.5) isn't included in your plan, so nothing was sent to a different model. Choose another model, or upgrade your plan to use this one.",
          code: 'model_unavailable',
          requestedModel: DISALLOWED,
          reason: 'not_in_plan',
          ...PLAN_FIELDS,
          userMessageSaved: false,
        });
        assertNothingRan();
      });

      it('grandfathering: a STORED model outside the plan (no request model) is a 422, never swapped or rewritten', async () => {
        mockChatbotDb.getChatSession.mockResolvedValue(baseSession(DISALLOWED) as any);
        const res = makeRes();
        await agentModeController.generateResponse(generateReq({}), res);
        expect(res.statusCode).toBe(422);
        expect(res.body).toMatchObject({ reason: 'not_in_plan', requestedModel: DISALLOWED });
        assertNothingRan();
      });

      it('an allowed pick and the configured default run as before', async () => {
        for (const llmModel of [ALLOWED, DEFAULT_MODEL]) {
          mockWorker.runInWorker.mockClear();
          const res = makeRes();
          await agentModeController.generateResponse(generateReq({ llmModel }), res);
          expect(res.statusCode).toBe(200);
          expect(mockWorker.runInWorker).toHaveBeenCalledWith(expect.objectContaining({ llmModel }), expect.anything());
        }
      });

      it('an admin caller acting on a user session is checked against the OWNER', async () => {
        mockUserDb.getUserById.mockImplementation(async (id: string) => ({ userId: id, isAdmin: id !== OWNER }) as any);
        const res = makeRes();
        await agentModeController.generateResponse({ ...generateReq({ llmModel: DISALLOWED }, true), user: { userId: 'admin-1', isAdmin: true } } as any, res);
        expect(res.statusCode).toBe(422);
        expect(res.body).toMatchObject({ reason: 'not_in_plan', tier: 'Free' });
      });
    });

    it('createSession: a requested model outside the plan is a 422 and no session is created; no model = default', async () => {
      const refused = makeRes();
      await agentModeController.createSession({ user: { userId: OWNER }, body: { portalType: 'agent', llmModel: DISALLOWED } } as any, refused);
      expect(refused.statusCode).toBe(422);
      expect(refused.body).toMatchObject({ reason: 'not_in_plan', ...PLAN_FIELDS });
      expect(mockChatbotDb.createChatSession).not.toHaveBeenCalled();

      const dflt = makeRes();
      await agentModeController.createSession({ user: { userId: OWNER }, body: { portalType: 'agent' } } as any, dflt);
      expect(dflt.statusCode).toBe(201);
      expect(mockChatbotDb.updateSessionLlmModel).toHaveBeenCalledWith(SESSION_ID, DEFAULT_MODEL, expect.anything(), 'system');
    });

    it('verified-generate: a stored model outside the plan is a 422 before anything runs', async () => {
      mockChatbotDb.getChatSession.mockResolvedValue(baseSession(DISALLOWED) as any);
      const res = makeRes();
      await agentModeController.verifiedGenerate({
        user: { userId: OWNER },
        body: { sessionId: SESSION_ID, startingMessage: MESSAGE, attachments: [] },
        on: jest.fn(),
      } as any, res);
      expect(res.statusCode).toBe(422);
      expect(res.body).toMatchObject({ reason: 'not_in_plan', ...PLAN_FIELDS });
      expect(mockWorker.runInWorker).not.toHaveBeenCalled();
      expect(mockChatbotDb.updateSessionLlmModel).not.toHaveBeenCalled();
    });

    it("shared view: the owner's stored model outside the plan is a 422 that does NOT carry the owner's plan", async () => {
      mockChatbotDb.getChatSession.mockResolvedValue(sharedSession(DISALLOWED) as any);
      const res = makeRes();
      await agentModeController.generateSharedResponse(shareReq(), res);
      expect(res.statusCode).toBe(422);
      expect(res.body).toEqual({
        error: "The model selected for this chat (GPT-5.5) isn't available on this account, so nothing was sent to a different model. Choose another model and try again.",
        code: 'model_unavailable',
        requestedModel: DISALLOWED,
        reason: 'not_in_plan',
        userMessageSaved: false,
      });
      expect(mockWorker.runInWorker).not.toHaveBeenCalled();
      expect(mockChatbotDb.addMessageToSession).not.toHaveBeenCalled();
    });

    it('shared view: an allowed stored model still runs', async () => {
      mockChatbotDb.getChatSession.mockResolvedValue(sharedSession(ALLOWED) as any);
      const res = makeRes();
      await agentModeController.generateSharedResponse(shareReq(), res);
      expect(res.statusCode).not.toBe(422);
      expect(mockWorker.runInWorker).toHaveBeenCalledWith(expect.objectContaining({ llmModel: ALLOWED }), expect.anything());
    });

    describe('session-model PATCH (checked against the session OWNER, 422 model_unavailable)', () => {
      const patchReq = (llmModel: string, user: Record<string, unknown> = { userId: OWNER }) =>
        ({ user, params: { sessionId: SESSION_ID }, body: { llmModel } }) as any;

      it('a pick outside the owner\'s plan is a 422 with the plan details and is not stored', async () => {
        const res = makeRes();
        await agentModeController.updateSessionLlmModel(patchReq(DISALLOWED), res);
        expect(res.statusCode).toBe(422);
        expect(res.body).toMatchObject({ code: 'model_unavailable', reason: 'not_in_plan', ...PLAN_FIELDS });
        expect(mockChatbotDb.updateSessionLlmModel).not.toHaveBeenCalled();
      });

      it("an admin caller cannot widen a user's session beyond the user's plan", async () => {
        mockUserDb.getUserById.mockImplementation(async (id: string) => ({ userId: id, isAdmin: id !== OWNER }) as any);
        const res = makeRes();
        await agentModeController.updateSessionLlmModel(patchReq(DISALLOWED, { userId: 'admin-1', isAdmin: true }), res);
        expect(res.statusCode).toBe(422);
        expect(mockChatbotDb.updateSessionLlmModel).not.toHaveBeenCalled();
      });

      it('an allowed pick is stored', async () => {
        const res = makeRes();
        await agentModeController.updateSessionLlmModel(patchReq(ALLOWED), res);
        expect(res.statusCode).toBe(200);
        expect(mockChatbotDb.updateSessionLlmModel).toHaveBeenCalledWith(SESSION_ID, ALLOWED, undefined, 'user');
      });

      it("the shared PATCH refuses a pick outside the owner's plan without exposing the plan", async () => {
        mockChatbotDb.getChatSession.mockResolvedValue(sharedSession(ALLOWED) as any);
        const res = makeRes();
        await agentModeController.updateSharedSessionLlmModel(
          { params: { shareId: SESSION_ID }, query: { conversable: 'tok' }, body: { llmModel: DISALLOWED } } as any, res);
        expect(res.statusCode).toBe(422);
        expect(res.body).toEqual(expect.objectContaining({ code: 'model_unavailable', reason: 'not_in_plan' }));
        expect(res.body).not.toHaveProperty('tier');
        expect(res.body).not.toHaveProperty('allowedModels');
        expect(res.body).not.toHaveProperty('upgradeRequired');
        expect(mockChatbotDb.updateSessionLlmModel).not.toHaveBeenCalled();
      });
    });

    /**
     * Review R1 (MAJOR 1): createSession with no model stamps the CURRENT default; after an admin rotates the default,
     * that stale stamp is still AgentWeb's choice (llmModelSource 'system'), not the user's, so neither /generate (the
     * portal echoes the stamp) nor a side channel (generateSessionResponse) may refuse it as "not in your plan".
     */
    describe('a system-stamped default stays exempt after the default rotates (review R1)', () => {
      const OLD_DEFAULT = DEFAULT_MODEL; // not in the Free list ([ALLOWED])
      const rotate = () => mockAgentModeService.getDefaultModel.mockResolvedValue(DISALLOWED);
      afterEach(() => mockAgentModeService.getDefaultModel.mockResolvedValue(DEFAULT_MODEL));

      it('createSession with no model records the stamp as a SYSTEM choice', async () => {
        const res = makeRes();
        await agentModeController.createSession({ user: { userId: OWNER }, body: { portalType: 'agent' } } as any, res);
        expect(res.statusCode).toBe(201);
        expect(mockChatbotDb.updateSessionLlmModel).toHaveBeenCalledWith(SESSION_ID, OLD_DEFAULT, expect.anything(), 'system');
      });

      it('after the rotation: /generate (echo and no model) and generateSessionResponse still run, no not_in_plan', async () => {
        rotate();
        mockChatbotDb.getChatSession.mockResolvedValue({ ...baseSession(OLD_DEFAULT), llmModelSource: 'system' } as any);
        for (const body of [{ llmModel: OLD_DEFAULT }, {}]) {
          mockWorker.runInWorker.mockClear();
          mockChatbotDb.updateSessionLlmModel.mockClear();
          const res = makeRes();
          await agentModeController.generateResponse(generateReq(body), res);
          expect(res.statusCode).toBe(200);
          expect(mockWorker.runInWorker).toHaveBeenCalledWith(expect.objectContaining({ llmModel: OLD_DEFAULT }), expect.anything());
          // ...and the stamp stays AgentWeb's choice (the echo is not a new pick).
          expect(mockChatbotDb.updateSessionLlmModel).toHaveBeenCalledWith(SESSION_ID, OLD_DEFAULT, expect.anything(), 'system');
        }
        mockWorker.runInWorker.mockClear();
        await generateSessionResponse(SESSION_ID, MESSAGE, OWNER, OLD_DEFAULT);
        expect(mockWorker.runInWorker).toHaveBeenCalledWith(expect.objectContaining({ llmModel: OLD_DEFAULT }), expect.anything());
      });

      it('a legacy session (no recorded source) whose decision shows the default stood in is treated as AgentWeb\'s', async () => {
        rotate();
        mockChatbotDb.getChatSession.mockResolvedValue({
          ...baseSession(OLD_DEFAULT),
          llmUsagePolicyDecision: { requestedModel: null, effectiveModel: OLD_DEFAULT, backupModel: null, backupSource: null, modelSelection: 'defaulted', modelSelectionReason: 'no_requested_model_using_default', usageMode: 'full_choice', usagePolicyVersion: null, recordedAt: 'x' },
        } as any);
        const res = makeRes();
        await agentModeController.generateResponse(generateReq({}), res);
        expect(res.statusCode).toBe(200);
      });

      it('a legacy session with no evidence the system chose it is a user pick: visible 422, never a swap', async () => {
        rotate();
        mockChatbotDb.getChatSession.mockResolvedValue(baseSession(OLD_DEFAULT) as any);
        const res = makeRes();
        await agentModeController.generateResponse(generateReq({}), res);
        expect(res.statusCode).toBe(422);
        expect(res.body).toMatchObject({ reason: 'not_in_plan', requestedModel: OLD_DEFAULT });
        expect(mockWorker.runInWorker).not.toHaveBeenCalled();
      });

      it('a DIFFERENT explicit pick is the user\'s: checked, and recorded as user when allowed', async () => {
        mockChatbotDb.getChatSession.mockResolvedValue({ ...baseSession(OLD_DEFAULT), llmModelSource: 'system' } as any);
        const refused = makeRes();
        await agentModeController.generateResponse(generateReq({ llmModel: DISALLOWED }), refused);
        expect(refused.statusCode).toBe(422);
        const ok = makeRes();
        await agentModeController.generateResponse(generateReq({ llmModel: ALLOWED }), ok);
        expect(ok.statusCode).toBe(200);
        expect(mockChatbotDb.updateSessionLlmModel).toHaveBeenCalledWith(SESSION_ID, ALLOWED, expect.anything(), 'user');
      });

      it('the PATCH records a pick as the user\'s', async () => {
        const res = makeRes();
        await agentModeController.updateSessionLlmModel({ user: { userId: OWNER }, params: { sessionId: SESSION_ID }, body: { llmModel: ALLOWED } } as any, res);
        expect(mockChatbotDb.updateSessionLlmModel).toHaveBeenCalledWith(SESSION_ID, ALLOWED, undefined, 'user');
      });
    });

    describe('final gate in generateSessionResponse (side channels: Slack, email, transports, resumes)', () => {
      it("refuses the session's STORED model outside the plan before anything is persisted", async () => {
        mockChatbotDb.getChatSession.mockResolvedValue(baseSession(DISALLOWED) as any);
        const err = await generateSessionResponse(SESSION_ID, MESSAGE, OWNER, DISALLOWED).catch((e) => e);
        expect(isModelUnavailableError(err)).toBe(true);
        expect(err).toMatchObject({ reason: 'not_in_plan' });
        expect(mockChatbotDb.addMessageToSession).not.toHaveBeenCalled();
        expect(mockWorker.runInWorker).not.toHaveBeenCalled();
      });

      it('a model the caller chose itself (not the stored one) is AgentWeb\'s choice and runs', async () => {
        mockChatbotDb.getChatSession.mockResolvedValue(baseSession(ALLOWED) as any);
        await generateSessionResponse(SESSION_ID, MESSAGE, OWNER, DISALLOWED);
        expect(mockWorker.runInWorker).toHaveBeenCalledWith(expect.objectContaining({ llmModel: DISALLOWED }), expect.anything());
      });

      it('switch off: the stored model runs', async () => {
        delete mockSettings.model_tier_allowlist_enabled;
        modelAccess.reset();
        mockChatbotDb.getChatSession.mockResolvedValue(baseSession(DISALLOWED) as any);
        await generateSessionResponse(SESSION_ID, MESSAGE, OWNER, DISALLOWED);
        expect(mockWorker.runInWorker).toHaveBeenCalledWith(expect.objectContaining({ llmModel: DISALLOWED }), expect.anything());
      });
    });
  });
});

/**
 * ENG-669 review round 3. Who chose a stored model is decided on CANONICAL ids (an alias of the stored model is the
 * same model, in both directions); a model the final gate refuses is the standard 422, never a 500; and a side-channel
 * session stamped before llmModelSource existed (no decision either) is AgentWeb's choice.
 */
describe('ENG-669 model source on canonical ids, final-gate 422, legacy side channels', () => {
  const ALLOWED = 'gemini-3.5-flash';
  const DISALLOWED = 'gpt-5.5';
  const TARGET = 'legacy-old-alias-target';
  const ALIAS = 'legacy-old-alias';
  const mockResolution = getUserSubscriptionResolution as jest.Mock;
  const mockTierConfig = readTierAllowedModels as jest.Mock;
  const SUPPORTED = ['gpt-5-chat-2', 'gemini-3.5-flash', 'gpt-5.5', 'live-voice-1'];

  /** A session store that keeps what updateSessionLlmModel writes (model, decision, source). */
  const storeSession = (initial: Record<string, unknown>) => {
    let stored: any = { ...initial };
    mockChatbotDb.getChatSession.mockImplementation(async () => stored);
    mockChatbotDb.updateSessionLlmModel.mockImplementation(async (_id: string, model: string, decision: any, source?: any) => {
      stored = { ...stored, llmModel: model, llmUsagePolicyDecision: decision, llmModelSource: source };
      if (!source) delete stored.llmModelSource;
      return stored;
    });
    return () => stored;
  };

  beforeEach(() => {
    mockSettings.model_tier_allowlist_enabled = 'true';
    mockSettings.subscription_types = JSON.stringify([{ name: 'Free', allowedModels: [ALLOWED] }, { name: 'Pro', allowedModels: ['*'] }]);
    mockResolution.mockResolvedValue({ subscriptionType: 'Free', resolved: true });
    mockTierConfig.mockImplementation(async (tier: string) => {
      const row = JSON.parse(mockSettings.subscription_types as string).find((t: any) => t.name === tier);
      return row ? { configured: true, allowedModels: row.allowedModels } : { configured: false };
    });
    (mockAgentModeService.getSupportedModels as jest.Mock).mockResolvedValue([...SUPPORTED, TARGET]);
  });
  afterEach(() => {
    (mockAgentModeService.getSupportedModels as jest.Mock).mockResolvedValue(SUPPORTED);
    mockAgentModeService.getDefaultModel.mockResolvedValue(DEFAULT_MODEL);
    assertSpy?.mockRestore();
    assertSpy = undefined;
  });
  let assertSpy: jest.SpyInstance | undefined;

  it('an ALIAS echo of a system stamp keeps it a system stamp: the next turn still runs (no false 422)', async () => {
    const stored = storeSession({ ...baseSession(TARGET), llmModelSource: 'system' });
    const first = makeRes();
    await agentModeController.generateResponse(generateReq({ llmModel: ALIAS }), first);
    expect(first.statusCode).toBe(200);
    expect(stored().llmModelSource).toBe('system');
    activeSessionGenerations.clear();
    const second = makeRes();
    await agentModeController.generateResponse(generateReq({ llmModel: TARGET }), second);
    expect(second.statusCode).toBe(200);
  });

  it('no laundering: a legacy stored user pick spelled as an ALIAS stays the user\'s on a no-model turn', async () => {
    mockSettings.subscription_types = JSON.stringify([{ name: 'Free', allowedModels: [ALLOWED, TARGET] }]);
    const stored = storeSession({ ...baseSession(ALIAS) }); // legacy: no source, no decision => a user pick
    const res = makeRes();
    await agentModeController.generateResponse(generateReq({}), res);
    expect(res.statusCode).toBe(200);
    expect(stored().llmModelSource).toBe('user');
  });

  it('...and the same holds with the switch off (the source is recorded either way, nothing is read)', async () => {
    delete mockSettings.model_tier_allowlist_enabled;
    modelAccess.reset();
    const stored = storeSession({ ...baseSession(ALIAS) });
    const res = makeRes();
    await agentModeController.generateResponse(generateReq({}), res);
    expect(res.statusCode).toBe(200);
    expect(stored().llmModelSource).toBe('user');
    expect(mockResolution).not.toHaveBeenCalled();
  });

  it('a user pick stays the user\'s: after the tier narrows, its echo is a 422', async () => {
    mockChatbotDb.getChatSession.mockResolvedValue({ ...baseSession(DISALLOWED), llmModelSource: 'user' } as any);
    const res = makeRes();
    await agentModeController.generateResponse(generateReq({ llmModel: DISALLOWED }), res);
    expect(res.statusCode).toBe(422);
  });

  it('PATCHing away from a system stamp and back loses the exemption (a pick is the user\'s)', async () => {
    mockAgentModeService.getDefaultModel.mockResolvedValue(ALLOWED);
    storeSession({ ...baseSession(DISALLOWED), llmModelSource: 'system' });
    const patch = (llmModel: string) => ({ user: { userId: OWNER }, params: { sessionId: SESSION_ID }, body: { llmModel } }) as any;
    const away = makeRes();
    await agentModeController.updateSessionLlmModel(patch(ALLOWED), away);
    expect(away.statusCode).toBe(200);
    const back = makeRes();
    await agentModeController.updateSessionLlmModel(patch(DISALLOWED), back);
    expect(back.statusCode).toBe(422);
  });

  it('verified-generate runs a system stamp after the default rotates', async () => {
    mockAgentModeService.getDefaultModel.mockResolvedValue(ALLOWED);
    mockChatbotDb.getChatSession.mockResolvedValue({ ...baseSession(DISALLOWED), llmModelSource: 'system' } as any);
    const res = makeRes();
    await agentModeController.verifiedGenerate({
      user: { userId: OWNER }, body: { sessionId: SESSION_ID, startingMessage: MESSAGE, attachments: [], llmModel: DISALLOWED }, on: jest.fn(),
    } as any, res);
    expect(res.statusCode).not.toBe(422);
  });

  it.each([
    ['a Slack thread', { slackThread: { channel: 'C1', threadTs: '1.2' } }],
    ['a GTM work item', { gtmWorkItem: { planId: 'p', phaseId: 'ph', workItemId: 'w' } }],
    ['an Emma email', { sessionType: 'emma-email' }],
    ['a result endpoint', { sessionType: 'result-endpoint' }],
  ])('legacy side channel (%s) stamped with the then-default and no decision is AgentWeb\'s choice after rotation', async (_n, marker) => {
    mockAgentModeService.getDefaultModel.mockResolvedValue(ALLOWED); // the default rotated away from gpt-5.5
    mockChatbotDb.getChatSession.mockResolvedValue({ ...baseSession(DISALLOWED), ...marker } as any);
    const err = await generateSessionResponse(SESSION_ID, MESSAGE, OWNER, DISALLOWED).catch((e) => e);
    expect(isModelUnavailableError(err)).toBe(false);
    expect(mockWorker.runInWorker).toHaveBeenCalledWith(expect.objectContaining({ llmModel: DISALLOWED }), expect.anything());
  });

  it('a regular legacy session with no decision is still a user pick (refused, visibly)', async () => {
    mockAgentModeService.getDefaultModel.mockResolvedValue(ALLOWED);
    mockChatbotDb.getChatSession.mockResolvedValue(baseSession(DISALLOWED) as any);
    const err = await generateSessionResponse(SESSION_ID, MESSAGE, OWNER, DISALLOWED).catch((e) => e);
    expect(err).toMatchObject({ reason: 'not_in_plan' });
  });

  it('/generate: a refusal from the FINAL gate (e.g. a tier change mid-turn) is the standard 422, not a 500', async () => {
    assertSpy = jest.spyOn(modelAccess, 'assertModelAllowed');
    // The pre-flight passes; the final gate inside generateSessionResponse then refuses.
    assertSpy.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new ModelUnavailableError(DISALLOWED, 'not_in_plan', {
      model: DISALLOWED, tier: 'Free', allowedModels: [ALLOWED], upgradeRequired: ['Pro'],
    }));
    storeSession({ ...baseSession(DISALLOWED), llmModelSource: 'user' });
    const res = makeRes();
    await agentModeController.generateResponse(generateReq({ llmModel: DISALLOWED }), res);
    expect(res.statusCode).toBe(422);
    expect(res.body).toMatchObject({ code: 'model_unavailable', reason: 'not_in_plan', tier: 'Free', upgradeRequired: ['Pro'] });
    expect(mockWorker.runInWorker).not.toHaveBeenCalled();
    expect(activeSessionGenerations.has(SESSION_ID)).toBe(false);
  });

  it('verified-generate: a refusal from the FINAL gate is the standard 422 owner body, not a 500', async () => {
    assertSpy = jest.spyOn(modelAccess, 'assertModelAllowed');
    assertSpy.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new ModelUnavailableError(DISALLOWED, 'not_in_plan', {
      model: DISALLOWED, tier: 'Free', allowedModels: [ALLOWED], upgradeRequired: ['Pro'],
    }));
    storeSession({ ...baseSession(DISALLOWED), llmModelSource: 'user' });
    const res = makeRes();
    await agentModeController.verifiedGenerate({
      user: { userId: OWNER }, body: { sessionId: SESSION_ID, startingMessage: MESSAGE, attachments: [], llmModel: DISALLOWED }, on: jest.fn(),
    } as any, res);
    expect(assertSpy).toHaveBeenCalledTimes(2);
    expect(res.statusCode).toBe(422);
    expect(res.body).toMatchObject({ code: 'model_unavailable', reason: 'not_in_plan', tier: 'Free', upgradeRequired: ['Pro'] });
    expect(mockWorker.runInWorker).not.toHaveBeenCalled();
  });

  it('a work-plan step refusal AFTER the user message is saved leaves the refusal in the chat (never unanswered) and is a 422', async () => {
    mockSettings.work_plan_step_models_enabled = 'true';
    // Pre-flight and final gate pass; the user's pick for the step whose own model is gone is then refused.
    assertSpy = jest.spyOn(modelAccess, 'assertModelAllowed');
    assertSpy.mockResolvedValueOnce(undefined).mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new ModelUnavailableError(DISALLOWED, 'not_in_plan', { model: DISALLOWED, tier: 'Free', allowedModels: [ALLOWED], upgradeRequired: ['Pro'] }));
    storeSession({
      ...baseSession(ALLOWED), llmModelSource: 'user',
      workPlan: { title: 'P', steps: [{ stepCount: 1, title: 'S1', status: 'pending', model: 'retired-model-9' }], createdAt: 'x', updatedAt: 'x' },
    });
    const res = makeRes();
    await agentModeController.generateResponse(generateReq({ llmModel: DISALLOWED }), res);
    expect(assertSpy).toHaveBeenCalledTimes(3);
    expect(res.statusCode).toBe(422);
    expect(res.body).toMatchObject({ code: 'model_unavailable', reason: 'not_in_plan' });
    const saved = mockChatbotDb.addMessageToSession.mock.calls.map(([, message]) => message as any).filter((m) => m.role !== 'system');
    expect(saved.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(saved[1]).toMatchObject({ role: 'assistant', metadata: expect.objectContaining({ isErrorMessage: true }) });
    expect(saved[1].content).toContain("isn't included in your plan");
    expect(mockWorker.runInWorker).not.toHaveBeenCalled();
    delete mockSettings.work_plan_step_models_enabled;
  });

  it("a step model the user adopted in an admin-authored plan stays the user's: checked, and paused when outside the plan", async () => {
    const honor = jest.spyOn(workPlanStepModels, 'shouldHonor').mockResolvedValue(true);
    storeSession({
      ...baseSession(ALLOWED), llmModelSource: 'user',
      workPlan: {
        title: 'P', planAuthor: 'system', engineModel: ALLOWED, createdAt: 'x', updatedAt: 'x',
        steps: [{ stepCount: 1, title: 'S1', status: 'pending', model: DISALLOWED, modelSource: 'user' }],
      },
    });
    const result = await generateSessionResponse(SESSION_ID, MESSAGE, OWNER, ALLOWED);
    honor.mockRestore();
    expect(result.content).toContain("which isn't included in this account's plan");
    expect(mockWorker.runInWorker).not.toHaveBeenCalled();
  });

  it("THROUGH the adoption write: a pick that replaces an admin plan's retired step model is recorded as the user's and checked on a later turn", async () => {
    const honor = jest.spyOn(workPlanStepModels, 'shouldHonor').mockResolvedValue(true);
    let stored: any = {
      ...baseSession(DEFAULT_MODEL), llmModelSource: 'system',
      workPlan: {
        title: 'P', planAuthor: 'system', createdAt: 'x', updatedAt: 'x',
        steps: [{ stepCount: 1, title: 'S1', status: 'pending', model: UNSERVED }],
      },
    };
    mockChatbotDb.getChatSession.mockImplementation(async () => stored);
    mockChatbotDb.updateSessionLlmModel.mockImplementation(async (_id: string, model: string, decision: any, source?: any) => {
      stored = { ...stored, llmModel: model, llmUsagePolicyDecision: decision, llmModelSource: source };
      return stored;
    });
    const db = mockChatbotDb as any;
    const hadWorkPlanWrite = 'updateSessionWorkPlan' in db;
    db.updateSessionWorkPlan = jest.fn(async (_id: string, workPlan: any) => { stored = { ...stored, workPlan }; return stored; });
    try {
      // Turn 1: the step's own (admin) model is retired; the user's explicit pick (in the plan today) runs and is adopted.
      const first = makeRes();
      await agentModeController.generateResponse(generateReq({ llmModel: ALLOWED }), first);
      expect(first.statusCode).toBe(200);
      expect(stored.workPlan.steps[0]).toMatchObject({ model: ALLOWED, modelSource: 'user' });
      expect(mockWorker.runInWorker).toHaveBeenCalledWith(expect.objectContaining({ llmModel: ALLOWED }), expect.anything());

      // Turn 2 (a side channel, no request model): the owner's plan has since narrowed and no longer includes the pick.
      mockSettings.subscription_types = JSON.stringify([{ name: 'Free', allowedModels: [TARGET] }, { name: 'Pro', allowedModels: ['*'] }]);
      modelAccess.reset();
      mockWorker.runInWorker.mockClear();
      const second = await generateSessionResponse(SESSION_ID, MESSAGE, OWNER, DEFAULT_MODEL);
      // Checked as the USER's pick, not exempted as the admin plan's step pin: the plan pauses, nothing runs.
      expect(second.content).toContain("which isn't included in this account's plan");
      expect(mockWorker.runInWorker).not.toHaveBeenCalled();
    } finally {
      honor.mockRestore();
      if (!hadWorkPlanWrite) delete db.updateSessionWorkPlan;
    }
  });

  it("a human's NEW pick of a model an admin-authored plan uses elsewhere is still checked against the owner's plan", async () => {
    storeSession({
      ...baseSession(ALLOWED), llmModelSource: 'user',
      workPlan: { title: 'P', planAuthor: 'system', createdAt: 'x', updatedAt: 'x', steps: [{ stepCount: 1, title: 'S1', status: 'pending', model: DISALLOWED }] },
    });
    const res = makeRes();
    await agentModeController.generateResponse(generateReq({ llmModel: DISALLOWED }), res);
    expect(res.statusCode).toBe(422);
    expect(res.body).toMatchObject({ reason: 'not_in_plan' });
  });

  it('shared view: an exhausted allowance keeps its usage-limit 429 even when the stored model is outside the plan', async () => {
    mockCheckTokenUsage.mockResolvedValue({
      allowed: false, warning: false, used: 1, allowance: 1, bonus: 0, effectiveAllowance: 1, percentUsed: 100, month: '2026-07',
    });
    storeSession({
      ...baseSession(DISALLOWED), llmModelSource: 'user',
      interactiveShareMetadata: { isActive: true, token: 'tok', sharedAt: '2026-07-01T00:00:00Z' },
    });
    const res = makeRes();
    await agentModeController.generateSharedResponse({
      params: { shareId: SESSION_ID }, query: { conversable: 'tok' }, body: { userMessage: MESSAGE, attachments: [] }, on: jest.fn(),
    } as unknown as Request, res);
    expect(res.statusCode).toBe(429);
    expect(mockWorker.runInWorker).not.toHaveBeenCalled();
  });

  it('shared view: a final-gate refusal is a 422 without the owner\'s plan', async () => {
    assertSpy = jest.spyOn(modelAccess, 'assertModelAllowed');
    assertSpy
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new ModelUnavailableError(DISALLOWED, 'not_in_plan', { model: DISALLOWED, tier: 'Free', allowedModels: [], upgradeRequired: [] }));
    storeSession({
      ...baseSession(DISALLOWED), llmModelSource: 'user',
      interactiveShareMetadata: { isActive: true, token: 'tok', sharedAt: '2026-07-01T00:00:00Z' },
    });
    const res = makeRes();
    await agentModeController.generateSharedResponse({
      params: { shareId: SESSION_ID }, query: { conversable: 'tok' }, body: { userMessage: MESSAGE, attachments: [] }, on: jest.fn(),
    } as unknown as Request, res);
    expect(res.statusCode).toBe(422);
    expect(res.body).toMatchObject({ code: 'model_unavailable', reason: 'not_in_plan' });
    expect(res.body).not.toHaveProperty('tier');
  });
});

describe('ENG-2641: every refused send says whether the user message was stored (userMessageSaved)', () => {
  const ALLOWED = 'gemini-3.5-flash';
  const DISALLOWED = 'gpt-5.5';
  const notInPlan = () => new ModelUnavailableError(DISALLOWED, 'not_in_plan', {
    model: DISALLOWED, tier: 'Free', allowedModels: [ALLOWED], upgradeRequired: ['Pro'],
  });
  const savedUserMessages = () => mockChatbotDb.addMessageToSession.mock.calls
    .map(([, message]) => message as any)
    .filter((m) => m.role === 'user');
  const verifiedReq = (body: Record<string, unknown> = {}) => ({
    user: { userId: OWNER },
    body: { sessionId: SESSION_ID, startingMessage: MESSAGE, attachments: [], llmModel: DISALLOWED, ...body },
    on: jest.fn(),
  } as any);
  const shareReq = () => ({
    params: { shareId: SESSION_ID }, query: { conversable: 'tok' }, body: { userMessage: MESSAGE, attachments: [] }, on: jest.fn(),
  } as unknown as Request);
  const sharedSession = (llmModel: string) => ({
    ...baseSession(llmModel), llmModelSource: 'user',
    interactiveShareMetadata: { isActive: true, token: 'tok', sharedAt: '2026-07-01T00:00:00Z' },
  });
  const exhausted = {
    allowed: false, warning: false, used: 1, allowance: 1, bonus: 0, effectiveAllowance: 1, percentUsed: 100, month: '2026-07',
  };
  let assertSpy: jest.SpyInstance | undefined;

  beforeEach(() => {
    mockSettings.model_tier_allowlist_enabled = 'true';
    mockSettings.subscription_types = JSON.stringify([{ name: 'Free', allowedModels: [ALLOWED] }, { name: 'Pro', allowedModels: ['*'] }]);
    (getUserSubscriptionResolution as jest.Mock).mockResolvedValue({ subscriptionType: 'Free', resolved: true });
    (readTierAllowedModels as jest.Mock).mockImplementation(async (tier: string) => {
      const row = JSON.parse(mockSettings.subscription_types as string).find((t: any) => t.name === tier);
      return row ? { configured: true, allowedModels: row.allowedModels } : { configured: false };
    });
    mockChatbotDb.getChatSession.mockResolvedValue({ ...baseSession(DISALLOWED), llmModelSource: 'user' } as any);
  });
  afterEach(() => {
    assertSpy?.mockRestore();
    assertSpy = undefined;
  });

  describe('POST /generate', () => {
    it('pre-flight 422 (an explicit pick outside the plan): false, and no user message was written', async () => {
      const res = makeRes();
      await agentModeController.generateResponse(generateReq({ llmModel: DISALLOWED }), res);
      expect(res.statusCode).toBe(422);
      expect(res.body).toMatchObject({ code: 'model_unavailable', reason: 'not_in_plan', userMessageSaved: false });
      expect(savedUserMessages()).toEqual([]);
    });

    it('final-gate 422 inside generateSessionResponse (before the save): false, and no user message was written', async () => {
      assertSpy = jest.spyOn(modelAccess, 'assertModelAllowed');
      assertSpy.mockResolvedValueOnce(undefined).mockRejectedValueOnce(notInPlan());
      const res = makeRes();
      await agentModeController.generateResponse(generateReq({ llmModel: DISALLOWED }), res);
      expect(assertSpy).toHaveBeenCalledTimes(2);
      expect(res.statusCode).toBe(422);
      expect(res.body).toMatchObject({ code: 'model_unavailable', userMessageSaved: false });
      expect(savedUserMessages()).toEqual([]);
    });

    it('Work Plan step-model 422 AFTER the save: true, and the stored message is the one this request sent', async () => {
      mockSettings.work_plan_step_models_enabled = 'true';
      assertSpy = jest.spyOn(modelAccess, 'assertModelAllowed');
      assertSpy.mockResolvedValueOnce(undefined).mockResolvedValueOnce(undefined).mockRejectedValueOnce(notInPlan());
      // A session store that keeps the model /generate stamps before the turn (as the real one does).
      let stored: any = {
        ...baseSession(ALLOWED), llmModelSource: 'user',
        workPlan: { title: 'P', steps: [{ stepCount: 1, title: 'S1', status: 'pending', model: UNSERVED }], createdAt: 'x', updatedAt: 'x' },
      };
      mockChatbotDb.getChatSession.mockImplementation(async () => stored);
      mockChatbotDb.updateSessionLlmModel.mockImplementation(async (_id: string, model: string, decision: any, source?: any) => {
        stored = { ...stored, llmModel: model, llmUsagePolicyDecision: decision, llmModelSource: source };
        return stored;
      });
      const res = makeRes();
      await agentModeController.generateResponse(generateReq({ llmModel: DISALLOWED, clientId: 'msg-1' }), res);
      expect(assertSpy).toHaveBeenCalledTimes(3);
      expect(res.statusCode).toBe(422);
      expect(res.body).toMatchObject({ code: 'model_unavailable', reason: 'not_in_plan', userMessageSaved: true });
      expect(savedUserMessages()).toEqual([expect.objectContaining({ content: MESSAGE, clientId: 'msg-1' })]);
      expect(mockWorker.runInWorker).not.toHaveBeenCalled();
    });

    it('409 SESSION_BUSY: false, and no user message was written', async () => {
      activeSessionGenerations.add(SESSION_ID);
      const res = makeRes();
      await agentModeController.generateResponse(generateReq({ llmModel: ALLOWED }), res);
      expect(res.statusCode).toBe(409);
      expect(res.body).toMatchObject({ code: 'SESSION_BUSY', userMessageSaved: false });
      expect(savedUserMessages()).toEqual([]);
    });

    it('429 usage paused: false, and no user message was written', async () => {
      mockChatbotDb.getChatSession.mockResolvedValue({ ...baseSession(ALLOWED), llmModelSource: 'user' } as any);
      mockCheckTokenUsage.mockResolvedValue(exhausted);
      const res = makeRes();
      await agentModeController.generateResponse(generateReq({ llmModel: ALLOWED }), res);
      expect(res.statusCode).toBe(429);
      expect(res.body).toMatchObject({ code: 'usage_paused', userMessageSaved: false });
      expect(savedUserMessages()).toEqual([]);
    });
  });

  describe('POST /ishare/:id/generate', () => {
    it('pre-flight 422 (the stored model outside the owner\'s plan): false', async () => {
      mockChatbotDb.getChatSession.mockResolvedValue(sharedSession(DISALLOWED) as any);
      const res = makeRes();
      await agentModeController.generateSharedResponse(shareReq(), res);
      expect(res.statusCode).toBe(422);
      expect(res.body).toMatchObject({ code: 'model_unavailable', userMessageSaved: false });
      expect(savedUserMessages()).toEqual([]);
    });

    it('final-gate 422 inside generateSessionResponse (before the save): false', async () => {
      assertSpy = jest.spyOn(modelAccess, 'assertModelAllowed');
      assertSpy.mockResolvedValueOnce(undefined).mockResolvedValueOnce(undefined).mockRejectedValueOnce(notInPlan());
      mockChatbotDb.getChatSession.mockResolvedValue(sharedSession(DISALLOWED) as any);
      const res = makeRes();
      await agentModeController.generateSharedResponse(shareReq(), res);
      expect(res.statusCode).toBe(422);
      expect(res.body).toMatchObject({ code: 'model_unavailable', userMessageSaved: false });
      expect(savedUserMessages()).toEqual([]);
    });

    it('409 SESSION_BUSY: false', async () => {
      mockChatbotDb.getChatSession.mockResolvedValue(sharedSession(ALLOWED) as any);
      activeSessionGenerations.add(SESSION_ID);
      const res = makeRes();
      await agentModeController.generateSharedResponse(shareReq(), res);
      expect(res.statusCode).toBe(409);
      expect(res.body).toMatchObject({ code: 'SESSION_BUSY', userMessageSaved: false });
    });

    it("429 (the owner's allowance is exhausted): false", async () => {
      mockChatbotDb.getChatSession.mockResolvedValue(sharedSession(ALLOWED) as any);
      mockCheckTokenUsage.mockResolvedValue(exhausted);
      const res = makeRes();
      await agentModeController.generateSharedResponse(shareReq(), res);
      expect(res.statusCode).toBe(429);
      expect(res.body).toMatchObject({ userMessageSaved: false });
      expect(savedUserMessages()).toEqual([]);
    });
  });

  describe('POST /verified-generate', () => {
    it('pre-flight 422: false', async () => {
      const res = makeRes();
      await agentModeController.verifiedGenerate(verifiedReq(), res);
      expect(res.statusCode).toBe(422);
      expect(res.body).toMatchObject({ code: 'model_unavailable', userMessageSaved: false });
      expect(savedUserMessages()).toEqual([]);
    });

    it('final-gate 422 on the FIRST attempt (before the starting message is saved): false', async () => {
      assertSpy = jest.spyOn(modelAccess, 'assertModelAllowed');
      assertSpy.mockResolvedValueOnce(undefined).mockRejectedValueOnce(notInPlan());
      const res = makeRes();
      await agentModeController.verifiedGenerate(verifiedReq(), res);
      expect(res.statusCode).toBe(422);
      expect(res.body).toMatchObject({ code: 'model_unavailable', userMessageSaved: false });
      expect(savedUserMessages()).toEqual([]);
    });

    it('final-gate 422 on a LATER attempt (the first attempt saved the starting message): true', async () => {
      assertSpy = jest.spyOn(modelAccess, 'assertModelAllowed');
      assertSpy.mockResolvedValueOnce(undefined).mockResolvedValueOnce(undefined).mockRejectedValueOnce(notInPlan());
      // Attempt 1 runs and saves the starting message, but answers nothing, so attempt 2 starts and is refused.
      mockWorker.runInWorker.mockResolvedValueOnce({ ...workerResult, content: '' } as any);
      const res = makeRes();
      await agentModeController.verifiedGenerate(verifiedReq(), res);
      expect(assertSpy).toHaveBeenCalledTimes(3);
      expect(res.statusCode).toBe(422);
      expect(res.body).toMatchObject({ code: 'model_unavailable', userMessageSaved: true });
      expect(savedUserMessages()[0]).toMatchObject({ content: MESSAGE });
    });

    it('attempt 1 saves the message then fails transiently; attempt 2 is refused BEFORE its own save: still true', async () => {
      assertSpy = jest.spyOn(modelAccess, 'assertModelAllowed');
      assertSpy.mockResolvedValueOnce(undefined).mockResolvedValueOnce(undefined).mockRejectedValueOnce(notInPlan());
      const transient = new Error('upstream overloaded');
      (isTransientLLMError as jest.Mock).mockImplementation((e: unknown) => e === transient);
      mockWorker.runInWorker.mockRejectedValueOnce(transient);
      try {
        const res = makeRes();
        await agentModeController.verifiedGenerate(verifiedReq(), res);
        expect(assertSpy).toHaveBeenCalledTimes(3);
        expect(mockWorker.runInWorker).toHaveBeenCalledTimes(1);
        expect(res.statusCode).toBe(422);
        expect(res.body).toMatchObject({ code: 'model_unavailable', userMessageSaved: true });
        expect(savedUserMessages()).toEqual([expect.objectContaining({ content: MESSAGE })]);
      } finally {
        (isTransientLLMError as jest.Mock).mockReset().mockReturnValue(false);
      }
    });

    it('429 usage paused: false', async () => {
      mockCheckTokenUsage.mockResolvedValue(exhausted);
      const res = makeRes();
      await agentModeController.verifiedGenerate(verifiedReq(), res);
      expect(res.statusCode).toBe(429);
      expect(res.body).toMatchObject({ code: 'usage_paused', userMessageSaved: false });
    });
  });
});

describe('ENG-2672: a generation that fails AFTER the user message was stored says so (userMessageSaved)', () => {
  const MODEL = 'gpt-5.5';
  const savedUserMessages = () => mockChatbotDb.addMessageToSession.mock.calls
    .map(([, message]) => message as any)
    .filter((m) => m.role === 'user');
  const shareReq = () => ({
    params: { shareId: SESSION_ID }, query: { conversable: 'tok' }, body: { userMessage: MESSAGE, attachments: [] }, on: jest.fn(),
    method: 'POST', path: '/api/agent-mode/ishare/generate', ip: '127.0.0.1', socket: { remoteAddress: '127.0.0.1' },
  } as unknown as Request);
  const sharedSession = () => ({
    ...baseSession(MODEL),
    interactiveShareMetadata: { isActive: true, token: 'tok', sharedAt: '2026-07-01T00:00:00Z' },
  });
  const send = async (body: Record<string, unknown> = {}) => {
    const res = makeRes();
    await agentModeController.generateResponse(generateReq({ llmModel: MODEL, ...body }), res);
    return res;
  };
  const sendShared = async () => {
    mockChatbotDb.getChatSession.mockResolvedValue(sharedSession() as any);
    const res = makeRes();
    await agentModeController.generateSharedResponse(shareReq(), res);
    return res;
  };
  const failures: Array<{ name: string; error: () => Error; prepare?: () => void; status: number; code: string }> = [
    {
      name: 'provider unavailable',
      error: () => new Error(PROVIDER_UNAVAILABLE_USER_MESSAGE),
      status: 503,
      code: 'PROVIDER_UNAVAILABLE',
    },
    {
      name: 'provider has no endpoints',
      error: () => new Error('No endpoints found for this model'),
      status: 503,
      code: 'PROVIDER_UNAVAILABLE',
    },
    {
      name: 'server restarting',
      error: () => new Error('worker shut down'),
      prepare: () => (isWorkerShutdownError as jest.Mock).mockReturnValue(true),
      status: 503,
      code: 'SERVER_RESTARTING',
    },
    {
      name: 'context limit',
      error: () => new Error('context length exceeded'),
      prepare: () => (isContextLimitError as jest.Mock).mockReturnValue(true),
      status: 413,
      code: 'CONTEXT_LIMIT_EXCEEDED',
    },
  ];
  afterEach(() => {
    (isWorkerShutdownError as jest.Mock).mockReturnValue(false);
    (isContextLimitError as jest.Mock).mockReturnValue(false);
    jest.useRealTimers();
  });

  describe.each(failures)('$name ($status $code)', ({ error, prepare, status, code }) => {
    it('/generate: true when the worker fails after the save, status and code unchanged', async () => {
      prepare?.();
      mockWorker.runInWorker.mockRejectedValueOnce(error());
      const res = await send({ clientId: 'msg-1' });
      expect(res.statusCode).toBe(status);
      expect(res.body).toMatchObject({ code, userMessageSaved: true });
      expect(savedUserMessages()).toEqual([expect.objectContaining({ content: MESSAGE, clientId: 'msg-1' })]);
    });

    it('/generate: false when the same failure is raised while saving the message (nothing stored)', async () => {
      prepare?.();
      const failure = error();
      // The first write of a new chat is its system message; only the USER message's save fails.
      mockChatbotDb.addMessageToSession.mockImplementation(async (_id: string, message: any) => {
        if (message.role === 'user') throw failure;
        return baseSession() as any;
      });
      const res = await send();
      expect(res.statusCode).toBe(status);
      expect(res.body).toMatchObject({ code, userMessageSaved: false });
    });

    it('/ishare/:id/generate: true when the worker fails after the save', async () => {
      prepare?.();
      mockWorker.runInWorker.mockRejectedValueOnce(error());
      const res = await sendShared();
      expect(res.statusCode).toBe(status);
      expect(res.body).toMatchObject({ code, userMessageSaved: true });
      expect(savedUserMessages()).toEqual([expect.objectContaining({ content: MESSAGE })]);
    });
  });

  describe('504 GENERATION_TIMEOUT', () => {
    it('/generate: true when the cap fires after the save', async () => {
      jest.useFakeTimers();
      mockWorker.runInWorker.mockReturnValueOnce(new Promise(() => undefined) as any);
      const pending = send();
      await jest.advanceTimersByTimeAsync(10 * 60 * 1000 + 1000);
      const res = await pending;
      expect(res.statusCode).toBe(504);
      expect(res.body).toMatchObject({ code: 'GENERATION_TIMEOUT', userMessageSaved: true });
      expect(savedUserMessages()).toHaveLength(1);
    });

    it('/generate: false when the cap fires before the save completed', async () => {
      jest.useFakeTimers();
      mockChatbotDb.addMessageToSession.mockImplementation((async (_id: string, message: any) => (
        message.role === 'user' ? new Promise(() => undefined) : baseSession()
      )) as any);
      const pending = send();
      await jest.advanceTimersByTimeAsync(10 * 60 * 1000 + 1000);
      const res = await pending;
      expect(res.statusCode).toBe(504);
      expect(res.body).toMatchObject({ code: 'GENERATION_TIMEOUT', userMessageSaved: false });
    });

    it('/ishare/:id/generate: true when the cap fires after the save', async () => {
      jest.useFakeTimers();
      mockWorker.runInWorker.mockReturnValueOnce(new Promise(() => undefined) as any);
      const pending = sendShared();
      await jest.advanceTimersByTimeAsync(10 * 60 * 1000 + 1000);
      const res = await pending;
      expect(res.statusCode).toBe(504);
      expect(res.body).toMatchObject({ code: 'GENERATION_TIMEOUT', userMessageSaved: true });
    });
  });

  describe('409 SESSION_BUSY from the idempotency claim (a duplicate while the first copy runs)', () => {
    beforeEach(() => {
      (isRunStoreEnabled as jest.Mock).mockReturnValue(true);
      (claimIdempotency as jest.Mock).mockResolvedValue({ claimed: false, inFlightRunId: 'run-1' });
    });
    afterEach(() => {
      (isRunStoreEnabled as jest.Mock).mockImplementation(() => jest.requireActual('../services/agentMode/runStore').isRunStoreEnabled());
      (claimIdempotency as jest.Mock).mockImplementation((...a: unknown[]) => jest.requireActual('../services/agentMode/runStore').claimIdempotency(...a));
    });

    it('true when the chat already holds a user message with this request\'s clientId', async () => {
      mockChatbotDb.getChatSession.mockResolvedValue({
        ...baseSession(MODEL),
        messages: [{ role: 'user', content: MESSAGE, clientId: 'msg-1', timestamp: 't' }],
      } as any);
      const res = await send({ clientId: 'msg-1' });
      expect(res.statusCode).toBe(409);
      expect(res.body).toMatchObject({ code: 'SESSION_BUSY', runId: 'run-1', userMessageSaved: true });
      // The read is strongly consistent, so a message the first copy saved a moment ago is seen.
      expect(mockChatbotDb.getChatSession).toHaveBeenLastCalledWith(SESSION_ID, true);
      expect(savedUserMessages()).toEqual([]);
    });

    it('false when only a DIFFERENT clientId is in the chat (an identical earlier message is not this copy)', async () => {
      mockChatbotDb.getChatSession.mockResolvedValue({
        ...baseSession(MODEL),
        messages: [{ role: 'user', content: MESSAGE, clientId: 'msg-0', timestamp: 't' }],
      } as any);
      const res = await send({ clientId: 'msg-1' });
      expect(res.body).toMatchObject({ code: 'SESSION_BUSY', userMessageSaved: false });
    });

    it('false when the request carries no clientId', async () => {
      mockChatbotDb.getChatSession.mockResolvedValue({
        ...baseSession(MODEL),
        messages: [{ role: 'user', content: MESSAGE, timestamp: 't' }],
      } as any);
      const res = await send();
      expect(res.body).toMatchObject({ code: 'SESSION_BUSY', userMessageSaved: false });
    });

    it('false when the chat cannot be read', async () => {
      mockChatbotDb.getChatSession
        .mockResolvedValueOnce(baseSession(MODEL) as any)
        .mockRejectedValue(new Error('dynamo down'));
      const res = await send({ clientId: 'msg-1' });
      expect(res.statusCode).toBe(409);
      expect(res.body).toMatchObject({ code: 'SESSION_BUSY', userMessageSaved: false });
    });
  });
});
