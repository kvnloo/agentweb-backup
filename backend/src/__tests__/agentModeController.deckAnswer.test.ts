/**
 * POST /api/agent-mode/generate — approval-deck answer channel (ENG-1635/1644).
 *
 * Closes the ship-blocking gap the independent Phase A review found: nothing
 * called agentModeService.submitApprovalDeckAnswers anywhere in the backend.
 * Mirrors agentModeController.askUserQuestionAnswer.test.ts's scaffolding —
 * this covers the controller glue (destructure -> dispatch -> inject outcome
 * into userMessage -> run), not submitApprovalDeckAnswers' own resolution
 * logic (covered in metaWriteManifestReconciliation.test.ts).
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
    updateSessionApprovalDeck: jest.fn(),
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
    submitApprovalDeckAnswers: jest.fn(),
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
  // Spread the real module so new exports (e.g. isProviderUnavailableError) never leave the controller error handler calling undefined.
  ...jest.requireActual('../utils/agentModeErrors'),
  isContextLimitError: jest.fn().mockReturnValue(false),
  isSessionLimitError: jest.fn().mockReturnValue(false),
  isTransientLLMError: jest.fn().mockReturnValue(false),
  isWorkerShutdownError: jest.fn().mockReturnValue(false),
  isProviderNoEndpointsError: jest.fn().mockReturnValue(false),
}));

import { agentModeController, activeSessionGenerations } from '../controllers/agentModeController';
import { chatbotDb } from '../services/chatbotService';
import { agentModeService } from '../services/agentModeService';
import { generateMarketingResponseWorkerService } from '../services/generateMarketingResponseWorkerService';

const mockChatbotDb = chatbotDb as jest.Mocked<typeof chatbotDb>;
const mockAgentModeService = agentModeService as jest.Mocked<typeof agentModeService>;
const mockWorkerService = generateMarketingResponseWorkerService as jest.Mocked<typeof generateMarketingResponseWorkerService>;

const ownerId = 'user-owner';
const attackerId = 'user-attacker';
const sessionId = 'session-with-deck';

function pendingDeck() {
  return {
    deckId: 'deck-1',
    status: 'awaiting' as const,
    items: [
      { itemId: 'write-1', kind: 'meta_write', question: 'Create ad set AS_1?', metaWriteManifestDigest: 'digest-1' },
      { itemId: 'write-2', kind: 'meta_write', question: 'Create ad set AS_2?', metaWriteManifestDigest: 'digest-2' },
    ],
    createdAt: '2026-09-15T00:00:00.000Z',
    finalizedAt: '2026-09-15T00:00:01.000Z',
  };
}

function sessionWith(pendingApprovalDeck: ReturnType<typeof pendingDeck> | undefined) {
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
    ...(pendingApprovalDeck ? { pendingApprovalDeck } : {}),
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

const makeReq = (user: ReqUser, deckAnswer: any, message = 'Reviewed the deck') =>
  ({
    user,
    body: {
      sessionId,
      userMessage: message,
      llmModel: 'gpt-5-chat-2',
      attachments: [],
      ...(deckAnswer !== undefined ? { deckAnswer } : {}),
    },
    method: 'POST',
    path: '/api/agent-mode/generate',
    ip: '127.0.0.1',
    socket: { remoteAddress: '127.0.0.1' },
    on: jest.fn(),
  } as unknown as Request);

const makeCancelReq = (user: ReqUser, deckCancel: any, message = 'Cancelled the review.') =>
  ({
    user,
    body: {
      sessionId,
      userMessage: message,
      llmModel: 'gpt-5-chat-2',
      attachments: [],
      ...(deckCancel !== undefined ? { deckCancel } : {}),
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

describe('generateResponse — approval-deck answer channel (ENG-1635/1644)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    activeSessionGenerations.clear();
    (mockChatbotDb as any).getMessagesFromMessagesTable.mockResolvedValue([]);
    mockChatbotDb.addMessageToSession.mockResolvedValue(undefined as any);
    mockChatbotDb.addMessagesToSession.mockResolvedValue(undefined as any);
    mockChatbotDb.updateSessionTitle.mockResolvedValue(undefined as any);
    mockWorkerService.runInWorker.mockResolvedValue(workerResult as any);
  });

  it('a deck submission dispatches through submitApprovalDeckAnswers and injects the outcome into the turn', async () => {
    mockChatbotDb.getChatSession.mockResolvedValue(sessionWith(pendingDeck()) as any);
    (mockAgentModeService as any).submitApprovalDeckAnswers.mockResolvedValue({
      outcome: 'submitted',
      run: { runId: 'run-1' },
      summary: {
        status: 'fully_applied',
        items: [
          { stepId: 'write-1', status: 'verified', appliedObjectId: 'id-AS_1' },
          { stepId: 'write-2', status: 'verified', appliedObjectId: 'id-AS_2' },
        ],
      },
      answeredDeck: {
        ...pendingDeck(),
        status: 'answered',
        answers: [
          { itemId: 'write-1', verdict: 'approve', answeredBy: 'user', at: '2026-09-15T00:00:02.000Z' },
          { itemId: 'write-2', verdict: 'approve', answeredBy: 'user', at: '2026-09-15T00:00:02.000Z' },
        ],
      },
    });

    const res = makeRes();
    const answers = [
      { itemId: 'write-1', verdict: 'approve' },
      { itemId: 'write-2', verdict: 'approve' },
    ];
    await agentModeController.generateResponse(
      makeReq({ userId: ownerId }, { deckId: 'deck-1', answers }),
      res,
    );

    expect(res.statusCode).toBe(200);
    expect(mockAgentModeService.submitApprovalDeckAnswers).toHaveBeenCalledWith(sessionId, 'deck-1', answers, 'user');
    expect(mockWorkerService.runInWorker).toHaveBeenCalledTimes(1);
    const workerArgs = (mockWorkerService.runInWorker as jest.Mock).mock.calls[0][0];
    expect(workerArgs.messageContent).toContain('Approval deck outcome');
    expect(workerArgs.messageContent).toContain('fully_applied');
    expect(workerArgs.messageContent).toContain('id-AS_1');
  });

  it('ENG-1635/1644 (found live 2026-09-18): a partially_applied/unapplied outcome includes an explicit instruction not to silently retry an identical failed write', async () => {
    mockChatbotDb.getChatSession.mockResolvedValue(sessionWith(pendingDeck()) as any);
    (mockAgentModeService as any).submitApprovalDeckAnswers.mockResolvedValue({
      outcome: 'submitted',
      run: { runId: 'run-1' },
      summary: {
        status: 'unapplied',
        items: [
          { stepId: 'write-1', status: 'failed', error: 'Your ad set budget must be more than ₹94.91 or your ads may not deliver. (Meta code 100, subcode 1885272)' },
          { stepId: 'write-2', status: 'failed', error: 'Your ad set budget must be more than ₹94.91 or your ads may not deliver. (Meta code 100, subcode 1885272)' },
        ],
      },
      answeredDeck: {
        ...pendingDeck(),
        status: 'answered',
        answers: [
          { itemId: 'write-1', verdict: 'approve', answeredBy: 'user', at: '2026-09-15T00:00:02.000Z' },
          { itemId: 'write-2', verdict: 'approve', answeredBy: 'user', at: '2026-09-15T00:00:02.000Z' },
        ],
      },
    });

    const res = makeRes();
    const answers = [
      { itemId: 'write-1', verdict: 'approve' },
      { itemId: 'write-2', verdict: 'approve' },
    ];
    await agentModeController.generateResponse(
      makeReq({ userId: ownerId }, { deckId: 'deck-1', answers }),
      res,
    );

    expect(res.statusCode).toBe(200);
    const workerArgs = (mockWorkerService.runInWorker as jest.Mock).mock.calls[0][0];
    expect(workerArgs.messageContent).toContain('unapplied');
    expect(workerArgs.messageContent).toContain('budget must be more than ₹94.91');
    expect(workerArgs.messageContent).toContain('Do NOT silently re-propose an identical write that already failed.');
  });

  it('ENG-1635/1644 round 6: the persisted/displayed user message is the clean label, byte-for-byte — no outcome JSON leaked onto it', async () => {
    mockChatbotDb.getChatSession.mockResolvedValue(sessionWith(pendingDeck()) as any);
    (mockAgentModeService as any).submitApprovalDeckAnswers.mockResolvedValue({
      outcome: 'submitted',
      run: { runId: 'run-1' },
      summary: {
        status: 'fully_applied',
        items: [
          { stepId: 'write-1', status: 'verified', appliedObjectId: 'id-AS_1' },
          { stepId: 'write-2', status: 'verified', appliedObjectId: 'id-AS_2' },
        ],
      },
      answeredDeck: {
        ...pendingDeck(),
        status: 'answered',
        answers: [
          { itemId: 'write-1', verdict: 'approve', answeredBy: 'user', at: '2026-09-15T00:00:02.000Z' },
          { itemId: 'write-2', verdict: 'approve', answeredBy: 'user', at: '2026-09-15T00:00:02.000Z' },
        ],
      },
    });

    const res = makeRes();
    const answers = [
      { itemId: 'write-1', verdict: 'approve' },
      { itemId: 'write-2', verdict: 'approve' },
    ];
    await agentModeController.generateResponse(
      makeReq({ userId: ownerId }, { deckId: 'deck-1', answers }, 'Approved all 2'),
      res,
    );

    expect(res.statusCode).toBe(200);
    // The clean label the frontend sent is exactly what's persisted — no JSON appended.
    const persistedCall = mockChatbotDb.addMessageToSession.mock.calls.find((call) => call[1]?.role === 'user');
    expect(persistedCall).toBeDefined();
    expect(persistedCall![1]).toEqual(expect.objectContaining({ content: 'Approved all 2' }));
    expect(persistedCall![1].content).not.toContain('Approval deck outcome');
    // The full detail still reaches the LLM-only channel.
    const workerArgs = (mockWorkerService.runInWorker as jest.Mock).mock.calls[0][0];
    expect(workerArgs.messageContent).toContain('Approval deck outcome');
    expect(workerArgs.messageContent).toContain('fully_applied');
  });

  it('ENG-1635/1644: a comment verdict is threaded into the turn via the commented[] array, and never leaks onto the persisted user message', async () => {
    mockChatbotDb.getChatSession.mockResolvedValue(sessionWith(pendingDeck()) as any);
    (mockAgentModeService as any).submitApprovalDeckAnswers.mockResolvedValue({
      outcome: 'submitted',
      run: { runId: 'run-1' },
      summary: {
        status: 'partially_applied',
        items: [{ stepId: 'write-1', status: 'verified', appliedObjectId: 'id-AS_1' }],
      },
    });

    const res = makeRes();
    const answers = [
      { itemId: 'write-1', verdict: 'approve' },
      { itemId: 'write-2', verdict: 'comment', freeText: 'What budget should this use?' },
    ];
    await agentModeController.generateResponse(
      makeReq({ userId: ownerId }, { deckId: 'deck-1', answers }, 'Reviewed the deck'),
      res,
    );

    expect(res.statusCode).toBe(200);
    const workerArgs = (mockWorkerService.runInWorker as jest.Mock).mock.calls[0][0];
    expect(workerArgs.messageContent).toContain('commented');
    expect(workerArgs.messageContent).toContain('What budget should this use?');
    const persistedCall = mockChatbotDb.addMessageToSession.mock.calls.find((call) => call[1]?.role === 'user');
    expect(persistedCall).toBeDefined();
    expect(persistedCall![1]).toEqual(expect.objectContaining({ content: 'Reviewed the deck' }));
    expect(persistedCall![1].content).not.toContain('What budget should this use?');
  });

  it('gap 4: a rejected item with a correction has the free text injected into the turn', async () => {
    mockChatbotDb.getChatSession.mockResolvedValue(sessionWith(pendingDeck()) as any);
    (mockAgentModeService as any).submitApprovalDeckAnswers.mockResolvedValue({
      outcome: 'submitted',
      run: { runId: 'run-1' },
      summary: {
        status: 'fully_applied',
        items: [{ stepId: 'write-1', status: 'verified', appliedObjectId: 'id-AS_1' }],
      },
      answeredDeck: {
        ...pendingDeck(),
        status: 'answered',
        answers: [
          { itemId: 'write-1', verdict: 'approve', answeredBy: 'user', at: '2026-09-15T00:00:02.000Z' },
          { itemId: 'write-2', verdict: 'reject', freeText: 'Use LINK_CLICKS instead.', answeredBy: 'user', at: '2026-09-15T00:00:02.000Z' },
        ],
      },
    });

    const res = makeRes();
    const answers = [
      { itemId: 'write-1', verdict: 'approve' },
      { itemId: 'write-2', verdict: 'reject', freeText: 'Use LINK_CLICKS instead.' },
    ];
    await agentModeController.generateResponse(
      makeReq({ userId: ownerId }, { deckId: 'deck-1', answers }),
      res,
    );

    expect(res.statusCode).toBe(200);
    const workerArgs = (mockWorkerService.runInWorker as jest.Mock).mock.calls[0][0];
    expect(workerArgs.messageContent).toContain('rejectedWithCorrections');
    expect(workerArgs.messageContent).toContain('Use LINK_CLICKS instead.');
  });

  it('ENG-1635/1644 Task 36 (found live on env1): a pure question-deck (no write items) reports its ACTUAL selections, not "nothing_approved" — the exact dead-loop bug where Emma re-asked the same deck 3 times in a row', async () => {
    const questionDeck = {
      deckId: 'deck-q1',
      status: 'awaiting' as const,
      items: [
        {
          itemId: 'question-1', kind: 'plan_choice', question: 'Which objective?',
          options: [
            { id: 'leads', label: 'Leads (Recommended)', consequence: 'x', recommended: true, why: 'y' },
            { id: 'traffic', label: 'Traffic', consequence: 'z' },
          ],
        },
      ],
      createdAt: '2026-09-16T00:00:00.000Z',
      finalizedAt: '2026-09-16T00:00:01.000Z',
    };
    mockChatbotDb.getChatSession.mockResolvedValue(sessionWith(questionDeck as any) as any);
    (mockAgentModeService as any).submitApprovalDeckAnswers.mockResolvedValue({
      outcome: 'submitted',
      run: null,
      // A pure question-deck has zero write items, so approvedWriteItems() is
      // always [] and the real submitApprovalDeckAnswers always returns
      // summary: null here — this mock reproduces that exactly.
      summary: null,
      answeredDeck: {
        ...questionDeck,
        status: 'answered',
        answers: [{ itemId: 'question-1', verdict: 'leads', answeredBy: 'user', at: '2026-09-16T00:00:02.000Z' }],
      },
    });

    const res = makeRes();
    await agentModeController.generateResponse(
      makeReq({ userId: ownerId }, { deckId: 'deck-q1', answers: [{ itemId: 'question-1', verdict: 'leads' }] }),
      res,
    );

    expect(res.statusCode).toBe(200);
    const workerArgs = (mockWorkerService.runInWorker as jest.Mock).mock.calls[0][0];
    expect(workerArgs.messageContent).not.toContain('nothing_approved');
    expect(workerArgs.messageContent).toContain('selections');
    expect(workerArgs.messageContent).toContain('Leads (Recommended)');
  });

  it('no pending approval deck at all is a 409 APPROVAL_DECK_INVALID — never dispatches, never runs', async () => {
    mockChatbotDb.getChatSession.mockResolvedValue(sessionWith(undefined) as any);

    const res = makeRes();
    await agentModeController.generateResponse(
      makeReq({ userId: ownerId }, { deckId: 'deck-1', answers: [{ itemId: 'write-1', verdict: 'approve' }] }),
      res,
    );

    expect(res.statusCode).toBe(409);
    expect(res.body).toEqual(expect.objectContaining({ code: 'APPROVAL_DECK_INVALID' }));
    expect(mockAgentModeService.submitApprovalDeckAnswers).not.toHaveBeenCalled();
    expect(mockWorkerService.runInWorker).not.toHaveBeenCalled();
  });

  it('an invalid submission (submitApprovalDeckAnswers returns outcome:invalid) is a 409, never runs', async () => {
    mockChatbotDb.getChatSession.mockResolvedValue(sessionWith(pendingDeck()) as any);
    (mockAgentModeService as any).submitApprovalDeckAnswers.mockResolvedValue({
      outcome: 'invalid',
      reason: 'Missing answer for deck item write-2',
    });

    const res = makeRes();
    await agentModeController.generateResponse(
      makeReq({ userId: ownerId }, { deckId: 'deck-1', answers: [{ itemId: 'write-1', verdict: 'approve' }] }),
      res,
    );

    expect(res.statusCode).toBe(409);
    expect(res.body).toEqual(expect.objectContaining({ code: 'APPROVAL_DECK_INVALID', error: 'Missing answer for deck item write-2' }));
    expect(mockWorkerService.runInWorker).not.toHaveBeenCalled();
  });

  it('a lost race (submitApprovalDeckAnswers returns outcome:conflict) is a 409, never runs', async () => {
    mockChatbotDb.getChatSession.mockResolvedValue(sessionWith(pendingDeck()) as any);
    (mockAgentModeService as any).submitApprovalDeckAnswers.mockResolvedValue({ outcome: 'conflict' });

    const res = makeRes();
    await agentModeController.generateResponse(
      makeReq({ userId: ownerId }, { deckId: 'deck-1', answers: [{ itemId: 'write-1', verdict: 'approve' }] }),
      res,
    );

    expect(res.statusCode).toBe(409);
    expect(res.body).toEqual(expect.objectContaining({ code: 'APPROVAL_DECK_INVALID' }));
    expect(mockWorkerService.runInWorker).not.toHaveBeenCalled();
  });

  it('ownership wins: a non-owner posting a deck answer gets 403 and never reaches the deck channel', async () => {
    mockChatbotDb.getChatSession.mockResolvedValue(sessionWith(pendingDeck()) as any);

    const res = makeRes();
    await agentModeController.generateResponse(
      makeReq({ userId: attackerId }, { deckId: 'deck-1', answers: [{ itemId: 'write-1', verdict: 'approve' }] }),
      res,
    );

    expect(res.statusCode).toBe(403);
    expect(mockAgentModeService.submitApprovalDeckAnswers).not.toHaveBeenCalled();
    expect(mockWorkerService.runInWorker).not.toHaveBeenCalled();
  });

  it('a normal message with no deckAnswer never touches the deck channel', async () => {
    mockChatbotDb.getChatSession.mockResolvedValue(sessionWith(pendingDeck()) as any);

    const res = makeRes();
    await agentModeController.generateResponse(makeReq({ userId: ownerId }, undefined, 'just chatting'), res);

    expect(res.statusCode).toBe(200);
    expect(mockAgentModeService.submitApprovalDeckAnswers).not.toHaveBeenCalled();
    expect(mockWorkerService.runInWorker).toHaveBeenCalledTimes(1);
  });
});

describe('generateResponse — approval-deck cancel channel (ENG-1635/1644 Phase 1b)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    activeSessionGenerations.clear();
    (mockChatbotDb as any).getMessagesFromMessagesTable.mockResolvedValue([]);
    mockChatbotDb.addMessageToSession.mockResolvedValue(undefined as any);
    mockChatbotDb.addMessagesToSession.mockResolvedValue(undefined as any);
    mockChatbotDb.updateSessionTitle.mockResolvedValue(undefined as any);
    mockWorkerService.runInWorker.mockResolvedValue(workerResult as any);
  });

  it('clears the deck to null via updateSessionApprovalDeck and injects a cancel directive into the turn, never onto the persisted user message', async () => {
    mockChatbotDb.getChatSession.mockResolvedValue(sessionWith(pendingDeck()) as any);
    (mockChatbotDb as any).updateSessionApprovalDeck.mockResolvedValue({ sessionId } as any);

    const res = makeRes();
    await agentModeController.generateResponse(
      makeCancelReq({ userId: ownerId }, { deckId: 'deck-1' }, 'Cancelled the review.'),
      res,
    );

    expect(res.statusCode).toBe(200);
    expect((mockChatbotDb as any).updateSessionApprovalDeck).toHaveBeenCalledWith(
      sessionId,
      null,
      { requireStillAwaiting: 'deck-1' },
    );
    expect(mockWorkerService.runInWorker).toHaveBeenCalledTimes(1);
    const workerArgs = (mockWorkerService.runInWorker as jest.Mock).mock.calls[0][0];
    expect(workerArgs.messageContent).toContain('Approval deck cancelled');

    const persistedCall = mockChatbotDb.addMessageToSession.mock.calls.find((call) => call[1]?.role === 'user');
    expect(persistedCall).toBeDefined();
    expect(persistedCall![1]).toEqual(expect.objectContaining({ content: 'Cancelled the review.' }));
    expect(persistedCall![1].content).not.toContain('Approval deck cancelled');
  });

  it('ENG-1635/1644 Task 35: cancelling a write-deck with a dropped question forwards it in the cancel directive, never onto the persisted user message', async () => {
    const deckWithDropped = { ...pendingDeck(), droppedQuestionDeckPayload: [{ question: 'What daily budget?', options: [] }] };
    mockChatbotDb.getChatSession.mockResolvedValue(sessionWith(deckWithDropped) as any);
    (mockChatbotDb as any).updateSessionApprovalDeck.mockResolvedValue({ sessionId } as any);

    const res = makeRes();
    await agentModeController.generateResponse(
      makeCancelReq({ userId: ownerId }, { deckId: 'deck-1' }, 'Cancelled the review.'),
      res,
    );

    expect(res.statusCode).toBe(200);
    const workerArgs = (mockWorkerService.runInWorker as jest.Mock).mock.calls[0][0];
    expect(workerArgs.messageContent).toContain('dropped 1');
    expect(workerArgs.messageContent).toContain('What daily budget?');

    const persistedCall = mockChatbotDb.addMessageToSession.mock.calls.find((call) => call[1]?.role === 'user');
    expect(persistedCall).toBeDefined();
    expect(persistedCall![1]).toEqual(expect.objectContaining({ content: 'Cancelled the review.' }));
    expect(persistedCall![1].content).not.toContain('What daily budget?');
  });

  it('no pending approval deck at all is a 409 APPROVAL_DECK_INVALID — never clears anything, never runs', async () => {
    mockChatbotDb.getChatSession.mockResolvedValue(sessionWith(undefined) as any);

    const res = makeRes();
    await agentModeController.generateResponse(makeCancelReq({ userId: ownerId }, { deckId: 'deck-1' }), res);

    expect(res.statusCode).toBe(409);
    expect(res.body).toEqual(expect.objectContaining({ code: 'APPROVAL_DECK_INVALID' }));
    expect((mockChatbotDb as any).updateSessionApprovalDeck).not.toHaveBeenCalled();
    expect(mockWorkerService.runInWorker).not.toHaveBeenCalled();
  });

  it('a deckId that does not match the session\'s live deck is a 409, never clears anything', async () => {
    mockChatbotDb.getChatSession.mockResolvedValue(sessionWith(pendingDeck()) as any); // live deck is 'deck-1'

    const res = makeRes();
    await agentModeController.generateResponse(makeCancelReq({ userId: ownerId }, { deckId: 'deck-stale' }), res);

    expect(res.statusCode).toBe(409);
    expect(res.body).toEqual(expect.objectContaining({ code: 'APPROVAL_DECK_INVALID' }));
    expect((mockChatbotDb as any).updateSessionApprovalDeck).not.toHaveBeenCalled();
    expect(mockWorkerService.runInWorker).not.toHaveBeenCalled();
  });

  it('a lost race (updateSessionApprovalDeck returns null — already answered/cancelled concurrently) is a 409, never runs', async () => {
    mockChatbotDb.getChatSession.mockResolvedValue(sessionWith(pendingDeck()) as any);
    (mockChatbotDb as any).updateSessionApprovalDeck.mockResolvedValue(null);

    const res = makeRes();
    await agentModeController.generateResponse(makeCancelReq({ userId: ownerId }, { deckId: 'deck-1' }), res);

    expect(res.statusCode).toBe(409);
    expect(res.body).toEqual(expect.objectContaining({ code: 'APPROVAL_DECK_INVALID' }));
    expect(mockWorkerService.runInWorker).not.toHaveBeenCalled();
  });

  it('ownership wins: a non-owner posting a deck cancel gets 403 and never reaches the cancel channel', async () => {
    mockChatbotDb.getChatSession.mockResolvedValue(sessionWith(pendingDeck()) as any);

    const res = makeRes();
    await agentModeController.generateResponse(makeCancelReq({ userId: attackerId }, { deckId: 'deck-1' }), res);

    expect(res.statusCode).toBe(403);
    expect((mockChatbotDb as any).updateSessionApprovalDeck).not.toHaveBeenCalled();
    expect(mockWorkerService.runInWorker).not.toHaveBeenCalled();
  });
});

// ENG-2962: an outside agent on Emma's MCP server answers cards through emma_answer_question_deck, which reaches this route as a
// self-call (isSelfCall, set by the auth middleware for `_svc` tokens). Reproduced on the test environment 2026-11-12: the agent
// approved Emma's Smartlead release card itself. A self-call may not approve a card only a person may approve.
describe('generateResponse — person-only approvals refused for MCP self-calls (ENG-2962)', () => {
  const card = (kind: string, extra: Record<string, unknown> = {}) => ({
    deckId: 'deck-1',
    status: 'awaiting' as const,
    items: [{ itemId: 'question-1', kind, question: 'Approve?', ...extra }],
    createdAt: '2026-11-12T00:00:00.000Z',
    finalizedAt: '2026-11-12T00:00:01.000Z',
  });
  const selfCallReq = (deckAnswer: any) => Object.assign(makeReq({ userId: ownerId }, deckAnswer), { isSelfCall: true });
  const submitted = (deck: any) => ({ outcome: 'submitted', run: null, summary: null, answeredDeck: { ...deck, status: 'answered', answers: [] } });

  beforeEach(() => {
    jest.clearAllMocks();
    activeSessionGenerations.clear();
    (mockChatbotDb as any).getMessagesFromMessagesTable.mockResolvedValue([]);
    mockChatbotDb.addMessageToSession.mockResolvedValue(undefined as any);
    mockChatbotDb.addMessagesToSession.mockResolvedValue(undefined as any);
    mockChatbotDb.updateSessionTitle.mockResolvedValue(undefined as any);
    mockWorkerService.runInWorker.mockResolvedValue(workerResult as any);
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it.each([
    ['Smartlead push or release', 'smartlead_push_approval:release:abc:0123456789abcdef', 'approve', {}],
    ['hot-lead call', 'hot_lead_call_approval:call:abc:0123456789abcdef', 'approve', {}],
    ['CRM sequence activation', 'crm_sequence_activation:seq-1:tok', 'activate', {}],
    ['paused Meta bundle', 'meta_write', 'approve', { metaWriteDispatch: { action: 'CREATE_PAUSED_BUNDLE' } }],
  ])('a self-call approving a %s card is refused (403), nothing is submitted and Emma does not run', async (_label, kind, verdict, extra) => {
    mockChatbotDb.getChatSession.mockResolvedValue(sessionWith(card(kind, extra) as any) as any);
    const res = makeRes();
    await agentModeController.generateResponse(selfCallReq({ deckId: 'deck-1', answers: [{ itemId: 'question-1', verdict }] }), res);
    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual(expect.objectContaining({ code: 'APPROVAL_NEEDS_PERSON' }));
    expect(res.body.error).toContain(`/agent-mode/${sessionId}`);
    expect(mockAgentModeService.submitApprovalDeckAnswers).not.toHaveBeenCalled();
    expect(mockWorkerService.runInWorker).not.toHaveBeenCalled();
  });

  it('a self-call may still decline a person-only card', async () => {
    const deck = card('smartlead_push_approval:start:abc:0123456789abcdef');
    mockChatbotDb.getChatSession.mockResolvedValue(sessionWith(deck as any) as any);
    (mockAgentModeService as any).submitApprovalDeckAnswers.mockResolvedValue(submitted(deck));
    const res = makeRes();
    const answers = [{ itemId: 'question-1', verdict: 'decline' }];
    await agentModeController.generateResponse(selfCallReq({ deckId: 'deck-1', answers }), res);
    expect(res.statusCode).toBe(200);
    expect(mockAgentModeService.submitApprovalDeckAnswers).toHaveBeenCalledWith(sessionId, 'deck-1', answers, 'user');
  });

  it('a self-call may still answer any other card (e.g. a Meta write deck)', async () => {
    const deck = pendingDeck();
    mockChatbotDb.getChatSession.mockResolvedValue(sessionWith(deck) as any);
    (mockAgentModeService as any).submitApprovalDeckAnswers.mockResolvedValue(submitted(deck));
    const res = makeRes();
    await agentModeController.generateResponse(selfCallReq({ deckId: 'deck-1', answers: [{ itemId: 'write-1', verdict: 'approve' }, { itemId: 'write-2', verdict: 'approve' }] }), res);
    expect(res.statusCode).toBe(200);
    expect(mockAgentModeService.submitApprovalDeckAnswers).toHaveBeenCalled();
  });

  it('a person in the app (not a self-call) still approves a person-only card', async () => {
    const deck = card('smartlead_push_approval:start:abc:0123456789abcdef');
    mockChatbotDb.getChatSession.mockResolvedValue(sessionWith(deck as any) as any);
    (mockAgentModeService as any).submitApprovalDeckAnswers.mockResolvedValue(submitted(deck));
    const res = makeRes();
    await agentModeController.generateResponse(makeReq({ userId: ownerId }, { deckId: 'deck-1', answers: [{ itemId: 'question-1', verdict: 'approve' }] }), res);
    expect(res.statusCode).toBe(200);
    expect(mockAgentModeService.submitApprovalDeckAnswers).toHaveBeenCalled();
  });
});
