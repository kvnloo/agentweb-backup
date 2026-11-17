/**
 * ENG-669 model provenance (review round 4, adapted from the reviewer's findings tests). A model is exempt from the
 * tier allowlist ONLY when its provenance recorded at write time says AgentWeb chose it, or it is the configured default
 * for the session's kind, or the owner is an admin. Nothing is inferred at check time from a session's plan or template
 * (the one legacy rule covers plan pins written before the record existed). A user-originated write (the picker PATCH)
 * is a user's pick. An approval-inbox resume refused by the allowlist leaves exactly one refusal and one live update,
 * and with the switch off nothing new happens there.
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
    getChatSessionRecord: jest.fn(),
    updateSessionWorkPlan: jest.fn(),
    getUserSessions: jest.fn(),
  },
  updateTaskExecutionStatus: jest.fn(),
}));

const mockEmit = jest.fn();
jest.mock('../server', () => ({ io: { to: jest.fn(() => ({ emit: mockEmit })) } }));
jest.mock('../services/approvalInboxService', () => ({ approvalInboxService: {} }));
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
    // A scheduled session's configured default: outside the Free plan below.
    getScheduledChatsDefaultModel: jest.fn().mockResolvedValue('gpt-5.5'),
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
import { checkTokenUsage } from '../services/tokenUsageService';
import { isRunStoreEnabled, claimIdempotency } from '../services/agentMode/runStore';
import { modelAccess } from '../services/agentMode/modelAccessInstance';
import { workPlanStepModels } from '../services/agentMode/workPlanStepModelsInstance';
import { readTierAllowedModels, getUserSubscriptionResolution } from '../services/subscriptionService';

const mockChatbotDb = chatbotDb as jest.Mocked<typeof chatbotDb>;
const mockWorker = generateMarketingResponseWorkerService as jest.Mocked<typeof generateMarketingResponseWorkerService>;
const mockPolicy = getEffectiveLlmUsagePolicy as jest.Mock;
const mockCheckTokenUsage = checkTokenUsage as jest.Mock;
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

describe('ENG-669 model provenance', () => {
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

  const PLAN_SYSTEM = (steps: any[], extra: Record<string, unknown> = {}) => ({ title: 'P', planAuthor: 'system', createdAt: 'x', updatedAt: 'x', steps, ...extra });
  const patch = (llmModel: string) => ({ user: { userId: OWNER }, params: { sessionId: SESSION_ID }, body: { llmModel } }) as any;

  it('PATCH is a user pick: an admin plan\'s step pin picked in the portal is refused, and so is its echo on /generate', async () => {
    const honor = jest.spyOn(workPlanStepModels, 'shouldHonor').mockResolvedValue(true);
    storeSession({ ...baseSession(ALLOWED), llmModelSource: 'user',
      workPlan: PLAN_SYSTEM([{ stepCount: 1, title: 'S1', status: 'pending' }, { stepCount: 2, title: 'S2', status: 'pending', model: DISALLOWED, modelSource: 'system' }]) });
    const p = makeRes();
    await agentModeController.updateSessionLlmModel(patch(DISALLOWED), p);
    expect(p.statusCode).toBe(422);
    expect(mockChatbotDb.updateSessionLlmModel).not.toHaveBeenCalled();
    const res = makeRes();
    await agentModeController.generateResponse(generateReq({ llmModel: DISALLOWED }), res);
    honor.mockRestore();
    expect(res.statusCode).toBe(422);
    expect(mockWorker.runInWorker).not.toHaveBeenCalled();
  });

  it('PATCH then /generate echo: the PATCH records a user pick, so the echo is checked (no bypass via the stored stamp)', async () => {
    const stored = storeSession({ ...baseSession(DEFAULT_MODEL), llmModelSource: 'system' });
    const p = makeRes();
    await agentModeController.updateSessionLlmModel(patch(ALLOWED), p);
    expect(p.statusCode).toBe(200);
    expect(stored().llmModelSource).toBe('user');
    mockSettings.subscription_types = JSON.stringify([{ name: 'Free', allowedModels: [TARGET] }]); // the plan narrows
    modelAccess.reset();
    const res = makeRes();
    await agentModeController.generateResponse(generateReq({ llmModel: ALLOWED }), res);
    expect(res.statusCode).toBe(422);
  });

  it('re-selecting the session\'s OWN system stamp in the picker is not a new pick (exempt, stays system)', async () => {
    const stored = storeSession({ ...baseSession(DISALLOWED), llmModelSource: 'system' });
    const p = makeRes();
    await agentModeController.updateSessionLlmModel(patch(DISALLOWED), p);
    expect(p.statusCode).toBe(200);
    expect(stored().llmModelSource).toBe('system');
  });

  it('legacy session on a still-admin template: an unsourced stored pick outside the plan is refused on a side channel', async () => {
    const { workPlanService } = require('../services/workPlanService');
    (workPlanService.getWorkPlan as jest.Mock).mockResolvedValue({ planId: 't1', visibility: 'system', defaultModel: ALLOWED, steps: [{ stepCount: 1, model: ALLOWED }] });
    storeSession({ ...baseSession(DISALLOWED), workPlan: { title: 'P', templatePlanId: 't1', createdAt: 'x', updatedAt: 'x', steps: [{ stepCount: 1, title: 'S1', status: 'pending' }] } });
    const err = await generateSessionResponse(SESSION_ID, MESSAGE, OWNER, DISALLOWED).catch((e) => e);
    (workPlanService.getWorkPlan as jest.Mock).mockResolvedValue(null);
    expect(err).toMatchObject({ reason: 'not_in_plan' });
    expect(mockWorker.runInWorker).not.toHaveBeenCalled();
  });

  it('...and on /generate the refusal comes from the pre-flight: a 422 that writes NOTHING to the session', async () => {
    const { workPlanService } = require('../services/workPlanService');
    (workPlanService.getWorkPlan as jest.Mock).mockResolvedValue({ planId: 't1', visibility: 'system', defaultModel: ALLOWED, steps: [{ stepCount: 1, model: ALLOWED }] });
    storeSession({ ...baseSession(DISALLOWED), workPlan: { title: 'P', templatePlanId: 't1', createdAt: 'x', updatedAt: 'x', steps: [{ stepCount: 1, title: 'S1', status: 'pending' }] } });
    const res = makeRes();
    await agentModeController.generateResponse(generateReq({}), res);
    (workPlanService.getWorkPlan as jest.Mock).mockResolvedValue(null);
    expect(res.statusCode).toBe(422);
    expect(mockChatbotDb.updateSessionLlmModel).not.toHaveBeenCalled();
    expect(mockChatbotDb.addMessageToSession).not.toHaveBeenCalled();
  });

  it('control: the same legacy pick without a template plan is refused on a side channel and on /generate', async () => {
    storeSession({ ...baseSession(DISALLOWED) });
    const err = await generateSessionResponse(SESSION_ID, MESSAGE, OWNER, DISALLOWED).catch((e) => e);
    expect(err).toMatchObject({ reason: 'not_in_plan' });
    const res = makeRes();
    await agentModeController.generateResponse(generateReq({}), res);
    expect(res.statusCode).toBe(422);
  });

  it('legacy plan pins (launched before the record) on a still-admin template run as system models', async () => {
    const honor = jest.spyOn(workPlanStepModels, 'shouldHonor').mockResolvedValue(true);
    const { workPlanService } = require('../services/workPlanService');
    (workPlanService.getWorkPlan as jest.Mock).mockResolvedValue({ planId: 't1', visibility: 'system', isBuiltIn: true });
    storeSession({ ...baseSession(ALLOWED), llmModelSource: 'user',
      workPlan: { title: 'P', templatePlanId: 't1', createdAt: 'x', updatedAt: 'x', steps: [{ stepCount: 1, title: 'S1', status: 'pending', model: DISALLOWED }] } });
    await generateSessionResponse(SESSION_ID, MESSAGE, OWNER, ALLOWED);
    honor.mockRestore();
    (workPlanService.getWorkPlan as jest.Mock).mockResolvedValue(null);
    expect(mockWorker.runInWorker).toHaveBeenCalledWith(expect.objectContaining({ llmModel: DISALLOWED }), expect.anything());
  });

  it.each([
    ['system', true],
    ['user', false],
    [undefined, false],
  ] as const)('a step pin recorded with modelSource %p (post-change plan, admin-authored) runs outside the plan (else pauses): %p', async (modelSource, runs) => {
    const honor = jest.spyOn(workPlanStepModels, 'shouldHonor').mockResolvedValue(true);
    const { workPlanService } = require('../services/workPlanService');
    storeSession({ ...baseSession(ALLOWED), llmModelSource: 'user',
      workPlan: PLAN_SYSTEM([{ stepCount: 1, title: 'S1', status: 'pending', model: DISALLOWED, ...(modelSource && { modelSource }) }], { templatePlanId: 't1' }) });
    const err = await generateSessionResponse(SESSION_ID, MESSAGE, OWNER, ALLOWED).catch((e) => e);
    honor.mockRestore();
    // Recorded provenance decides; nothing is inferred from the template (never read).
    expect(workPlanService.getWorkPlan).not.toHaveBeenCalled();
    if (runs) {
      expect(mockWorker.runInWorker).toHaveBeenCalledWith(expect.objectContaining({ llmModel: DISALLOWED }), expect.anything());
    } else {
      // The plan's own pin is outside the plan: the plan pauses loudly (never a swap), nothing runs.
      expect(String(err?.content)).toContain("which isn't included in this account's plan");
      expect(mockWorker.runInWorker).not.toHaveBeenCalled();
    }
  });

  /** A plan whose step 1 pin is retired while AgentWeb's own stamp (outside the Free plan) stands on the session. */
  const retiredStepWithSystemStamp = () => ({ ...baseSession(DISALLOWED), llmModelSource: 'system',
    workPlan: PLAN_SYSTEM([
      { stepCount: 1, title: 'S1', status: 'pending', model: 'retired-model-9', modelSource: 'system' },
      { stepCount: 2, title: 'S2', status: 'pending', model: DISALLOWED, modelSource: 'system' },
    ], { launchModel: ALLOWED }) });

  it('#3607 follow-up 5: approval resume on a RETIRED step pin with AgentWeb\'s stamp standing gets the retired-model pause, not "not in your plan"', async () => {
    const honor = jest.spyOn(workPlanStepModels, 'shouldHonor').mockResolvedValue(true);
    // The stored stamp is AgentWeb's (passes the final gate); the step's own model is retired. The stamp is not a pick the
    // user made, so its refusal is not what this turn reports: the step's own model is.
    const s = retiredStepWithSystemStamp();
    storeSession(s);
    (mockChatbotDb as any).getChatSessionRecord.mockResolvedValue(s);
    mockChatbotDb.addMessageToSession.mockImplementation(async (_id: string, m: any) => ({ messages: [{ ...m, messageIndex: 7 }] }) as any);
    const { resumeOriginSession } = require('../services/approvalInboxExecution');
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    await resumeOriginSession(SESSION_ID, 'Approved: send it');
    honor.mockRestore();
    const saved = mockChatbotDb.addMessageToSession.mock.calls.map(([, m]) => m as any).filter((m) => m.role === 'assistant');
    expect(mockWorker.runInWorker).not.toHaveBeenCalled();
    expect(saved.filter((m) => m.metadata?.isErrorMessage)).toHaveLength(0);
    const pause = saved.filter((m) => m.metadata?.kind === 'work-plan-step-model-unavailable');
    expect(pause).toHaveLength(1);
    expect(pause[0].metadata).toMatchObject({ stepCount: 1, model: 'retired-model-9' });
    expect(pause[0].content).toContain('which is no longer available');
    expect(pause[0].content).not.toContain('included in');
    expect(mockEmit).toHaveBeenCalledWith('session-message-appended', { sessionId: SESSION_ID, message: { role: 'assistant', content: pause[0].content } });
  });

  it('...while a pick the user makes IN this request for that step is still answered as theirs (not in the plan)', async () => {
    const honor = jest.spyOn(workPlanStepModels, 'shouldHonor').mockResolvedValue(true);
    storeSession({ ...retiredStepWithSystemStamp(), llmModel: ALLOWED });
    const err = await generateSessionResponse(
      SESSION_ID, MESSAGE, OWNER, ALLOWED,
      undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      false, DISALLOWED, // isUnattendedRun, explicitModelPick
    ).catch((e) => e);
    honor.mockRestore();
    expect(err).toMatchObject({ reason: 'not_in_plan', requestedModel: DISALLOWED });
    expect(mockWorker.runInWorker).not.toHaveBeenCalled();
  });

  describe('#3607 follow-up 4: the end-of-plan restore of the pre-plan model', () => {
    const finishedPlan = (extra: Record<string, unknown>) => ({
      title: 'P', templatePlanId: 't1', createdAt: 'x', updatedAt: 'x', engineModel: ALLOWED, launchModel: DISALLOWED,
      steps: [{ stepCount: 1, title: 'S1', status: 'completed', model: ALLOWED }], ...extra,
    });
    const restoreNotices = () => mockChatbotDb.addMessageToSession.mock.calls.map(([, m]) => m as any)
      .filter((m) => m?.metadata?.kind === 'work-plan-model-restore-failed');

    it('a LEGACY plan (no launchModelSource, no planAuthor): the restore is AgentWeb\'s action and puts the pre-plan model back', async () => {
      const honor = jest.spyOn(workPlanStepModels, 'shouldHonor').mockResolvedValue(true);
      const stored = storeSession({ ...baseSession(ALLOWED), llmModelSource: 'system', workPlan: finishedPlan({}) });
      await generateSessionResponse(SESSION_ID, MESSAGE, OWNER, ALLOWED);
      honor.mockRestore();
      expect(mockWorker.runInWorker).toHaveBeenCalledWith(expect.objectContaining({ llmModel: DISALLOWED }), expect.anything());
      expect(stored()).toMatchObject({ llmModel: DISALLOWED, llmModelSource: 'system' });
      expect(restoreNotices()).toHaveLength(0);
    });

    it('a restore that is refused (the launch recorded the user\'s own pick, now outside the plan) is said in the chat, never silent', async () => {
      const honor = jest.spyOn(workPlanStepModels, 'shouldHonor').mockResolvedValue(true);
      const stored = storeSession({ ...baseSession(ALLOWED), llmModelSource: 'system',
        workPlan: finishedPlan({ planAuthor: 'system', launchModelSource: 'user' }) });
      await generateSessionResponse(SESSION_ID, MESSAGE, OWNER, ALLOWED);
      honor.mockRestore();
      // The turn runs on the current model, and the chat says why the old one did not come back (once: marker cleared).
      expect(mockWorker.runInWorker).toHaveBeenCalledWith(expect.objectContaining({ llmModel: ALLOWED }), expect.anything());
      expect(restoreNotices()).toHaveLength(1);
      expect(restoreNotices()[0].content).toBe(
        "The work plan is finished. This chat used GPT-5.5 before the plan, but that model isn't included in this account's plan, so the chat stays on gemini-3.5-flash. To switch, choose another model in the model picker.",
      );
      expect(mockEmit).toHaveBeenCalledWith('session-message-appended', { sessionId: SESSION_ID, message: { role: 'assistant', content: restoreNotices()[0].content } });
      expect(mockChatbotDb.updateSessionWorkPlan).toHaveBeenCalledWith(SESSION_ID, expect.not.objectContaining({ engineModel: expect.anything() }));
      expect(stored().llmModel).toBe(ALLOWED);
    });

    it('the note names the selection the chat keeps (the stored model), not the model this turn happened to run', async () => {
      // e.g. a stored AgentWeb Model selection: the caller hands over the concrete routed model for this turn.
      const honor = jest.spyOn(workPlanStepModels, 'shouldHonor').mockResolvedValue(true);
      storeSession({ ...baseSession(ALLOWED), llmModelSource: 'system', workPlan: finishedPlan({ planAuthor: 'system', launchModelSource: 'user' }) });
      await generateSessionResponse(SESSION_ID, MESSAGE, OWNER, DEFAULT_MODEL);
      honor.mockRestore();
      expect(restoreNotices()).toHaveLength(1);
      expect(restoreNotices()[0].content).toContain('so the chat stays on gemini-3.5-flash.');
    });
  });

  describe('#3607 follow-up 1: a session kind\'s configured default is AgentWeb\'s unless the user picks it now', () => {
    const SCHEDULED_DEFAULT = DISALLOWED; // getScheduledChatsDefaultModel, outside the Free plan
    const scheduled = (extra: Record<string, unknown>) => ({ ...baseSession(ALLOWED), sessionType: 'scheduled', ...extra });

    it('the picker PATCH to the kind\'s default is a user pick: refused when outside the plan, nothing written', async () => {
      storeSession(scheduled({ llmModelSource: 'system' }));
      const p = makeRes();
      await agentModeController.updateSessionLlmModel(patch(SCHEDULED_DEFAULT), p);
      expect(p.statusCode).toBe(422);
      expect(p.body).toMatchObject({ code: 'model_unavailable', reason: 'not_in_plan' });
      expect(mockChatbotDb.updateSessionLlmModel).not.toHaveBeenCalled();
    });

    it('AgentWeb\'s own stamp of it (recorded system, or a legacy stamp with none recorded) still runs and can be re-selected', async () => {
      const stored = storeSession(scheduled({ llmModel: SCHEDULED_DEFAULT, llmModelSource: 'system' }));
      const p = makeRes();
      await agentModeController.updateSessionLlmModel(patch(SCHEDULED_DEFAULT), p);
      expect(p.statusCode).toBe(200);
      expect(stored().llmModelSource).toBe('system');

      storeSession(scheduled({ llmModel: SCHEDULED_DEFAULT }));
      await generateSessionResponse(SESSION_ID, MESSAGE, OWNER, SCHEDULED_DEFAULT);
      expect(mockWorker.runInWorker).toHaveBeenCalledWith(expect.objectContaining({ llmModel: SCHEDULED_DEFAULT }), expect.anything());
    });

    it('a LEGACY stamp of it (none recorded) keeps running turn after turn: the portal\'s echo does not turn it into a user pick', async () => {
      // Every session written before llmModelSource existed (2026-10-19) is like this. The portal re-sends the picker
      // value on every turn; that echo is not a new choice, so the second turn must run like the first.
      const stored = storeSession(scheduled({ llmModel: SCHEDULED_DEFAULT }));
      for (const turn of [1, 2]) {
        const res = makeRes();
        await agentModeController.generateResponse(generateReq({ llmModel: SCHEDULED_DEFAULT }), res);
        expect({ turn, status: res.statusCode, body: res.statusCode === 200 ? undefined : res.body }).toEqual({ turn, status: 200, body: undefined });
      }
      expect(mockWorker.runInWorker).toHaveBeenCalledTimes(2);
      expect(stored().llmModel).toBe(SCHEDULED_DEFAULT);
    });

    it('a stamp of it RECORDED as the user\'s (what that echo wrote on legacy stamps since 2026-10-19) still runs at the final gate', async () => {
      storeSession(scheduled({ llmModel: SCHEDULED_DEFAULT, llmModelSource: 'user' }));
      await generateSessionResponse(SESSION_ID, MESSAGE, OWNER, SCHEDULED_DEFAULT);
      expect(mockWorker.runInWorker).toHaveBeenCalledWith(expect.objectContaining({ llmModel: SCHEDULED_DEFAULT }), expect.anything());
    });

    it('...while a NEW /generate pick of it from another model is refused by the pre-flight, nothing written', async () => {
      storeSession(scheduled({ llmModelSource: 'system' }));
      const res = makeRes();
      await agentModeController.generateResponse(generateReq({ llmModel: SCHEDULED_DEFAULT }), res);
      expect(res.statusCode).toBe(422);
      expect(res.body).toMatchObject({ reason: 'not_in_plan' });
      expect(mockChatbotDb.updateSessionLlmModel).not.toHaveBeenCalled();
      expect(mockWorker.runInWorker).not.toHaveBeenCalled();
    });

    // The model the session had when a plan was launched there is not a pick the user makes at the plan's end (restore)
    // or on a model-less step (its fallback), even when the launch recorded it as the user's: still the kind's default.
    const planOnScheduledDefault = (steps: any[], extra: Record<string, unknown> = {}) => scheduled({
      llmModel: ALLOWED, llmModelSource: 'system',
      workPlan: { title: 'P', createdAt: 'x', updatedAt: 'x', engineModel: ALLOWED, launchModel: SCHEDULED_DEFAULT, steps, ...extra },
    });

    it('the end-of-plan restore of the kind\'s default (launch recorded \'user\') puts it back, with no "not in your plan" note', async () => {
      const honor = jest.spyOn(workPlanStepModels, 'shouldHonor').mockResolvedValue(true);
      const stored = storeSession(planOnScheduledDefault(
        [{ stepCount: 1, title: 'S1', status: 'completed', model: ALLOWED, modelSource: 'system' }],
        { planAuthor: 'system', launchModelSource: 'user' },
      ));
      await generateSessionResponse(SESSION_ID, MESSAGE, OWNER, ALLOWED);
      honor.mockRestore();
      expect(mockWorker.runInWorker).toHaveBeenCalledWith(expect.objectContaining({ llmModel: SCHEDULED_DEFAULT }), expect.anything());
      expect(stored().llmModel).toBe(SCHEDULED_DEFAULT);
      expect(mockChatbotDb.addMessageToSession.mock.calls.map(([, m]) => (m as any)?.metadata?.kind)).not.toContain('work-plan-model-restore-failed');
    });

    it('a model-less step falls back to the kind\'s default it was launched on (legacy plan): it runs, the plan does not pause', async () => {
      const honor = jest.spyOn(workPlanStepModels, 'shouldHonor').mockResolvedValue(true);
      storeSession(planOnScheduledDefault([
        { stepCount: 1, title: 'S1', status: 'completed', model: ALLOWED },
        { stepCount: 2, title: 'S2', status: 'pending' },
      ]));
      const result = await generateSessionResponse(SESSION_ID, MESSAGE, OWNER, ALLOWED);
      honor.mockRestore();
      expect(String(result?.content)).not.toContain('included in');
      expect(mockWorker.runInWorker).toHaveBeenCalledWith(expect.objectContaining({ llmModel: SCHEDULED_DEFAULT }), expect.anything());
    });

    it('the interactive configured default stays a free pick in any kind of session', async () => {
      storeSession(scheduled({ llmModel: ALLOWED, llmModelSource: 'user' }));
      const p = makeRes();
      await agentModeController.updateSessionLlmModel(patch(DEFAULT_MODEL), p);
      expect(p.statusCode).toBe(200);
    });
  });

  describe('#3607 follow-up 6: owner session reads carry no model provenance bookkeeping', () => {
    const sessionWithPlan = () => ({ ...baseSession(ALLOWED), llmModelSource: 'system',
      workPlan: { title: 'P', templatePlanId: 't1', planAuthor: 'system', launchModel: ALLOWED, launchModelSource: 'user',
        planDefaultModel: ALLOWED, planDefaultModelSource: 'system', createdAt: 'x', updatedAt: 'x',
        steps: [{ stepCount: 1, title: 'S1', status: 'pending', model: DISALLOWED, modelSource: 'system' }, { stepCount: 2, title: 'S2', status: 'pending' }] } });
    const read = async (user: Record<string, unknown>) => {
      const res = makeRes();
      await agentModeController.getSession({ params: { sessionId: SESSION_ID }, user, query: {} } as any, res);
      return res;
    };

    it('the owner\'s read drops planAuthor, launchModelSource, planDefaultModelSource and step modelSource; keeps what the portal reads', async () => {
      storeSession(sessionWithPlan());
      const res = await read({ userId: OWNER, isAdmin: false });
      expect(res.statusCode).toBe(200);
      const plan = res.body.workPlan;
      expect(plan).not.toHaveProperty('planAuthor');
      expect(plan).not.toHaveProperty('launchModelSource');
      expect(plan).not.toHaveProperty('planDefaultModelSource');
      expect(plan.steps[0]).not.toHaveProperty('modelSource');
      expect(plan.steps[0].model).toBe(DISALLOWED);
      expect(plan.templatePlanId).toBe('t1');
      expect(res.body.llmModelSource).toBe('system'); // the portal's llmModelIsSystemChoice reads it
      // The stored plan is untouched.
      expect(mockChatbotDb.updateSessionWorkPlan).not.toHaveBeenCalled();
    });

    it('an admin read keeps them (support)', async () => {
      storeSession(sessionWithPlan());
      const res = await read({ userId: 'admin-1', isAdmin: true });
      expect(res.body.workPlan).toMatchObject({ planAuthor: 'system', launchModelSource: 'user', planDefaultModelSource: 'system' });
      expect(res.body.workPlan.steps[0].modelSource).toBe('system');
    });

    const expectNoProvenance = (plan: any) => {
      expect(plan).toBeDefined();
      expect(JSON.stringify(plan)).not.toMatch(/planAuthor|launchModelSource|planDefaultModelSource|"modelSource"/);
      expect(plan.steps[0].model).toBe(DISALLOWED);
      expect(plan.templatePlanId).toBe('t1');
    };

    it('the session LIST the portal polls drops them too (owner); an admin keeps them', async () => {
      (mockChatbotDb as any).getUserSessions.mockResolvedValue({ sessions: [sessionWithPlan()], lastEvaluatedKey: undefined });
      const list = async (user: Record<string, unknown>) => {
        const res = makeRes();
        await agentModeController.getSessions({ user, query: {} } as any, res);
        return res;
      };
      const owner = await list({ userId: OWNER, isAdmin: false });
      expect(owner.statusCode).toBe(200);
      expectNoProvenance(owner.body.sessions[0].workPlan);
      expect(owner.body.sessions[0].llmModelSource).toBe('system');
      const admin = await list({ userId: 'admin-1', isAdmin: true });
      expect(admin.body.sessions[0].workPlan).toMatchObject({ planAuthor: 'system', launchModelSource: 'user' });
    });

    it('an idempotent replay of session creation drops them too', async () => {
      (isRunStoreEnabled as jest.Mock).mockReturnValueOnce(true);
      (claimIdempotency as jest.Mock).mockResolvedValueOnce({ claimed: false, sessionId: SESSION_ID });
      storeSession(sessionWithPlan());
      const res = makeRes();
      await agentModeController.createSession({ user: { userId: OWNER, isAdmin: false }, body: { idempotencyKey: 'k1' }, query: {} } as any, res);
      expect(res.statusCode).toBe(200);
      expect(res.body.idempotentReplay).toBe(true);
      expectNoProvenance(res.body.workPlan);
    });
  });

  it('switch OFF: the shared-view pre-flight reads no usage and no tier', async () => {
    delete mockSettings.model_tier_allowlist_enabled; modelAccess.reset();
    storeSession({ ...baseSession(DISALLOWED), llmModelSource: 'user', interactiveShareMetadata: { isActive: true, token: 'tok', sharedAt: '2026-07-01T00:00:00Z' } });
    const res = makeRes();
    await agentModeController.generateSharedResponse({ params: { shareId: SESSION_ID }, query: { conversable: 'tok' }, body: { userMessage: MESSAGE, attachments: [] }, on: jest.fn() } as unknown as Request, res);
    expect(res.statusCode).toBe(200);
    expect(mockCheckTokenUsage).toHaveBeenCalledTimes(1); // only the pre-existing usage gate
    expect(mockResolution).not.toHaveBeenCalled();
  });

  it('switch OFF: an approval resume refused for another reason behaves as before (no refusal saved, no live update)', async () => {
    delete mockSettings.model_tier_allowlist_enabled; modelAccess.reset();
    const honor = jest.spyOn(workPlanStepModels, 'shouldHonor').mockResolvedValue(true);
    const s = { ...baseSession('internal-judge-1'), llmModelSource: 'user',
      workPlan: { title: 'P', planAuthor: 'system', launchModel: ALLOWED, createdAt: 'x', updatedAt: 'x',
        steps: [{ stepCount: 1, title: 'S1', status: 'pending', model: 'retired-model-9', modelSource: 'system' }] } };
    storeSession(s);
    (mockChatbotDb as any).getChatSessionRecord.mockResolvedValue(s);
    const { resumeOriginSession } = require('../services/approvalInboxExecution');
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    await resumeOriginSession(SESSION_ID, 'Approved');
    honor.mockRestore();
    const refusals = mockChatbotDb.addMessageToSession.mock.calls.map(([, m]) => m as any).filter((m) => m.role === 'assistant' && m.metadata?.isErrorMessage);
    expect(refusals).toHaveLength(0);
    expect(mockEmit).not.toHaveBeenCalled();
    expect(mockResolution).not.toHaveBeenCalled();
  });
});
