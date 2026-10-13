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
jest.mock('../services/agentMode/workPlanStepModelsInstance', () => ({
  workPlanStepModels: { isEnabled: jest.fn(async () => { mockSwitchReads += 1; return mockSwitch; }) },
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
    expect(mockSwitchReads).toBe(0);
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
      `Step 2 uses ${RETIRED}, which is no longer available. Pick another model for this step to continue. The plan is paused and nothing was sent to a different model.`,
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
