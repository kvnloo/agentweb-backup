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
// The whole-turn cap is read when the controller loads: 0.3 s makes the real timeout race fire inside a test.
process.env.AGENT_MODE_GENERATION_TIMEOUT_MS = '300';
import { Request, Response } from 'express';
import { markTurnToolsRan } from '../services/funding/claudeRouteErrors';
import { agentModeController, activeSessionGenerations, generateSessionResponse } from '../controllers/agentModeController';
import { chatbotDb } from '../services/chatbotService';
import { generateMarketingResponseWorkerService } from '../services/generateMarketingResponseWorkerService';
import { checkTokenUsage } from '../services/tokenUsageService';
import { agentModeService } from '../services/agentModeService';
import { resolveTurnFunding } from '../services/funding/claudeFunding';
import { claudeCodeBackend } from '../services/funding/claudeCodeBackendInstance';
import { ClaudeRouteStopError } from '../services/funding/claudeRouteErrors';
import { assertModelInOwnerPlan, modelAccess } from '../services/agentMode/modelAccessInstance';
import { userDb } from '../services/db';
import { resolveRunFunding } from '../services/funding/runFunding';
import { isSessionLimitError, isWorkerShutdownError } from '../utils/agentModeErrors';
import { emitProgress, requestCancel } from '../utils/sseProgress';
import { WORK_PLAN_NEEDS_YOU_MESSAGE } from '../controllers/agentModeController';

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
// The needs-you hand-back emits over Socket.IO through the real server module, which must not boot inside a unit test.
jest.mock('../server', () => ({ io: { to: jest.fn().mockReturnValue({ emit: jest.fn() }) } }));
jest.mock('../services/funding/claudeFunding', () => ({ resolveTurnFunding: jest.fn() }));
// Real modules with one spy each, so the AgentWeb-only steps can be shown to run for a normal request and to stay out of a plan turn.
jest.mock('../services/agentMode/modelAccessInstance', () => ({
  ...jest.requireActual('../services/agentMode/modelAccessInstance'),
  assertModelInOwnerPlan: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../services/funding/runFunding', () => {
  const actual = jest.requireActual('../services/funding/runFunding');
  return { ...actual, resolveRunFunding: jest.fn(actual.resolveRunFunding) };
});
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
      // ...it is a typed stop the user can act on, nothing was saved, and the session is not left locked
      expect(res.status).toHaveBeenCalledWith(503);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'lookup_failed', funding: 'claude_subscription', userMessageSaved: false, canUseAgentWebCredits: true }));
      expect(db.addMessageToSession).not.toHaveBeenCalled();
      expect(activeSessionGenerations.has('s1')).toBe(false);
    });

    it('an early stop says the user message was not saved', async () => {
      funding.mockRejectedValueOnce(new ClaudeRouteStopError('not_enabled'));
      const res = makeRes();
      await agentModeController.generateResponse(makeReq({ fundingChoice: 'claude_subscription' }), res);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'not_enabled', userMessageSaved: false, canUseAgentWebCredits: false }));
    });

    it('a pre-run stop that is a plan problem offers AgentWeb credits (the saved-message variants are pinned in the plan-turn tests as false)', async () => {
      funding.mockRejectedValueOnce(new ClaudeRouteStopError('needs_reconnect'));
      const res = makeRes();
      await agentModeController.generateResponse(makeReq({ fundingChoice: 'claude_subscription' }), res);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'needs_reconnect', userMessageSaved: false, canUseAgentWebCredits: true }));
    });

    it('does not resolve the model pick for a request that never asked for the plan', async () => {
      worker.runInWorker.mockResolvedValueOnce({ content: 'OK', toolCalls: [], knowledgeBaseQueries: [], sources: [], responseMessages: [] } as any);
      await agentModeController.generateResponse(makeReq({ llmModel: PLAN_MODEL }), makeRes());
      expect(funding).toHaveBeenCalledWith(expect.objectContaining({ explicitModelId: undefined }));
    });

    it('hands the resolver an organisation lookup that reads the STORED user (req.user never carries orgId), the Fable acknowledgement, the initiator and a delegated session', async () => {
      funding.mockRejectedValue(new ClaudeRouteStopError('not_enabled'));
      db.getChatSession.mockResolvedValue({ ...SESSION, delegateInfo: { isDelegated: true } } as any);
      const req = makeReq({ fundingChoice: 'claude_subscription', acknowledgeExtraUsage: true }) as any;
      await agentModeController.generateResponse(req, makeRes());
      expect(funding).toHaveBeenLastCalledWith(expect.objectContaining({ acknowledgedExtraUsage: true, sessionIsDelegated: true, initiatorUserId: 'u1' }));
      expect(funding.mock.calls[funding.mock.calls.length - 1][0]).not.toHaveProperty('initiatorOrgId');
      const lookup = funding.mock.calls[funding.mock.calls.length - 1][0].lookupOrgId as () => Promise<unknown>;
      const read = jest.spyOn(userDb, 'getUserByIdConsistent');
      read.mockResolvedValueOnce({ userId: 'u1', orgId: 'org-1' } as any);
      expect(await lookup()).toBe('org-1');
      expect(read).toHaveBeenCalledWith('u1');
      read.mockResolvedValueOnce({ userId: 'u1' } as any);
      expect(await lookup()).toBeUndefined();
      read.mockResolvedValueOnce(undefined as any);
      await expect(lookup()).rejects.toThrow(); // a missing record is a failed lookup, never "no organisation"
      read.mockRejectedValueOnce(new Error('dynamo blip'));
      await expect(lookup()).rejects.toThrow('dynamo blip');
      await agentModeController.generateResponse(makeReq({ fundingChoice: 'claude_subscription', acknowledgeExtraUsage: 'yes' }), makeRes());
      expect(funding).toHaveBeenLastCalledWith(expect.objectContaining({ acknowledgedExtraUsage: false })); // only the literal true counts
      const admin = makeReq({ fundingChoice: 'claude_subscription' }) as any;
      admin.user = { userId: 'admin-1', email: 'a@example.com', isAdmin: true };
      db.getChatSession.mockResolvedValue(SESSION as any);
      await agentModeController.generateResponse(admin, makeRes());
      expect(funding).toHaveBeenLastCalledWith(expect.objectContaining({ initiatorUserId: 'admin-1', sessionOwnerUserId: 'u1' }));
    });
  });

  describe('/verified-generate', () => {
    it('refuses a request for the plan: it always runs on AgentWeb, so a plan request must hear no', async () => {
      const res = makeRes();
      await agentModeController.verifiedGenerate(makeReq({ fundingChoice: 'claude_subscription', startingMessage: 'x', requiredFunctions: [] }), res);
      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'invalid_funding_choice', userMessageSaved: false }));
      expect(db.getChatSession).not.toHaveBeenCalled();
      expect(backend).not.toHaveBeenCalled();
    });

    it('lets an explicit "agentweb" or no choice through to the normal flow', async () => {
      for (const fundingChoice of ['agentweb', undefined, null]) {
        const res = makeRes();
        await agentModeController.verifiedGenerate(makeReq({ fundingChoice, startingMessage: 'x', requiredFunctions: [] }), res);
        expect(res.status).not.toHaveBeenCalledWith(400);
        expect(db.getChatSession).toHaveBeenCalled();
        db.getChatSession.mockClear();
      }
    });
  });

  describe('shared link generate', () => {
    const sharedReq = (body: Record<string, unknown>) =>
      ({ ...(makeReq(body) as object), params: { shareId: 's1' }, query: { conversable: 'tok' } }) as unknown as Request;

    it('refuses a request for the plan: a shared link always runs on AgentWeb, so a plan request must hear no', async () => {
      for (const fundingChoice of ['claude_subscription', 'codex_subscription', 'bogus', 0, false]) {
        const res = makeRes();
        await agentModeController.generateSharedResponse(sharedReq({ fundingChoice }), res);
        expect(res.status).toHaveBeenCalledWith(400);
        expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'invalid_funding_choice', userMessageSaved: false }));
      }
      expect((chatbotDb as any).getChatSession).not.toHaveBeenCalled();
      expect(backend).not.toHaveBeenCalled();
    });

    it('lets an explicit "agentweb" or no choice through to the normal flow', async () => {
      for (const fundingChoice of ['agentweb', undefined, null]) {
        const res = makeRes();
        await agentModeController.generateSharedResponse(sharedReq({ fundingChoice }), res);
        expect(res.status).not.toHaveBeenCalledWith(400);
        expect((chatbotDb as any).getChatSession).toHaveBeenCalled();
        (chatbotDb as any).getChatSession.mockClear();
      }
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

    it('a backend stop after the message was saved says so in the body (the message is in the chat)', async () => {
      backend.mockRejectedValueOnce(new ClaudeRouteStopError('host_busy'));
      const res = makeRes();
      await agentModeController.generateResponse(makeReq({ fundingChoice: 'claude_subscription' }), res);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'host_busy', userMessageSaved: true, canUseAgentWebCredits: false, canContinueSavedMessage: false, agentWebOffer: 'new_message' })); // saved, nothing says no tool ran: only "send as a new message"; never a plain resend
    });

    it('a stop that is KNOWN to have run no tool is continuable: the note says so and the body offers the continue', async () => {
      const stop = new ClaudeRouteStopError('host_busy');
      markTurnToolsRan(stop, false);
      backend.mockRejectedValueOnce(stop);
      const res = makeRes();
      await agentModeController.generateResponse(makeReq({ fundingChoice: 'claude_subscription' }), res);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'host_busy', userMessageSaved: true, canUseAgentWebCredits: false, canContinueSavedMessage: true, agentWebOffer: 'continue' }));
      const note = db.addMessageToSession.mock.calls.map((c) => c[1] as any).find((m) => m?.metadata?.kind === 'claude-plan-stop');
      expect(note.metadata.resumable).toBe(true);
    });

    it('a stop after a tool ran is never continuable', async () => {
      const stop = new ClaudeRouteStopError('turn_failed');
      markTurnToolsRan(stop, true);
      backend.mockRejectedValueOnce(stop);
      const res = makeRes();
      await agentModeController.generateResponse(makeReq({ fundingChoice: 'claude_subscription' }), res);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ userMessageSaved: true, canContinueSavedMessage: false, agentWebOffer: 'new_message' }));
      const note = db.addMessageToSession.mock.calls.map((c) => c[1] as any).find((m) => m?.metadata?.kind === 'claude-plan-stop');
      expect(note.metadata.resumable).toBe(false);
    });

    describe('continueSavedMessage', () => {
      const note = (over: Record<string, unknown> = {}) => ({ role: 'assistant', content: 'stopped', metadata: { kind: 'claude-plan-stop', isErrorMessage: true, resumable: true, ...over } });
      const stoppedSession = (messages: unknown[]) => ({ ...SESSION, messages });
      const refused = (res: Response) => {
        expect(res.status).toHaveBeenCalledWith(409);
        expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'CONTINUE_NOT_AVAILABLE' }));
        expect(db.addMessageToSession).not.toHaveBeenCalled();
        expect(backend).not.toHaveBeenCalled();
        expect(worker.runInWorker).not.toHaveBeenCalled();
      };

      it('answers the saved message on AgentWeb WITHOUT storing the user message a second time', async () => {
        funding.mockResolvedValue({ route: 'agentweb' });
        db.getChatSession.mockResolvedValue(stoppedSession([{ role: 'user', content: 'Hello' }, note()]) as any);
        worker.runInWorker.mockResolvedValueOnce({ content: 'OK', toolCalls: [], knowledgeBaseQueries: [], sources: [], responseMessages: [] } as any);
        const res = makeRes();
        await agentModeController.generateResponse(makeReq({ llmModel: 'gpt-5-chat-2', continueSavedMessage: true }), res);
        expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ content: 'OK' }));
        expect(worker.runInWorker).toHaveBeenCalledTimes(1);
        const stored = db.addMessageToSession.mock.calls.map((c) => c[1] as any);
        expect(stored.filter((m) => m?.role === 'user')).toHaveLength(0);
        // The continue marker is saved BEFORE anything runs (it ends the "continuable" state until a verdict note follows).
        expect(stored.some((m) => m?.metadata?.kind === 'claude-plan-continue')).toBe(true);
        // The guard that skips the save reads the chat strongly consistent (a stale read could skip the save of a message that is not stored).
        expect(db.getChatSession.mock.calls.filter((c) => c[0] === 's1' && c[1] === true).length).toBeGreaterThanOrEqual(2);
        // The model gets the saved message once: the plan-stop note under it is not part of the history it is given.
        const history = JSON.stringify(worker.runInWorker.mock.calls[0]);
        expect(history).not.toContain('claude-plan-stop');
      });

      it('the continue marker and the stop notes are not part of the history the model gets (the saved message is the last thing it sees)', async () => {
        funding.mockResolvedValue({ route: 'agentweb' });
        const marker = { role: 'assistant', content: 'Continuing your last message.', metadata: { kind: 'claude-plan-continue', isErrorMessage: true } };
        db.getChatSession.mockImplementation((async (_id: string, consistent?: boolean) =>
          consistent ? stoppedSession([{ role: 'user', content: 'Hello' }, note()]) : stoppedSession([{ role: 'user', content: 'Hello' }, note(), marker])) as any);
        worker.runInWorker.mockResolvedValueOnce({ content: 'OK', toolCalls: [], knowledgeBaseQueries: [], sources: [], responseMessages: [] } as any);
        await agentModeController.generateResponse(makeReq({ llmModel: 'gpt-5-chat-2', continueSavedMessage: true }), makeRes());
        const sent = JSON.stringify(worker.runInWorker.mock.calls[0]);
        expect(sent).not.toContain('claude-plan-continue');
        expect(sent).not.toContain('claude-plan-stop');
        expect(sent).toContain('Hello');
      });

      it('answers the saved message on the plan again (a retry) without storing it a second time', async () => {
        db.getChatSession.mockResolvedValue(stoppedSession([{ role: 'user', content: 'Hello' }, note()]) as any);
        backend.mockResolvedValueOnce(planResult());
        const res = makeRes();
        await agentModeController.generateResponse(makeReq({ fundingChoice: 'claude_subscription', continueSavedMessage: true }), res);
        expect(backend).toHaveBeenCalledTimes(1);
        expect(db.addMessageToSession.mock.calls.map((c) => c[1] as any).filter((m) => m?.role === 'user')).toHaveLength(0);
      });

      it('a normal send of the same text still stores the user message (the skip is only for a continue)', async () => {
        funding.mockResolvedValue({ route: 'agentweb' });
        db.getChatSession.mockResolvedValue(stoppedSession([{ role: 'user', content: 'Hello' }, note()]) as any);
        worker.runInWorker.mockResolvedValueOnce({ content: 'OK', toolCalls: [], knowledgeBaseQueries: [], sources: [], responseMessages: [] } as any);
        await agentModeController.generateResponse(makeReq({ llmModel: 'gpt-5-chat-2' }), makeRes());
        expect(db.addMessageToSession.mock.calls.map((c) => c[1] as any).filter((m) => m?.role === 'user')).toHaveLength(1);
      });

      it('is refused when the stop is not marked resumable (a tool may have run)', async () => {
        db.getChatSession.mockResolvedValue(stoppedSession([{ role: 'user', content: 'Hello' }, note({ resumable: false })]) as any);
        const res = makeRes();
        await agentModeController.generateResponse(makeReq({ llmModel: 'gpt-5-chat-2', continueSavedMessage: true }), res);
        refused(res);
      });

      it('is refused when nothing was saved (no stop note), when the text differs, and when the chat moved on', async () => {
        for (const messages of [[], [{ role: 'user', content: 'Hello' }], [{ role: 'user', content: 'Something else' }, note()], [{ role: 'user', content: 'Hello' }, note(), { role: 'assistant', content: 'answered' }]]) {
          jest.clearAllMocks();
          db.getChatSession.mockResolvedValue(stoppedSession(messages) as any);
          const res = makeRes();
          await agentModeController.generateResponse(makeReq({ llmModel: 'gpt-5-chat-2', continueSavedMessage: true }), res);
          refused(res);
        }
      });

      it('the turn itself re-checks right before it skips the save: a chat that changed after the request check never skips it', async () => {
        db.getChatSession.mockResolvedValue(stoppedSession([{ role: 'user', content: 'Hello' }, note(), { role: 'assistant', content: 'answered in another tab' }]) as any);
        await expect(
          generateSessionResponse('s1', 'Hello', 'u1', 'gpt-5-chat-2', undefined, undefined, undefined, false, undefined, undefined, undefined, undefined, undefined, undefined, 'resume-saved'),
        ).rejects.toThrow('RESUME_SAVED_MESSAGE_NOT_AVAILABLE');
        expect(db.addMessageToSession).not.toHaveBeenCalled();
      });

      it('a chat that changes between the request check and the turn is a typed 409: no error note, no diagnosis agent, nothing saved, lock released', async () => {
        funding.mockResolvedValue({ route: 'agentweb' });
        const good = stoppedSession([{ role: 'user', content: 'Hello' }, note()]);
        const moved = stoppedSession([{ role: 'user', content: 'Hello' }, note(), { role: 'assistant', content: 'answered in another tab' }]);
        let consistentReads = 0;
        db.getChatSession.mockImplementation((async (_id: string, consistent?: boolean) => (consistent ? (++consistentReads === 1 ? good : moved) : good)) as any);
        const res = makeRes();
        await agentModeController.generateResponse(makeReq({ llmModel: 'gpt-5-chat-2', continueSavedMessage: true }), res);
        expect(res.status).toHaveBeenCalledWith(409);
        expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'CONTINUE_NOT_AVAILABLE' }));
        expect(db.addMessageToSession).not.toHaveBeenCalled();
        expect(agentModeService.generateDiagnosticMessage).not.toHaveBeenCalled();
        expect(worker.runInWorker).not.toHaveBeenCalled();
        expect(activeSessionGenerations.has('s1')).toBe(false);
      });

      it('a plan-route continue that loses that race is the same 409, not a plan stop that claims nothing was saved', async () => {
        const good = stoppedSession([{ role: 'user', content: 'Hello' }, note()]);
        const moved = stoppedSession([{ role: 'user', content: 'Hello' }, note(), { role: 'assistant', content: 'answered in another tab' }]);
        let consistentReads = 0;
        db.getChatSession.mockImplementation((async (_id: string, consistent?: boolean) => (consistent ? (++consistentReads === 1 ? good : moved) : good)) as any);
        const res = makeRes();
        await agentModeController.generateResponse(makeReq({ fundingChoice: 'claude_subscription', continueSavedMessage: true }), res);
        expect(res.status).toHaveBeenCalledWith(409);
        expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'CONTINUE_NOT_AVAILABLE' }));
        expect(backend).not.toHaveBeenCalled();
      });

      it('a continue whose marker cannot be saved does not start (409), and a read that fails is also a 409', async () => {
        funding.mockResolvedValue({ route: 'agentweb' });
        db.getChatSession.mockResolvedValue(stoppedSession([{ role: 'user', content: 'Hello' }, note()]) as any);
        db.addMessageToSession.mockRejectedValueOnce(new Error('dynamo down'));
        let res = makeRes();
        await agentModeController.generateResponse(makeReq({ llmModel: 'gpt-5-chat-2', continueSavedMessage: true }), res);
        expect(res.status).toHaveBeenCalledWith(409);
        expect(worker.runInWorker).not.toHaveBeenCalled();
        jest.clearAllMocks();
        db.getChatSession.mockImplementation((async (_id: string, consistent?: boolean) => {
          if (consistent) throw new Error('dynamo down');
          return stoppedSession([{ role: 'user', content: 'Hello' }, note()]);
        }) as any);
        res = makeRes();
        await agentModeController.generateResponse(makeReq({ llmModel: 'gpt-5-chat-2', continueSavedMessage: true }), res);
        expect(res.status).toHaveBeenCalledWith(409);
        expect(db.addMessageToSession).not.toHaveBeenCalled();
      });

      it('a stop before the continue starts (the plan is not reachable) still says the message is saved and continuable, never a plain resend', async () => {
        db.getChatSession.mockResolvedValue(stoppedSession([{ role: 'user', content: 'Hello' }, note()]) as any);
        funding.mockRejectedValueOnce(new ClaudeRouteStopError('host_unavailable'));
        const res = makeRes();
        await agentModeController.generateResponse(makeReq({ fundingChoice: 'claude_subscription', continueSavedMessage: true }), res);
        expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'host_unavailable', userMessageSaved: true, canUseAgentWebCredits: false, canContinueSavedMessage: true, agentWebOffer: 'continue' }));
        expect(db.addMessageToSession).not.toHaveBeenCalled();
      });

      it('a nothing-saved stop is still a plain resend, and a stop with no AgentWeb offer has no offer', async () => {
        funding.mockRejectedValueOnce(new ClaudeRouteStopError('host_unavailable'));
        let res = makeRes();
        await agentModeController.generateResponse(makeReq({ fundingChoice: 'claude_subscription' }), res);
        expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ userMessageSaved: false, canUseAgentWebCredits: true, canContinueSavedMessage: false, agentWebOffer: 'resend' }));
        funding.mockRejectedValueOnce(new ClaudeRouteStopError('not_enabled'));
        res = makeRes();
        await agentModeController.generateResponse(makeReq({ fundingChoice: 'claude_subscription' }), res);
        expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ canUseAgentWebCredits: false, agentWebOffer: null }));
      });

      it('a stop that cannot be retried or offered (context too large) is not continuable either', async () => {
        const stop = new ClaudeRouteStopError('context_too_large');
        markTurnToolsRan(stop, false);
        backend.mockRejectedValueOnce(stop);
        const res = makeRes();
        await agentModeController.generateResponse(makeReq({ fundingChoice: 'claude_subscription' }), res);
        expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'context_too_large', userMessageSaved: true, canContinueSavedMessage: false, agentWebOffer: null }));
      });

      it('is refused together with attachments, an answer or a deck', async () => {
        db.getChatSession.mockResolvedValue(stoppedSession([{ role: 'user', content: 'Hello' }, note()]) as any);
        for (const extra of [{ attachments: [{ url: 'u', filename: 'f' }] }, { questionAnswer: { questionId: 'q', answer: 'a' } }, { deckCancel: { deckId: 'd' } }]) {
          jest.clearAllMocks();
          const res = makeRes();
          await agentModeController.generateResponse(makeReq({ llmModel: 'gpt-5-chat-2', continueSavedMessage: true, ...extra }), res);
          refused(res);
        }
      });

      it('only a literal true counts (a truthy string does not skip the save)', async () => {
        funding.mockResolvedValue({ route: 'agentweb' });
        db.getChatSession.mockResolvedValue(stoppedSession([{ role: 'user', content: 'Hello' }, note()]) as any);
        worker.runInWorker.mockResolvedValueOnce({ content: 'OK', toolCalls: [], knowledgeBaseQueries: [], sources: [], responseMessages: [] } as any);
        await agentModeController.generateResponse(makeReq({ llmModel: 'gpt-5-chat-2', continueSavedMessage: 'true' }), makeRes());
        expect(db.addMessageToSession.mock.calls.map((c) => c[1] as any).filter((m) => m?.role === 'user')).toHaveLength(1);
      });
    });

    it('the whole-turn cap ends a turn that never answers: the real race fires, the turn is cancelled, and it is the fixed timeout note', async () => {
      backend.mockImplementationOnce(() => new Promise(() => {})); // never settles
      const res = makeRes();
      await agentModeController.generateResponse(makeReq({ fundingChoice: 'claude_subscription' }), res);
      expect(requestCancel).toHaveBeenCalledWith('s1');
      expect(worker.cancelSession).toHaveBeenCalledWith('s1');
      expect(res.status).toHaveBeenCalledWith(504);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'turn_timeout', funding: 'claude_subscription', userMessageSaved: true, retryable: false, canUseAgentWebCredits: false, canContinueSavedMessage: false, agentWebOffer: null }));
      const note = db.addMessageToSession.mock.calls.map((c) => c[1] as any).find((m) => m?.metadata?.kind === 'claude-plan-stop');
      expect(note).toMatchObject({ metadata: { code: 'turn_timeout', isErrorMessage: true } });
      expect(emitProgress).toHaveBeenCalledWith('s1', { iteration: 0, status: 'complete' }); // the progress stream is closed, not left "generating"
      expect(agentModeService.generateDiagnosticMessage).not.toHaveBeenCalled(); // no AgentWeb money spent guessing
      expect(db.getChatSession).not.toHaveBeenCalledWith('s1', true); // no salvage read
      expect(worker.runInWorker).not.toHaveBeenCalled();
      expect(activeSessionGenerations.has('s1')).toBe(false);
    });

    it('any other failure on a plan turn is also the fixed note: no diagnosis agent, no AgentWeb run', async () => {
      // an error that escapes the backend's own handling (or comes from the code around it)
      backend.mockRejectedValueOnce(new Error('dynamo down: secret-ish detail'));
      const res = makeRes();
      await agentModeController.generateResponse(makeReq({ fundingChoice: 'claude_subscription' }), res);
      expect(res.status).toHaveBeenCalledWith(502);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'turn_failed', funding: 'claude_subscription', userMessageSaved: true, canUseAgentWebCredits: false, canContinueSavedMessage: false, agentWebOffer: 'new_message' }));
      expect(JSON.stringify((res.json as jest.Mock).mock.calls)).not.toContain('secret-ish');
      expect(agentModeService.generateDiagnosticMessage).not.toHaveBeenCalled();
      expect(worker.runInWorker).not.toHaveBeenCalled();
      expect(activeSessionGenerations.has('s1')).toBe(false);
    });

    it('a worker-shutdown error on a plan turn is the restarting stop, in the plan shape', async () => {
      backend.mockRejectedValueOnce(new Error('worker exited'));
      (isWorkerShutdownError as unknown as jest.Mock).mockReturnValueOnce(true);
      const res = makeRes();
      await agentModeController.generateResponse(makeReq({ fundingChoice: 'claude_subscription' }), res);
      expect(res.status).toHaveBeenCalledWith(503);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'server_restarting', funding: 'claude_subscription', retryable: true }));
      expect(agentModeService.generateDiagnosticMessage).not.toHaveBeenCalled();
    });

    it('an error before the user message is saved is a typed stop that says so, with no note under a message that does not exist', async () => {
      db.getMessagesFromMessagesTable.mockRejectedValueOnce(new Error('messages table down')); // read before the user message is stored
      const res = makeRes();
      await agentModeController.generateResponse(makeReq({ fundingChoice: 'claude_subscription' }), res);
      expect(res.status).toHaveBeenCalledWith(502);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'turn_failed', funding: 'claude_subscription', userMessageSaved: false }));
      expect(db.addMessageToSession.mock.calls.some((c) => (c[1] as any)?.metadata?.kind === 'claude-plan-stop')).toBe(false);
      expect(backend).not.toHaveBeenCalled();
      expect(agentModeService.generateDiagnosticMessage).not.toHaveBeenCalled();
    });

    it('a full session keeps its own answer on a plan turn: never a retryable "try again", never a note under a message that was not saved', async () => {
      backend.mockRejectedValueOnce(new Error('SESSION_MESSAGE_LIMIT_EXCEEDED'));
      (isSessionLimitError as unknown as jest.Mock).mockReturnValue(true);
      try {
        const res = makeRes();
        await agentModeController.generateResponse(makeReq({ fundingChoice: 'claude_subscription' }), res);
        expect(res.json).not.toHaveBeenCalledWith(expect.objectContaining({ code: 'turn_failed' }));
        expect(db.addMessageToSession.mock.calls.some((c) => (c[1] as any)?.metadata?.kind === 'claude-plan-stop')).toBe(false);
      } finally {
        (isSessionLimitError as unknown as jest.Mock).mockReturnValue(false);
      }
    });

    it('hands the backend what the turn needs: delegation, the turn clock, the stamps and a progress sink that reaches the stream', async () => {
      backend.mockResolvedValueOnce(planResult());
      const req = makeReq({ fundingChoice: 'claude_subscription' }) as any;
      req.delegateInfo = { isDelegated: true };
      await agentModeController.generateResponse(req, makeRes());
      const arg = backend.mock.calls[0][0];
      expect(arg).toMatchObject({ isDelegatedAccess: true, turnStartMs: expect.any(Number), onProgress: expect.any(Function) });
      expect(Date.now() - arg.turnStartMs).toBeLessThan(10_000);
      arg.onProgress({ iteration: 1, status: 'executing_tools' });
      expect(emitProgress).toHaveBeenCalledWith('s1', { iteration: 1, status: 'executing_tools' });
    });

    describe('AgentWeb-only steps stay out of a plan turn', () => {
      const normalAnswer = { content: 'OK', toolCalls: [], knowledgeBaseQueries: [], sources: [], responseMessages: [] } as any;
      const enabledWithStoredModel = () => {
        jest.spyOn(modelAccess, 'isEnabled').mockResolvedValue(true);
        db.getChatSession.mockResolvedValue({ ...SESSION, llmModel: 'gpt-5-chat-2' } as any);
      };

      it('checks the model against the owner\'s AgentWeb plan for a normal request, and not for a plan turn', async () => {
        enabledWithStoredModel();
        funding.mockResolvedValueOnce({ route: 'agentweb' });
        worker.runInWorker.mockResolvedValueOnce(normalAnswer);
        await agentModeController.generateResponse(makeReq({ llmModel: 'gpt-5-chat-2' }), makeRes());
        expect(assertModelInOwnerPlan).toHaveBeenCalled(); // the condition is live...
        (assertModelInOwnerPlan as jest.Mock).mockClear();
        // the same situation on a plan turn: the stored model IS the one the plan runs
        db.getChatSession.mockResolvedValue({ ...SESSION, llmModel: PLAN_MODEL } as any);
        backend.mockResolvedValueOnce(planResult());
        await agentModeController.generateResponse(makeReq({ fundingChoice: 'claude_subscription', llmModel: PLAN_MODEL }), makeRes());
        expect(backend).toHaveBeenCalledTimes(1);
        expect(assertModelInOwnerPlan).not.toHaveBeenCalled(); // ...and a plan turn is not held to AgentWeb's plan
      });

      it('resolves AgentWeb run funding for a normal request, and not for a plan turn', async () => {
        funding.mockResolvedValueOnce({ route: 'agentweb' });
        worker.runInWorker.mockResolvedValueOnce(normalAnswer);
        await agentModeController.generateResponse(makeReq({ llmModel: 'gpt-5-chat-2' }), makeRes());
        expect(resolveRunFunding).toHaveBeenCalled();
        (resolveRunFunding as jest.Mock).mockClear();
        backend.mockResolvedValueOnce(planResult());
        await agentModeController.generateResponse(makeReq({ fundingChoice: 'claude_subscription' }), makeRes());
        expect(resolveRunFunding).not.toHaveBeenCalled();
      });

      it('hands a blocked autocomplete work plan back to the user once on AgentWeb, and never on the plan', async () => {
        const blocked = [{ name: 'set_work_plan_status', result: { blocked: true, reason: 'workplan_unresolved_removed_requirements' } }];
        const workPlan = { autocomplete: true, steps: [{ status: 'pending' }] };
        db.getChatSession.mockResolvedValue({ ...SESSION, workPlan } as any); // the turn reads its work plan back from the session
        funding.mockResolvedValueOnce({ route: 'agentweb' });
        worker.runInWorker.mockResolvedValueOnce({ ...normalAnswer, toolCalls: blocked });
        await agentModeController.generateResponse(makeReq({ llmModel: 'gpt-5-chat-2' }), makeRes());
        await flush();
        await flush();
        const needsYou = () => db.addMessageToSession.mock.calls.filter((c) => (c[1] as any)?.content === WORK_PLAN_NEEDS_YOU_MESSAGE).length;
        expect(needsYou()).toBe(1); // the check is live on the AgentWeb path
        db.addMessageToSession.mockClear();
        backend.mockResolvedValueOnce(planResult({ toolCalls: blocked }));
        await agentModeController.generateResponse(makeReq({ fundingChoice: 'claude_subscription' }), makeRes());
        await flush();
        await flush();
        expect(needsYou()).toBe(0);
      });

      it('never auto-continues a stalled autocomplete work plan on the plan', async () => {
        // A continuation starts by admitting itself against the AgentWeb allowance (checkTokenUsage); a plan turn is never admitted there.
        db.getChatSession.mockResolvedValue({ ...SESSION, workPlan: { autocomplete: true, steps: [{ status: 'pending' }] } } as any);
        backend.mockResolvedValueOnce(planResult({ toolCalls: [] }));
        await agentModeController.generateResponse(makeReq({ fundingChoice: 'claude_subscription' }), makeRes());
        await flush();
        await flush();
        await flush();
        expect(usage).not.toHaveBeenCalled();
        expect(backend).toHaveBeenCalledTimes(1);
        expect(worker.runInWorker).not.toHaveBeenCalled();
      });

      it('does not store the pick as the session\'s explicit model on the plan', async () => {
        backend.mockResolvedValueOnce(planResult());
        await agentModeController.generateResponse(makeReq({ fundingChoice: 'claude_subscription', llmModel: PLAN_MODEL }), makeRes());
        expect(db.updateSessionLlmModel).not.toHaveBeenCalled();
      });
    });
  });
});
