/**
 * ENG-669 PR-D: a work plan that pauses on a step's model (outside the owner's plan, or no longer available) in an
 * UNATTENDED session emails the owner once per session and step, on top of today's in-chat pause message. Interactive
 * sessions keep the message only; switch (model_tier_allowlist_enabled) off => exactly as before. The mock preamble is
 * agentModeController.workPlanStepModel.test.ts's.
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
  emailService: {
    sendOncallAlert: jest.fn().mockResolvedValue(undefined),
    sendWorkPlanStepModelUnavailableEmail: jest.fn().mockResolvedValue(undefined),
  },
}));
// The tier-allowlist switch (and the tiers) by AW-Settings name; off unless a test sets it.
const mockSettings: Record<string, string | undefined> = {};
jest.mock('../services/settingsService', () => ({
  settingsService: {
    getSetting: jest.fn(async (name: string) => (mockSettings[name] === undefined ? null : { settingName: name, settingValue: mockSettings[name] })),
  },
}));

jest.mock('../services/db', () => ({
  userDb: { getUserById: jest.fn() },
  scheduleDb: { getScheduleById: jest.fn() },
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
jest.mock('../services/subscriptionService', () => ({
  getAllowedSkills: jest.fn().mockResolvedValue([]),
  getUserSubscriptionResolution: jest.fn(async () => ({ subscriptionType: 'Free', resolved: true })),
  readTierAllowedModels: jest.fn(async () => ({ configured: true, allowedModels: ['gemini-3.5-flash'] })),
}));
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
import { scheduleDb, userDb } from '../services/db';
import { emailService } from '../services/emailService';
import { modelAccess } from '../services/agentMode/modelAccessInstance';
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
  for (const key of Object.keys(mockSettings)) delete mockSettings[key];
  modelAccess.reset();
  activeSessionGenerations.clear();
  autoContinuationSessions.clear();
  mockSwitch = true;
  mockUnknown = false;
  mockSwitchReads = 0;
  mockPolicy.mockResolvedValue({ billingUserId: OWNER, policy: null, costUsedMicroUsd: 0, tokenUsed: 0, mode: FULL_CHOICE });
  mockUsage.mockResolvedValue({ allowed: true, warning: false, used: 0, allowance: null, bonus: 0, effectiveAllowance: null, percentUsed: 0, month: '2026-10' });
  (userDb.getUserById as jest.Mock).mockResolvedValue({ userId: OWNER, isAdmin: false, email: 'owner@example.com' });
  (scheduleDb.getScheduleById as jest.Mock).mockResolvedValue(null);
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

const mockStepEmail = emailService.sendWorkPlanStepModelUnavailableEmail as jest.Mock;
const SCHEDULE_ID = 'abc-123';
const plan = (stepTwoModel = RETIRED) => ({ steps: [step(1, 'completed', 'gpt-5.5'), step(2, 'pending', stepTwoModel)] });
const scheduledSession = (messages: any[] = [], pageIdentifier = `Scheduled: Weekly report|scheduleId:${SCHEDULE_ID}`, workPlan: any = plan()) => ({
  ...makeSession(workPlan, 'gemini-3.5-flash', messages), sessionType: 'scheduled', title: 'Scheduled: Weekly report', pageIdentifier,
});
/** generateSessionResponse with its per-turn attendance signal (position 20). */
const turn = (isUnattendedRun: boolean | undefined) => generateSessionResponse(
  SESSION_ID, 'go', OWNER, 'gemini-3.5-flash',
  undefined, undefined, undefined, undefined, undefined, undefined, undefined,
  undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
  isUnattendedRun,
);
const pauseWrites = () => db.addMessageToSession.mock.calls
  .map((c) => c[1] as any)
  .filter((m) => m?.metadata?.kind === 'work-plan-step-model-unavailable');
const stampedPause = (stepCount: number) => ({
  role: 'assistant', content: `Step ${stepCount} paused`,
  metadata: { kind: 'work-plan-step-model-unavailable', stepCount, model: RETIRED, ownerNotified: true },
});

describe('unattended session, switch on', () => {
  beforeEach(() => { mockSettings.model_tier_allowlist_enabled = 'true'; });

  it('the pause message is stamped and the owner is emailed; a retired model still pages on-call as before', async () => {
    db.getChatSession.mockResolvedValue(makeSession(plan()) as any);
    const result = await turn(true);

    expect(worker.runInWorker).not.toHaveBeenCalled();
    expect(result.content).toContain('Step 2 uses');
    expect(pauseWrites()).toHaveLength(1);
    expect(pauseWrites()[0].metadata).toMatchObject({ stepCount: 2, model: RETIRED, ownerNotified: true });
    expect(mockStepEmail).toHaveBeenCalledTimes(1);
    expect(mockStepEmail).toHaveBeenCalledWith(['owner@example.com'], {
      sessionId: SESSION_ID, stepCount: 2, modelLabel: RETIRED, reason: 'not_served', scheduleName: undefined, sessionTitle: 'Chat', upgradeRequired: [],
    });
    expect(mockAlert).toHaveBeenCalledTimes(1);
  });

  it('once per (session, step): a later pause of the same step (a retry turn after a nudge) is not emailed again', async () => {
    db.getChatSession.mockResolvedValue(makeSession(plan(), 'gemini-3.5-flash', [
      stampedPause(2), { role: 'user', content: 'Please perform the work on pending steps.' },
    ]) as any);
    await turn(true);
    expect(pauseWrites()).toHaveLength(1);
    expect(pauseWrites()[0].metadata).not.toHaveProperty('ownerNotified');
    expect(mockStepEmail).not.toHaveBeenCalled();
  });

  it('runVerifiedChat-style repeats in one session: N pauses of the step, ONE email', async () => {
    const messages: any[] = [];
    db.getChatSession.mockImplementation(async () => makeSession(plan(), 'gemini-3.5-flash', [...messages]) as any);
    db.addMessageToSession.mockImplementation(async (_id: string, message: any) => { messages.push(message); return makeSession(plan()) as any; });
    for (let i = 0; i < 5; i++) await turn(true);
    expect(pauseWrites()).toHaveLength(5);
    expect(mockStepEmail).toHaveBeenCalledTimes(1);
  });

  it('another step of the same session is a new notice', async () => {
    db.getChatSession.mockResolvedValue(makeSession(
      { steps: [step(1, 'completed', 'gpt-5.5'), step(2, 'completed', 'gpt-5.5'), step(3, 'pending', RETIRED)] },
      'gemini-3.5-flash', [stampedPause(2)],
    ) as any);
    await turn(true);
    expect(mockStepEmail).toHaveBeenCalledTimes(1);
    expect(mockStepEmail.mock.calls[0][1]).toMatchObject({ stepCount: 3 });
  });

  it("a run of the owner's schedule follows that schedule's recipients and names it", async () => {
    db.getChatSession.mockResolvedValue(scheduledSession() as any);
    (scheduleDb.getScheduleById as jest.Mock).mockResolvedValue({
      scheduleId: SCHEDULE_ID, userId: OWNER, scheduleName: 'Weekly report', emailNotifications: ['team@example.com'],
    });
    await turn(true);
    expect(scheduleDb.getScheduleById).toHaveBeenCalledWith(SCHEDULE_ID);
    expect(mockStepEmail).toHaveBeenCalledWith(['team@example.com'], expect.objectContaining({ scheduleName: 'Weekly report' }));
  });

  it('an owner who opted out of schedule email gets none; a schedule that is not the owner\'s is ignored', async () => {
    db.getChatSession.mockResolvedValue(scheduledSession() as any);
    (scheduleDb.getScheduleById as jest.Mock).mockResolvedValue({ scheduleId: SCHEDULE_ID, userId: OWNER, scheduleName: 'W', emailOptOut: true });
    await turn(true);
    expect(mockStepEmail).not.toHaveBeenCalled();

    (scheduleDb.getScheduleById as jest.Mock).mockResolvedValue({ scheduleId: SCHEDULE_ID, userId: 'someone-else', scheduleName: 'Theirs', emailNotifications: ['x@example.com'] });
    await turn(true);
    expect(mockStepEmail).toHaveBeenCalledWith(['owner@example.com'], expect.objectContaining({ scheduleName: undefined }));
  });

  it('no attendance signal: a scheduled session counts as unattended, a regular one does not', async () => {
    db.getChatSession.mockResolvedValue(scheduledSession() as any);
    await turn(undefined);
    expect(mockStepEmail).toHaveBeenCalledTimes(1);

    mockStepEmail.mockClear();
    db.getChatSession.mockResolvedValue(makeSession(plan()) as any);
    await turn(undefined);
    expect(mockStepEmail).not.toHaveBeenCalled();
  });

  it('an INTERACTIVE turn (even on a scheduled session) keeps the in-chat message only', async () => {
    db.getChatSession.mockResolvedValue(scheduledSession() as any);
    await turn(false);
    expect(pauseWrites()).toHaveLength(1);
    expect(pauseWrites()[0].metadata).not.toHaveProperty('ownerNotified');
    expect(mockStepEmail).not.toHaveBeenCalled();
  });

  it('a manual "Test this schedule" run is watched by its owner: no email', async () => {
    db.getChatSession.mockResolvedValue(scheduledSession([], `Test: Weekly report|scheduleId:${SCHEDULE_ID}`) as any);
    await turn(true);
    expect(pauseWrites()).toHaveLength(1);
    expect(mockStepEmail).not.toHaveBeenCalled();
  });

  it('a step model outside the owner\'s plan: emailed with the plan reason, and (as before) nobody is paged', async () => {
    mockSettings.subscription_types = JSON.stringify([{ name: 'Free', allowedModels: ['gemini-3.5-flash'] }, { name: 'Pro' }]);
    db.getChatSession.mockResolvedValue(makeSession(plan('gpt-5.5')) as any);
    await turn(true);
    expect(worker.runInWorker).not.toHaveBeenCalled();
    expect(mockStepEmail).toHaveBeenCalledWith(['owner@example.com'], expect.objectContaining({ stepCount: 2, reason: 'not_in_plan', upgradeRequired: ['Pro'] }));
    expect(mockAlert).not.toHaveBeenCalled();
  });

  it('#3676 follow-up 5: a step model no tier includes is emailed with an EMPTY upgradeRequired (no upgrade offered)', async () => {
    mockSettings.subscription_types = JSON.stringify([{ name: 'Free', allowedModels: ['gemini-3.5-flash'] }, { name: 'Pro', allowedModels: ['gemini-3.5-flash'] }]);
    db.getChatSession.mockResolvedValue(makeSession(plan('gpt-5.5')) as any);
    await turn(true);
    expect(mockStepEmail).toHaveBeenCalledWith(['owner@example.com'], expect.objectContaining({ reason: 'not_in_plan', upgradeRequired: [] }));
  });

  it('a failing email never breaks the turn', async () => {
    mockStepEmail.mockRejectedValueOnce(new Error('SMTP down'));
    db.getChatSession.mockResolvedValue(makeSession(plan()) as any);
    await expect(turn(true)).resolves.toMatchObject({ content: expect.stringContaining('Step 2 uses') });
  });

  it('#3676 follow-up 2: a continuation chain started by an attended /generate turn on a scheduled session keeps the in-chat message only', async () => {
    const autoPlan = (steps: any[]) => ({ planId: 'p', autocomplete: true, steps });
    const stall = (workPlan: any) => {
      const session = { ...makeSession(workPlan), sessionType: 'scheduled', pageIdentifier: `Scheduled: Weekly report|scheduleId:${SCHEDULE_ID}` };
      db.getChatSession.mockResolvedValue(session as any);
      db.getChatSessionRecord.mockResolvedValue(session as any);
    };
    // Step 1's model is in the (Free) plan, so the interactive turn runs it; step 2's model is gone by the next round.
    stall(autoPlan([step(1, 'pending', 'gemini-3.5-flash')]));
    worker.runInWorker.mockImplementationOnce(async () => {
      stall(autoPlan([step(1, 'completed', 'gemini-3.5-flash'), step(2, 'pending', RETIRED)]));
      return workerResult('step 1 done', []) as any;
    });
    await agentModeController.generateResponse(generateReq(), makeRes());
    await flush();
    // The owner who reopened the scheduled chat started this chain: it is attended, whatever the session's kind.
    expect(pauseWrites()).toHaveLength(1);
    expect(pauseWrites()[0].metadata).not.toHaveProperty('ownerNotified');
    expect(mockStepEmail).not.toHaveBeenCalled();
  });

  it('#3676 follow-up 2: each round of the chain runs with the starting turn\'s attendance (never re-derived from the session kind)', async () => {
    const autoPlan = (steps: any[]) => ({ planId: 'p', autocomplete: true, steps });
    const stall = (workPlan: any) => {
      const session = { ...makeSession(workPlan), sessionType: 'scheduled', pageIdentifier: `Scheduled: Weekly report|scheduleId:${SCHEDULE_ID}` };
      db.getChatSession.mockResolvedValue(session as any);
      db.getChatSessionRecord.mockResolvedValue(session as any);
    };
    stall(autoPlan([step(1, 'pending', 'gemini-3.5-flash')]));
    worker.runInWorker.mockImplementationOnce(async () => {
      stall(autoPlan([step(1, 'completed', 'gemini-3.5-flash'), step(2, 'pending', 'gemini-3.5-flash')]));
      return workerResult('step 1 done', []) as any;
    });
    worker.runInWorker.mockImplementationOnce(async () => {
      stall(autoPlan([step(1, 'completed', 'gemini-3.5-flash'), step(2, 'completed', 'gemini-3.5-flash')]));
      return workerResult('step 2 done', []) as any;
    });
    await agentModeController.generateResponse(generateReq(), makeRes());
    await flush(40);
    expect(worker.runInWorker).toHaveBeenCalledTimes(2);
    expect(worker.runInWorker.mock.calls[0][0]).toMatchObject({ isUnattendedRun: false });
    expect(worker.runInWorker.mock.calls[1][0]).toMatchObject({ isUnattendedRun: false });
  });
});

describe('switch off: exactly as before', () => {
  it('an unattended pause writes the same message (no stamp), sends no email, and alerts as before', async () => {
    db.getChatSession.mockResolvedValue(scheduledSession() as any);
    await turn(true);
    expect(pauseWrites()).toHaveLength(1);
    expect(Object.keys(pauseWrites()[0].metadata).sort()).toEqual(['kind', 'model', 'stepCount', 'timestamp']);
    expect(mockStepEmail).not.toHaveBeenCalled();
    expect(scheduleDb.getScheduleById).not.toHaveBeenCalled();
    expect(mockAlert).toHaveBeenCalledTimes(1);
  });
});
