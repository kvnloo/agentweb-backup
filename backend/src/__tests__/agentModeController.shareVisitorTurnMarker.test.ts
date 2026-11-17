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
import { progressStore } from '../utils/sseProgress';
import { getUserFromToken } from '../middleware/auth';
import { agentModeController, tryClaimSessionGeneration, releaseSessionGeneration } from '../controllers/agentModeController';
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
