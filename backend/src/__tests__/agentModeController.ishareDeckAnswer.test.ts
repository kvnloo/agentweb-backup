/**
 * POST /api/agent-mode/ishare/:shareId/generate — approval-deck answer/cancel
 * channel on a shared link (ENG-1635/1644 Part F).
 *
 * Mirrors agentModeController.deckAnswer.test.ts's scaffolding for the
 * authenticated path, combined with agentModeController.ishareUsageGate.test.ts's
 * mock setup for generateSharedResponse itself. The one behavior this suite
 * exists to pin that the authenticated path does NOT need: an anonymous
 * shared-link visitor may answer a genuine question deck, but must be refused
 * with a 403 the instant the deck carries a real Meta write
 * (metaWriteManifestDigest) or an immutable item (e.g. the campaign-objective
 * reconfirmation) — deckAnswer.answers is never even read for a blocked deck.
 */
import { Request, Response } from 'express';

jest.mock('../services/chatbotService', () => ({
  chatbotDb: {
    getChatSession: jest.fn(),
    addMessageToSession: jest.fn(),
    addMessagesToSession: jest.fn(),
    updateSessionTitle: jest.fn(),
    updateSessionLlmModel: jest.fn(),
    getMessagesFromMessagesTable: jest.fn(),
    updateSessionApprovalDeck: jest.fn(),
    getChatSessionRecord: jest.fn(),
  },
}));

jest.mock('../services/agentModeService', () => ({
  agentModeService: {
    default_model: 'gpt-5-chat-2',
    getDefaultModel: jest.fn(),
    getMarketingSystemPrompt: jest.fn(),
    generateSessionTitle: jest.fn(),
    submitApprovalDeckAnswers: jest.fn(),
  },
}));

jest.mock('../services/generateMarketingResponseWorkerService', () => ({
  generateMarketingResponseWorkerService: {
    runInWorker: jest.fn(),
    cancelSession: jest.fn(),
  },
}));

jest.mock('../utils/sseProgress', () => ({
  progressStore: {
    delete: jest.fn().mockReturnValue(true),
    has: jest.fn().mockReturnValue(false),
    add: jest.fn(),
  },
  getLatestProgress: jest.fn().mockReturnValue(undefined),
  requestCancel: jest.fn(),
  clearCancel: jest.fn(),
  isCancelled: jest.fn().mockReturnValue(false),
  emitProgress: jest.fn(),
}));

jest.mock('../services/tokenUsageService', () => ({
  checkTokenUsage: jest.fn().mockResolvedValue({
    allowed: true, warning: false, used: 0, allowance: null,
    bonus: 0, effectiveAllowance: null, percentUsed: 0, month: '2026-09',
  }),
}));

import { chatbotDb } from '../services/chatbotService';
import { agentModeService } from '../services/agentModeService';
import { generateMarketingResponseWorkerService } from '../services/generateMarketingResponseWorkerService';
import { progressStore } from '../utils/sseProgress';
import { agentModeController } from '../controllers/agentModeController';

const mockChatbotDb = chatbotDb as jest.Mocked<typeof chatbotDb>;
const mockAgentModeService = agentModeService as jest.Mocked<typeof agentModeService>;
const mockWorkerService = generateMarketingResponseWorkerService as jest.Mocked<typeof generateMarketingResponseWorkerService>;
const mockProgressStore = progressStore as jest.Mocked<typeof progressStore>;

const SESSION_ID = 'ishare-session-deck';
const CONVERSABLE_TOKEN = 'tok-deck-abc';
const OWNER_USER_ID = 'share-owner-user-id';

function questionDeck() {
  return {
    deckId: 'deck-q1',
    status: 'awaiting' as const,
    items: [
      {
        itemId: 'question-1', kind: 'plan_choice', question: 'Which objective?',
        options: [
          { id: 'leads', label: 'Leads', recommended: true },
          { id: 'traffic', label: 'Traffic' },
        ],
      },
    ],
    createdAt: '2026-09-20T00:00:00.000Z',
    finalizedAt: '2026-09-20T00:00:01.000Z',
  };
}

function writeDeck() {
  return {
    deckId: 'deck-write',
    status: 'awaiting' as const,
    items: [
      { itemId: 'write-1', kind: 'meta_write', question: 'Create ad set AS_1?', metaWriteManifestDigest: 'digest-1' },
    ],
    createdAt: '2026-09-20T00:00:00.000Z',
    finalizedAt: '2026-09-20T00:00:01.000Z',
  };
}

function immutableDeck() {
  return {
    deckId: 'deck-objective',
    status: 'awaiting' as const,
    items: [
      {
        itemId: 'objective-1', kind: 'meta_objective', question: 'Confirm the campaign objective?', immutable: true,
        options: [
          { id: 'leads', label: 'Leads', recommended: true },
          { id: 'traffic', label: 'Traffic' },
        ],
      },
    ],
    createdAt: '2026-09-20T00:00:00.000Z',
    finalizedAt: '2026-09-20T00:00:01.000Z',
  };
}

function sessionWith(pendingApprovalDeck: any) {
  return {
    sessionId: SESSION_ID,
    userId: OWNER_USER_ID,
    title: 'Shared Session',
    messages: [],
    createdAt: '2026-09-20T00:00:00Z',
    updatedAt: '2026-09-20T00:00:00Z',
    llmModel: 'gpt-5-chat-2',
    interactiveShareMetadata: {
      isActive: true,
      token: CONVERSABLE_TOKEN,
      sharedAt: '2026-09-20T00:00:00Z',
      expiresAt: '2099-01-01T00:00:00Z',
    },
    ...(pendingApprovalDeck ? { pendingApprovalDeck } : {}),
  };
}

const workerResponse = {
  content: 'Got it',
  toolCalls: [],
  knowledgeBaseQueries: [],
  sources: [],
  responseMessages: [],
};

function makeReq(body: Record<string, unknown>) {
  return {
    params: { shareId: SESSION_ID },
    query: { conversable: CONVERSABLE_TOKEN },
    body: { userMessage: 'Reviewed the deck', attachments: [], ...body },
    ip: '203.0.113.42',
    headers: { 'user-agent': 'Mozilla/5.0 (Test Browser)' },
  } as unknown as Request;
}

function makeRes() {
  return {
    json: jest.fn(),
    status: jest.fn().mockReturnThis(),
  } as unknown as Response;
}

describe('generateSharedResponse — approval-deck answer channel (ENG-1635/1644 Part F)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockAgentModeService.getDefaultModel.mockResolvedValue('gpt-5-chat-2');
    mockAgentModeService.getMarketingSystemPrompt.mockResolvedValue('System prompt');
    mockAgentModeService.generateSessionTitle.mockResolvedValue('Title');
    mockWorkerService.runInWorker.mockResolvedValue(workerResponse);
    mockProgressStore.delete.mockReturnValue(true);
    (mockProgressStore as any).has.mockReturnValue(false);
    (mockProgressStore as any).add.mockReturnValue(undefined);
    (mockChatbotDb.addMessageToSession as jest.Mock).mockResolvedValue(undefined);
    (mockChatbotDb.updateSessionTitle as jest.Mock).mockResolvedValue(undefined);
    (mockChatbotDb.updateSessionLlmModel as jest.Mock).mockResolvedValue(undefined);
    (mockChatbotDb as any).getMessagesFromMessagesTable.mockResolvedValue([]);
  });

  it('a genuine question deck is answerable — dispatches through submitApprovalDeckAnswers and injects the outcome into the turn', async () => {
    mockChatbotDb.getChatSession.mockResolvedValue(sessionWith(questionDeck()) as any);
    (mockAgentModeService as any).submitApprovalDeckAnswers.mockResolvedValue({
      outcome: 'submitted',
      run: null,
      summary: null,
      answeredDeck: {
        ...questionDeck(),
        status: 'answered',
        answers: [{ itemId: 'question-1', verdict: 'leads', answeredBy: 'user', at: '2026-09-20T00:00:02.000Z' }],
      },
    });

    const res = makeRes();
    const answers = [{ itemId: 'question-1', verdict: 'leads' }];
    await agentModeController.generateSharedResponse(
      makeReq({ deckAnswer: { deckId: 'deck-q1', answers } }),
      res,
    );

    expect(res.status).not.toHaveBeenCalledWith(403);
    expect(res.status).not.toHaveBeenCalledWith(409);
    expect(mockAgentModeService.submitApprovalDeckAnswers).toHaveBeenCalledWith(SESSION_ID, 'deck-q1', answers, 'user');
    expect(mockWorkerService.runInWorker).toHaveBeenCalledTimes(1);
    const workerArgs = (mockWorkerService.runInWorker as jest.Mock).mock.calls[0][0];
    expect(workerArgs.messageContent).toContain('Approval deck outcome');
    expect(workerArgs.messageContent).toContain('selections');
  });

  it('a Meta write deck is refused with 403 — never reaches submitApprovalDeckAnswers, never runs', async () => {
    mockChatbotDb.getChatSession.mockResolvedValue(sessionWith(writeDeck()) as any);

    const res = makeRes();
    await agentModeController.generateSharedResponse(
      makeReq({ deckAnswer: { deckId: 'deck-write', answers: [{ itemId: 'write-1', verdict: 'approve' }] } }),
      res,
    );

    expect(res.status).toHaveBeenCalledWith(403);
    const body = (res.json as jest.Mock).mock.calls[0][0];
    expect(body.code).toBe('APPROVAL_DECK_FORBIDDEN');
    expect(mockAgentModeService.submitApprovalDeckAnswers).not.toHaveBeenCalled();
    expect(mockWorkerService.runInWorker).not.toHaveBeenCalled();
  });

  it('an immutable item (campaign-objective reconfirmation) is refused with 403 even though it carries options like a plain question', async () => {
    mockChatbotDb.getChatSession.mockResolvedValue(sessionWith(immutableDeck()) as any);

    const res = makeRes();
    await agentModeController.generateSharedResponse(
      makeReq({ deckAnswer: { deckId: 'deck-objective', answers: [{ itemId: 'objective-1', verdict: 'leads' }] } }),
      res,
    );

    expect(res.status).toHaveBeenCalledWith(403);
    const body = (res.json as jest.Mock).mock.calls[0][0];
    expect(body.code).toBe('APPROVAL_DECK_FORBIDDEN');
    expect(mockAgentModeService.submitApprovalDeckAnswers).not.toHaveBeenCalled();
    expect(mockWorkerService.runInWorker).not.toHaveBeenCalled();
  });

  it('a mixed deck (one blocked item among others) is refused entirely — the atomic all-or-nothing gate, not a partial answer', async () => {
    const mixed = {
      ...questionDeck(),
      deckId: 'deck-mixed',
      items: [...questionDeck().items, ...writeDeck().items],
    };
    mockChatbotDb.getChatSession.mockResolvedValue(sessionWith(mixed) as any);

    const res = makeRes();
    await agentModeController.generateSharedResponse(
      makeReq({ deckAnswer: { deckId: 'deck-mixed', answers: [{ itemId: 'question-1', verdict: 'leads' }, { itemId: 'write-1', verdict: 'approve' }] } }),
      res,
    );

    expect(res.status).toHaveBeenCalledWith(403);
    expect(mockAgentModeService.submitApprovalDeckAnswers).not.toHaveBeenCalled();
  });

  it('no pending approval deck at all is a 409 APPROVAL_DECK_INVALID — never dispatches, never runs', async () => {
    mockChatbotDb.getChatSession.mockResolvedValue(sessionWith(undefined) as any);

    const res = makeRes();
    await agentModeController.generateSharedResponse(
      makeReq({ deckAnswer: { deckId: 'deck-q1', answers: [{ itemId: 'question-1', verdict: 'leads' }] } }),
      res,
    );

    expect(res.status).toHaveBeenCalledWith(409);
    expect(mockAgentModeService.submitApprovalDeckAnswers).not.toHaveBeenCalled();
    expect(mockWorkerService.runInWorker).not.toHaveBeenCalled();
  });

  it('a deckId that does not match the session\'s live deck is a 409, never dispatches', async () => {
    mockChatbotDb.getChatSession.mockResolvedValue(sessionWith(questionDeck()) as any);

    const res = makeRes();
    await agentModeController.generateSharedResponse(
      makeReq({ deckAnswer: { deckId: 'deck-stale', answers: [{ itemId: 'question-1', verdict: 'leads' }] } }),
      res,
    );

    expect(res.status).toHaveBeenCalledWith(409);
    expect(mockAgentModeService.submitApprovalDeckAnswers).not.toHaveBeenCalled();
  });

  it('an invalid submission (submitApprovalDeckAnswers returns outcome:invalid) is a 409, never runs', async () => {
    mockChatbotDb.getChatSession.mockResolvedValue(sessionWith(questionDeck()) as any);
    (mockAgentModeService as any).submitApprovalDeckAnswers.mockResolvedValue({
      outcome: 'invalid',
      reason: 'Missing answer for deck item question-1',
    });

    const res = makeRes();
    await agentModeController.generateSharedResponse(
      makeReq({ deckAnswer: { deckId: 'deck-q1', answers: [] } }),
      res,
    );

    expect(res.status).toHaveBeenCalledWith(409);
    expect(mockWorkerService.runInWorker).not.toHaveBeenCalled();
  });

  it('a normal message with no deckAnswer never touches the deck channel', async () => {
    mockChatbotDb.getChatSession.mockResolvedValue(sessionWith(questionDeck()) as any);

    const res = makeRes();
    await agentModeController.generateSharedResponse(makeReq({}), res);

    expect(mockAgentModeService.submitApprovalDeckAnswers).not.toHaveBeenCalled();
    expect(mockWorkerService.runInWorker).toHaveBeenCalledTimes(1);
  });
});

describe('generateSharedResponse — approval-deck cancel channel (ENG-1635/1644 Part F)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockAgentModeService.getDefaultModel.mockResolvedValue('gpt-5-chat-2');
    mockAgentModeService.getMarketingSystemPrompt.mockResolvedValue('System prompt');
    mockAgentModeService.generateSessionTitle.mockResolvedValue('Title');
    mockWorkerService.runInWorker.mockResolvedValue(workerResponse);
    mockProgressStore.delete.mockReturnValue(true);
    (mockProgressStore as any).has.mockReturnValue(false);
    (mockProgressStore as any).add.mockReturnValue(undefined);
    (mockChatbotDb.addMessageToSession as jest.Mock).mockResolvedValue(undefined);
    (mockChatbotDb.updateSessionTitle as jest.Mock).mockResolvedValue(undefined);
    (mockChatbotDb.updateSessionLlmModel as jest.Mock).mockResolvedValue(undefined);
    (mockChatbotDb as any).getMessagesFromMessagesTable.mockResolvedValue([]);
  });

  it('cancel is allowed unconditionally — even a write-deck can be cancelled from a shared link, since nothing executes', async () => {
    mockChatbotDb.getChatSession.mockResolvedValue(sessionWith(writeDeck()) as any);
    (mockChatbotDb as any).updateSessionApprovalDeck.mockResolvedValue({ sessionId: SESSION_ID } as any);

    const res = makeRes();
    await agentModeController.generateSharedResponse(
      makeReq({ deckCancel: { deckId: 'deck-write' }, userMessage: 'Cancelled the review.' }),
      res,
    );

    expect(res.status).not.toHaveBeenCalledWith(403);
    expect((mockChatbotDb as any).updateSessionApprovalDeck).toHaveBeenCalledWith(
      SESSION_ID,
      null,
      { requireStillAwaiting: 'deck-write' },
    );
    expect(mockWorkerService.runInWorker).toHaveBeenCalledTimes(1);
    const workerArgs = (mockWorkerService.runInWorker as jest.Mock).mock.calls[0][0];
    expect(workerArgs.messageContent).toContain('Approval deck cancelled');
  });

  it('no pending approval deck at all is a 409 — never clears anything, never runs', async () => {
    mockChatbotDb.getChatSession.mockResolvedValue(sessionWith(undefined) as any);

    const res = makeRes();
    await agentModeController.generateSharedResponse(makeReq({ deckCancel: { deckId: 'deck-q1' } }), res);

    expect(res.status).toHaveBeenCalledWith(409);
    expect((mockChatbotDb as any).updateSessionApprovalDeck).not.toHaveBeenCalled();
    expect(mockWorkerService.runInWorker).not.toHaveBeenCalled();
  });

  it('a lost race (updateSessionApprovalDeck returns null) is a 409, never runs', async () => {
    mockChatbotDb.getChatSession.mockResolvedValue(sessionWith(questionDeck()) as any);
    (mockChatbotDb as any).updateSessionApprovalDeck.mockResolvedValue(null);

    const res = makeRes();
    await agentModeController.generateSharedResponse(makeReq({ deckCancel: { deckId: 'deck-q1' } }), res);

    expect(res.status).toHaveBeenCalledWith(409);
    expect(mockWorkerService.runInWorker).not.toHaveBeenCalled();
  });

  // ENG-3170: Full control is everything the customer can do, including approving a write or a locked decision.
  describe('a link whose owner turned on FULL CONTROL', () => {
    const link = (allowSensitiveActions: boolean | undefined) =>
      ({ sessionId: SESSION_ID, interactiveShareMetadata: { isActive: true, token: 'tok', sharedAt: '2026-11-01T00:00:00.000Z', ...(allowSensitiveActions === undefined ? {} : { allowSensitiveActions }) } }) as any;

    it.each([
      ['a Meta write deck', () => writeDeck(), 'deck-write', [{ itemId: 'write-1', verdict: 'approve' }]],
      ['an immutable item (the campaign objective)', () => immutableDeck(), 'deck-objective', [{ itemId: 'objective-1', verdict: 'leads' }]],
    ])('lets the visitor answer %s, and reads the link with a consistent read', async (_label, deck, deckId, answers) => {
      mockChatbotDb.getChatSession.mockResolvedValue(sessionWith(deck()) as any);
      (mockChatbotDb as any).getChatSessionRecord.mockResolvedValue(link(true));
      const res = makeRes();
      await agentModeController.generateSharedResponse(makeReq({ deckAnswer: { deckId, answers } }), res);
      expect(res.status).not.toHaveBeenCalledWith(403);
      expect((mockChatbotDb as any).getChatSessionRecord).toHaveBeenCalledWith(SESSION_ID, true);
      expect(mockAgentModeService.submitApprovalDeckAnswers).toHaveBeenCalledWith(SESSION_ID, deckId, answers, 'user');
    });

    it('lets the visitor answer a mixed deck too (the deck is still answered whole)', async () => {
      const mixed = { ...questionDeck(), deckId: 'deck-mixed', items: [...questionDeck().items, ...writeDeck().items] };
      mockChatbotDb.getChatSession.mockResolvedValue(sessionWith(mixed) as any);
      (mockChatbotDb as any).getChatSessionRecord.mockResolvedValue(link(true));
      const res = makeRes();
      await agentModeController.generateSharedResponse(makeReq({ deckAnswer: { deckId: 'deck-mixed', answers: [{ itemId: 'question-1', verdict: 'leads' }, { itemId: 'write-1', verdict: 'approve' }] } }), res);
      expect(res.status).not.toHaveBeenCalledWith(403);
      expect(mockAgentModeService.submitApprovalDeckAnswers).toHaveBeenCalledTimes(1);
    });

    const linkWith = (extra: Record<string, unknown>) =>
      ({ sessionId: SESSION_ID, interactiveShareMetadata: { isActive: true, token: 'tok', sharedAt: new Date(Date.now() - 86_400_000).toISOString(), ...extra } }) as any;

    it.each([
      ['a link made before the setting existed, with a share-dialog lifetime (it reads "sensitive tools allowed" but never FULL control: its visitors were refused this answer before)', () => linkWith({ expiresAt: new Date(Date.now() + 6 * 86_400_000).toISOString() })],
      ['full control is on but the owner has stopped sharing (isActive false)', () => linkWith({ isActive: false, allowSensitiveActions: true })],
      ['full control is on but the link has expired', () => linkWith({ expiresAt: new Date(Date.now() - 60_000).toISOString(), allowSensitiveActions: true })],
      ['the stored choice is not a boolean', () => linkWith({ allowSensitiveActions: 'true' })],
    ])('still refuses with 403 when %s', async (_label, record) => {
      mockChatbotDb.getChatSession.mockResolvedValue(sessionWith(writeDeck()) as any);
      (mockChatbotDb as any).getChatSessionRecord.mockResolvedValue(record());
      const res = makeRes();
      await agentModeController.generateSharedResponse(makeReq({ deckAnswer: { deckId: 'deck-write', answers: [{ itemId: 'write-1', verdict: 'approve' }] } }), res);
      expect(res.status).toHaveBeenCalledWith(403);
      expect(mockAgentModeService.submitApprovalDeckAnswers).not.toHaveBeenCalled();
    });

    it('a write that FAILED gets the same instruction the owner\'s own route gives (read the error, do not re-propose the identical write)', async () => {
      mockChatbotDb.getChatSession.mockResolvedValue(sessionWith(writeDeck()) as any);
      (mockChatbotDb as any).getChatSessionRecord.mockResolvedValue(link(true));
      (mockAgentModeService as any).submitApprovalDeckAnswers.mockResolvedValue({
        outcome: 'submitted',
        run: null,
        summary: { status: 'unapplied', items: [{ itemId: 'write-1', status: 'failed', error: 'budget is below the account minimum' }] },
        answeredDeck: { ...writeDeck(), status: 'answered', answers: [{ itemId: 'write-1', verdict: 'approve', answeredBy: 'user', at: '2026-09-20T00:00:02.000Z' }] },
      });
      const res = makeRes();
      await agentModeController.generateSharedResponse(makeReq({ deckAnswer: { deckId: 'deck-write', answers: [{ itemId: 'write-1', verdict: 'approve' }] } }), res);
      expect(res.status).not.toHaveBeenCalledWith(403);
      const workerArgs = (mockWorkerService.runInWorker as jest.Mock).mock.calls[0][0];
      expect(workerArgs.messageContent).toContain('"status":"unapplied"');
      expect(workerArgs.messageContent).toContain('budget is below the account minimum');
      expect(workerArgs.messageContent).toContain('Do NOT silently re-propose an identical write that already failed.');
    });

    it('a question deck answer carries no failure instruction', async () => {
      mockChatbotDb.getChatSession.mockResolvedValue(sessionWith(questionDeck()) as any);
      (mockAgentModeService as any).submitApprovalDeckAnswers.mockResolvedValue({
        outcome: 'submitted', run: null, summary: null,
        answeredDeck: { ...questionDeck(), status: 'answered', answers: [{ itemId: 'question-1', verdict: 'leads', answeredBy: 'user', at: '2026-09-20T00:00:02.000Z' }] },
      });
      const res = makeRes();
      await agentModeController.generateSharedResponse(makeReq({ deckAnswer: { deckId: 'deck-q1', answers: [{ itemId: 'question-1', verdict: 'leads' }] } }), res);
      const workerArgs = (mockWorkerService.runInWorker as jest.Mock).mock.calls[0][0];
      expect(workerArgs.messageContent).not.toContain('Do NOT silently re-propose');
    });

    it.each([
      ['full control is off', () => link(false)],
      ['a link made before the setting existed with no expiry (reads off)', () => link(undefined)],
      ['no session record at all', () => null],
    ])('still refuses with 403 when %s', async (_label, record) => {
      mockChatbotDb.getChatSession.mockResolvedValue(sessionWith(writeDeck()) as any);
      (mockChatbotDb as any).getChatSessionRecord.mockResolvedValue(record());
      const res = makeRes();
      await agentModeController.generateSharedResponse(makeReq({ deckAnswer: { deckId: 'deck-write', answers: [{ itemId: 'write-1', verdict: 'approve' }] } }), res);
      expect(res.status).toHaveBeenCalledWith(403);
      expect((res.json as jest.Mock).mock.calls[0][0].code).toBe('APPROVAL_DECK_FORBIDDEN');
      expect(mockAgentModeService.submitApprovalDeckAnswers).not.toHaveBeenCalled();
    });

    it('still refuses when the link can not be read (fail closed)', async () => {
      mockChatbotDb.getChatSession.mockResolvedValue(sessionWith(writeDeck()) as any);
      (mockChatbotDb as any).getChatSessionRecord.mockRejectedValue(new Error('throttled'));
      const res = makeRes();
      await agentModeController.generateSharedResponse(makeReq({ deckAnswer: { deckId: 'deck-write', answers: [{ itemId: 'write-1', verdict: 'approve' }] } }), res);
      expect(res.status).toHaveBeenCalledWith(403);
      expect(mockAgentModeService.submitApprovalDeckAnswers).not.toHaveBeenCalled();
    });

    it('a plain question deck needs no read of the link at all', async () => {
      mockChatbotDb.getChatSession.mockResolvedValue(sessionWith(questionDeck()) as any);
      const res = makeRes();
      await agentModeController.generateSharedResponse(makeReq({ deckAnswer: { deckId: 'deck-q1', answers: [{ itemId: 'question-1', verdict: 'leads' }] } }), res);
      expect((mockChatbotDb as any).getChatSessionRecord).not.toHaveBeenCalled();
    });
  });
});
