import { Request, Response } from 'express';

// ENG-2816: a share link runs as the owner. When the portal sends the logged-in OWNER's login, the turn is an owner turn
// (no share flag, no anonymous-sender stamp). Anyone else stays a visitor, exactly as before.
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
  incrementUserTokenUsage: jest.fn(),
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
import { agentModeController } from '../controllers/agentModeController';

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

/** The flag the worker was handed for this turn. */
function workerShareFlag(): unknown {
  const call = mockWorkerService.runInWorker.mock.calls[0];
  return (call?.[0] as any)?.isInteractiveShare;
}

function userMessageMetadata(): any {
  const call = (mockChatbotDb.addMessageToSession as jest.Mock).mock.calls.find(([, msg]: any) => msg.role === 'user');
  return call?.[1]?.metadata;
}

describe('generateSharedResponse: the link owner, logged in, is not a visitor (ENG-2816)', () => {
  beforeEach(() => {
    // clearAllMocks, not resetAllMocks: the factory stubs above (the usage gate, progress store) must keep their implementations.
    jest.clearAllMocks();
    (mockChatbotDb.getChatSession as jest.Mock).mockReset();
    mockAgentModeService.getDefaultModel.mockResolvedValue('gpt-5-chat-2');
    mockAgentModeService.getMarketingSystemPrompt.mockResolvedValue('System prompt');
    mockAgentModeService.generateSessionTitle.mockResolvedValue('Title');
    mockWorkerService.runInWorker.mockResolvedValue(workerResponse);
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

  it('an anonymous visitor (no login) is still a visitor: share flag on, anonymous-sender stamp', async () => {
    await agentModeController.generateSharedResponse(shareRequest(), fakeRes());
    expect(mockGetUserFromToken).not.toHaveBeenCalled();
    expect(workerShareFlag()).toBe(true);
    expect(userMessageMetadata().ishareSender).toEqual(expect.objectContaining({ isAnonymous: true, ip: '203.0.113.42' }));
  });

  it("the owner's own login makes it an owner turn: no share flag and no anonymous-sender stamp", async () => {
    mockGetUserFromToken.mockResolvedValue({ user: { userId: OWNER_ID, email: 'o@x.com', isAdmin: false }, decoded: { userId: OWNER_ID } });
    await agentModeController.generateSharedResponse(shareRequest({ authorization: 'Bearer owner.jwt' }), fakeRes());
    expect(workerShareFlag()).toBe(false);
    expect(userMessageMetadata()).not.toHaveProperty('ishareSender');
  });

  it('recognising the owner does not also grant delegated (admin-support) access', async () => {
    // A bug that fed "is the owner" into the delegated-access argument would hand every owner admin tools on their own link.
    mockGetUserFromToken.mockResolvedValue({ user: { userId: OWNER_ID }, decoded: { userId: OWNER_ID } });
    await agentModeController.generateSharedResponse(shareRequest({ authorization: 'Bearer owner.jwt' }), fakeRes());
    expect(workerShareFlag()).toBe(false);
    expect((mockWorkerService.runInWorker.mock.calls[0][0] as any).isDelegatedAccess).toBeFalsy();
  });

  it('leaves a trace when it runs an owner turn (telemetry then says regular, not interactive_share), and none for a visitor', async () => {
    const log = jest.spyOn(console, 'log');
    try {
      mockGetUserFromToken.mockResolvedValue({ user: { userId: OWNER_ID }, decoded: { userId: OWNER_ID } });
      await agentModeController.generateSharedResponse(shareRequest({ authorization: 'Bearer owner.jwt' }), fakeRes());
      const traces = () => log.mock.calls.map(c => String(c[0])).filter(m => m.includes('[ENG-2816]'));
      expect(traces()).toHaveLength(1);
      expect(traces()[0]).toContain(SESSION_ID);
      expect(traces()[0]).not.toContain('owner.jwt');
      expect(traces()[0]).not.toContain(OWNER_ID);
      expect(traces()[0]).not.toContain('o@x.com');

      log.mockClear();
      mockWorkerService.runInWorker.mockClear();
      (mockChatbotDb.getChatSession as jest.Mock).mockReset()
        .mockResolvedValueOnce(baseSession)
        .mockResolvedValue({ ...baseSession, messages: [{ role: 'user', content: 'hi', metadata: { timestamp: new Date().toISOString() } }] });
      mockGetUserFromToken.mockResolvedValue({ user: null });
      await agentModeController.generateSharedResponse(shareRequest({ authorization: 'Bearer stale.jwt' }), fakeRes());
      expect(traces()).toHaveLength(0);
    } finally {
      log.mockRestore();
    }
  });

  it("a logged-in colleague (someone else's login) stays a visitor", async () => {
    mockGetUserFromToken.mockResolvedValue({ user: { userId: 'colleague-id' }, decoded: { userId: 'colleague-id' } });
    await agentModeController.generateSharedResponse(shareRequest({ authorization: 'Bearer colleague.jwt' }), fakeRes());
    expect(workerShareFlag()).toBe(true);
    expect(userMessageMetadata().ishareSender).toEqual(expect.objectContaining({ isAnonymous: true }));
  });

  it('an admin delegate token for the owner stays a visitor', async () => {
    mockGetUserFromToken.mockResolvedValue({
      user: { userId: OWNER_ID },
      decoded: { userId: 'admin-id', delegateAccess: { adminUserId: 'admin-id', adminEmail: 'a@x.com', targetUserId: OWNER_ID, targetEmail: 'o@x.com' } },
    });
    await agentModeController.generateSharedResponse(shareRequest({ authorization: 'Bearer delegate.jwt' }), fakeRes());
    expect(workerShareFlag()).toBe(true);
  });

  it('an invalid, expired or revoked login falls back to a visitor turn, never an error', async () => {
    mockGetUserFromToken.mockResolvedValue({ user: null });
    const res = fakeRes();
    await agentModeController.generateSharedResponse(shareRequest({ authorization: 'Bearer stale.jwt' }), res);
    expect(workerShareFlag()).toBe(true);
    expect((res.status as jest.Mock)).not.toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalled();
  });

  it('a login never replaces the link check: a wrong share token is still refused for the owner', async () => {
    mockGetUserFromToken.mockResolvedValue({ user: { userId: OWNER_ID }, decoded: { userId: OWNER_ID } });
    const req = shareRequest({ authorization: 'Bearer owner.jwt' });
    (req as any).query = { conversable: 'wrong-token' };
    const res = fakeRes();
    await agentModeController.generateSharedResponse(req, res);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(mockWorkerService.runInWorker).not.toHaveBeenCalled();
  });
});
