/**
 * ENG-2378: the engine side of per-step models.
 *
 * At each turn start (generateSessionResponse) and each automatic continuation round
 * (scheduleAutoWorkPlanContinuation) the plan's CURRENT pending step may demand its own model:
 *   - step.model beats the request's llmModel AND the session's stored llmModel for that turn, and the session's
 *     llmModel is updated to it so the UI shows the truth;
 *   - a step without a model, a session without a plan, or the switch being off => today's behaviour;
 *   - a step model that became unavailable MID-PLAN pauses the plan with a visible message and an oncall alert.
 *     Nothing is ever sent to a different model.
 */
import { Request, Response } from 'express';

jest.mock('../services/chatbotService', () => ({
  chatbotDb: {
    getChatSession: jest.fn(),
    getChatSessionRecord: jest.fn(),
    getMostRecentRealUserMessage: jest.fn(),
    updateSessionLlmModel: jest.fn(),
    updateSessionWorkPlan: jest.fn(),
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
  generateMarketingResponseWorkerService: { runInWorker: jest.fn(), cancelSession: jest.fn() },
}));

jest.mock('../services/agentModeService', () => ({
  agentModeService: {
    default_model: 'gpt-5-chat-2',
    getDefaultModel: jest.fn().mockResolvedValue('gpt-5-chat-2'),
    getSupportedModels: jest.fn(async () => ['gpt-5-chat-2', 'gemini-3.5-flash', 'gpt-5.5', 'claude-step-model']),
    resolveGenerationModel: jest.fn((model: string) => {
      const registry = new Set(['gpt-5-chat-2', 'gemini-3.5-flash', 'gpt-5.5', 'claude-step-model', 'internal-judge-1']);
      return registry.has(model)
        ? { model, fellBack: false, requestedModel: model }
        : { model: 'gpt-5-chat-2', fellBack: true, requestedModel: model };
    }),
    isLiveModel: jest.fn(() => false),
    isModelSelectableBy: jest.fn(() => true),
    getModelDisplayName: jest.fn((id: string) => (id === 'retired-named-1' ? 'Retired Named' : undefined)),
    generateSessionTitle: jest.fn().mockResolvedValue('Test Title'),
    getMarketingSystemPrompt: jest.fn().mockResolvedValue('System prompt'),
    generateDiagnosticMessage: jest.fn().mockResolvedValue(null),
    getSkillsForDisplay: jest.fn().mockResolvedValue([]),
    callLLM: jest.fn(),
  },
  AgentModeService: jest.fn(),
}));

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
let mockSwitch = true;
let mockSwitchReads = 0;
let mockUnknown = false;
jest.mock('../services/agentMode/workPlanStepModelsInstance', () => ({
  workPlanStepModels: {
    isEnabled: jest.fn(async () => { mockSwitchReads += 1; return mockSwitch; }),
    shouldHonor: jest.fn(async () => { mockSwitchReads += 1; return mockSwitch || mockUnknown; }),
  },
}));
const mockIoEmit = jest.fn();
const mockIoTo = jest.fn().mockReturnValue({ emit: mockIoEmit });
jest.mock('../server', () => ({ io: { to: mockIoTo } }));

import { agentModeController, activeSessionGenerations, autoContinuationSessions, generateSessionResponse } from '../controllers/agentModeController';
import { chatbotDb } from '../services/chatbotService';
import { userDb } from '../services/db';
import { generateMarketingResponseWorkerService } from '../services/generateMarketingResponseWorkerService';
import { getEffectiveLlmUsagePolicy } from '../services/llmUsagePolicyResolverService';
import { checkTokenUsage } from '../services/tokenUsageService';
import { sendAgentModeOncallAlert } from '../utils/agentModeAlerts';

const db = chatbotDb as jest.Mocked<typeof chatbotDb>;
const worker = generateMarketingResponseWorkerService as jest.Mocked<typeof generateMarketingResponseWorkerService>;
const mockPolicy = getEffectiveLlmUsagePolicy as jest.Mock;
const mockUsage = checkTokenUsage as jest.Mock;
const mockAlert = sendAgentModeOncallAlert as jest.Mock;

const OWNER = 'user-owner';
const SESSION_ID = 'session-1';
const FULL_CHOICE = { usageMode: 'full_choice', admissionAllowed: true, reason: 'policy_not_enforced' };
const RETIRED = 'retired-model-9';

const step = (n: number, status: string, model?: string) => ({ stepCount: n, title: `Step ${n}`, status, ...(model !== undefined && { model }) });
const makeSession = (workPlan: any, llmModel = 'gemini-3.5-flash', messages: any[] = []) => ({
  sessionId: SESSION_ID, userId: OWNER, sessionType: 'regular', title: 'Chat', messages,
  createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z', portalType: 'agent' as const,
  pageIdentifier: 'agent-mode', llmModel, ...(workPlan !== undefined && { workPlan }),
});

const generateReq = (llmModel = 'gemini-3.5-flash') => ({
  user: { userId: OWNER, isAdmin: false },
  body: { sessionId: SESSION_ID, userMessage: 'go', attachments: [], llmModel },
  method: 'POST', path: '/api/agent-mode/generate', ip: '127.0.0.1',
  socket: { remoteAddress: '127.0.0.1' }, on: jest.fn(),
} as unknown as Request);
const makeRes = () => {
  const res: any = { statusCode: 200, body: undefined };
  res.status = jest.fn((c: number) => { res.statusCode = c; return res; });
  res.json = jest.fn((b: any) => { res.body = b; return res; });
  return res as Response & { statusCode: number; body: any };
};
const workerResult = (content = 'OK', toolCalls: any[] = []) => ({
  content, toolCalls, knowledgeBaseQueries: [], sources: [],
  responseMessages: [{ role: 'assistant', content, timestamp: 't', metadata: { timestamp: 't' } }],
  cancelled: false, persistedResponseCount: 0,
});
const flush = async (n = 20) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };
const workerModels = () => worker.runInWorker.mock.calls.map((c) => (c[0] as any).llmModel);

beforeEach(() => {
  jest.clearAllMocks();
  activeSessionGenerations.clear();
  autoContinuationSessions.clear();
  mockSwitch = true;
  mockUnknown = false;
  mockSwitchReads = 0;
  mockPolicy.mockResolvedValue({ billingUserId: OWNER, policy: null, costUsedMicroUsd: 0, tokenUsed: 0, mode: FULL_CHOICE });
  mockUsage.mockResolvedValue({ allowed: true, warning: false, used: 0, allowance: null, bonus: 0, effectiveAllowance: null, percentUsed: 0, month: '2026-10' });
  (userDb.getUserById as jest.Mock).mockResolvedValue({ userId: OWNER, isAdmin: false });
  db.getChatSession.mockResolvedValue(makeSession(undefined) as any);
  db.getChatSessionRecord.mockResolvedValue(makeSession(undefined) as any);
  (db as any).getMessagesFromMessagesTable.mockResolvedValue([]);
  (db as any).getMostRecentRealUserMessage.mockResolvedValue(null);
  db.addMessageToSession.mockResolvedValue(makeSession(undefined) as any);
  db.addMessagesToSession.mockResolvedValue(undefined as any);
  db.updateSessionTitle.mockResolvedValue(undefined as any);
  db.updateSessionLlmModel.mockResolvedValue(makeSession(undefined) as any);
  db.updateSessionWorkPlan.mockResolvedValue(makeSession(undefined) as any);
  worker.runInWorker.mockResolvedValue(workerResult() as any);
});

describe('interactive turn: the pending step\'s model wins', () => {
  it('step.model beats the request llmModel and the session llmModel; the session model is updated to it', async () => {
    db.getChatSession.mockResolvedValue(makeSession({ steps: [step(1, 'pending', 'gpt-5.5')] }, 'gemini-3.5-flash') as any);
    const res = makeRes();
    await agentModeController.generateResponse(generateReq('gemini-3.5-flash'), res);
    expect(res.statusCode).toBe(200);
    expect(workerModels()).toEqual(['gpt-5.5']);
    // /generate first stored the request model, then the engine corrected it to the step's model: the last write is the truth
    const writes = db.updateSessionLlmModel.mock.calls;
    expect(writes[writes.length - 1][1]).toBe('gpt-5.5');
    expect(writes[writes.length - 1][2]).toMatchObject({ effectiveModel: 'gpt-5.5', modelSelection: 'honored' });
  });

  it('the step in effect is the FIRST step that is not completed/skipped (earlier steps without a model do not matter)', async () => {
    db.getChatSession.mockResolvedValue(makeSession({
      steps: [step(1, 'completed', 'gpt-5.5'), step(2, 'skipped', RETIRED), step(3, 'pending', 'claude-step-model'), step(4, 'pending', 'gpt-5.5')],
    }) as any);
    await agentModeController.generateResponse(generateReq(), makeRes());
    expect(workerModels()).toEqual(['claude-step-model']);
  });

  it('a step WITHOUT a model leaves the request model alone (no step model of a LATER step leaks in)', async () => {
    db.getChatSession.mockResolvedValue(makeSession({ steps: [step(1, 'pending'), step(2, 'pending', 'gpt-5.5')] }) as any);
    await agentModeController.generateResponse(generateReq('gemini-3.5-flash'), makeRes());
    expect(workerModels()).toEqual(['gemini-3.5-flash']);
  });

  it('a session without a work plan, and a plan whose steps are all done, are unaffected', async () => {
    await agentModeController.generateResponse(generateReq('gemini-3.5-flash'), makeRes());
    db.getChatSession.mockResolvedValue(makeSession({ steps: [step(1, 'completed', 'gpt-5.5')] }) as any);
    await agentModeController.generateResponse(generateReq('gemini-3.5-flash'), makeRes());
    expect(workerModels()).toEqual(['gemini-3.5-flash', 'gemini-3.5-flash']);
  });

  it('switch OFF: the step model is ignored entirely (even a retired one) and the request model runs', async () => {
    mockSwitch = false;
    db.getChatSession.mockResolvedValue(makeSession({ steps: [step(1, 'pending', RETIRED)] }) as any);
    const res = makeRes();
    await agentModeController.generateResponse(generateReq('gemini-3.5-flash'), res);
    expect(res.statusCode).toBe(200);
    expect(workerModels()).toEqual(['gemini-3.5-flash']);
    expect(mockAlert).not.toHaveBeenCalled();
  });

  it('a step model already equal to the session model causes no redundant model write beyond /generate\'s own', async () => {
    db.getChatSession.mockResolvedValue(makeSession({ steps: [step(1, 'pending', 'gpt-5.5')] }, 'gpt-5.5') as any);
    await agentModeController.generateResponse(generateReq('gpt-5.5'), makeRes());
    expect(workerModels()).toEqual(['gpt-5.5']);
    expect(db.updateSessionLlmModel).toHaveBeenCalledTimes(1);
  });
});

describe('mid-plan retirement: pause, never swap', () => {
  const pausedSession = (messages: any[] = []) =>
    makeSession({ steps: [step(1, 'completed', 'gpt-5.5'), step(2, 'pending', RETIRED)] }, 'gemini-3.5-flash', messages);

  it('does not call the worker, answers with the pause message, persists it as an assistant message, alerts oncall', async () => {
    db.getChatSession.mockResolvedValue(pausedSession() as any);
    const res = makeRes();
    await agentModeController.generateResponse(generateReq(), res);

    expect(worker.runInWorker).not.toHaveBeenCalled(); // no LLM call on ANY model
    expect(res.statusCode).toBe(200);
    expect(res.body.content).toBe(
      `Step 2 uses ${RETIRED}, which is no longer available. Choose another model in the model picker and send again to resume this step. The plan is paused and nothing was sent to a different model.`,
    );
    const assistantWrites = db.addMessageToSession.mock.calls.filter((c) => (c[1] as any).role === 'assistant');
    expect(assistantWrites).toHaveLength(1);
    expect(assistantWrites[0][1]).toMatchObject({
      content: expect.stringContaining('Step 2 uses'),
      metadata: expect.objectContaining({ kind: 'work-plan-step-model-unavailable', stepCount: 2, model: RETIRED }),
    });
    expect(mockAlert).toHaveBeenCalledTimes(1);
    expect(mockAlert.mock.calls[0][0]).toMatchObject({
      sessionId: SESSION_ID,
      dedupeKey: `work_plan_step_model_unavailable:${SESSION_ID}:2:${RETIRED}`,
    });
    expect(mockAlert.mock.calls[0][0].message).toContain('step 2');
    // the plan itself is untouched and no model swap was written to the session
    expect(db.updateSessionLlmModel.mock.calls.every((c) => c[1] !== 'gpt-5-chat-2')).toBe(true);
  });

  it('uses the registry display name when there is one', async () => {
    db.getChatSession.mockResolvedValue(makeSession({ steps: [step(1, 'pending', 'retired-named-1')] }) as any);
    const res = makeRes();
    await agentModeController.generateResponse(generateReq(), res);
    expect(res.body.content).toContain('Step 1 uses Retired Named, which is no longer available.');
    expect(worker.runInWorker).not.toHaveBeenCalled();
  });

  it('a model that is still registered but no longer SELECTABLE (e.g. internal-only) also pauses', async () => {
    db.getChatSession.mockResolvedValue(makeSession({ steps: [step(1, 'pending', 'internal-judge-1')] }) as any);
    const res = makeRes();
    await agentModeController.generateResponse(generateReq(), res);
    expect(worker.runInWorker).not.toHaveBeenCalled();
    expect(res.body.content).toContain('Step 1 uses internal-judge-1, which is no longer available');
  });

  it('is idempotent per step+model: a pause message already at the tail is not duplicated and does not re-alert (continuation chain safety)', async () => {
    const tail = { role: 'assistant', content: 'Step 2 uses X', metadata: { kind: 'work-plan-step-model-unavailable', stepCount: 2, model: RETIRED } };
    db.getChatSession.mockResolvedValue(pausedSession([tail]) as any);
    await agentModeController.generateResponse(generateReq(), makeRes());
    // the user's own message is saved, but no second pause message / alert
    expect(db.addMessageToSession.mock.calls.filter((c) => (c[1] as any).role === 'assistant')).toHaveLength(0);
    expect(mockAlert).not.toHaveBeenCalled();
  });

  it('picking another model for the step (editing the plan\'s session step) resumes on that model', async () => {
    db.getChatSession.mockResolvedValue(makeSession({ steps: [step(1, 'completed', 'gpt-5.5'), step(2, 'pending', 'claude-step-model')] }) as any);
    await agentModeController.generateResponse(generateReq(), makeRes());
    expect(workerModels()).toEqual(['claude-step-model']);
    expect(mockAlert).not.toHaveBeenCalled();
  });

  it('generateSessionResponse (non-HTTP entry points: Slack, MCP, scheduled) pauses identically and returns the shaped result', async () => {
    db.getChatSession.mockResolvedValue(pausedSession() as any);
    const result = await generateSessionResponse(SESSION_ID, 'go', OWNER, 'gemini-3.5-flash');
    expect(worker.runInWorker).not.toHaveBeenCalled();
    expect(result).toMatchObject({ toolCalls: [], sources: [], knowledgeBaseQueries: [], skills: [] });
    expect(result.content).toContain('Step 2 uses');
    expect(result.responseMessages[0]).toMatchObject({ role: 'assistant', metadata: expect.objectContaining({ stepCount: 2 }) });
  });

  it('an unexpected failure resolving the step model is NOT swallowed into a swap: the turn fails', async () => {
    mockPolicy.mockRejectedValue(new Error('policy store down'));
    db.getChatSession.mockResolvedValue(makeSession({ steps: [step(1, 'pending', 'gpt-5.5')] }) as any);
    await expect(generateSessionResponse(SESSION_ID, 'go', OWNER, 'gemini-3.5-flash')).rejects.toThrow('policy store down');
    expect(worker.runInWorker).not.toHaveBeenCalled();
  });
});

describe('automatic work-plan continuation', () => {
  const planWith = (steps: any[]) => ({ planId: 'p', autocomplete: true, steps });
  const stall = (workPlan: any) => {
    db.getChatSession.mockResolvedValue(makeSession(workPlan) as any);
    db.getChatSessionRecord.mockResolvedValue(makeSession(workPlan) as any);
  };

  it('each continuation round runs on the CURRENT pending step\'s model, even though the original request used another', async () => {
    stall(planWith([step(1, 'pending', 'gpt-5.5'), step(2, 'pending', 'claude-step-model')]));
    worker.runInWorker
      .mockResolvedValueOnce(workerResult('thinking', []) as any) // turn 1: no tool calls, step 1 still pending => stall
      .mockImplementationOnce(async () => {
        // round 1 completes step 1; the next pending step has a different model
        stall(planWith([step(1, 'completed', 'gpt-5.5'), step(2, 'pending', 'claude-step-model')]));
        return workerResult('step 1 done', []) as any;
      })
      .mockImplementationOnce(async () => {
        stall(planWith([step(1, 'completed', 'gpt-5.5'), step(2, 'completed', 'claude-step-model')]));
        return workerResult('all done', []) as any;
      });
    await agentModeController.generateResponse(generateReq('gemini-3.5-flash'), makeRes());
    await flush();
    expect(workerModels()).toEqual(['gpt-5.5', 'gpt-5.5', 'claude-step-model']);
  });

  it('a step model retired between rounds PAUSES the chain: no further generation, one visible message (live-emitted), one alert', async () => {
    stall(planWith([step(1, 'pending', 'gpt-5.5')]));
    worker.runInWorker.mockImplementationOnce(async () => {
      // turn 1 finishes step 1 but stalls overall; step 2's model is gone
      stall(planWith([step(1, 'completed', 'gpt-5.5'), step(2, 'pending', RETIRED)]));
      return workerResult('step 1 done', []) as any;
    });
    await agentModeController.generateResponse(generateReq(), makeRes());
    await flush();

    expect(worker.runInWorker).toHaveBeenCalledTimes(1); // the continuation round never reached a model
    expect(db.addMessageToSession.mock.calls.filter((c) => (c[1] as any).metadata?.kind === 'work-plan-step-model-unavailable')).toHaveLength(1);
    expect(mockIoEmit).toHaveBeenCalledWith('session-message-appended', expect.objectContaining({
      sessionId: SESSION_ID,
      message: expect.objectContaining({ content: expect.stringContaining('Step 2 uses') }),
    }));
    expect(mockAlert).toHaveBeenCalledTimes(1);
    // the pre-fire check stops the round BEFORE it persists its hidden directive turn
    expect(db.addMessageToSession.mock.calls.some((c) => (c[1] as any).metadata?.kind === 'auto-continuation')).toBe(false);
    expect(activeSessionGenerations.has(SESSION_ID)).toBe(false);
    expect(autoContinuationSessions.has(SESSION_ID)).toBe(false);
  });

  it('a continuation whose step model cannot be resolved for an unexpected reason stops (fails closed) instead of running on another model', async () => {
    stall(planWith([step(1, 'pending', 'gpt-5.5')]));
    worker.runInWorker.mockImplementationOnce(async () => {
      mockPolicy.mockRejectedValue(new Error('policy store down'));
      return workerResult('thinking', []) as any;
    });
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    await agentModeController.generateResponse(generateReq(), makeRes());
    await flush();
    expect(worker.runInWorker).toHaveBeenCalledTimes(1);
    expect(activeSessionGenerations.has(SESSION_ID)).toBe(false);
    expect(autoContinuationSessions.has(SESSION_ID)).toBe(false);
    errSpy.mockRestore();
  });

  it('switch OFF: continuation behaves exactly as before (request model, no step-model lookups)', async () => {
    mockSwitch = false;
    stall(planWith([step(1, 'pending', 'gpt-5.5')]));
    worker.runInWorker
      .mockResolvedValueOnce(workerResult('thinking', []) as any)
      .mockImplementationOnce(async () => {
        stall(planWith([step(1, 'completed', 'gpt-5.5')]));
        return workerResult('done', []) as any;
      });
    await agentModeController.generateResponse(generateReq('gemini-3.5-flash'), makeRes());
    await flush();
    expect(workerModels()).toEqual(['gemini-3.5-flash', 'gemini-3.5-flash']);
  });
});

// ---- ENG-2378 review fixes ------------------------------------------------------------------------------------

describe('an explicit model pick resumes a paused step (finding 2)', () => {
  const plan = (extra: any = {}) => ({ steps: [step(1, 'completed', 'gpt-5.5'), step(2, 'pending', RETIRED)], ...extra });

  it('a request model that differs from the stored stamp overrides the UNAVAILABLE step model: the turn runs on it, the step is updated, the session stamped', async () => {
    db.getChatSession.mockResolvedValue(makeSession(plan(), 'gemini-3.5-flash') as any);
    const res = makeRes();
    await agentModeController.generateResponse(generateReq('claude-step-model'), res);
    expect(res.statusCode).toBe(200);
    expect(workerModels()).toEqual(['claude-step-model']);
    const written = db.updateSessionWorkPlan.mock.calls.map((c) => c[1] as any);
    expect(written[written.length - 1].steps[1].model).toBe('claude-step-model');
    expect(written[written.length - 1].steps[0].model).toBe('gpt-5.5'); // finished step untouched
    const stamps = db.updateSessionLlmModel.mock.calls;
    expect(stamps[stamps.length - 1][1]).toBe('claude-step-model');
    expect(mockAlert).not.toHaveBeenCalled();
    expect(db.addMessageToSession.mock.calls.some((c) => (c[1] as any).metadata?.kind === 'work-plan-step-model-unavailable')).toBe(false);
  });

  it('no explicit pick (the request just echoes the stored stamp): still paused, and the message says how to resume', async () => {
    db.getChatSession.mockResolvedValue(makeSession(plan(), 'gemini-3.5-flash') as any);
    const res = makeRes();
    await agentModeController.generateResponse(generateReq('gemini-3.5-flash'), res);
    expect(worker.runInWorker).not.toHaveBeenCalled();
    expect(res.body.content).toContain('Choose another model in the model picker and send again');
    expect(db.updateSessionWorkPlan).not.toHaveBeenCalled();
  });

  it('an explicit pick that is itself unavailable is a 422 and nothing runs or is written', async () => {
    db.getChatSession.mockResolvedValue(makeSession(plan(), 'gemini-3.5-flash') as any);
    const res = makeRes();
    await agentModeController.generateResponse(generateReq('another-retired-9'), res);
    expect(res.statusCode).toBe(422);
    expect(res.body).toMatchObject({ code: 'model_unavailable' });
    expect(worker.runInWorker).not.toHaveBeenCalled();
    expect(db.updateSessionWorkPlan).not.toHaveBeenCalled();
  });

  it('an AVAILABLE step model still wins over an explicit pick (the picker cannot override a working step)', async () => {
    db.getChatSession.mockResolvedValue(makeSession({ steps: [step(1, 'pending', 'gpt-5.5')] }, 'gpt-5.5') as any);
    await agentModeController.generateResponse(generateReq('claude-step-model'), makeRes());
    expect(workerModels()).toEqual(['gpt-5.5']);
    expect(db.updateSessionWorkPlan.mock.calls.every((c) => (c[1] as any).steps[0].model === 'gpt-5.5')).toBe(true);
  });
});

describe('a step WITHOUT a model: plan default, then the pre-plan model (finding 3)', () => {
  const twoStep = (extra: any = {}) => ({ steps: [step(1, 'completed', 'gpt-5.5'), step(2, 'pending')], ...extra });

  it('interactive: step 2 (no model) does NOT inherit step 1\'s model; plan defaultModel wins over launchModel', async () => {
    db.getChatSession.mockResolvedValue(makeSession(twoStep({ planDefaultModel: 'gemini-3.5-flash', launchModel: 'gpt-5-chat-2' }), 'gpt-5.5') as any);
    await agentModeController.generateResponse(generateReq('gpt-5.5'), makeRes()); // the portal echoes the stamp
    expect(workerModels()).toEqual(['gemini-3.5-flash']);
    const stamps = db.updateSessionLlmModel.mock.calls;
    expect(stamps[stamps.length - 1][1]).toBe('gemini-3.5-flash');
  });

  it('falls back to launchModel (the model the session had before the plan) when the plan has no default', async () => {
    db.getChatSession.mockResolvedValue(makeSession(twoStep({ launchModel: 'gpt-5-chat-2' }), 'gpt-5.5') as any);
    await agentModeController.generateResponse(generateReq('gpt-5.5'), makeRes());
    expect(workerModels()).toEqual(['gpt-5-chat-2']);
  });

  it('a plan that never recorded either (legacy / pre-fix session) keeps today\'s behaviour: the request model', async () => {
    db.getChatSession.mockResolvedValue(makeSession(twoStep(), 'gpt-5.5') as any);
    await agentModeController.generateResponse(generateReq('gpt-5.5'), makeRes());
    expect(workerModels()).toEqual(['gpt-5.5']);
  });

  it('an explicit pick (differs from the stamp) on a model-less step wins', async () => {
    db.getChatSession.mockResolvedValue(makeSession(twoStep({ planDefaultModel: 'gemini-3.5-flash' }), 'gpt-5.5') as any);
    await agentModeController.generateResponse(generateReq('claude-step-model'), makeRes());
    expect(workerModels()).toEqual(['claude-step-model']);
  });

  it('a plan with no step models at all is untouched even if it carries launch fields', async () => {
    db.getChatSession.mockResolvedValue(makeSession({ steps: [step(1, 'pending')], planDefaultModel: 'gemini-3.5-flash' }, 'gpt-5.5') as any);
    await agentModeController.generateResponse(generateReq('gpt-5.5'), makeRes());
    expect(workerModels()).toEqual(['gpt-5.5']);
    expect(mockSwitchReads).toBe(0);
  });

  it('continuation: a model-less next step runs on the fallback, not on the original request model nor the previous step\'s', async () => {
    const stall = (wp: any) => { db.getChatSession.mockResolvedValue(makeSession(wp, 'gpt-5.5') as any); db.getChatSessionRecord.mockResolvedValue(makeSession(wp, 'gpt-5.5') as any); };
    const wp = (steps: any[]) => ({ autocomplete: true, launchModel: 'gpt-5-chat-2', steps });
    stall(wp([step(1, 'pending', 'gpt-5.5'), step(2, 'pending')]));
    worker.runInWorker
      .mockImplementationOnce(async () => { stall(wp([step(1, 'completed', 'gpt-5.5'), step(2, 'pending')])); return workerResult('s1 done', []) as any; })
      .mockImplementationOnce(async () => { stall(wp([step(1, 'completed', 'gpt-5.5'), step(2, 'completed')])); return workerResult('done', []) as any; });
    await agentModeController.generateResponse(generateReq('gemini-3.5-flash'), makeRes());
    await flush();
    expect(workerModels()).toEqual(['gpt-5.5', 'gpt-5-chat-2']);
    const stamps = db.updateSessionLlmModel.mock.calls.map((c) => c[1]);
    expect(stamps[stamps.length - 1]).toBe('gpt-5-chat-2'); // the stamp is exactly what ran
  });
});

describe('end of plan: the pre-plan model is restored unless the user picked one (finding 5)', () => {
  const done = (extra: any = {}) => ({ steps: [step(1, 'completed', 'gpt-5.5')], launchModel: 'gemini-3.5-flash', engineModel: 'gpt-5.5', ...extra });

  it('restores launchModel on the next turn, stamps it, and clears the marker', async () => {
    db.getChatSession.mockResolvedValue(makeSession(done(), 'gpt-5.5') as any);
    await agentModeController.generateResponse(generateReq('gpt-5.5'), makeRes());
    expect(workerModels()).toEqual(['gemini-3.5-flash']);
    const stamps = db.updateSessionLlmModel.mock.calls;
    expect(stamps[stamps.length - 1][1]).toBe('gemini-3.5-flash');
    const written = db.updateSessionWorkPlan.mock.calls.map((c) => c[1] as any);
    expect(written[written.length - 1].engineModel).toBeUndefined();
  });

  it('an explicit pick during the plan wins: the stamp no longer equals the engine\'s model, so nothing is restored', async () => {
    db.getChatSession.mockResolvedValue(makeSession(done(), 'claude-step-model') as any);
    await agentModeController.generateResponse(generateReq('claude-step-model'), makeRes());
    expect(workerModels()).toEqual(['claude-step-model']);
  });

  it('an explicit pick in the request itself wins too', async () => {
    db.getChatSession.mockResolvedValue(makeSession(done(), 'gpt-5.5') as any);
    await agentModeController.generateResponse(generateReq('claude-step-model'), makeRes());
    expect(workerModels()).toEqual(['claude-step-model']);
  });

  it('runs once: after the marker is cleared nothing is restored again', async () => {
    db.getChatSession.mockResolvedValue(makeSession(done({ engineModel: undefined }), 'gpt-5.5') as any);
    await agentModeController.generateResponse(generateReq('gpt-5.5'), makeRes());
    expect(workerModels()).toEqual(['gpt-5.5']);
  });
});

describe('switch state UNKNOWN (settings outage, no last-known value) honours the stored model (finding 7a)', () => {
  it('unknown: a stored step model is honoured; a definite off still ignores it', async () => {
    mockSwitch = false;
    mockUnknown = true;
    db.getChatSession.mockResolvedValue(makeSession({ steps: [step(1, 'pending', 'gpt-5.5')] }) as any);
    await agentModeController.generateResponse(generateReq('gemini-3.5-flash'), makeRes());
    expect(workerModels()).toEqual(['gpt-5.5']);
    mockUnknown = false;
    await agentModeController.generateResponse(generateReq('gemini-3.5-flash'), makeRes());
    expect(workerModels()).toEqual(['gpt-5.5', 'gemini-3.5-flash']);
  });
});

describe('round 2: standing pick, restore retry, pause idempotence', () => {
  const wp = (extra: any = {}) => ({ steps: [step(1, 'completed', 'gpt-5.5'), step(2, 'pending')], planDefaultModel: 'gemini-3.5-flash', launchModel: 'gpt-5-chat-2', engineModel: 'gpt-5.5', ...extra });

  it('N3: a pick made on a model-less step STANDS for the following turns (stamp = pick, no restamp to the default)', async () => {
    // turn 1: the user picks claude-step-model on model-less step 2 (stored stamp is the engine's gpt-5.5)
    db.getChatSession.mockResolvedValue(makeSession(wp(), 'gpt-5.5') as any);
    await agentModeController.generateResponse(generateReq('claude-step-model'), makeRes());
    expect(workerModels()).toEqual(['claude-step-model']);
    const written = db.updateSessionWorkPlan.mock.calls.map((c) => c[1] as any);
    // the engine marker still names ITS choice, so the pick stays distinguishable from engine stamps
    expect(written.every((w) => w.engineModel !== 'claude-step-model')).toBe(true);
    // turn 2: the portal echoes the stamp (= the pick); the engine marker is whatever turn 1 left
    const marker = written.length ? written[written.length - 1].engineModel : 'gpt-5.5';
    db.getChatSession.mockResolvedValue(makeSession(wp({ engineModel: marker }), 'claude-step-model') as any);
    db.updateSessionLlmModel.mockClear();
    await agentModeController.generateResponse(generateReq('claude-step-model'), makeRes());
    expect(workerModels()).toEqual(['claude-step-model', 'claude-step-model']);
    expect(db.updateSessionLlmModel.mock.calls.every((c) => c[1] === 'claude-step-model')).toBe(true);
  });

  it('N3: when no pick was ever made the plan default still applies (stamp == engine marker)', async () => {
    db.getChatSession.mockResolvedValue(makeSession(wp(), 'gpt-5.5') as any);
    await agentModeController.generateResponse(generateReq('gpt-5.5'), makeRes());
    expect(workerModels()).toEqual(['gemini-3.5-flash']);
  });

  it('N3: a pick on the very first, model-less step also stands (marker records the engine\'s own choice)', async () => {
    const first = (extra: any = {}) => ({ steps: [step(1, 'pending'), step(2, 'pending', 'gpt-5.5')], launchModel: 'gpt-5-chat-2', ...extra });
    db.getChatSession.mockResolvedValue(makeSession(first(), 'gpt-5-chat-2') as any);
    await agentModeController.generateResponse(generateReq('claude-step-model'), makeRes());
    const written = db.updateSessionWorkPlan.mock.calls.map((c) => c[1] as any);
    expect(written[written.length - 1].engineModel).toBe('gpt-5-chat-2');
    db.getChatSession.mockResolvedValue(makeSession(first({ engineModel: 'gpt-5-chat-2' }), 'claude-step-model') as any);
    await agentModeController.generateResponse(generateReq('claude-step-model'), makeRes());
    expect(workerModels()).toEqual(['claude-step-model', 'claude-step-model']);
  });

  it('restore retry: when the pre-plan model is gone the marker is cleared once, the turn runs on the request model, and it is not retried', async () => {
    const done = { steps: [step(1, 'completed', 'gpt-5.5')], launchModel: RETIRED, engineModel: 'gpt-5.5' };
    db.getChatSession.mockResolvedValue(makeSession(done, 'gpt-5.5') as any);
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    await agentModeController.generateResponse(generateReq('gpt-5.5'), makeRes());
    expect(workerModels()).toEqual(['gpt-5.5']);
    const written = db.updateSessionWorkPlan.mock.calls.map((c) => c[1] as any);
    expect(written).toHaveLength(1);
    expect('engineModel' in written[0]).toBe(false);
    expect(warn.mock.calls.some((c) => String(c[0]).includes('could not be restored'))).toBe(true);
    warn.mockRestore();
  });

  it('M10: the pause is idempotent per step AND model: a different model or step at the tail is a new pause', async () => {
    const tail = (stepCount: number, model: string) => ({ role: 'assistant', content: 'x', metadata: { kind: 'work-plan-step-model-unavailable', stepCount, model } });
    const run = async (t: any) => {
      jest.clearAllMocks();
      db.getChatSession.mockResolvedValue(makeSession({ steps: [step(1, 'completed', 'gpt-5.5'), step(2, 'pending', RETIRED)] }, 'gemini-3.5-flash', [t]) as any);
      db.addMessageToSession.mockResolvedValue(makeSession(undefined) as any);
      await agentModeController.generateResponse(generateReq(), makeRes());
      return db.addMessageToSession.mock.calls.filter((c) => (c[1] as any).metadata?.kind === 'work-plan-step-model-unavailable').length;
    };
    expect(await run(tail(2, RETIRED))).toBe(0);            // same step + model: no duplicate
    expect(await run(tail(2, 'some-other-retired'))).toBe(1); // same step, different model: new pause
    expect(await run(tail(3, RETIRED))).toBe(1);             // different step: new pause
  });
});

// ---- round 3: the picker PATCHes the stamp BEFORE /generate, so the request model equals the stamp ---------------------
describe('picker flow: PATCH /llm-model then /generate echoing the stamp', () => {
  let store: any;
  const mkStore = (wp: any, stamp: string) => {
    store = makeSession(wp, stamp);
    db.getChatSession.mockImplementation(async () => JSON.parse(JSON.stringify(store)));
    db.getChatSessionRecord.mockImplementation(async () => JSON.parse(JSON.stringify(store)));
    db.updateSessionLlmModel.mockImplementation(async (_id: string, m: string) => { store.llmModel = m; return store; });
    db.updateSessionWorkPlan.mockImplementation(async (_id: string, w: any) => { store.workPlan = w; return store; });
  };
  const patchPick = async (m: string) => {
    const r = makeRes();
    await (agentModeController as any).updateSessionLlmModel({ params: { sessionId: SESSION_ID }, body: { llmModel: m }, user: { userId: OWNER, isAdmin: false } }, r);
    expect(r.statusCode).toBe(200);
  };
  const base = { launchModel: 'gemini-3.5-flash', planDefaultModel: 'gpt-5-chat-2' };

  it.each([
    ['with the engine marker on the retired step model', { engineModel: RETIRED }, RETIRED],
    ['without a marker (nothing stamped yet)', {}, 'gpt-5-chat-2'],
  ])('P1: a plan paused on a retired step model resumes via the picker, %s', async (_n, extra, stamp) => {
    mkStore({ steps: [step(1, 'pending', RETIRED), step(2, 'pending')], ...base, ...extra }, stamp);
    await patchPick('claude-step-model');
    const res = makeRes();
    await agentModeController.generateResponse(generateReq('claude-step-model'), res);
    expect(workerModels()).toEqual(['claude-step-model']);
    expect(store.workPlan.steps[0].model).toBe('claude-step-model'); // the step adopted the pick
    expect(store.workPlan.engineModel).toBe('claude-step-model');   // ...and the stamp is the engine's own from here on
    expect(mockAlert).not.toHaveBeenCalled();
    // next turn: no pause, still the same model, no restamp churn
    await agentModeController.generateResponse(generateReq('claude-step-model'), makeRes());
    expect(workerModels()).toEqual(['claude-step-model', 'claude-step-model']);
    expect(db.addMessageToSession.mock.calls.some((c) => (c[1] as any).metadata?.kind === 'work-plan-step-model-unavailable')).toBe(false);
  });

  it('P1: without any pick the same plan stays paused', async () => {
    mkStore({ steps: [step(1, 'pending', RETIRED), step(2, 'pending')], ...base, engineModel: RETIRED }, RETIRED);
    await agentModeController.generateResponse(generateReq(RETIRED), makeRes());
    // the request model equals the stamp equals the marker: nothing is a pick (the preflight accepts the stored id for a non-explicit stamp)
    expect(worker.runInWorker).not.toHaveBeenCalled();
  });

  it('P2: an AVAILABLE step model still wins over a PATCHed pick', async () => {
    mkStore({ steps: [step(1, 'pending', 'gpt-5.5')], ...base, engineModel: 'gpt-5.5' }, 'gpt-5.5');
    await patchPick('claude-step-model');
    await agentModeController.generateResponse(generateReq('claude-step-model'), makeRes());
    expect(workerModels()).toEqual(['gpt-5.5']);
    expect(store.llmModel).toBe('gpt-5.5');
    expect(store.workPlan.engineModel).toBe('gpt-5.5');
  });

  it.each([
    ['marker present', { engineModel: 'gpt-5-chat-2' }, 'gpt-5-chat-2'],
    ['no marker yet (the plan\'s first step)', {}, 'gpt-5-chat-2'],
  ])('P3: a pick on a model-less step is the model used, now and on the next turn, %s', async (_n, extra, stamp) => {
    mkStore({ steps: [step(1, 'pending'), step(2, 'pending', 'gpt-5.5')], ...base, ...extra }, stamp);
    await patchPick('claude-step-model');
    await agentModeController.generateResponse(generateReq('claude-step-model'), makeRes());
    await agentModeController.generateResponse(generateReq('claude-step-model'), makeRes());
    expect(workerModels()).toEqual(['claude-step-model', 'claude-step-model']);
    expect(store.llmModel).toBe('claude-step-model');
    expect(store.workPlan.engineModel).not.toBe('claude-step-model'); // the pick stays distinguishable from engine stamps
  });

  it('P3: with no pick, the model-less first step runs on the plan default', async () => {
    mkStore({ steps: [step(1, 'pending'), step(2, 'pending', 'gpt-5.5')], ...base }, 'gpt-5-chat-2');
    await agentModeController.generateResponse(generateReq('gpt-5-chat-2'), makeRes());
    expect(workerModels()).toEqual(['gpt-5-chat-2']);
  });

  it('continuation uses the same rule: a standing pick is honoured by the automatic round too', async () => {
    mkStore({ autocomplete: true, steps: [step(1, 'pending'), step(2, 'pending', 'gpt-5.5')], ...base, engineModel: 'gpt-5-chat-2' }, 'gpt-5-chat-2');
    await patchPick('claude-step-model');
    worker.runInWorker
      .mockResolvedValueOnce(workerResult('thinking', []) as any)
      .mockImplementationOnce(async () => { store.workPlan = { ...store.workPlan, steps: [step(1, 'completed'), step(2, 'completed', 'gpt-5.5')] }; return workerResult('done', []) as any; });
    await agentModeController.generateResponse(generateReq('claude-step-model'), makeRes());
    await flush();
    expect(workerModels()[0]).toBe('claude-step-model');
    expect(workerModels()[1]).toBe('claude-step-model');
  });
});

describe('round 4: share viewers and the first-step baseline', () => {
  let store: any;
  const mkStore = (wp: any, stamp: string) => {
    store = makeSession(wp, stamp);
    db.getChatSession.mockImplementation(async () => JSON.parse(JSON.stringify(store)));
    db.getChatSessionRecord.mockImplementation(async () => JSON.parse(JSON.stringify(store)));
    db.updateSessionLlmModel.mockImplementation(async (_id: string, m: string) => { store.llmModel = m; return store; });
    db.updateSessionWorkPlan.mockImplementation(async (_id: string, w: any) => { store.workPlan = w; return store; });
  };
  const base = { launchModel: 'gemini-3.5-flash', planDefaultModel: 'gpt-5-chat-2' };

  it('a share VIEWER\'s pick never rewrites the owner\'s retired step model: the viewer gets the pause, the owner resumes', async () => {
    mkStore({ steps: [step(1, 'pending', RETIRED)], ...base, engineModel: RETIRED }, 'claude-step-model'); // the viewer PATCHed the stamp
    const viewer = await generateSessionResponse(SESSION_ID, 'go', OWNER, 'claude-step-model', undefined, true);
    expect(worker.runInWorker).not.toHaveBeenCalled();
    expect(viewer.content).toContain('Choose another model in the model picker');
    expect(store.workPlan.steps[0].model).toBe(RETIRED);
    // the genuine owner, same stamp, resumes
    await generateSessionResponse(SESSION_ID, 'go', OWNER, 'claude-step-model', undefined, false);
    expect(workerModels()).toEqual(['claude-step-model']);
    expect(store.workPlan.steps[0].model).toBe('claude-step-model');
  });

  it('on a MODEL-LESS step a viewer\'s pick still runs for the turn, with no plan write', async () => {
    mkStore({ steps: [step(1, 'pending'), step(2, 'pending', 'gpt-5.5')], ...base, engineModel: 'gpt-5.5' }, 'claude-step-model');
    await generateSessionResponse(SESSION_ID, 'go', OWNER, 'claude-step-model', undefined, true);
    expect(workerModels()).toEqual(['claude-step-model']);
    expect(db.updateSessionWorkPlan).not.toHaveBeenCalled();
  });

  it('M2: when Emma pinned a plan default, an untouched stamp (= the pin) is NOT a pick, so a retired first-step model pauses instead of adopting the pin', async () => {
    // launchModel is the PRE-pin model, planDefaultModel the pin the launch stamped onto the session
    mkStore({ steps: [step(1, 'pending', RETIRED), step(2, 'pending')], launchModel: 'gemini-3.5-flash', planDefaultModel: 'gpt-5-chat-2' }, 'gpt-5-chat-2');
    const res = makeRes();
    await agentModeController.generateResponse(generateReq('gpt-5-chat-2'), res);
    expect(worker.runInWorker).not.toHaveBeenCalled();
    expect(store.workPlan.steps[0].model).toBe(RETIRED);
    expect(res.body.content).toContain('Choose another model in the model picker');
  });
});

describe('review: the user\'s pick survives the end of the plan', () => {
  let store: any;
  const mkStore = (wp: any, stamp: string) => {
    store = makeSession(wp, stamp);
    db.getChatSession.mockImplementation(async () => JSON.parse(JSON.stringify(store)));
    db.getChatSessionRecord.mockImplementation(async () => JSON.parse(JSON.stringify(store)));
    db.updateSessionLlmModel.mockImplementation(async (_id: string, m: string) => { store.llmModel = m; return store; });
    db.updateSessionWorkPlan.mockImplementation(async (_id: string, w: any) => { store.workPlan = w; return store; });
  };
  const patchPick = async (m: string) => {
    const r = makeRes();
    await (agentModeController as any).updateSessionLlmModel({ params: { sessionId: SESSION_ID }, body: { llmModel: m }, user: { userId: OWNER, isAdmin: false } }, r);
  };
  const complete = () => { store.workPlan = { ...store.workPlan, steps: store.workPlan.steps.map((x: any) => ({ ...x, status: 'completed' })) }; };
  const base = { launchModel: 'gemini-3.5-flash', planDefaultModel: 'gpt-5-chat-2' };

  it('a pick on a MODEL-LESS step: after the plan completes the next turn still runs on the pick', async () => {
    mkStore({ steps: [step(1, 'pending'), step(2, 'pending', 'gpt-5.5')], ...base, engineModel: 'gpt-5-chat-2' }, 'gpt-5-chat-2');
    await patchPick('claude-step-model');
    await agentModeController.generateResponse(generateReq('claude-step-model'), makeRes());
    store.workPlan = { ...store.workPlan, steps: [step(1, 'completed'), step(2, 'completed', 'gpt-5.5')] };
    await agentModeController.generateResponse(generateReq('claude-step-model'), makeRes());
    expect(workerModels()).toEqual(['claude-step-model', 'claude-step-model']);
    expect(store.llmModel).toBe('claude-step-model');
  });

  it('a pick that RESUMED a retired step (the step adopted it): after completion it is not replaced by the launch model', async () => {
    mkStore({ steps: [step(1, 'pending', RETIRED)], ...base, engineModel: RETIRED }, RETIRED);
    await patchPick('claude-step-model');
    await agentModeController.generateResponse(generateReq('claude-step-model'), makeRes());
    expect(store.workPlan.steps[0].model).toBe('claude-step-model');
    complete();
    await agentModeController.generateResponse(generateReq('claude-step-model'), makeRes());
    expect(workerModels()).toEqual(['claude-step-model', 'claude-step-model']);
    expect(store.llmModel).toBe('claude-step-model');
  });

  it('control: with no pick the pre-plan model still returns when the plan completes', async () => {
    mkStore({ steps: [step(1, 'pending', 'gpt-5.5')], ...base }, 'gpt-5-chat-2');
    await agentModeController.generateResponse(generateReq('gpt-5-chat-2'), makeRes());
    expect(workerModels()).toEqual(['gpt-5.5']);
    complete();
    await agentModeController.generateResponse(generateReq('gpt-5.5'), makeRes());
    expect(workerModels()).toEqual(['gpt-5.5', 'gemini-3.5-flash']);
  });
});

describe('/generate reports the model that RAN (CodeRabbit)', () => {
  let store: any;
  const mkStore = (wp: any, stamp: string) => {
    store = makeSession(wp, stamp);
    db.getChatSession.mockImplementation(async () => JSON.parse(JSON.stringify(store)));
    db.getChatSessionRecord.mockImplementation(async () => JSON.parse(JSON.stringify(store)));
    db.updateSessionLlmModel.mockImplementation(async (_id: string, m: string) => { store.llmModel = m; return store; });
    db.updateSessionWorkPlan.mockImplementation(async (_id: string, w: any) => { store.workPlan = w; return store; });
  };
  const fields = (b: any) => ({ requestedModel: b.requestedModel, effectiveModel: b.effectiveModel, modelSelection: b.modelSelection });

  it('an available step model B overrides request A: the response says B, B is what the worker ran (and stamps on the message)', async () => {
    mkStore({ steps: [step(1, 'pending', 'gpt-5.5')] }, 'gemini-3.5-flash');
    const res = makeRes();
    await agentModeController.generateResponse(generateReq('gemini-3.5-flash'), res);
    expect(workerModels()).toEqual(['gpt-5.5']);
    expect(fields(res.body)).toEqual({ requestedModel: 'gpt-5.5', effectiveModel: 'gpt-5.5', modelSelection: 'honored' });
  });

  it('a pick that resumed a retired step: the response names the pick', async () => {
    mkStore({ steps: [step(1, 'pending', RETIRED)], engineModel: RETIRED }, RETIRED);
    const res = makeRes();
    await agentModeController.generateResponse(generateReq('claude-step-model'), res);
    expect(workerModels()).toEqual(['claude-step-model']);
    expect(res.body.effectiveModel).toBe('claude-step-model');
  });

  it('a standing pick on a model-less step: the response names the model that ran', async () => {
    mkStore({ steps: [step(1, 'pending'), step(2, 'pending', 'gpt-5.5')], planDefaultModel: 'gpt-5-chat-2', launchModel: 'gemini-3.5-flash', engineModel: 'gpt-5-chat-2' }, 'claude-step-model');
    const res = makeRes();
    await agentModeController.generateResponse(generateReq('claude-step-model'), res);
    expect(res.body.effectiveModel).toBe(workerModels()[0]);
    expect(res.body.effectiveModel).toBe('claude-step-model');
  });

  it('the plan default replacing a stale echo is what the response reports', async () => {
    mkStore({ steps: [step(1, 'completed', 'gpt-5.5'), step(2, 'pending')], planDefaultModel: 'gemini-3.5-flash', launchModel: 'gpt-5-chat-2', engineModel: 'gpt-5.5' }, 'gpt-5.5');
    const res = makeRes();
    await agentModeController.generateResponse(generateReq('gpt-5.5'), res);
    expect(res.body.effectiveModel).toBe('gemini-3.5-flash');
    expect(workerModels()).toEqual(['gemini-3.5-flash']);
  });

  it('no plan: unchanged (the request-level decision)', async () => {
    mkStore(undefined, 'gemini-3.5-flash');
    const res = makeRes();
    await agentModeController.generateResponse(generateReq('gemini-3.5-flash'), res);
    expect(fields(res.body)).toEqual({ requestedModel: 'gemini-3.5-flash', effectiveModel: 'gemini-3.5-flash', modelSelection: 'honored' });
  });

  it('a plan whose steps carry no model: unchanged', async () => {
    mkStore({ steps: [step(1, 'pending')] }, 'gemini-3.5-flash');
    const res = makeRes();
    await agentModeController.generateResponse(generateReq('gemini-3.5-flash'), res);
    expect(res.body.effectiveModel).toBe('gemini-3.5-flash');
  });
});
