import { Request, Response } from 'express';

// ENG-2816 (step 3): a share route marks the turn it runs as a VISITOR's, where it claims the session's generation lock, until the
// owner is recognised; the marker is cleared when the lock is released. The schedule write handlers and the stop route read it.
jest.mock('../services/chatbotService', () => ({
  chatbotDb: {
    getChatSession: jest.fn(),
    addMessageToSession: jest.fn(),
    addMessagesToSession: jest.fn(),
    updateSessionTitle: jest.fn(),
    getMessagesFromMessagesTable: jest.fn(),
  },
}));

jest.mock('../services/agentModeService', () => ({
  agentModeService: {
    default_model: 'gpt-5-chat-2',
    getDefaultModel: jest.fn(),
    getMarketingSystemPrompt: jest.fn(),
    generateSessionTitle: jest.fn(),
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
  checkTokenUsage: jest.fn().mockResolvedValue({ allowed: true, warning: false, percentUsed: 0 }),
}));

// Only the login check is replaced; the rest of the auth module stays real for the controller.
jest.mock('../middleware/auth', () => ({
  ...jest.requireActual('../middleware/auth'),
  getUserFromToken: jest.fn(),
}));

import { chatbotDb } from '../services/chatbotService';
import { agentModeService } from '../services/agentModeService';
import { generateMarketingResponseWorkerService } from '../services/generateMarketingResponseWorkerService';
import { progressStore, requestCancel } from '../utils/sseProgress';
import * as markerModule from '../services/shareVisitorTurnMarker';
import { getUserFromToken } from '../middleware/auth';
import {
  agentModeController, tryClaimSessionGeneration, releaseSessionGeneration, preemptAutoContinuationAndWait, autoContinuationSessions,
} from '../controllers/agentModeController';
import { isShareVisitorTurn, clearShareVisitorTurn } from '../services/shareVisitorTurnMarker';

const mockChatbotDb = chatbotDb as jest.Mocked<typeof chatbotDb>;
const mockAgentModeService = agentModeService as jest.Mocked<typeof agentModeService>;
const mockWorkerService = generateMarketingResponseWorkerService as jest.Mocked<typeof generateMarketingResponseWorkerService>;
const mockGetUserFromToken = getUserFromToken as jest.Mock;

const SESSION_ID = 'ishare-session-owner-rec';
const CONVERSABLE_TOKEN = 'tok-owner-rec';
const OWNER_ID = 'owner-user-id';

const baseSession = {
  sessionId: SESSION_ID,
  userId: OWNER_ID,
  title: 'My Session',
  messages: [],
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  llmModel: 'gpt-5-chat-2',
  interactiveShareMetadata: {
    isActive: true,
    token: CONVERSABLE_TOKEN,
    sharedAt: new Date().toISOString(),
    expiresAt: '2099-01-01T00:00:00Z',
  },
};

const workerResponse = { content: 'Hello', toolCalls: [], knowledgeBaseQueries: [], sources: [], responseMessages: [] };

function shareRequest(headers: Record<string, string> = {}): Request {
  return {
    params: { shareId: SESSION_ID },
    query: { conversable: CONVERSABLE_TOKEN },
    body: { userMessage: 'Hello there', attachments: [] },
    ip: '203.0.113.42',
    headers: { 'user-agent': 'Mozilla/5.0 (Test Browser)', ...headers },
  } as unknown as Request;
}

function fakeRes(): Response {
  return { json: jest.fn(), status: jest.fn().mockReturnThis() } as unknown as Response;
}

/** What the marker said at the moment the turn reached the worker (that is, while the turn was running). */
let markerDuringTurn: boolean | undefined;

describe('generateSharedResponse marks the turn a visitor\'s while it runs (ENG-2816 step 3)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    markerDuringTurn = undefined;
    clearShareVisitorTurn(SESSION_ID);
    releaseSessionGeneration(SESSION_ID);
    (mockChatbotDb.getChatSession as jest.Mock).mockReset();
    mockAgentModeService.getDefaultModel.mockResolvedValue('gpt-5-chat-2');
    mockAgentModeService.getMarketingSystemPrompt.mockResolvedValue('System prompt');
    mockAgentModeService.generateSessionTitle.mockResolvedValue('Title');
    mockWorkerService.runInWorker.mockImplementation(async () => {
      markerDuringTurn = isShareVisitorTurn(SESSION_ID);
      return workerResponse as any;
    });
    (progressStore.delete as jest.Mock).mockReturnValue(true);
    (progressStore as any).has.mockReturnValue(false);
    (mockChatbotDb.getChatSession as jest.Mock)
      .mockResolvedValueOnce(baseSession)
      .mockResolvedValue({ ...baseSession, messages: [{ role: 'user', content: 'hi', metadata: { timestamp: new Date().toISOString() } }] });
    (mockChatbotDb.addMessageToSession as jest.Mock).mockResolvedValue(undefined);
    (mockChatbotDb.updateSessionTitle as jest.Mock).mockResolvedValue(undefined);
    (mockChatbotDb as any).getMessagesFromMessagesTable.mockResolvedValue([]);
    mockGetUserFromToken.mockResolvedValue({ user: null });
  });
  afterEach(() => {
    clearShareVisitorTurn(SESSION_ID);
    releaseSessionGeneration(SESSION_ID);
  });

  it('an anonymous visitor\'s turn is marked while it runs, and the marker goes with the lock', async () => {
    await agentModeController.generateSharedResponse(shareRequest(), fakeRes());
    expect(markerDuringTurn).toBe(true);
    expect(isShareVisitorTurn(SESSION_ID)).toBe(false);
  });

  it('a colleague\'s login or a delegate token is still a visitor\'s turn', async () => {
    mockGetUserFromToken.mockResolvedValue({ user: { userId: 'colleague-id' }, decoded: { userId: 'colleague-id' } });
    await agentModeController.generateSharedResponse(shareRequest({ authorization: 'Bearer colleague.jwt' }), fakeRes());
    expect(markerDuringTurn).toBe(true);
  });

  it('the OWNER\'s own login makes it an owner turn: not marked while it runs', async () => {
    mockGetUserFromToken.mockResolvedValue({ user: { userId: OWNER_ID }, decoded: { userId: OWNER_ID } });
    await agentModeController.generateSharedResponse(shareRequest({ authorization: 'Bearer owner.jwt' }), fakeRes());
    expect(markerDuringTurn).toBe(false);
    expect(isShareVisitorTurn(SESSION_ID)).toBe(false);
  });

  it('the marker is cleared when the turn FAILS too (the lock is released in a finally)', async () => {
    mockWorkerService.runInWorker.mockImplementation(async () => {
      markerDuringTurn = isShareVisitorTurn(SESSION_ID);
      throw new Error('worker died');
    });
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    await agentModeController.generateSharedResponse(shareRequest(), fakeRes());
    expect(markerDuringTurn).toBe(true);
    expect(isShareVisitorTurn(SESSION_ID)).toBe(false);
  });

  it('a visitor request REFUSED because the session is busy does not mark the turn that is running (the owner\'s)', async () => {
    tryClaimSessionGeneration(SESSION_ID, OWNER_ID); // the owner's own turn holds the lock
    const res = fakeRes();
    await agentModeController.generateSharedResponse(shareRequest(), res);
    expect(res.status).toHaveBeenCalledWith(409);
    expect(isShareVisitorTurn(SESSION_ID)).toBe(false);
    expect(mockWorkerService.runInWorker).not.toHaveBeenCalled();
  });

  it('a request refused for a wrong token marks nothing', async () => {
    const req = shareRequest();
    (req as any).query = { conversable: 'wrong-token' };
    await agentModeController.generateSharedResponse(req, fakeRes());
    expect(isShareVisitorTurn(SESSION_ID)).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// The gap between claiming the lock and recognising the owner, and whose continuation a visitor may preempt (ENG-2816 step 3, round 2).

const flush = async (ticks = 10) => { for (let i = 0; i < ticks; i++) await new Promise((resolve) => setImmediate(resolve)); };
const stopRequest = (headers: Record<string, string> = {}): Request => ({
  params: { shareId: SESSION_ID }, query: { conversable: CONVERSABLE_TOKEN }, headers,
}) as unknown as Request;
const OWNER_AUTH = { user: { userId: OWNER_ID }, decoded: { userId: OWNER_ID } };

describe('a visitor\'s stop cannot cancel an owner turn that is still STARTING (the stop window)', () => {
  let markSpy: jest.SpyInstance;
  const cancel = requestCancel as jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    clearShareVisitorTurn(SESSION_ID);
    releaseSessionGeneration(SESSION_ID);
    autoContinuationSessions.delete(SESSION_ID);
    markSpy = jest.spyOn(markerModule, 'markShareVisitorTurn');
    (mockChatbotDb.getChatSession as jest.Mock).mockReset().mockResolvedValue({ ...baseSession, messages: [{ role: 'user', content: 'hi', metadata: { timestamp: new Date().toISOString() } }] });
    mockAgentModeService.getDefaultModel.mockResolvedValue('gpt-5-chat-2');
    mockAgentModeService.getMarketingSystemPrompt.mockResolvedValue('System prompt');
    mockAgentModeService.generateSessionTitle.mockResolvedValue('Title');
    mockWorkerService.runInWorker.mockResolvedValue(workerResponse as any);
    (progressStore.delete as jest.Mock).mockReturnValue(true);
    (progressStore as any).has.mockReturnValue(false);
    (mockChatbotDb.addMessageToSession as jest.Mock).mockResolvedValue(undefined);
    (mockChatbotDb.updateSessionTitle as jest.Mock).mockResolvedValue(undefined);
    (mockChatbotDb as any).getMessagesFromMessagesTable.mockResolvedValue([]);
    mockGetUserFromToken.mockResolvedValue({ user: null });
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => {
    markSpy.mockRestore();
    clearShareVisitorTurn(SESSION_ID);
    releaseSessionGeneration(SESSION_ID);
    autoContinuationSessions.delete(SESSION_ID);
  });

  it('the owner\'s login on their share link: the turn is NEVER marked a visitor\'s, at any moment', async () => {
    mockGetUserFromToken.mockResolvedValue(OWNER_AUTH);
    mockWorkerService.runInWorker.mockImplementation(async () => { markerDuringTurn = isShareVisitorTurn(SESSION_ID); return workerResponse as any; });
    await agentModeController.generateSharedResponse(shareRequest({ authorization: 'Bearer owner.jwt' }), fakeRes());
    expect(markSpy).not.toHaveBeenCalled();
    expect(markerDuringTurn).toBe(false);
  });

  it('a visitor (no login, a colleague, a delegate) is marked, once, before generation starts', async () => {
    mockWorkerService.runInWorker.mockImplementation(async () => { markerDuringTurn = isShareVisitorTurn(SESSION_ID); return workerResponse as any; });
    await agentModeController.generateSharedResponse(shareRequest(), fakeRes());
    expect(markSpy).toHaveBeenCalledTimes(1);
    expect(markSpy).toHaveBeenCalledWith(SESSION_ID);
    expect(markerDuringTurn).toBe(true);

    markSpy.mockClear();
    mockGetUserFromToken.mockResolvedValue({ user: { userId: 'colleague' }, decoded: { userId: 'colleague' } });
    await agentModeController.generateSharedResponse(shareRequest({ authorization: 'Bearer colleague.jwt' }), fakeRes());
    expect(markSpy).toHaveBeenCalledTimes(1);
  });

  it('a visitor\'s stop DURING the gap (lock claimed, owner login still being verified) is ignored; the owner\'s turn runs on uncancelled', async () => {
    let finishLogin!: (value: unknown) => void;
    // The FIRST verification (right after the lock claim) is held open; the later owner-turn decision then resolves at once.
    mockGetUserFromToken.mockImplementationOnce(() => new Promise((resolve) => { finishLogin = resolve; }));
    mockGetUserFromToken.mockResolvedValue(OWNER_AUTH);
    const turn = agentModeController.generateSharedResponse(shareRequest({ authorization: 'Bearer owner.jwt' }), fakeRes());
    await flush();
    // The gap: the lock is held, the owner is not yet recognised, and nothing has been marked.
    expect(mockGetUserFromToken).toHaveBeenCalledTimes(1);
    expect(markSpy).not.toHaveBeenCalled();
    expect(mockWorkerService.runInWorker).not.toHaveBeenCalled();

    const stopRes = fakeRes();
    await agentModeController.stopGenerationPublic(stopRequest(), stopRes);
    expect(stopRes.json).toHaveBeenCalledWith({ success: true });
    expect(cancel).not.toHaveBeenCalled();
    expect(mockWorkerService.cancelSession).not.toHaveBeenCalled();

    finishLogin(OWNER_AUTH);
    await turn;
    expect(cancel).not.toHaveBeenCalled();
    expect(mockWorkerService.runInWorker).toHaveBeenCalledTimes(1);
  });

  it('a visitor\'s own turn stays stoppable by that visitor once it is under way', async () => {
    let releaseWorker!: () => void;
    mockWorkerService.runInWorker.mockImplementation(() => new Promise((resolve) => { releaseWorker = () => resolve(workerResponse as any); }));
    const turn = agentModeController.generateSharedResponse(shareRequest(), fakeRes());
    await flush();
    expect(isShareVisitorTurn(SESSION_ID)).toBe(true);

    const stopRes = fakeRes();
    await agentModeController.stopGenerationPublic(stopRequest(), stopRes);
    expect(cancel).toHaveBeenCalledWith(SESSION_ID);

    releaseWorker();
    await turn;
  });
});

describe('a visitor\'s message preempts only a continuation of a VISITOR\'s turn (ENG-1239 preemption, ENG-2816 step 3)', () => {
  const cancel = requestCancel as jest.Mock;
  const workerCancel = () => (mockWorkerService as any).cancelSession as jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    clearShareVisitorTurn(SESSION_ID);
    releaseSessionGeneration(SESSION_ID);
    autoContinuationSessions.delete(SESSION_ID);
    (mockChatbotDb.getChatSession as jest.Mock).mockReset().mockResolvedValue({ ...baseSession, messages: [{ role: 'user', content: 'hi', metadata: { timestamp: new Date().toISOString() } }] });
    mockAgentModeService.getDefaultModel.mockResolvedValue('gpt-5-chat-2');
    mockAgentModeService.getMarketingSystemPrompt.mockResolvedValue('System prompt');
    mockAgentModeService.generateSessionTitle.mockResolvedValue('Title');
    mockWorkerService.runInWorker.mockResolvedValue(workerResponse as any);
    (progressStore.delete as jest.Mock).mockReturnValue(true);
    (progressStore as any).has.mockReturnValue(false);
    (mockChatbotDb.addMessageToSession as jest.Mock).mockResolvedValue(undefined);
    (mockChatbotDb.updateSessionTitle as jest.Mock).mockResolvedValue(undefined);
    (mockChatbotDb as any).getMessagesFromMessagesTable.mockResolvedValue([]);
    mockGetUserFromToken.mockResolvedValue({ user: null });
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => {
    clearShareVisitorTurn(SESSION_ID);
    releaseSessionGeneration(SESSION_ID);
    autoContinuationSessions.delete(SESSION_ID);
  });

  /** A background continuation holding the session lock; a visitor's one carries the visitor-turn marker, as scheduleAutoMediaContinuation sets it. */
  const holdContinuation = (visitorOwned: boolean) => {
    tryClaimSessionGeneration(SESSION_ID, OWNER_ID);
    autoContinuationSessions.add(SESSION_ID);
    if (visitorOwned) markerModule.markShareVisitorTurn(SESSION_ID);
  };

  it('an OWNER\'s continuation is not preempted by the share route: the visitor is answered like a held lock (409), and nothing is cancelled', async () => {
    holdContinuation(false);
    const res = fakeRes();
    await agentModeController.generateSharedResponse(shareRequest(), res);

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith({
      error: 'Session is busy',
      message: 'A response is already being generated for this session. Please wait.',
      code: 'SESSION_BUSY',
      userMessageSaved: false,
    });
    expect(cancel).not.toHaveBeenCalled();
    expect(workerCancel()).not.toHaveBeenCalled();
    expect(mockWorkerService.runInWorker).not.toHaveBeenCalled();
    // The continuation still holds its lock.
    expect(tryClaimSessionGeneration(SESSION_ID, OWNER_ID)).toBe(false);
  });

  it('a VISITOR\'s continuation is still preempted by a visitor\'s message (as before)', async () => {
    holdContinuation(true);
    setTimeout(() => releaseSessionGeneration(SESSION_ID), 30);
    const res = fakeRes();
    await agentModeController.generateSharedResponse(shareRequest(), res);

    expect(cancel).toHaveBeenCalledWith(SESSION_ID);
    expect(workerCancel()).toHaveBeenCalledWith(SESSION_ID);
    expect(res.status).not.toHaveBeenCalledWith(409);
    expect(mockWorkerService.runInWorker).toHaveBeenCalledTimes(1);
  });

  describe('preemptAutoContinuationAndWait itself', () => {
    it('with onlyVisitorContinuations: an owner continuation is left alone (false, no cancel); a visitor one is preempted', async () => {
      holdContinuation(false);
      await expect(preemptAutoContinuationAndWait(SESSION_ID, OWNER_ID, true)).resolves.toBe(false);
      expect(cancel).not.toHaveBeenCalled();
      expect(workerCancel()).not.toHaveBeenCalled();

      markerModule.markShareVisitorTurn(SESSION_ID);
      setTimeout(() => releaseSessionGeneration(SESSION_ID), 30);
      await expect(preemptAutoContinuationAndWait(SESSION_ID, OWNER_ID, true)).resolves.toBe(true);
      expect(cancel).toHaveBeenCalledWith(SESSION_ID);
    });

    it('WITHOUT the option (the authenticated /generate path) an owner continuation is preempted exactly as before', async () => {
      holdContinuation(false);
      setTimeout(() => releaseSessionGeneration(SESSION_ID), 30);
      await expect(preemptAutoContinuationAndWait(SESSION_ID, OWNER_ID)).resolves.toBe(true);
      expect(cancel).toHaveBeenCalledWith(SESSION_ID);
      expect(workerCancel()).toHaveBeenCalledWith(SESSION_ID);
    });

    it('nothing to preempt: not a continuation, so false either way (a plain held lock is not touched)', async () => {
      tryClaimSessionGeneration(SESSION_ID, OWNER_ID);
      await expect(preemptAutoContinuationAndWait(SESSION_ID, OWNER_ID, true)).resolves.toBe(false);
      await expect(preemptAutoContinuationAndWait(SESSION_ID, OWNER_ID)).resolves.toBe(false);
      expect(cancel).not.toHaveBeenCalled();
    });
  });
});
