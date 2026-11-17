/**
 * ENG-669 PR-C: the AgentWeb Model router, wired through the controller.
 *
 * `agentweb-model` is a selection like any other model id. With the switch OFF it is an unknown id, refused exactly as
 * before (no extra reads). With it ON: the SELECTION is what the tier allowlist checks; the router picks the concrete
 * model per task (AgentWeb's choice, exempt as a pick); the session (and the step engine's markers) store the
 * selection, never the routed model; the routed decision is recorded with routedVia / routingReason / tableVersion and
 * handed to the worker so each reply carries `llmSelected` beside the concrete `llm`; an unavailable router is a
 * visible 422 with one alert, never a fallback.
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
  },
  updateTaskExecutionStatus: jest.fn(),
}));
jest.mock('../server', () => ({ io: { to: jest.fn(() => ({ emit: jest.fn() })) } }));
jest.mock('../services/approvalInboxService', () => ({ approvalInboxService: {} }));
jest.mock('../services/emailService', () => ({ emailService: { sendOncallAlert: jest.fn().mockResolvedValue(undefined) } }));
jest.mock('../services/db', () => ({ userDb: { getUserById: jest.fn() }, scheduleDb: {}, taskDb: {} }));
jest.mock('../services/generateMarketingResponseWorkerService', () => ({
  generateMarketingResponseWorkerService: { runInWorker: jest.fn(), cancelSession: jest.fn() },
}));

// Real registry ids (the routing table is validated against the real registry and price table).
const DEFAULT_MODEL = 'gemini-3.8-flash';
const ROUTED_CHAT = 'gemini-3.5-flash';
const ROUTED_SCHEDULED = 'gpt-5.5';
const OTHER = 'openrouter/x-ai/grok-4.7';

jest.mock('../services/agentModeService', () => {
  const served = ['gemini-3.8-flash', 'gemini-3.5-flash', 'gpt-5.5', 'openrouter/x-ai/grok-4.7'];
  return {
    agentModeService: {
      default_model: 'gemini-3.8-flash',
      getDefaultModel: jest.fn().mockResolvedValue('gemini-3.8-flash'),
      getReportsModel: jest.fn().mockResolvedValue('gemini-3.8-flash'),
      getReportGenerationDefaultModel: jest.fn().mockResolvedValue('gemini-3.8-flash'),
      getImageGenerationDefaultModel: jest.fn().mockResolvedValue('gemini-3.8-flash'),
      getVideoGenerationDefaultModel: jest.fn().mockResolvedValue('gemini-3.8-flash'),
      getScheduledChatsDefaultModel: jest.fn().mockResolvedValue('gemini-3.8-flash'),
      getCustomerSupportDefaultModel: jest.fn().mockResolvedValue('gemini-3.8-flash'),
      getSupportedModels: jest.fn(async () => [...served]),
      normalizeModelId: jest.fn((id: string) => id),
      resolveGenerationModel: jest.fn((model: string) => (served.includes(String(model))
        ? { model, fellBack: false, requestedModel: model }
        : { model: 'gemini-3.8-flash', fellBack: true, requestedModel: model })),
      isLiveModel: jest.fn(() => false),
      isModelSelectableBy: jest.fn((id: string) => served.includes(id)),
      getModelDisplayName: jest.fn(() => undefined),
      generateSessionTitle: jest.fn().mockResolvedValue('Title'),
      getMarketingSystemPrompt: jest.fn().mockResolvedValue('System prompt'),
      generateDiagnosticMessage: jest.fn().mockResolvedValue(null),
      getSkillsForDisplay: jest.fn().mockResolvedValue([]),
      getSupportedModelsWithMetadata: jest.fn(async () => served.map((id) => ({ id, name: id, tier: 'medium', description: 'd', provider: 'other' }))),
    },
    AgentModeService: jest.fn(),
    normalizeWorkPlanTitleForMatch: (title: string) => title.toLowerCase().replace(/[\s_-]+/g, ' ').trim(),
  };
});
jest.mock('../services/agentMode/concurrentGenerationCap', () => {
  const actual = jest.requireActual('../services/agentMode/concurrentGenerationCap');
  return { ...actual, acquireInteractiveGenerationSlot: jest.fn() };
});
jest.mock('../services/llmUsagePolicyResolverService', () => ({ getEffectiveLlmUsagePolicy: jest.fn() }));
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
jest.mock('../services/workPlanService', () => ({ workPlanService: { getWorkPlan: jest.fn().mockResolvedValue(null) } }));
jest.mock('../services/skillService', () => ({
  skillService: { getInstalledSkills: jest.fn().mockResolvedValue([]), getPublishedSkills: jest.fn().mockResolvedValue([]) },
}));
jest.mock('../services/subscriptionService', () => ({
  getAllowedSkills: jest.fn().mockResolvedValue([]),
  getUserSubscriptionResolution: jest.fn(),
  readTierAllowedModels: jest.fn(),
}));
const mockSettings: Record<string, string | undefined> = {};
jest.mock('../services/settingsService', () => ({
  settingsService: {
    getSetting: jest.fn(async (name: string) => (mockSettings[name] === undefined ? null : { settingName: name, settingValue: mockSettings[name] })),
  },
}));
jest.mock('../utils/agentModeAlerts', () => ({ sendAgentModeOncallAlert: jest.fn().mockResolvedValue(undefined) }));
const mockTokenUser: { user?: { userId: string; isAdmin: boolean } } = {};
jest.mock('../middleware/auth', () => ({
  ...jest.requireActual('../middleware/auth'),
  getUserFromToken: jest.fn(async () => ({ user: mockTokenUser.user })),
}));
jest.mock('../utils/agentModeErrors', () => ({
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
} from '../controllers/agentModeController';
import { ModelUnavailableError, buildModelUnavailableBody } from '../services/agentMode/modelUnavailable';
import { chatbotDb } from '../services/chatbotService';
import { userDb } from '../services/db';
import { generateMarketingResponseWorkerService } from '../services/generateMarketingResponseWorkerService';
import { getEffectiveLlmUsagePolicy } from '../services/llmUsagePolicyResolverService';
import { checkTokenUsage } from '../services/tokenUsageService';
import { settingsService } from '../services/settingsService';
import { sendAgentModeOncallAlert } from '../utils/agentModeAlerts';
import { acquireInteractiveGenerationSlot } from '../services/agentMode/concurrentGenerationCap';
import { modelAccess } from '../services/agentMode/modelAccessInstance';
import { agentWebModelRouter } from '../services/agentMode/agentWebModelRouterInstance';
import { workPlanStepModels } from '../services/agentMode/workPlanStepModelsInstance';
import { getUserSubscriptionResolution, readTierAllowedModels } from '../services/subscriptionService';
import {
  AGENTWEB_MODEL_ROUTER_SETTING,
  AGENTWEB_MODEL_ROUTING_TABLE_SETTING,
  ROUTER_UNAVAILABLE_ALERT_DEDUPE_KEY,
} from '../services/agentMode/agentWebModelRouter';
import { checkPlanStepModelsWrite, resolvePlanStepModelsForLaunch } from '../services/agentMode/workPlanStepModels';
import { agentModeService } from '../services/agentModeService';

const mockChatbotDb = chatbotDb as jest.Mocked<typeof chatbotDb>;
const mockWorker = generateMarketingResponseWorkerService as jest.Mocked<typeof generateMarketingResponseWorkerService>;
const mockGetSetting = settingsService.getSetting as jest.Mock;
const mockAlert = sendAgentModeOncallAlert as jest.Mock;

const AW = 'agentweb-model';
const OWNER = 'user-owner';
const SESSION_ID = 'session-1';
const TABLE = { version: 't1', default: ROUTED_CHAT, routes: { scheduled: ROUTED_SCHEDULED } };
const ROUTED_DECISION = {
  requestedModel: AW, effectiveModel: ROUTED_CHAT, routedVia: AW, routingReason: 'chat task: table default', tableVersion: 't1',
  modelSelection: 'honored', backupModel: null, backupSource: null,
};
const STAMP = { llmSelected: AW, llmRoutingReason: 'chat task: table default', llmRoutingTableVersion: 't1' };

const makeRes = () => {
  const res: any = { statusCode: 200, body: undefined, headersSent: false };
  res.status = jest.fn((code: number) => { res.statusCode = code; return res; });
  res.json = jest.fn((payload: any) => { res.body = payload; return res; });
  res.set = jest.fn(() => res);
  return res as Response & { statusCode: number; body: any };
};

const baseSession = (llmModel?: string, extra: Record<string, unknown> = {}) => ({
  sessionId: SESSION_ID, userId: OWNER, sessionType: 'regular', title: 'Chat', messages: [],
  createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z', portalType: 'agent' as const, pageIdentifier: 'agent-mode',
  interactiveShareMetadata: { isActive: true, token: 'tok', sharedAt: '2026-10-01T00:00:00Z' },
  ...(llmModel ? { llmModel } : {}),
  ...extra,
});

/** A session store that keeps what the model / work-plan writes put there. */
const storeSession = (initial: Record<string, any>) => {
  let stored: any = { ...initial };
  mockChatbotDb.getChatSession.mockImplementation(async () => stored);
  mockChatbotDb.updateSessionLlmModel.mockImplementation(async (_id: string, model: string, decision: any, source?: any) => {
    stored = { ...stored, llmModel: model, llmUsagePolicyDecision: decision, llmModelSource: source };
    if (!source) delete stored.llmModelSource;
    if (!decision) delete stored.llmUsagePolicyDecision;
    return stored;
  });
  (mockChatbotDb as any).updateSessionWorkPlan.mockImplementation(async (_id: string, workPlan: any) => {
    stored = { ...stored, workPlan };
    return stored;
  });
  return { get: () => stored, set: (patch: Record<string, unknown>) => { stored = { ...stored, ...patch }; } };
};

const generateReq = (body: Record<string, unknown>) => ({
  user: { userId: OWNER, isAdmin: false },
  body: { sessionId: SESSION_ID, userMessage: 'Draft the launch email', attachments: [], ...body },
  method: 'POST', path: '/api/agent-mode/generate', ip: '127.0.0.1', socket: { remoteAddress: '127.0.0.1' }, on: jest.fn(),
} as unknown as Request);
const patchReq = (llmModel: unknown) => ({ user: { userId: OWNER }, params: { sessionId: SESSION_ID }, body: { llmModel } }) as any;

const workerCall = (i = 0) => mockWorker.runInWorker.mock.calls[i]?.[0] as any;
const routerSettingReads = () => mockGetSetting.mock.calls
  .map(([name]) => name)
  .filter((name) => name === AGENTWEB_MODEL_ROUTER_SETTING || name === AGENTWEB_MODEL_ROUTING_TABLE_SETTING);
const tableReads = () => mockGetSetting.mock.calls.filter(([name]) => name === AGENTWEB_MODEL_ROUTING_TABLE_SETTING);

const turnOn = (table: unknown = TABLE) => {
  mockSettings[AGENTWEB_MODEL_ROUTER_SETTING] = 'true';
  mockSettings[AGENTWEB_MODEL_ROUTING_TABLE_SETTING] = typeof table === 'string' ? table : JSON.stringify(table);
};
/** The PR-A tier allowlist on, with the owner on `Free`. */
const allowlist = (free: string[], extraTiers: Array<{ name: string; allowedModels?: string[] }> = [{ name: 'Pro', allowedModels: ['*'] }]) => {
  mockSettings.model_tier_allowlist_enabled = 'true';
  mockSettings.subscription_types = JSON.stringify([{ name: 'Free', allowedModels: free }, ...extraTiers]);
};

beforeEach(() => {
  jest.clearAllMocks();
  for (const key of Object.keys(mockSettings)) delete mockSettings[key];
  modelAccess.reset();
  agentWebModelRouter.reset();
  activeSessionGenerations.clear();
  (acquireInteractiveGenerationSlot as jest.Mock).mockResolvedValue({ ok: true, release: jest.fn() });
  (getEffectiveLlmUsagePolicy as jest.Mock).mockResolvedValue({
    billingUserId: OWNER, policy: null, costUsedMicroUsd: 0, tokenUsed: 0,
    mode: { usageMode: 'full_choice', admissionAllowed: true, reason: 'policy_not_enforced' },
  });
  (checkTokenUsage as jest.Mock).mockResolvedValue({
    allowed: true, warning: false, used: 0, allowance: null, bonus: 0, effectiveAllowance: null, percentUsed: 0, month: '2026-10',
  });
  (getUserSubscriptionResolution as jest.Mock).mockResolvedValue({ subscriptionType: 'Free', resolved: true });
  (readTierAllowedModels as jest.Mock).mockImplementation(async (tier: string) => {
    const tiers = mockSettings.subscription_types ? JSON.parse(mockSettings.subscription_types) : [];
    const row = tiers.find((t: any) => t.name === tier);
    return row ? { configured: true, allowedModels: row.allowedModels } : { configured: false };
  });
  (userDb.getUserById as jest.Mock).mockResolvedValue({ userId: OWNER, isAdmin: false });
  (mockChatbotDb as any).getMessagesFromMessagesTable.mockResolvedValue([]);
  mockChatbotDb.addMessageToSession.mockResolvedValue(baseSession() as any);
  mockChatbotDb.addMessagesToSession.mockResolvedValue(undefined as any);
  mockChatbotDb.updateSessionTitle.mockResolvedValue(undefined as any);
  mockChatbotDb.createChatSession.mockResolvedValue(baseSession() as any);
  mockWorker.runInWorker.mockResolvedValue({ content: 'OK', toolCalls: [], knowledgeBaseQueries: [], sources: [], responseMessages: [] } as any);
  storeSession(baseSession(DEFAULT_MODEL, { llmModelSource: 'system' }));
});

const AW_UNAVAILABLE = 'AgentWeb Model isn\'t available right now. Choose another model to continue.';

describe('switch OFF: as before the router (the id is an unknown model), with the AgentWeb Model sentence', () => {
  it('/generate refuses the id with the same 422 as an unknown model (code, reason, id), worded by name; writes and runs nothing', async () => {
    const unknown = makeRes();
    await agentModeController.generateResponse(generateReq({ llmModel: 'retired-model-9' }), unknown);
    const res = makeRes();
    await agentModeController.generateResponse(generateReq({ llmModel: AW }), res);

    expect(res.statusCode).toBe(422);
    expect(unknown.statusCode).toBe(422);
    expect(res.body).toEqual({ error: AW_UNAVAILABLE, code: 'model_unavailable', requestedModel: AW, reason: 'not_served', userMessageSaved: false });
    expect(unknown.body).toEqual({ ...buildModelUnavailableBody(new ModelUnavailableError('retired-model-9', 'not_served')), userMessageSaved: false });
    expect(Object.keys(res.body).sort()).toEqual(Object.keys(unknown.body).sort());
    expect(mockWorker.runInWorker).not.toHaveBeenCalled();
    expect(mockChatbotDb.updateSessionLlmModel).not.toHaveBeenCalled();
    expect(tableReads()).toHaveLength(0);
  });

  it('a turn on any other model never reads the router switch or table', async () => {
    const res = makeRes();
    await agentModeController.generateResponse(generateReq({ llmModel: OTHER }), res);
    expect(res.statusCode).toBe(200);
    expect(routerSettingReads()).toEqual([]);
    expect(workerCall().modelRouting).toBeUndefined();
  });

  it('the picker PATCH answers the id with the same 400 as any unsupported id', async () => {
    const res = makeRes();
    await agentModeController.updateSessionLlmModel(patchReq(AW), res);
    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: `Unsupported model '${AW}'. Choose a model returned by the supported-models endpoint.` });
    expect(mockChatbotDb.updateSessionLlmModel).not.toHaveBeenCalled();
  });

  it('/model-options does not offer it', async () => {
    const res = makeRes();
    await agentModeController.getModelOptions({ user: { userId: OWNER, isAdmin: false } } as any, res);
    expect(res.body.allModels).not.toContain(AW);
    expect(tableReads()).toHaveLength(0);
  });

  it('a side channel running a stored selection is refused, never run on another model', async () => {
    storeSession(baseSession(AW, { llmModelSource: 'user' }));
    const error = await generateSessionResponse(SESSION_ID, 'hi', OWNER, AW).catch((e) => e);
    expect(error).toMatchObject({ code: 'model_unavailable', requestedModel: AW, reason: 'not_served' });
    expect(mockWorker.runInWorker).not.toHaveBeenCalled();
  });
});

describe('switch ON', () => {
  beforeEach(() => turnOn());

  it('/generate runs the routed model, stores the SELECTION with the routed decision, and hands the stamp to the worker', async () => {
    const store = storeSession(baseSession(DEFAULT_MODEL, { llmModelSource: 'system' }));
    const res = makeRes();
    await agentModeController.generateResponse(generateReq({ llmModel: AW, llmBackupModel: OTHER }), res);

    expect(res.statusCode).toBe(200);
    expect(workerCall().llmModel).toBe(ROUTED_CHAT);
    expect(workerCall().modelRouting).toEqual(STAMP);
    expect(store.get().llmModel).toBe(AW);
    expect(store.get().llmModelSource).toBe('user');
    // No backup, no fallback: the routed model runs or the turn errors.
    expect(store.get().llmUsagePolicyDecision).toMatchObject(ROUTED_DECISION);
    expect(res.body).toMatchObject({ requestedModel: AW, effectiveModel: ROUTED_CHAT, routedVia: AW, routingReason: 'chat task: table default', tableVersion: 't1', backupModel: null });
    // Never stored as the concrete model anywhere.
    expect(mockChatbotDb.updateSessionLlmModel.mock.calls.map((c) => c[1])).not.toContain(ROUTED_CHAT);
  });

  it('the portal echo of the stored selection keeps it the user\'s pick and keeps routing', async () => {
    const store = storeSession(baseSession(AW, { llmModelSource: 'user' }));
    await agentModeController.generateResponse(generateReq({ llmModel: AW }), makeRes());
    await agentModeController.generateResponse(generateReq({ llmModel: AW }), makeRes());
    expect(store.get()).toMatchObject({ llmModel: AW, llmModelSource: 'user' });
    expect(mockWorker.runInWorker.mock.calls.map((c) => (c[0] as any).llmModel)).toEqual([ROUTED_CHAT, ROUTED_CHAT]);
  });

  it('the tier allowlist checks the SELECTION: a plan without the AgentWeb Model gets 422 not_in_plan', async () => {
    allowlist([ROUTED_CHAT]);
    const res = makeRes();
    await agentModeController.generateResponse(generateReq({ llmModel: AW }), res);
    expect(res.statusCode).toBe(422);
    expect(res.body).toMatchObject({ code: 'model_unavailable', reason: 'not_in_plan', requestedModel: AW, model: AW, tier: 'Free' });
    expect(mockWorker.runInWorker).not.toHaveBeenCalled();
  });

  it('the ROUTED model is AgentWeb\'s choice: only the selection is tier-checked', async () => {
    allowlist([AW, ROUTED_CHAT, ROUTED_SCHEDULED]);
    const spy = jest.spyOn(modelAccess, 'assertModelAllowed');
    const res = makeRes();
    await agentModeController.generateResponse(generateReq({ llmModel: AW }), res);
    expect(res.statusCode).toBe(200);
    expect(spy.mock.calls.map(([input]) => input.canonicalModel)).toEqual([AW]);
    spy.mockRestore();
  });

  /** The owner's subscription tier for the next reads (the access cache is reset). */
  const ownerTier = (tier: string) => {
    (getUserSubscriptionResolution as jest.Mock).mockResolvedValue({ subscriptionType: tier, resolved: true });
    modelAccess.reset();
  };
  const turn = async (body: Record<string, unknown> = { llmModel: AW }) => {
    const res = makeRes();
    await agentModeController.generateResponse(generateReq(body), res);
    return res;
  };

  it('narrowing ONE tier\'s allowedModels refuses only that tier (one alert naming it); other tiers route normally', async () => {
    // Free may select the router but no longer allows the chat route's model; Team does; Pro is a wildcard.
    allowlist([AW, ROUTED_SCHEDULED], [{ name: 'Pro', allowedModels: ['*'] }, { name: 'Team', allowedModels: [AW, ROUTED_CHAT, ROUTED_SCHEDULED] }]);
    for (let i = 0; i < 2; i++) {
      const refused = await turn();
      expect(refused.statusCode).toBe(422);
      expect(refused.body).toEqual({ ...buildModelUnavailableBody(new ModelUnavailableError(AW, 'not_served')), userMessageSaved: false });
    }
    expect(mockWorker.runInWorker).not.toHaveBeenCalled();

    for (const tier of ['Pro', 'Team']) {
      ownerTier(tier);
      const ok = await turn();
      expect(ok.statusCode).toBe(200);
    }
    expect(mockWorker.runInWorker.mock.calls.map((c) => (c[0] as any).llmModel)).toEqual([ROUTED_CHAT, ROUTED_CHAT]);

    const routerAlerts = mockAlert.mock.calls.map(([a]) => a).filter((a) => String(a.dedupeKey).startsWith('agentweb_model_router:'));
    expect(routerAlerts.map((a) => a.dedupeKey)).toEqual(['agentweb_model_router:tier:Free']);
    expect(routerAlerts[0].subject).toBe('AgentMode: AgentWeb Model unavailable for tier "Free"');
    expect(routerAlerts[0].message).toContain(`chat -> "${ROUTED_CHAT}"`);
  });

  it('an unusable target used by ONE route refuses only that route; other routes keep working', async () => {
    // Scheduled tasks route to an admin-only model; chat tasks are fine.
    turnOn({ ...TABLE, routes: { scheduled: 'openrouter/anthropic/claude-sonnet-5.5' } });
    expect((await turn()).statusCode).toBe(200);
    expect(workerCall(0).llmModel).toBe(ROUTED_CHAT);

    storeSession(baseSession(AW, { llmModelSource: 'user', sessionType: 'scheduled' }));
    const error = await generateSessionResponse(SESSION_ID, 'hi', OWNER, AW).catch((e) => e);
    expect(error).toMatchObject({ requestedModel: AW, reason: 'not_served' });
    expect(mockWorker.runInWorker).toHaveBeenCalledTimes(1); // never sent to the table default instead

    const routerAlerts = mockAlert.mock.calls.map(([a]) => a).filter((a) => String(a.dedupeKey).startsWith('agentweb_model_router:'));
    expect(routerAlerts.map((a) => a.dedupeKey)).toEqual(['agentweb_model_router:target:openrouter/anthropic/claude-sonnet-5.5']);
  });

  it('an unparseable table refuses every tier, even where a stored model may fall back, with one alert', async () => {
    turnOn({ ...TABLE, routes: { chats: ROUTED_CHAT } });
    allowlist(['*']);
    storeSession(baseSession(AW, { llmModelSource: 'user' }));
    for (const tier of ['Free', 'Pro']) {
      ownerTier(tier);
      const res = await turn({}); // stored only: allowSilentSwap
      expect(res.statusCode).toBe(422);
      expect(res.body).toMatchObject({ requestedModel: AW, reason: 'not_served' });
    }
    expect(mockWorker.runInWorker).not.toHaveBeenCalled();
    const routerAlerts = mockAlert.mock.calls.filter(([a]) => a.dedupeKey === ROUTER_UNAVAILABLE_ALERT_DEDUPE_KEY);
    expect(routerAlerts).toHaveLength(1);
    expect(routerAlerts[0][0].message).toContain('unknown task type "chats"');
  });

  it('the pickers offer it only to tiers it is currently valid for', async () => {
    allowlist([AW, ROUTED_SCHEDULED], [{ name: 'Pro', allowedModels: ['*'] }]);
    const options = async () => {
      const res = makeRes();
      await agentModeController.getModelOptions({ user: { userId: OWNER, isAdmin: false } } as any, res);
      return res.body.allModels as string[];
    };
    expect(await options()).not.toContain(AW); // Free: unavailable for its tier
    ownerTier('Pro');
    expect(await options()).toContain(AW);
  });

  it('a failed tier read while the allowlist is OFF alerts about the router, not the allowlist', async () => {
    (getUserSubscriptionResolution as jest.Mock).mockResolvedValue({ subscriptionType: 'Free', resolved: false });
    const res = await turn();
    expect(res.statusCode).toBe(200);
    await new Promise((r) => setImmediate(r));
    const tierAlerts = mockAlert.mock.calls.map(([a]) => a).filter((a) => a.dedupeKey === 'model_tier_allowlist:tier_unreadable');
    expect(tierAlerts).toHaveLength(1);
    expect(tierAlerts[0].subject).toBe('AgentMode: AgentWeb Model router could not read a subscription tier');
    expect(tierAlerts[0].message).not.toMatch(/allowlist/i);
  });

  it('createSession stores the selection (not the routed model) with the routed decision', async () => {
    const res = makeRes();
    await agentModeController.createSession({
      user: { userId: OWNER, isAdmin: false }, body: { portalType: 'agent', llmModel: AW }, headers: {}, on: jest.fn(),
    } as any, res);
    expect(res.statusCode).toBe(201);
    const [, model, decision, source] = mockChatbotDb.updateSessionLlmModel.mock.calls[0];
    expect(model).toBe(AW);
    expect(decision).toMatchObject(ROUTED_DECISION);
    expect(source).toBe('user');
  });

  it('the interactive-share turn runs the routed model and keeps the owner\'s selection', async () => {
    const store = storeSession(baseSession(AW, { llmModelSource: 'user' }));
    const res = makeRes();
    await agentModeController.generateSharedResponse({
      params: { shareId: SESSION_ID }, query: { conversable: 'tok' }, body: { userMessage: 'hi' }, headers: {}, on: jest.fn(),
    } as any, res);
    expect(res.statusCode).toBe(200);
    expect(workerCall().llmModel).toBe(ROUTED_CHAT);
    expect(workerCall().modelRouting).toEqual(STAMP);
    expect(store.get()).toMatchObject({ llmModel: AW, llmModelSource: 'user', llmUsagePolicyDecision: ROUTED_DECISION });
  });

  it('the conversable turn runs the routed model and records the routed decision under the selection', async () => {
    const store = storeSession(baseSession(AW, { llmModelSource: 'user' }));
    const res = makeRes();
    await agentModeController.generateConversableResponse({ body: { userMessage: 'hi' }, conversableSession: store.get(), on: jest.fn() } as any, res);
    expect(workerCall().llmModel).toBe(ROUTED_CHAT);
    expect(workerCall().modelRouting).toEqual(STAMP);
    expect(store.get()).toMatchObject({ llmModel: AW, llmUsagePolicyDecision: ROUTED_DECISION });
  });

  it('verified-generate runs the routed model and persists the selection', async () => {
    const store = storeSession(baseSession(AW, { llmModelSource: 'user' }));
    mockWorker.runInWorker.mockResolvedValue({ content: 'OK', toolCalls: [{ name: 'update_html_file', result: { success: true } }], knowledgeBaseQueries: [], sources: [], responseMessages: [] } as any);
    const res = makeRes();
    await agentModeController.verifiedGenerate({
      user: { userId: OWNER },
      body: { sessionId: SESSION_ID, startingMessage: 'do it', requiredFunctions: [{ functionName: 'update_html_file', minCount: 1 }], keywords: [], attachments: [], maxAttempts: 1 },
      on: jest.fn(),
    } as unknown as Request, res);
    expect(workerCall().llmModel).toBe(ROUTED_CHAT);
    expect(workerCall().modelRouting).toEqual(STAMP);
    expect(mockChatbotDb.updateSessionLlmModel.mock.calls.map((c) => c[1])).toEqual([AW]);
    expect(store.get().llmModel).toBe(AW);
  });

  it('a side channel passing the stored selection is routed before anything is persisted, and the session keeps it', async () => {
    const store = storeSession(baseSession(AW, { llmModelSource: 'user', sessionType: 'scheduled' }));
    await generateSessionResponse(SESSION_ID, 'hi', OWNER, AW);
    expect(workerCall().llmModel).toBe(ROUTED_SCHEDULED);
    expect(workerCall().modelRouting).toEqual({ llmSelected: AW, llmRoutingReason: 'scheduled task: table route', llmRoutingTableVersion: 't1' });
    expect(mockChatbotDb.updateSessionLlmModel).not.toHaveBeenCalled();
    expect(store.get().llmModel).toBe(AW);
  });

  it('a side channel is refused (before saving the user message) when the selection is outside the plan', async () => {
    allowlist([ROUTED_CHAT]);
    storeSession(baseSession(AW, { llmModelSource: 'user' }));
    const error = await generateSessionResponse(SESSION_ID, 'hi', OWNER, AW).catch((e) => e);
    expect(error).toMatchObject({ requestedModel: AW, reason: 'not_in_plan' });
    expect(mockChatbotDb.addMessageToSession).not.toHaveBeenCalled();
    expect(mockWorker.runInWorker).not.toHaveBeenCalled();
  });

  it('only a turn its caller routed is stamped: the session\'s stored routed decision is never read back', async () => {
    // The stored decision describes an earlier routed turn on the SAME model; this turn's caller did not route it.
    storeSession(baseSession(AW, { llmModelSource: 'user', llmUsagePolicyDecision: ROUTED_DECISION }));
    await generateSessionResponse(SESSION_ID, 'hi', OWNER, ROUTED_CHAT);
    expect(workerCall(0).modelRouting).toBeUndefined();
    // ...and a caller decision for another model stamps nothing either.
    await generateSessionResponse(SESSION_ID, 'hi', OWNER, OTHER, undefined, undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, undefined, false, undefined, undefined, undefined, false, undefined, ROUTED_DECISION as any);
    expect(workerCall(1).modelRouting).toBeUndefined();
  });

  it('the picker PATCH stores the selection as the user\'s pick; refuses it with 422 when the router is unavailable', async () => {
    const store = storeSession(baseSession(DEFAULT_MODEL, { llmModelSource: 'system' }));
    const ok = makeRes();
    await agentModeController.updateSessionLlmModel(patchReq(AW), ok);
    expect(ok.statusCode).toBe(200);
    expect(store.get()).toMatchObject({ llmModel: AW, llmModelSource: 'user' });

    turnOn('{not json');
    agentWebModelRouter.reset();
    const refused = makeRes();
    await agentModeController.updateSessionLlmModel(patchReq(AW), refused);
    expect(refused.statusCode).toBe(422);
    expect(refused.body).toMatchObject({ code: 'model_unavailable', requestedModel: AW, reason: 'not_served' });
  });

  it('/model-options offers it right after the default (never index 0: portals pre-select that), never as a schedule backup', async () => {
    const res = makeRes();
    await agentModeController.getModelOptions({ user: { userId: OWNER, isAdmin: false } } as any, res);
    expect(res.body.allModels.slice(0, 2)).toEqual([DEFAULT_MODEL, AW]);
    expect(res.body.selectableModels.slice(0, 2)).toEqual([DEFAULT_MODEL, AW]);
    expect(res.body.scheduleBackupModels).not.toContain(AW);
  });

  it('/public/llm-models carries its catalog entry for a signed-in user (after the default), never for an anonymous read', async () => {
    mockTokenUser.user = { userId: OWNER, isAdmin: false };
    const signedIn = makeRes();
    await agentModeController.getSupportedModels({ headers: {} } as any, signedIn);
    expect(signedIn.body.map((m: any) => m.id).slice(0, 2)).toEqual([DEFAULT_MODEL, AW]);
    expect(signedIn.body[1]).toEqual({ id: AW, name: 'AgentWeb Model', tier: 'medium', description: expect.any(String), provider: 'other' });

    mockTokenUser.user = undefined;
    const anonymous = makeRes();
    await agentModeController.getSupportedModels({ headers: {} } as any, anonymous);
    expect(anonymous.body.map((m: any) => m.id)).not.toContain(AW);
  });

  it('/model-options hides it from a plan that does not include it', async () => {
    allowlist([ROUTED_CHAT]);
    const res = makeRes();
    await agentModeController.getModelOptions({ user: { userId: OWNER, isAdmin: false } } as any, res);
    expect(res.body.allModels).not.toContain(AW);
  });
});

describe('switch ON: Work Plan step models (ENG-2378) with the AgentWeb Model', () => {
  let honor: jest.SpyInstance;
  beforeEach(() => {
    turnOn();
    honor = jest.spyOn(workPlanStepModels, 'shouldHonor').mockResolvedValue(true);
  });
  afterEach(() => honor.mockRestore());

  const plan = (steps: any[], extra: Record<string, unknown> = {}) => ({
    title: 'P', planAuthor: 'user', launchModelSource: 'user', createdAt: 'x', updatedAt: 'x', steps, ...extra,
  });

  it('a step pinned to the AgentWeb Model is accepted at write and launch (stored as the selection); refused with the switch off', async () => {
    const steps = [{ stepCount: 1, title: 'S1', model: AW }];
    await expect(checkPlanStepModelsWrite(async () => false, steps, undefined, OWNER)).resolves.toEqual({ ok: true });
    await expect(resolvePlanStepModelsForLaunch(agentModeService as any, async () => false, steps, OWNER)).resolves.toEqual(new Map([[0, AW]]));

    allowlist([ROUTED_CHAT]);
    modelAccess.reset();
    const refused = await checkPlanStepModelsWrite(async () => false, steps, undefined, OWNER);
    expect(refused).toMatchObject({ ok: false, body: { reason: 'not_in_plan', stepCount: 1 } });

    delete mockSettings[AGENTWEB_MODEL_ROUTER_SETTING];
    agentWebModelRouter.reset();
    const off = await checkPlanStepModelsWrite(async () => false, steps, undefined, OWNER);
    expect(off).toMatchObject({ ok: false, body: { reason: 'not_served', requestedModel: AW, stepCount: 1 } });
  });

  it('a session on a concrete model running a step pinned to the AgentWeb Model: routed, stamped as the selection, no false pick', async () => {
    const store = storeSession(baseSession(OTHER, {
      llmModelSource: 'user',
      workPlan: plan([{ stepCount: 1, title: 'S1', status: 'pending', model: AW, modelSource: 'user' }, { stepCount: 2, title: 'S2', status: 'pending' }], { launchModel: OTHER }),
    }));
    await generateSessionResponse(SESSION_ID, 'go', OWNER, OTHER);
    expect(workerCall(0).llmModel).toBe(ROUTED_CHAT);
    expect(workerCall(0).modelRouting).toEqual(STAMP);
    expect(store.get()).toMatchObject({ llmModel: AW, llmUsagePolicyDecision: ROUTED_DECISION });
    expect(store.get().workPlan.engineModel).toBe(AW);
    expect(store.get().workPlan.pickedModel).toBeUndefined();

    // Next turn: the portal echoes the stored selection. Still the step's own routed model, not a user's pick.
    const res = makeRes();
    await agentModeController.generateResponse(generateReq({ llmModel: AW }), res);
    expect(res.statusCode).toBe(200);
    expect(workerCall(1).llmModel).toBe(ROUTED_CHAT);
    expect(store.get().workPlan.pickedModel).toBeUndefined();
    expect(store.get().workPlan.steps[0]).toMatchObject({ model: AW, modelSource: 'user' });
    expect(store.get().workPlan.engineModel).toBe(AW);
  });

  it('a session on the AgentWeb Model running a plan with CONCRETE step pins: the pin runs, then the router resumes, then the restore', async () => {
    const store = storeSession(baseSession(AW, {
      llmModelSource: 'user',
      workPlan: plan([
        { stepCount: 1, title: 'S1', status: 'pending', model: OTHER, modelSource: 'user' },
        { stepCount: 2, title: 'S2', status: 'pending' },
      ], { launchModel: AW }),
    }));
    // Step 1: its concrete pin runs; nothing claims it was routed.
    await generateSessionResponse(SESSION_ID, 'go', OWNER, AW);
    expect(workerCall(0).llmModel).toBe(OTHER);
    expect(workerCall(0).modelRouting).toBeUndefined();
    expect(store.get().llmModel).toBe(OTHER);
    expect(store.get().workPlan.engineModel).toBe(OTHER);

    // Step 2 has no model: back to the pre-plan selection, routed; the stamp is the selection again.
    const wp = store.get().workPlan;
    store.set({ workPlan: { ...wp, steps: [{ ...wp.steps[0], status: 'completed' }, wp.steps[1]] } });
    await generateSessionResponse(SESSION_ID, 'next', OWNER, OTHER);
    expect(workerCall(1).llmModel).toBe(ROUTED_CHAT);
    expect(workerCall(1).modelRouting).toEqual(STAMP);
    expect(store.get().llmModel).toBe(AW);
    expect(store.get().workPlan.engineModel).toBe(AW);
    expect(store.get().workPlan.pickedModel).toBeUndefined();

    // Plan complete: the pre-plan selection is restored (routed), and the engine marker is cleared.
    const wp2 = store.get().workPlan;
    store.set({ workPlan: { ...wp2, steps: wp2.steps.map((s: any) => ({ ...s, status: 'completed' })) } });
    await generateSessionResponse(SESSION_ID, 'thanks', OWNER, AW);
    expect(workerCall(2).llmModel).toBe(ROUTED_CHAT);
    expect(store.get().llmModel).toBe(AW);
    expect(store.get().workPlan.engineModel).toBeUndefined();
  });

  it('a user\'s pick of the AgentWeb Model on a model-less step is recorded as the selection', async () => {
    const store = storeSession(baseSession(OTHER, {
      llmModelSource: 'user',
      workPlan: plan([
        { stepCount: 1, title: 'S1', status: 'pending' },
        { stepCount: 2, title: 'S2', status: 'pending', model: OTHER, modelSource: 'user' },
      ], { launchModel: OTHER }),
    }));
    await generateSessionResponse(SESSION_ID, 'go', OWNER, OTHER, undefined, undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, undefined, false, undefined, undefined, undefined, false, AW);
    expect(workerCall(0).llmModel).toBe(ROUTED_CHAT);
    expect(store.get().llmModel).toBe(AW);
    expect(store.get().workPlan.pickedModel).toBe(AW);
    expect(store.get().workPlan.engineModel).toBe(OTHER);
  });
});

/* ============ ENG-669 PR-C review round (rv-3677): adapted from the reviewer's probes ============ */
import { filterMessagesForClient } from '../utils/adminOnlyMessageFilter';
import { resolveEffectiveModelForUser } from '../controllers/agentModeController';
import { offersAgentWebModel } from '../services/agentMode/agentWebModelRouterInstance';
import { workPlanService } from '../services/workPlanService';

const ownerTier = (tier: string) => {
  (getUserSubscriptionResolution as jest.Mock).mockResolvedValue({ subscriptionType: tier, resolved: true });
  modelAccess.reset();
};
const shareReq = () => ({ params: { shareId: SESSION_ID }, query: { conversable: 'tok' }, body: { userMessage: 'hi' }, headers: {}, on: jest.fn() } as any);
const rollback = () => { delete mockSettings[AGENTWEB_MODEL_ROUTER_SETTING]; agentWebModelRouter.reset(); };

describe('MAJOR 1: the owner\'s plan never reaches a share viewer through the routing provenance', () => {
  it('a plan-override route is stamped without the tier name, and share / conversable reads strip the routing fields', async () => {
    turnOn({ version: 't1', default: ROUTED_SCHEDULED, tiers: { Enterprise: { routes: { chat: ROUTED_CHAT } } } });
    mockSettings.subscription_types = JSON.stringify([{ name: 'Enterprise' }, { name: 'Free' }]);
    ownerTier('Enterprise');
    const store = storeSession(baseSession(AW, { llmModelSource: 'user', shareMetadata: { isShared: true } }));
    const res = makeRes();
    await agentModeController.generateSharedResponse(shareReq(), res);
    expect(res.statusCode).toBe(200);
    const stamp = workerCall().modelRouting;
    expect(stamp).toEqual({ llmSelected: AW, llmRoutingReason: 'chat task: plan route', llmRoutingTableVersion: 't1' });
    expect(JSON.stringify(stamp)).not.toContain('Enterprise');

    // What the worker persists is then served to viewers: the share read and the conversable read strip it.
    store.set({ messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'OK', llm: ROUTED_CHAT, ...stamp }] });
    const view = makeRes();
    await agentModeController.getSharedConversation({ params: { shareId: SESSION_ID }, query: {} } as any, view);
    expect(view.statusCode).toBe(200);
    // ENG-2645: the read-only page shows no model footer, so its rows carry no model fields at all.
    expect(view.body.session.messages.find((m: any) => m.role === 'assistant')).toEqual({ role: 'assistant', content: 'OK' });
    const conversableView = makeRes();
    await agentModeController.getSharedConversation({ params: { shareId: SESSION_ID }, query: { conversable: 'tok' } } as any, conversableView);
    expect(conversableView.statusCode).toBe(200);
    const served = conversableView.body.session.messages.find((m: any) => m.role === 'assistant');
    expect(served).toMatchObject({ llm: ROUTED_CHAT, content: 'OK' });
    expect(served).not.toHaveProperty('llmSelected');
    expect(served).not.toHaveProperty('llmRoutingReason');
    expect(served).not.toHaveProperty('llmRoutingTableVersion');
  });

  it('the non-owner message filter strips the routing fields; the owner filter keeps them', () => {
    const message = { role: 'assistant', content: 'x', llm: ROUTED_CHAT, ...STAMP };
    expect(filterMessagesForClient([message], { omitBranchOrigin: true })[0]).toEqual({ role: 'assistant', content: 'x', llm: ROUTED_CHAT });
    expect(filterMessagesForClient([message])[0]).toEqual(message);
  });
});

describe('MAJOR 2: a STORED AgentWeb Model selection the router cannot serve is refused visibly on every path', () => {
  const expectRefused = (res: any) => {
    expect(res.statusCode).toBe(422);
    expect(res.body).toEqual({ error: AW_UNAVAILABLE, code: 'model_unavailable', requestedModel: AW, reason: 'not_served', userMessageSaved: false });
  };
  const expectUntouched = (store: { get: () => any }) => {
    expect(mockWorker.runInWorker).not.toHaveBeenCalled();
    expect(mockChatbotDb.updateSessionLlmModel).not.toHaveBeenCalled();
    expect(store.get().llmModel).toBe(AW);
  };
  // Switch off (a rollback), and switch on but the router unavailable for this owner's tier.
  const states: Array<[string, () => void]> = [
    ['the switch is off', () => { turnOn(); rollback(); }],
    ['the router is unavailable for the owner\'s tier', () => { turnOn({ ...TABLE, tiers: { Free: { routes: { chta: ROUTED_CHAT } } } }); mockSettings.subscription_types = JSON.stringify([{ name: 'Free' }]); }],
  ];

  describe.each(states)('when %s', (_label, setUp) => {
    beforeEach(() => setUp());

    it('interactive share turn: 422, never the default, the stored selection kept', async () => {
      const store = storeSession(baseSession(AW, { llmModelSource: 'user' }));
      const res = makeRes();
      await agentModeController.generateSharedResponse(shareReq(), res);
      expectRefused(res);
      expectUntouched(store);
    });

    it('conversable turn: 422', async () => {
      const store = storeSession(baseSession(AW, { llmModelSource: 'user', llmUsagePolicyDecision: ROUTED_DECISION }));
      const res = makeRes();
      await agentModeController.generateConversableResponse({ body: { userMessage: 'hi' }, conversableSession: store.get(), on: jest.fn() } as any, res);
      expectRefused(res);
      expectUntouched(store);
    });

    it('/generate with NO model in the body (MCP/API callers): 422', async () => {
      const store = storeSession(baseSession(AW, { llmModelSource: 'user' }));
      const res = makeRes();
      await agentModeController.generateResponse(generateReq({}), res);
      expectRefused(res);
      expectUntouched(store);
    });

    it('/generate with the portal echo: 422', async () => {
      const store = storeSession(baseSession(AW, { llmModelSource: 'user' }));
      const res = makeRes();
      await agentModeController.generateResponse(generateReq({ llmModel: AW }), res);
      expectRefused(res);
      expectUntouched(store);
    });

    it('verified-generate on the stored selection: 422', async () => {
      const store = storeSession(baseSession(AW, { llmModelSource: 'user' }));
      const res = makeRes();
      await agentModeController.verifiedGenerate({
        user: { userId: OWNER },
        body: { sessionId: SESSION_ID, startingMessage: 'do it', requiredFunctions: [], keywords: [], attachments: [], maxAttempts: 1 },
        on: jest.fn(),
      } as unknown as Request, res);
      expectRefused(res);
      expectUntouched(store);
    });

    it('branch inheriting the selection (the resolver with allowSilentSwap, as chatBranchController calls it): refused, never corrected', async () => {
      const session = baseSession(AW, { llmModelSource: 'user' });
      await expect(resolveEffectiveModelForUser({ userId: OWNER, requestedModel: AW, allowSilentSwap: true, session }))
        .rejects.toMatchObject({ code: 'model_unavailable', requestedModel: AW, reason: 'not_served' });
    });
  });
});

describe('MAJOR 4: a malformed tier override takes down only that tier', () => {
  it.each([
    ['an unknown route key', { Pro: { routes: { chta: ROUTED_SCHEDULED } } }],
    ['an empty default', { Pro: { default: '' } }],
    ['a non-string target', { Pro: { routes: { chat: 5 } } }],
  ])('%s in tiers.Pro: Free still routes, Pro is refused, one alert names Pro', async (_label, tiers) => {
    turnOn({ version: 't1', default: ROUTED_CHAT, tiers });
    mockSettings.subscription_types = JSON.stringify([{ name: 'Free' }, { name: 'Pro' }]);
    ownerTier('Free');
    const free = makeRes();
    await agentModeController.generateResponse(generateReq({ llmModel: AW }), free);
    expect(free.statusCode).toBe(200);
    expect(workerCall().llmModel).toBe(ROUTED_CHAT);

    ownerTier('Pro');
    const pro = makeRes();
    await agentModeController.generateResponse(generateReq({ llmModel: AW }), pro);
    expect(pro.statusCode).toBe(422);
    expect(pro.body).toMatchObject({ requestedModel: AW, reason: 'not_served' });
    const routerAlerts = mockAlert.mock.calls.map(([a]) => a.dedupeKey).filter((k) => String(k).startsWith('agentweb_model_router:'));
    expect(routerAlerts).toEqual(['agentweb_model_router:tier:Pro']);
  });
});

describe('MINOR c: an admin-authored plan\'s router pin is checked against the LAUNCHER\'s tier at launch', () => {
  const plan = { planId: 'p1', title: 'Router plan', visibility: 'system', isBuiltIn: true, defaultModel: AW, steps: [{ stepCount: 1, title: 'S1' }] };
  const launch = async () => {
    const res = makeRes();
    await agentModeController.createSessionWithPlan({ params: { planTitle: 'Router plan' }, body: {}, query: {}, headers: {}, on: jest.fn() } as any, res);
    return res;
  };
  beforeEach(() => {
    turnOn({ ...TABLE, tiers: { Free: { routes: { chta: ROUTED_CHAT } } } }); // the router is unavailable for Free only
    mockSettings.subscription_types = JSON.stringify([{ name: 'Free' }, { name: 'Pro' }]);
    Object.assign(workPlanService as any, {
      getWorkPlansByVisibility: jest.fn(async (visibility: string) => (visibility === 'system' ? [plan] : [])),
      getWorkPlansByOwner: jest.fn(async () => []),
      getWorkPlansByOrg: jest.fn(async () => []),
    });
    mockTokenUser.user = { userId: OWNER, isAdmin: false };
  });
  afterEach(() => { mockTokenUser.user = undefined; });

  it('refused with a visible 422 naming the AgentWeb Model for a launcher whose tier it cannot route; nothing is created', async () => {
    ownerTier('Free');
    const res = await launch();
    expect(res.statusCode).toBe(422);
    expect(res.body).toMatchObject({ code: 'model_unavailable', requestedModel: AW, reason: 'not_served' });
    expect(res.body.error).toContain('(AgentWeb Model)');
    expect(mockChatbotDb.createChatSession).not.toHaveBeenCalled();
  });

  it('launches for a launcher whose tier it routes, storing the selection', async () => {
    ownerTier('Pro');
    const res = await launch();
    expect(mockChatbotDb.createChatSession).toHaveBeenCalled();
    expect(mockChatbotDb.updateSessionLlmModel.mock.calls[0][1]).toBe(AW);
    expect(res.statusCode).not.toBe(422);
  });
});

describe('MINOR e: customer copy names the AgentWeb Model, never the raw id', () => {
  it('a step pinned to the router pauses with the display name when the router is off (no page)', async () => {
    const honor = jest.spyOn(workPlanStepModels, 'shouldHonor').mockResolvedValue(true);
    storeSession(baseSession(OTHER, {
      llmModelSource: 'user',
      workPlan: { title: 'P', planAuthor: 'user', launchModelSource: 'user', launchModel: OTHER, createdAt: 'x', updatedAt: 'x',
        steps: [{ stepCount: 1, title: 'S1', status: 'pending', model: AW, modelSource: 'user' }] },
    }));
    const out = await generateSessionResponse(SESSION_ID, 'go', OWNER, OTHER);
    honor.mockRestore();
    expect(mockWorker.runInWorker).not.toHaveBeenCalled();
    expect(out.content).toContain('Step 1 uses AgentWeb Model, which is unavailable right now.');
    expect(out.content).not.toContain(AW);
    expect(mockAlert.mock.calls.filter(([a]) => String(a.subject).includes('Work Plan paused'))).toHaveLength(0);
  });

  it('a refusal outside the plan names the AgentWeb Model', async () => {
    turnOn();
    allowlist([ROUTED_CHAT]);
    const res = makeRes();
    await agentModeController.generateResponse(generateReq({ llmModel: AW }), res);
    expect(res.statusCode).toBe(422);
    expect(res.body.error).toContain('(AgentWeb Model)');
    expect(res.body.error).not.toContain(AW);
  });
});

describe('admin pickers', () => {
  it('the catalog still offers the AgentWeb Model to an admin (the plan step-model picker routes it); benchmark and default-model pickers drop it client-side and the server refuses it there', async () => {
    turnOn();
    (userDb.getUserById as jest.Mock).mockResolvedValue({ userId: 'admin-1', isAdmin: true });
    expect(await offersAgentWebModel('admin-1')).toBe(true);
  });
});

/* ============ ENG-669 PR-C final review round (rv2-3677) ============ */
import { resumeOriginSession } from '../services/approvalInboxExecution';

const flushImmediates = async (rounds = 30) => { for (let i = 0; i < rounds; i++) await new Promise((r) => setImmediate(r)); };
const DEFERRED_MEDIA = {
  content: 'Two images are still rendering; continuing.',
  toolCalls: [{ name: 'generate_image', result: { deferred: true, reason: 'media_generation_time_budget' } }],
  knowledgeBaseQueries: [], sources: [], responseMessages: [],
};
const DONE = { content: 'Batch complete.', toolCalls: [], knowledgeBaseQueries: [], sources: [], responseMessages: [] };

describe('auto continuations carry the SELECTION and are routed as turns of their own', () => {
  it('a media continuation started by a routed /generate turn is routed again and its reply is stamped', async () => {
    turnOn();
    const store = storeSession(baseSession(AW, { llmModelSource: 'user' }));
    mockWorker.runInWorker.mockResolvedValueOnce(DEFERRED_MEDIA as any).mockResolvedValueOnce(DONE as any);
    const res = makeRes();
    await agentModeController.generateResponse(generateReq({ llmModel: AW }), res);
    expect(res.statusCode).toBe(200);
    await flushImmediates();
    expect(mockWorker.runInWorker).toHaveBeenCalledTimes(2);
    expect(workerCall(1)).toMatchObject({ llmModel: ROUTED_CHAT, modelRouting: STAMP });
    expect(store.get().llmModel).toBe(AW);
  });

  it('a rollback mid-chain stops the continuation VISIBLY: nothing runs on the old routed model, the refusal is saved and pushed', async () => {
    turnOn();
    storeSession(baseSession(AW, { llmModelSource: 'user' }));
    mockWorker.runInWorker.mockImplementationOnce(async () => {
      // The switch goes off while the first turn is running; the continuation that follows must notice.
      delete mockSettings[AGENTWEB_MODEL_ROUTER_SETTING];
      agentWebModelRouter.reset();
      return DEFERRED_MEDIA as any;
    });
    await agentModeController.generateResponse(generateReq({ llmModel: AW }), makeRes());
    await flushImmediates();
    expect(mockWorker.runInWorker).toHaveBeenCalledTimes(1);
    const refusals = mockChatbotDb.addMessageToSession.mock.calls
      .map((c) => c[1] as any)
      .filter((m) => m?.metadata?.isErrorMessage);
    expect(refusals).toEqual([expect.objectContaining({ role: 'assistant', content: AW_UNAVAILABLE })]);
  });

  it('a concrete selection\'s continuation still runs that model, unstamped (unchanged)', async () => {
    storeSession(baseSession(OTHER, { llmModelSource: 'user' }));
    mockWorker.runInWorker.mockResolvedValueOnce(DEFERRED_MEDIA as any).mockResolvedValueOnce(DONE as any);
    await agentModeController.generateResponse(generateReq({ llmModel: OTHER }), makeRes());
    await flushImmediates();
    expect(mockWorker.runInWorker).toHaveBeenCalledTimes(2);
    expect(workerCall(1).llmModel).toBe(OTHER);
    expect(workerCall(1).modelRouting).toBeUndefined();
  });
});

describe('approval-inbox resume on an unservable AgentWeb Model selection', () => {
  const refusalsSaved = () => mockChatbotDb.addMessageToSession.mock.calls
    .map((c) => c[1] as any)
    .filter((m) => m?.metadata?.isErrorMessage);

  it.each([
    ['the switch is off', () => { turnOn(); delete mockSettings[AGENTWEB_MODEL_ROUTER_SETTING]; agentWebModelRouter.reset(); }],
    ['the router is unavailable', () => turnOn('{not json')],
  ])('%s: nothing runs, and the visible refusal is saved (not only a passive note)', async (_label, setUp) => {
    setUp();
    storeSession(baseSession(AW, { llmModelSource: 'user' }));
    (mockChatbotDb as any).getChatSessionRecord.mockResolvedValue(baseSession(AW));
    await resumeOriginSession(SESSION_ID, 'Approved: send the email');
    expect(mockWorker.runInWorker).not.toHaveBeenCalled();
    expect(refusalsSaved()).toEqual([expect.objectContaining({ role: 'assistant', content: AW_UNAVAILABLE })]);
  });

  it('switch-off parity for other models: a retired stored model still gets only the passive note', async () => {
    storeSession(baseSession('retired-model-9', { llmModelSource: 'user' }));
    (mockChatbotDb as any).getChatSessionRecord.mockResolvedValue(baseSession('retired-model-9'));
    await resumeOriginSession(SESSION_ID, 'Approved: send the email');
    expect(refusalsSaved()).toEqual([]);
  });
});

/* ============ ENG-669 PR-C switch-on fixes: /model-options `agentWebModel` ============ */
import { describeAgentWebModelAvailability } from '../services/agentMode/agentWebModelRouterInstance';

describe('/model-options `agentWebModel`: the portal can tell "not offered to this tier" from "switch off"', () => {
  const options = async () => {
    const res = makeRes();
    await agentModeController.getModelOptions({ user: { userId: OWNER, isAdmin: false } } as any, res);
    expect(res.statusCode).toBe(200);
    return res.body;
  };
  const NAME = 'AgentWeb Model';
  const DESCRIPTION = 'AgentWeb picks the model for each task; every reply shows which model ran.';
  /** The /model-options keys on main (before this field); `modelAccess` only while the tier allowlist is on. */
  const MAIN_KEYS = [
    'usageMode', 'canGenerate', 'allModels', 'selectableModels', 'scheduleBackupModels', 'optimizedDefaultModel',
    'usagePolicyVersion', 'chatBranchingEnabled', 'compareSaveAlternatives', 'legacyModelAliases', 'workPlanStepModelsEnabled',
  ];
  /** A plan that routes the table (both route targets) but does not list the AgentWeb Model. */
  const PLAN_WITHOUT_AW = [ROUTED_CHAT, ROUTED_SCHEDULED];
  const sessionTurn = async (source: 'system' | 'user') => {
    storeSession(baseSession(AW, { llmModelSource: source }));
    const res = makeRes();
    await agentModeController.generateResponse(generateReq({}), res);
    return res;
  };

  describe('switch OFF: the field is absent, the response is exactly main\'s, nothing beyond the switch is read', () => {
    it.each([
      ['tier allowlist off', () => undefined, MAIN_KEYS],
      ['tier allowlist on', () => allowlist(PLAN_WITHOUT_AW), [...MAIN_KEYS, 'modelAccess']],
    ])('%s', async (_label, setUp, keys) => {
      setUp();
      const filter = jest.spyOn(modelAccess, 'filterAllowedModels');
      const body = await options();
      expect(Object.keys(body).sort()).toEqual([...keys].sort());
      expect(body).not.toHaveProperty('agentWebModel');
      expect(body.allModels).not.toContain(AW);
      expect(tableReads()).toHaveLength(0);
      expect(filter.mock.calls.some(([, ids]) => ids.includes(AW))).toBe(false);
      expect(await describeAgentWebModelAvailability(OWNER)).toBeNull();
      filter.mockRestore();
    });
  });

  describe('switch ON', () => {
    beforeEach(() => turnOn());

    it('offered: enabled + offered with its name and description, no reason; listed right after the default', async () => {
      const body = await options();
      expect(body.agentWebModel).toEqual({ enabled: true, offered: true, name: NAME, description: DESCRIPTION });
      expect(body.allModels.slice(0, 2)).toEqual([DEFAULT_MODEL, AW]);
    });

    it('the description is the catalog entry\'s (one wording for both lists)', async () => {
      mockTokenUser.user = { userId: OWNER, isAdmin: false };
      const catalog = makeRes();
      await agentModeController.getSupportedModels({ headers: {} } as any, catalog);
      mockTokenUser.user = undefined;
      const entry = catalog.body.find((m: any) => m.id === AW);
      expect((await options()).agentWebModel).toMatchObject({ name: entry.name, description: entry.description });
    });

    it('routable for the tier but not in its plan: not_in_plan, the name still sent, not listed', async () => {
      allowlist(PLAN_WITHOUT_AW);
      const body = await options();
      expect(body.agentWebModel).toEqual({ enabled: true, offered: false, reason: 'not_in_plan', name: NAME, description: DESCRIPTION });
      expect(body.allModels).not.toContain(AW);
      expect(body.selectableModels).not.toContain(AW);
    });

    it.each([
      ['in the plan, but a route target is outside it', [AW, ROUTED_SCHEDULED]],
      ['outside the plan too (the stronger reason wins)', [ROUTED_SCHEDULED]],
    ])('the router cannot route the tier, %s: unavailable_for_tier', async (_label, plan) => {
      allowlist(plan);
      const body = await options();
      expect(body.agentWebModel).toEqual({ enabled: true, offered: false, reason: 'unavailable_for_tier', name: NAME, description: DESCRIPTION });
      expect(body.allModels).not.toContain(AW);
    });

    it('a broken override for the tier with the allowlist OFF: unavailable_for_tier, no modelAccess', async () => {
      turnOn({ ...TABLE, tiers: { Free: { routes: { chta: ROUTED_CHAT } } } });
      mockSettings.subscription_types = JSON.stringify([{ name: 'Free' }]);
      const body = await options();
      expect(body).not.toHaveProperty('modelAccess');
      expect(body.agentWebModel).toEqual({ enabled: true, offered: false, reason: 'unavailable_for_tier', name: NAME, description: DESCRIPTION });
    });

    it('the reason says what runs: not_in_plan = AgentWeb\'s own pin runs and a pick is refused (not_in_plan)', async () => {
      allowlist(PLAN_WITHOUT_AW);
      expect((await options()).agentWebModel.reason).toBe('not_in_plan');
      const system = await sessionTurn('system');
      expect(system.statusCode).toBe(200);
      expect(workerCall().llmModel).toBe(ROUTED_CHAT);
      const pick = await sessionTurn('user');
      expect(pick.statusCode).toBe(422);
      expect(pick.body).toMatchObject({ code: 'model_unavailable', requestedModel: AW, reason: 'not_in_plan' });
    });

    it.each([
      ['a broken override for the tier', () => {
        turnOn({ ...TABLE, tiers: { Free: { routes: { chta: ROUTED_CHAT } } } });
        mockSettings.subscription_types = JSON.stringify([{ name: 'Free' }]);
      }],
      // Free does not list the router, so the table's load-time tier check skips Free; the chat route is outside it.
      ['a plan without the router whose allowlist misses a route', () => allowlist([ROUTED_SCHEDULED])],
    ])('the reason says what runs: unavailable_for_tier (%s) = neither AgentWeb\'s own pin nor a pick runs', async (_label, setUp) => {
      setUp();
      expect((await options()).agentWebModel.reason).toBe('unavailable_for_tier');
      const system = await sessionTurn('system');
      expect(system.statusCode).toBe(422);
      expect(system.body).toMatchObject({ code: 'model_unavailable', requestedModel: AW, reason: 'not_served' });
      // A pick is refused too (outside the plan it is refused as not_in_plan before the route is checked).
      const pick = await sessionTurn('user');
      expect(pick.statusCode).toBe(422);
      expect(pick.body).toMatchObject({ code: 'model_unavailable', requestedModel: AW });
      expect(mockWorker.runInWorker).not.toHaveBeenCalled();
    });

    it('`offered` always equals offersAgentWebModel and whether the lists carry it', async () => {
      const cases: Array<() => void> = [
        () => undefined,
        () => allowlist(PLAN_WITHOUT_AW),
        () => allowlist([AW, ROUTED_SCHEDULED]),
        () => allowlist([AW, ...PLAN_WITHOUT_AW]),
      ];
      for (const setUp of cases) {
        delete mockSettings.model_tier_allowlist_enabled;
        delete mockSettings.subscription_types;
        setUp();
        modelAccess.reset();
        agentWebModelRouter.reset();
        const body = await options();
        const offered = await offersAgentWebModel(OWNER);
        expect(body.agentWebModel.offered).toBe(offered);
        expect(body.allModels.includes(AW)).toBe(offered);
        expect(body.selectableModels.includes(AW)).toBe(offered);
        expect('reason' in body.agentWebModel).toBe(!offered);
      }
    });

    it('never names a tier (only enabled / offered / reason / name / description)', async () => {
      allowlist(PLAN_WITHOUT_AW, [{ name: 'Pro', allowedModels: ['*'] }]);
      const { agentWebModel } = await options();
      expect(Object.keys(agentWebModel).sort()).toEqual(['description', 'enabled', 'name', 'offered', 'reason']);
      expect(JSON.stringify(agentWebModel)).not.toMatch(/Free|Pro/);
    });
  });
});

/* ============ runVerifiedChat's task-type defaults never replace a stored AgentWeb Model selection ============ */
import { runVerifiedChat } from '../controllers/agentModeController';

describe('runVerifiedChat with NO model (Slack, revisions, human-eval): a stored AgentWeb Model selection is kept', () => {
  const REPORT_DEFAULT = 'gemini-3.8-flash';
  const verified = (functionName: string) => runVerifiedChat({
    sessionId: SESSION_ID, userId: OWNER, startingMessage: 'Build the report', keywords: [],
    requiredFunctions: [{ functionName, minCount: 1 }], maxAttempts: 1, attachments: [],
  } as any);
  const workerReturns = (toolName: string) => mockWorker.runInWorker.mockResolvedValue({
    content: 'Done', toolCalls: [{ name: toolName, result: { success: true } }], knowledgeBaseQueries: [], sources: [], responseMessages: [],
  } as any);
  const writtenModels = () => mockChatbotDb.updateSessionLlmModel.mock.calls.map((c) => c[1]);

  it.each([
    ['update_html_file', 'report'],
    ['generate_image', 'image'],
  ])('switch on, %s: the selection stays, it is routed on the %s route, the replies are stamped', async (tool, taskType) => {
    turnOn({ ...TABLE, routes: { scheduled: ROUTED_SCHEDULED, [taskType]: ROUTED_SCHEDULED } });
    const store = storeSession(baseSession(AW, { llmModelSource: 'user' }));
    workerReturns(tool);
    await verified(tool);
    expect(writtenModels()).not.toContain(REPORT_DEFAULT);
    expect(store.get()).toMatchObject({ llmModel: AW, llmModelSource: 'user' });
    expect(workerCall().llmModel).toBe(ROUTED_SCHEDULED);
    expect(workerCall().modelRouting).toMatchObject({ llmSelected: AW, llmRoutingTableVersion: 't1' });
    expect(workerCall().modelRouting.llmRoutingReason).toContain(taskType);
  });

  /** The refusals runVerifiedChat saved to the chat (error messages). */
  const savedRefusals = () => mockChatbotDb.addMessageToSession.mock.calls
    .map(([, message]) => message as any)
    .filter((message) => message?.metadata?.isErrorMessage === true);

  // rv-3681: refused, never swapped, and the refusal is saved to the chat (once) so the owner sees why; the headless
  // callers present the rethrown error (revisionService / humanEvalActionService / slack tests).
  it.each([
    ['after a rollback (switch off)', 'update_html_file', () => undefined, 'not_served', AW_UNAVAILABLE],
    ['after a rollback (switch off)', 'generate_image', () => undefined, 'not_served', AW_UNAVAILABLE],
    ['with the router unavailable for the tier', 'generate_image', () => {
      turnOn({ ...TABLE, routes: { image: ROUTED_SCHEDULED } });
      allowlist([AW, ROUTED_CHAT]);
    }, 'not_served', AW_UNAVAILABLE],
    ['with the user\'s own pick outside the plan', 'generate_image', () => {
      turnOn();
      allowlist([ROUTED_CHAT, ROUTED_SCHEDULED]);
    }, 'not_in_plan', 'The model you selected (AgentWeb Model) isn\'t included in your plan'],
  ])('%s, %s: refused visibly, the refusal saved to the chat once, the selection kept, nothing run', async (_label, tool, setUp, reason, sentence) => {
    setUp();
    const store = storeSession(baseSession(AW, { llmModelSource: 'user' }));
    workerReturns(tool);
    const error = await verified(tool).then(() => null, (e) => e);
    expect(error).toMatchObject({ code: 'model_unavailable', requestedModel: AW, reason });
    expect(writtenModels()).not.toContain(REPORT_DEFAULT);
    expect(store.get()).toMatchObject({ llmModel: AW, llmModelSource: 'user' });
    expect(mockWorker.runInWorker).not.toHaveBeenCalled();
    const refusals = savedRefusals();
    expect(refusals).toHaveLength(1);
    expect(refusals[0]).toMatchObject({ role: 'assistant' });
    expect(refusals[0].content).toContain(sentence);
    expect(refusals[0].content).not.toContain(AW);
  });

  it('a non-model failure is not saved as a refusal (unchanged)', async () => {
    turnOn();
    storeSession(baseSession(AW, { llmModelSource: 'user' }));
    mockWorker.runInWorker.mockRejectedValue(new Error('LLM provider exploded'));
    const error = await verified('update_html_file').then(() => null, (e) => e);
    expect(error?.message).toContain('LLM provider exploded');
    expect(savedRefusals()).toHaveLength(0);
  });

  it('non-router parity: a stored concrete model is still replaced by the task-type default, as before', async () => {
    turnOn();
    storeSession(baseSession(OTHER, { llmModelSource: 'user' }));
    workerReturns('update_html_file');
    await verified('update_html_file');
    expect(writtenModels()).toEqual([REPORT_DEFAULT]);
    expect(mockChatbotDb.updateSessionLlmModel.mock.calls[0][3]).toBe('system');
    expect(workerCall().llmModel).toBe(REPORT_DEFAULT);
  });
});
