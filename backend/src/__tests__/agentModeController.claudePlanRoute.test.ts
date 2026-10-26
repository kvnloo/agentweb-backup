/**
 * ENG-2113 PR C: the /generate controller on the user's own Claude plan.
 *
 * The rules pinned here are the ones that keep a plan request from ever being silently served by AgentWeb, and keep a request that never asked
 * for the plan exactly as it is today:
 *  - no `fundingChoice`: AgentWeb path, allowance admission recorded, worker used, backend never touched;
 *  - a stop (flag off, not allowed here, no connection...) answers BEFORE anything is saved or locked, with the typed body;
 *  - a plan turn spends no AgentWeb allowance, takes no AgentWeb model policy, never reaches the worker, never rewrites the stored session model,
 *    and schedules no automatic continuation (those would run on AgentWeb);
 *  - a backend stop after the user's message was saved leaves a fixed-copy note, uses no diagnosis agent, and releases the session lock;
 *  - a whole-turn timeout stops the turn and is reported as the timeout, with no salvage.
 */
import { Request, Response } from 'express';
import { agentModeController, activeSessionGenerations } from '../controllers/agentModeController';
import { chatbotDb } from '../services/chatbotService';
import { generateMarketingResponseWorkerService } from '../services/generateMarketingResponseWorkerService';
import { checkTokenUsage } from '../services/tokenUsageService';
import { agentModeService } from '../services/agentModeService';
import { resolveTurnFunding } from '../services/funding/claudeFunding';
import { claudeCodeBackend } from '../services/funding/claudeCodeBackendInstance';
import { ClaudeRouteStopError } from '../services/funding/claudeRouteErrors';

jest.mock('../services/chatbotService', () => ({
  chatbotDb: {
    getChatSession: jest.fn(),
    addMessageToSession: jest.fn(),
    addMessagesToSession: jest.fn(),
    updateSessionTitle: jest.fn(),
    updateSessionLlmModel: jest.fn(),
    getMessagesFromMessagesTable: jest.fn(),
  },
  updateTaskExecutionStatus: jest.fn(),
}));
jest.mock('../services/emailService', () => ({ emailService: { sendOncallAlert: jest.fn().mockResolvedValue(undefined) } }));
jest.mock('../services/generateMarketingResponseWorkerService', () => ({
  generateMarketingResponseWorkerService: { runInWorker: jest.fn(), cancelSession: jest.fn() },
}));
jest.mock('../services/agentModeService', () => ({
  agentModeService: {
    getDefaultModel: jest.fn().mockResolvedValue('gpt-5-chat-2'),
    // the registry's pin resolution (canonicalPinId): a served id resolves to itself
    resolveGenerationModel: jest.fn((m: string) => ({ model: m, fellBack: false, requestedModel: m })),
    generateSessionTitle: jest.fn().mockResolvedValue('Test Title'),
    getMarketingSystemPrompt: jest.fn().mockResolvedValue('System prompt'),
    generateDiagnosticMessage: jest.fn().mockResolvedValue(null),
  },
  AgentModeService: jest.fn(),
}));
jest.mock('../services/tokenUsageService', () => ({
  checkTokenUsage: jest.fn().mockResolvedValue({ allowed: true, warning: false, used: 0, allowance: null, bonus: 0, effectiveAllowance: null, percentUsed: 0, month: '2026-06' }),
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
jest.mock('../services/funding/claudeFunding', () => ({ resolveTurnFunding: jest.fn() }));
jest.mock('../services/funding/claudeCodeBackendInstance', () => ({ claudeCodeBackend: { run: jest.fn() } }));

const db = chatbotDb as jest.Mocked<typeof chatbotDb> & Record<string, jest.Mock>;
const worker = generateMarketingResponseWorkerService as jest.Mocked<typeof generateMarketingResponseWorkerService>;
const funding = resolveTurnFunding as jest.Mock;
const backend = claudeCodeBackend.run as jest.Mock;
const usage = checkTokenUsage as jest.Mock;

const PLAN_MODEL = 'openrouter/anthropic/claude-sonnet-5.5';
const DECISION = { route: 'claude_subscription', connectionId: 'conn-1', epoch: 2, alias: 'sonnet', modelId: PLAN_MODEL, ownerUserId: 'u1' };
const SESSION = { sessionId: 's1', userId: 'u1', title: 'T', messages: [], createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', portalType: 'agent' as const, pageIdentifier: 'agent-mode', llmModel: 'gpt-5-chat-2' };
const flush = () => new Promise((r) => setImmediate(r));

const makeReq = (body: Record<string, unknown> = {}) =>
  ({
    user: { userId: 'u1', email: 'u1@example.com' },
    body: { sessionId: 's1', userMessage: 'Hello', llmModel: PLAN_MODEL, attachments: [], ...body },
    method: 'POST', path: '/api/agent-mode/generate', ip: '127.0.0.1', socket: { remoteAddress: '127.0.0.1' }, on: jest.fn(),
  }) as unknown as Request;
const makeRes = () => ({ json: jest.fn(), status: jest.fn().mockReturnThis(), headersSent: false }) as unknown as Response;

const planResult = (over: Record<string, unknown> = {}) => ({
  content: 'Plan answer', toolCalls: [], knowledgeBaseQueries: [], sources: [], persistedResponseCount: 0,
  responseMessages: [{ role: 'assistant', content: 'Plan answer', llm: PLAN_MODEL }], ...over,
});

describe('/generate on the Claude plan route', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    activeSessionGenerations.clear();
    db.getChatSession.mockResolvedValue(SESSION as any);
    db.getMessagesFromMessagesTable.mockResolvedValue([]);
    db.addMessageToSession.mockResolvedValue(SESSION as any);
    db.addMessagesToSession.mockResolvedValue({ messages: [] } as any);
    funding.mockResolvedValue({ route: 'agentweb' });
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => jest.restoreAllMocks());

  describe('a request that never asked for the plan', () => {
    it('is untouched: the funding decision sees no choice, the allowance is admitted, the worker runs, the backend does not', async () => {
      worker.runInWorker.mockResolvedValueOnce({ content: 'OK', toolCalls: [], knowledgeBaseQueries: [], sources: [], responseMessages: [] } as any);
      const res = makeRes();
      await agentModeController.generateResponse(makeReq({ llmModel: 'gpt-5-chat-2' }), res);
      expect(funding).toHaveBeenCalledWith(expect.objectContaining({ rawFundingChoice: undefined, initiatorUserId: 'u1', sessionOwnerUserId: 'u1', requestIsDelegated: false }));
      expect(usage).toHaveBeenCalled();
      expect(agentModeService.getDefaultModel).toHaveBeenCalled(); // the AgentWeb model policy ran
      expect(worker.runInWorker).toHaveBeenCalledTimes(1);
      expect(backend).not.toHaveBeenCalled();
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ content: 'OK' }));
    });
  });

  describe('a stop before the turn starts', () => {
    it('answers with the typed body and consumes nothing: no message saved, no lock held, no allowance, no worker, no backend', async () => {
      funding.mockRejectedValueOnce(new ClaudeRouteStopError('not_enabled'));
      const res = makeRes();
      await agentModeController.generateResponse(makeReq({ fundingChoice: 'claude_subscription' }), res);
      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'not_enabled', funding: 'claude_subscription', retryable: false }));
      expect(db.addMessageToSession).not.toHaveBeenCalled();
      expect(activeSessionGenerations.has('s1')).toBe(false);
      expect(usage).not.toHaveBeenCalled();
      expect(worker.runInWorker).not.toHaveBeenCalled();
      expect(backend).not.toHaveBeenCalled();
    });

    it('passes only the request\'s own model pick: a stored session model is never a plan pick', async () => {
      funding.mockRejectedValue(new ClaudeRouteStopError('model_not_on_plan'));
      await agentModeController.generateResponse(makeReq({ fundingChoice: 'claude_subscription', llmModel: PLAN_MODEL }), makeRes());
      expect(funding).toHaveBeenLastCalledWith(expect.objectContaining({ explicitModelId: PLAN_MODEL }));
      await agentModeController.generateResponse(makeReq({ fundingChoice: 'claude_subscription', llmModel: undefined }), makeRes());
      expect(funding).toHaveBeenLastCalledWith(expect.objectContaining({ explicitModelId: undefined })); // SESSION.llmModel is set, and ignored
    });

    it('hands the resolver the real facts: the request\'s own pick, the session owner, and both delegation flags', async () => {
      funding.mockRejectedValueOnce(new ClaudeRouteStopError('not_allowed_here'));
      const req = makeReq({ fundingChoice: 'claude_subscription' }) as any;
      req.delegateInfo = { isDelegated: true };
      await agentModeController.generateResponse(req, makeRes());
      expect(funding).toHaveBeenCalledWith(expect.objectContaining({ rawFundingChoice: 'claude_subscription', initiatorUserId: 'u1', sessionOwnerUserId: 'u1', requestIsDelegated: true, sessionIsDelegated: false }));
    });

    it('an invalid choice is the 400 the resolver throws, passed through', async () => {
      funding.mockRejectedValueOnce(new ClaudeRouteStopError('invalid_funding_choice'));
      const res = makeRes();
      await agentModeController.generateResponse(makeReq({ fundingChoice: 'nonsense' }), res);
      expect(res.status).toHaveBeenCalledWith(400);
    });

    it('a resolver failure that is not a stop is not swallowed into an AgentWeb run', async () => {
      funding.mockRejectedValueOnce(new Error('unexpected'));
      const res = makeRes();
      await agentModeController.generateResponse(makeReq({ fundingChoice: 'claude_subscription' }), res);
      expect(worker.runInWorker).not.toHaveBeenCalled();
      expect(backend).not.toHaveBeenCalled();
    });
  });

  describe('a plan turn', () => {
    beforeEach(() => {
      funding.mockResolvedValue(DECISION);
    });

    it('runs in the backend only, spends no AgentWeb allowance and leaves the stored model alone', async () => {
      backend.mockResolvedValueOnce(planResult());
      const res = makeRes();
      await agentModeController.generateResponse(makeReq({ fundingChoice: 'claude_subscription' }), res);
      expect(backend).toHaveBeenCalledTimes(1);
      expect(backend.mock.calls[0][0]).toMatchObject({ decision: DECISION, sessionId: 's1', userId: 'u1', llmModel: PLAN_MODEL, isDelegatedAccess: false });
      expect(worker.runInWorker).not.toHaveBeenCalled();
      expect(usage).not.toHaveBeenCalled();
      expect(agentModeService.getDefaultModel).not.toHaveBeenCalled(); // neither AgentWeb model-policy pass ran
      expect(db.updateSessionLlmModel).not.toHaveBeenCalled();
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ content: 'Plan answer' }));
      expect(activeSessionGenerations.has('s1')).toBe(false);
    });

    it('persists the backend\'s messages as the batch', async () => {
      const result = planResult();
      backend.mockResolvedValueOnce(result);
      await agentModeController.generateResponse(makeReq({ fundingChoice: 'claude_subscription' }), makeRes());
      expect(db.addMessagesToSession).toHaveBeenCalledWith('s1', result.responseMessages);
    });

    it('a cancelled plan turn persists nothing from the controller (the backend kept the settled work itself)', async () => {
      backend.mockResolvedValueOnce(planResult({ cancelled: true, responseMessages: [] }));
      await agentModeController.generateResponse(makeReq({ fundingChoice: 'claude_subscription' }), makeRes());
      expect(db.addMessagesToSession).not.toHaveBeenCalled();
    });

    it('schedules no automatic continuation, even when the turn reports a deferred media call', async () => {
      backend.mockResolvedValueOnce(planResult({ toolCalls: [{ name: 'generate_image', result: { deferred: true, reason: 'media_generation_time_budget' } }] }));
      await agentModeController.generateResponse(makeReq({ fundingChoice: 'claude_subscription' }), makeRes());
      await flush();
      await flush();
      expect(backend).toHaveBeenCalledTimes(1);
      expect(worker.runInWorker).not.toHaveBeenCalled();
    });

    it('a plan request is never handed to the worker, even if the backend returns nothing', async () => {
      backend.mockResolvedValueOnce(undefined);
      const res = makeRes();
      await agentModeController.generateResponse(makeReq({ fundingChoice: 'claude_subscription' }), res);
      expect(worker.runInWorker).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(502);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'turn_failed', funding: 'claude_subscription' }));
    });

    it('a backend stop after the message was saved leaves a fixed-copy note, uses no diagnosis agent and releases the lock', async () => {
      backend.mockRejectedValueOnce(new ClaudeRouteStopError('usage_limit'));
      const res = makeRes();
      await agentModeController.generateResponse(makeReq({ fundingChoice: 'claude_subscription' }), res);
      expect(res.status).toHaveBeenCalledWith(429);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'usage_limit', funding: 'claude_subscription' }));
      const note = db.addMessageToSession.mock.calls.map((c) => c[1] as any).find((m) => m?.metadata?.kind === 'claude-plan-stop');
      expect(note).toMatchObject({ role: 'assistant', metadata: { isErrorMessage: true, code: 'usage_limit' } });
      expect(note.content).toMatch(/usage limit/);
      expect(agentModeService.generateDiagnosticMessage).not.toHaveBeenCalled();
      expect(worker.runInWorker).not.toHaveBeenCalled();
      expect(activeSessionGenerations.has('s1')).toBe(false);
    });

    it('a whole-turn timeout cancels the turn through cancelSession, is reported as the timeout, and is never salvaged', async () => {
      backend.mockRejectedValueOnce(Object.assign(new Error('Generation timed out'), { isGenerationTimeout: true }));
      const res = makeRes();
      await agentModeController.generateResponse(makeReq({ fundingChoice: 'claude_subscription' }), res);
      expect(worker.cancelSession).toHaveBeenCalledWith('s1');
      expect(db.getChatSession).not.toHaveBeenCalledWith('s1', true); // the salvage read
      expect(worker.runInWorker).not.toHaveBeenCalled();
      expect(activeSessionGenerations.has('s1')).toBe(false);
    });
  });
});
