/**
 * POST /api/agent-mode/generate — AskUserQuestion structured answer channel (ENG-396).
 *
 * When the chat card posts a selection (req.body.questionAnswer), generateResponse
 * must resolve it against the session's pending question and PERSIST the answered
 * state BEFORE the run starts, so the consumer gate (checkQuestionGate — the Meta
 * objective write, ENG-400) reads a human-attributed answer from the DB rather than
 * parsing prose. Invariants exercised here:
 *   - a matching direct pick → persisted answered by 'user', run proceeds;
 *   - a delegation click → persisted answered by 'delegation' on the recommended
 *     option (never a silent different choice);
 *   - a stale/absent/mismatched selection → 409 ASK_USER_QUESTION_INVALID, no run;
 *   - ownership still wins: a non-owner never reaches the answer channel.
 *
 * The load-bearing resolution logic is unit-tested in
 * services/agentMode/core/__tests__/askUserQuestion.test.ts; this file covers the
 * controller glue (destructure → resolve → persist → error mapping).
 */
import { Request, Response } from 'express';
import { buildPendingUserQuestion, PendingUserQuestion } from '../services/agentMode/core/askUserQuestion';

jest.mock('../services/chatbotService', () => ({
  chatbotDb: {
    createChatSession: jest.fn(),
    getChatSession: jest.fn(),
    updateSessionLlmModel: jest.fn(),
    addMessageToSession: jest.fn(),
    addMessagesToSession: jest.fn(),
    updateSessionTitle: jest.fn(),
    getMessagesFromMessagesTable: jest.fn(),
    updateSessionAskUserQuestion: jest.fn(),
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

jest.mock('../utils/agentModeErrors', () => ({
  isContextLimitError: jest.fn().mockReturnValue(false),
  isSessionLimitError: jest.fn().mockReturnValue(false),
  isTransientLLMError: jest.fn().mockReturnValue(false),
  isWorkerShutdownError: jest.fn().mockReturnValue(false),
}));

import { agentModeController, activeSessionGenerations } from '../controllers/agentModeController';
import { chatbotDb } from '../services/chatbotService';
import { generateMarketingResponseWorkerService } from '../services/generateMarketingResponseWorkerService';

const mockChatbotDb = chatbotDb as jest.Mocked<typeof chatbotDb>;
const mockWorkerService = generateMarketingResponseWorkerService as jest.Mocked<typeof generateMarketingResponseWorkerService>;

const ownerId = 'user-owner';
const attackerId = 'user-attacker';
const sessionId = 'session-with-question';

function pendingObjectiveQuestion(): PendingUserQuestion {
  return buildPendingUserQuestion({
    questionId: 'q-objective-1',
    question: 'Which Meta campaign objective? It cannot be changed after launch.',
    options: [
      {
        id: 'leads',
        label: 'Leads',
        consequence: 'Optimizes for booked demos.',
        recommended: true,
        why: '162 LEAD events fired on your pixel in the last 30d.',
        payload: { objective: 'OUTCOME_LEADS' },
      },
      {
        id: 'traffic',
        label: 'Traffic',
        consequence: 'Cheap clicks, optimizes for visits not leads.',
        payload: { objective: 'OUTCOME_TRAFFIC' },
      },
    ],
    immutable: true,
    allowEmmaDecide: true,
    createdAt: '2026-07-21T00:00:00.000Z',
  });
}

function sessionWith(pending: PendingUserQuestion | undefined) {
  return {
    sessionId,
    userId: ownerId,
    title: 'Owner Session',
    messages: [],
    createdAt: '2026-07-01T00:00:00Z',
    updatedAt: '2026-07-01T00:00:00Z',
    portalType: 'agent' as const,
    pageIdentifier: 'agent-mode',
    llmModel: 'gpt-5-chat-2',
    ...(pending ? { pendingUserQuestion: pending } : {}),
  };
}

const workerResult = {
  content: 'OK',
  toolCalls: [],
  knowledgeBaseQueries: [],
  sources: [],
  responseMessages: [],
};

type ReqUser = { userId: string; email?: string; isAdmin?: boolean };

const makeReq = (user: ReqUser, questionAnswer: any, message = 'Leads') =>
  ({
    user,
    body: {
      sessionId,
      userMessage: message,
      llmModel: 'gpt-5-chat-2',
      attachments: [],
      ...(questionAnswer !== undefined ? { questionAnswer } : {}),
    },
    method: 'POST',
    path: '/api/agent-mode/generate',
    ip: '127.0.0.1',
    socket: { remoteAddress: '127.0.0.1' },
    on: jest.fn(),
  } as unknown as Request);

const makeRes = () => {
  const res: any = { statusCode: 200, body: undefined };
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

describe('generateResponse — AskUserQuestion answer channel (ENG-396)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    activeSessionGenerations.clear();
    (mockChatbotDb as any).getMessagesFromMessagesTable.mockResolvedValue([]);
    mockChatbotDb.addMessageToSession.mockResolvedValue(undefined as any);
    mockChatbotDb.addMessagesToSession.mockResolvedValue(undefined as any);
    mockChatbotDb.updateSessionTitle.mockResolvedValue(undefined as any);
    // A real DynamoDB update always returns truthy Attributes on success — only
    // a lost optimistic-lock race (a concurrent answer already won) returns
    // null. Default to a successful persist; race-specific tests override this.
    (mockChatbotDb as any).updateSessionAskUserQuestion.mockResolvedValue({ sessionId } as any);
    mockWorkerService.runInWorker.mockResolvedValue(workerResult as any);
  });

  it('a matching direct pick persists the answered question (answeredBy "user") then runs', async () => {
    mockChatbotDb.getChatSession.mockResolvedValue(sessionWith(pendingObjectiveQuestion()) as any);

    const res = makeRes();
    await agentModeController.generateResponse(
      makeReq({ userId: ownerId }, { questionId: 'q-objective-1', optionId: 'traffic' }),
      res,
    );

    expect(res.statusCode).toBe(200);
    expect((mockChatbotDb as any).updateSessionAskUserQuestion).toHaveBeenCalledTimes(1);
    const [persistedSessionId, persisted] = (mockChatbotDb as any).updateSessionAskUserQuestion.mock.calls[0];
    expect(persistedSessionId).toBe(sessionId);
    expect(persisted.status).toBe('answered');
    expect(persisted.answer).toMatchObject({ optionId: 'traffic', delegated: false, answeredBy: 'user' });
    // The run proceeds after the answer lands.
    expect(mockWorkerService.runInWorker).toHaveBeenCalledTimes(1);
  });

  it('a delegation click persists answeredBy "delegation" on the recommended option', async () => {
    mockChatbotDb.getChatSession.mockResolvedValue(sessionWith(pendingObjectiveQuestion()) as any);

    const res = makeRes();
    await agentModeController.generateResponse(
      makeReq({ userId: ownerId }, { questionId: 'q-objective-1', delegated: true }, 'Let Emma decide'),
      res,
    );

    expect(res.statusCode).toBe(200);
    const [, persisted] = (mockChatbotDb as any).updateSessionAskUserQuestion.mock.calls[0];
    expect(persisted.answer).toMatchObject({ optionId: 'leads', delegated: true, answeredBy: 'delegation' });
    expect(persisted.answer.rationale).toContain('162 LEAD events');
    expect(mockWorkerService.runInWorker).toHaveBeenCalledTimes(1);
  });

  it('persists the answer with an optimistic-lock guard requiring the question to still be THIS awaiting one', async () => {
    mockChatbotDb.getChatSession.mockResolvedValue(sessionWith(pendingObjectiveQuestion()) as any);

    await agentModeController.generateResponse(
      makeReq({ userId: ownerId }, { questionId: 'q-objective-1', optionId: 'leads' }),
      makeRes(),
    );

    expect((mockChatbotDb as any).updateSessionAskUserQuestion).toHaveBeenCalledWith(
      sessionId,
      expect.objectContaining({ status: 'answered' }),
      { requireStillAwaiting: 'q-objective-1' },
    );
  });

  // Greptile P1 ("Concurrent answers overwrite selections"): two concurrent
  // submissions both validate against the same in-memory 'awaiting' snapshot;
  // without a guard the later unconditional write would silently clobber the
  // earlier answer. A null return means the optimistic lock lost the race
  // (the question was already answered by the time this write landed).
  it('a lost optimistic-lock race (concurrent answer already won) is a 409 — never silently overwrites', async () => {
    mockChatbotDb.getChatSession.mockResolvedValue(sessionWith(pendingObjectiveQuestion()) as any);
    (mockChatbotDb as any).updateSessionAskUserQuestion.mockResolvedValue(null);

    const res = makeRes();
    await agentModeController.generateResponse(
      makeReq({ userId: ownerId }, { questionId: 'q-objective-1', optionId: 'leads' }),
      res,
    );

    expect(res.statusCode).toBe(409);
    expect(res.body).toEqual(expect.objectContaining({ code: 'ASK_USER_QUESTION_INVALID' }));
    expect(mockWorkerService.runInWorker).not.toHaveBeenCalled();
  });

  it('a selection with NO pending question is a 409 ASK_USER_QUESTION_INVALID — no run', async () => {
    mockChatbotDb.getChatSession.mockResolvedValue(sessionWith(undefined) as any);

    const res = makeRes();
    await agentModeController.generateResponse(
      makeReq({ userId: ownerId }, { questionId: 'q-objective-1', optionId: 'leads' }),
      res,
    );

    expect(res.statusCode).toBe(409);
    expect(res.body).toEqual(expect.objectContaining({ code: 'ASK_USER_QUESTION_INVALID' }));
    expect((mockChatbotDb as any).updateSessionAskUserQuestion).not.toHaveBeenCalled();
    expect(mockWorkerService.runInWorker).not.toHaveBeenCalled();
  });

  it('a selection whose questionId does not match the pending question is a 409 — no run (stale card)', async () => {
    mockChatbotDb.getChatSession.mockResolvedValue(sessionWith(pendingObjectiveQuestion()) as any);

    const res = makeRes();
    await agentModeController.generateResponse(
      makeReq({ userId: ownerId }, { questionId: 'q-stale', optionId: 'leads' }),
      res,
    );

    expect(res.statusCode).toBe(409);
    expect(res.body).toEqual(expect.objectContaining({ code: 'ASK_USER_QUESTION_INVALID' }));
    expect(mockWorkerService.runInWorker).not.toHaveBeenCalled();
  });

  it('ownership wins: a non-owner posting a selection gets 403 and never reaches the answer channel', async () => {
    mockChatbotDb.getChatSession.mockResolvedValue(sessionWith(pendingObjectiveQuestion()) as any);

    const res = makeRes();
    await agentModeController.generateResponse(
      makeReq({ userId: attackerId }, { questionId: 'q-objective-1', optionId: 'leads' }),
      res,
    );

    expect(res.statusCode).toBe(403);
    expect((mockChatbotDb as any).updateSessionAskUserQuestion).not.toHaveBeenCalled();
    expect(mockWorkerService.runInWorker).not.toHaveBeenCalled();
  });

  it('a typed message while a question is awaiting RELEASES it (never infers from prose) so Emma can re-ask, then runs', async () => {
    mockChatbotDb.getChatSession.mockResolvedValue(sessionWith(pendingObjectiveQuestion()) as any);

    const res = makeRes();
    await agentModeController.generateResponse(makeReq({ userId: ownerId }, undefined, 'lets do lead'), res);

    expect(res.statusCode).toBe(200);
    // The open question is abandoned (cleared) — the prose is NOT parsed into an answer.
    // Clearing frees the one-live-question guard so Emma can emit a fresh card. Guarded
    // (requireStillAwaiting) so a concurrent card-answer submission can't be erased by
    // this clear (Greptile P1, "Typed messages bypass answer lock").
    expect((mockChatbotDb as any).updateSessionAskUserQuestion).toHaveBeenCalledWith(
      sessionId, null, { requireStillAwaiting: 'q-objective-1' },
    );
    expect(mockWorkerService.runInWorker).toHaveBeenCalledTimes(1);
  });

  it('when the clear LOSES a race to a concurrent answer, re-reads fresh state instead of erasing it', async () => {
    mockChatbotDb.getChatSession
      .mockResolvedValueOnce(sessionWith(pendingObjectiveQuestion()) as any) // initial read
      .mockResolvedValueOnce(sessionWith({
        ...pendingObjectiveQuestion(),
        status: 'answered',
        answer: { optionId: 'leads', delegated: false, answeredBy: 'user', at: 't' },
      }) as any); // re-read after lost race
    (mockChatbotDb as any).updateSessionAskUserQuestion.mockResolvedValue(null); // guard refused: lost the race

    const res = await (async () => {
      const r = makeRes();
      await agentModeController.generateResponse(makeReq({ userId: ownerId }, undefined, 'lets do lead'), r);
      return r;
    })();

    expect(res.statusCode).toBe(200);
    // Did NOT treat the concurrently-answered question as abandoned/re-askable.
    expect(mockWorkerService.runInWorker).toHaveBeenCalledTimes(1);
  });

  it('a typed message with NO pending question never touches the answer channel', async () => {
    mockChatbotDb.getChatSession.mockResolvedValue(sessionWith(undefined) as any);

    const res = makeRes();
    await agentModeController.generateResponse(makeReq({ userId: ownerId }, undefined, 'just chatting'), res);

    expect(res.statusCode).toBe(200);
    expect((mockChatbotDb as any).updateSessionAskUserQuestion).not.toHaveBeenCalled();
    expect(mockWorkerService.runInWorker).toHaveBeenCalledTimes(1);
  });
});
