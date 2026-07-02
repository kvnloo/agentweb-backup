/**
 * Tests for Agent Mode progress SSE endpoints
 */

import { Request, Response } from 'express';
import { agentModeController } from '../controllers/agentModeController';
import { chatbotDb } from '../services/chatbotService';
import { emitProgress, registerProgressCallback, getLatestProgress, cleanupProgress } from '../utils/sseProgress';
import { generateMarketingResponseWorkerService } from '../services/generateMarketingResponseWorkerService';

// Mock dependencies
jest.mock('../services/chatbotService', () => ({
  chatbotDb: {
    getChatSession: jest.fn(),
    addMessagesToSession: jest.fn(),
    addMessageToSession: jest.fn(),
    updateSessionTitle: jest.fn(),
    incrementCalledFunctions: jest.fn(),
    getMessagesFromMessagesTable: jest.fn()
  }
}));

jest.mock('../services/generateMarketingResponseWorkerService', () => ({
  generateMarketingResponseWorkerService: {
    runInWorker: jest.fn()
  }
}));

jest.mock('../services/agentModeService', () => ({
  agentModeService: {
    isModelRestrictedForUser: jest.fn().mockReturnValue(false),
    generateSessionTitle: jest.fn().mockResolvedValue('Test Session Title'),
    getSkillsForDisplay: jest.fn().mockResolvedValue([])
  }
}));

jest.mock('../services/tokenUsageService', () => ({
  checkTokenUsage: jest.fn().mockResolvedValue({
    allowed: true, warning: false, used: 0, allowance: null,
    bonus: 0, effectiveAllowance: null, percentUsed: 0, month: '2026-03',
  }),
}));

jest.mock('../utils/sseProgress', () => ({
  emitProgress: jest.fn(),
  registerProgressCallback: jest.fn(),
  getLatestProgress: jest.fn(),
  cleanupProgress: jest.fn(),
  progressStore: new Map(),
  requestCancel: jest.fn(),
  clearCancel: jest.fn(),
  isCancelled: jest.fn().mockReturnValue(false),
}));

interface User {
  userId: string;
  email: string;
}

const mockRequest = (overrides: Partial<Request> = {}): Partial<Request> => ({
  params: {},
  query: {},
  body: {},
  user: { userId: 'test-user-id', email: 'test@example.com' } as User,
  on: jest.fn(),
  ...overrides
});

const mockResponse = (): Partial<Response> => {
  const res: Partial<Response> = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
    setHeader: jest.fn().mockReturnThis(),
    write: jest.fn().mockReturnValue(true),
    end: jest.fn(),
    headersSent: false
  };
  return res;
};

describe('AgentMode Progress SSE Endpoints', () => {
  const sessionId = 'test-session-123';
  const mockSession = {
    sessionId,
    userId: 'test-user-id',
    messages: [],
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
    portalType: 'agent' as const,
    pageIdentifier: 'agent-mode',
    interactiveShareMetadata: {
      isActive: true,
      token: 'test-conversable-token',
      sharedAt: '2024-01-01T00:00:00Z',
      expiresAt: '2099-01-01T00:00:00Z'
    }
  };

  beforeEach(() => {
    jest.clearAllMocks();
    (chatbotDb.getChatSession as jest.Mock).mockResolvedValue(mockSession);
    (chatbotDb.getMessagesFromMessagesTable as jest.Mock).mockResolvedValue([]);
    (getLatestProgress as jest.Mock).mockReturnValue(undefined);
  });

  afterEach(() => {
    cleanupProgress(sessionId);
  });

  describe('getProgress (authenticated)', () => {
    it('should set up SSE connection for authenticated user', async () => {
      const req = mockRequest({
        params: { sessionId },
        user: { userId: 'test-user-id', email: 'test@example.com' } as User
      }) as Request;
      const res = mockResponse() as Response;

      const mockCleanup = jest.fn();
      (registerProgressCallback as jest.Mock).mockReturnValue(mockCleanup);

      await agentModeController.getProgress(req as any, res);

      expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'text/event-stream');
      expect(res.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-cache');
      expect(res.setHeader).toHaveBeenCalledWith('Connection', 'keep-alive');
      expect(res.write).toHaveBeenCalledWith(': connected\n\n');
      expect(registerProgressCallback).toHaveBeenCalledWith(sessionId, expect.any(Function));
    });

    it('should return 400 if sessionId is missing', async () => {
      const req = mockRequest({ params: {} }) as Request;
      const res = mockResponse() as Response;

      await agentModeController.getProgress(req as any, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({ error: 'Session ID is required' });
    });

    it('should return 404 if session not found', async () => {
      (chatbotDb.getChatSession as jest.Mock).mockResolvedValue(null);

      const req = mockRequest({ params: { sessionId } }) as Request;
      const res = mockResponse() as Response;

      await agentModeController.getProgress(req as any, res);

      expect(res.status).toHaveBeenCalledWith(404);
      expect(res.json).toHaveBeenCalledWith({ error: 'Session not found' });
    });

    it('should return 403 if user does not own session', async () => {
      const req = mockRequest({
        params: { sessionId },
        user: { userId: 'different-user-id', email: 'other@example.com' } as User
      }) as Request;
      const res = mockResponse() as Response;

      await agentModeController.getProgress(req as any, res);

      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith({ error: 'Unauthorized access to session' });
    });

    // Regression: under admin delegation, the session list shown in the admin UI
    // can mix the target user's sessions with the admin's own admin-owned
    // sessions. Before this fix, polling an admin-owned session while delegated
    // as the target user 403'd (session.userId === admin !== user.userId ===
    // target), which put the UI in a 403 polling loop. See prod nginx log,
    // 2026-04-23 23:52-23:55 UTC, 26 consecutive 403s on four session IDs.
    it('allows a delegated admin to read their own admin-owned session', async () => {
      (chatbotDb.getChatSession as jest.Mock).mockResolvedValue({
        ...mockSession,
        userId: 'admin-user-id', // session was created by the admin, not the target
      });

      const req = mockRequest({
        params: { sessionId },
        // Under delegation middleware sets req.user.userId to the TARGET user.
        user: { userId: 'target-user-id', email: 'target@example.com' } as User,
      }) as Request;
      (req as any).delegateInfo = {
        adminUserId: 'admin-user-id',
        adminEmail: 'admin@example.com',
        isDelegated: true,
      };
      const res = mockResponse() as Response;

      (registerProgressCallback as jest.Mock).mockReturnValue(jest.fn());

      await agentModeController.getProgress(req as any, res);

      expect(res.status).not.toHaveBeenCalledWith(403);
      expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'text/event-stream');
      expect(registerProgressCallback).toHaveBeenCalledWith(sessionId, expect.any(Function));
    });

    it('still 403s a delegated admin trying to read a stranger\'s session', async () => {
      (chatbotDb.getChatSession as jest.Mock).mockResolvedValue({
        ...mockSession,
        userId: 'stranger-user-id', // neither target nor admin
      });

      const req = mockRequest({
        params: { sessionId },
        user: { userId: 'target-user-id', email: 'target@example.com' } as User,
      }) as Request;
      (req as any).delegateInfo = {
        adminUserId: 'admin-user-id',
        adminEmail: 'admin@example.com',
        isDelegated: true,
      };
      const res = mockResponse() as Response;

      await agentModeController.getProgress(req as any, res);

      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith({ error: 'Unauthorized access to session' });
    });

    it('allows a delegated admin to read the target user\'s session (primary path)', async () => {
      (chatbotDb.getChatSession as jest.Mock).mockResolvedValue({
        ...mockSession,
        userId: 'target-user-id',
      });

      const req = mockRequest({
        params: { sessionId },
        user: { userId: 'target-user-id', email: 'target@example.com' } as User,
      }) as Request;
      (req as any).delegateInfo = {
        adminUserId: 'admin-user-id',
        adminEmail: 'admin@example.com',
        isDelegated: true,
      };
      const res = mockResponse() as Response;

      (registerProgressCallback as jest.Mock).mockReturnValue(jest.fn());

      await agentModeController.getProgress(req as any, res);

      expect(res.status).not.toHaveBeenCalledWith(403);
      expect(registerProgressCallback).toHaveBeenCalledWith(sessionId, expect.any(Function));
    });

    it('should send latest progress if available', async () => {
      const latestProgress = {
        iteration: 1,
        status: 'thinking',
        toolCalls: []
      };
      (getLatestProgress as jest.Mock).mockReturnValue(latestProgress);

      const req = mockRequest({
        params: { sessionId },
        user: { userId: 'test-user-id', email: 'test@example.com' } as User
      }) as Request;
      const res = mockResponse() as Response;

      (registerProgressCallback as jest.Mock).mockReturnValue(jest.fn());

      await agentModeController.getProgress(req as any, res);

      expect(res.write).toHaveBeenCalledWith(`data: ${JSON.stringify(latestProgress)}\n\n`);
    });

    it('should handle client disconnect', async () => {
      const req = mockRequest({
        params: { sessionId },
        user: { userId: 'test-user-id', email: 'test@example.com' } as User
      }) as Request;
      const res = mockResponse() as Response;

      const mockCleanup = jest.fn();
      (registerProgressCallback as jest.Mock).mockReturnValue(mockCleanup);

      let closeHandler: (() => void) | undefined;
      (req.on as jest.Mock).mockImplementation((event: string, handler: any) => {
        if (event === 'close') {
          closeHandler = handler;
        }
      });

      await agentModeController.getProgress(req as any, res);

      // Simulate client disconnect
      if (closeHandler) {
        closeHandler();
      }

      expect(mockCleanup).toHaveBeenCalled();
      expect(res.end).toHaveBeenCalled();
    });
  });

  describe('getProgressPublic (anonymous with conversable token)', () => {
    it('should set up SSE connection for anonymous user with valid token', async () => {
      const req = mockRequest({
        params: { shareId: sessionId },
        query: { conversable: 'test-conversable-token' }
      }) as Request;
      const res = mockResponse() as Response;

      const mockCleanup = jest.fn();
      (registerProgressCallback as jest.Mock).mockReturnValue(mockCleanup);

      await agentModeController.getProgressPublic(req, res);

      expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'text/event-stream');
      expect(res.write).toHaveBeenCalledWith(': connected\n\n');
      expect(registerProgressCallback).toHaveBeenCalledWith(sessionId, expect.any(Function));
    });

    it('should return 400 if shareId is missing', async () => {
      const req = mockRequest({ params: {}, query: { conversable: 'token' } }) as Request;
      const res = mockResponse() as Response;

      await agentModeController.getProgressPublic(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({ error: 'Session ID is required' });
    });

    it('should return 401 if conversable token is missing', async () => {
      const req = mockRequest({
        params: { shareId: sessionId },
        query: {}
      }) as Request;
      const res = mockResponse() as Response;

      await agentModeController.getProgressPublic(req, res);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({ error: 'Conversable token required' });
    });

    it('should return 404 if session not found', async () => {
      (chatbotDb.getChatSession as jest.Mock).mockResolvedValue(null);

      const req = mockRequest({
        params: { shareId: sessionId },
        query: { conversable: 'test-token' }
      }) as Request;
      const res = mockResponse() as Response;

      await agentModeController.getProgressPublic(req, res);

      expect(res.status).toHaveBeenCalledWith(404);
      expect(res.json).toHaveBeenCalledWith({ error: 'Session not found' });
    });

    it('should return 401 if conversable token is invalid', async () => {
      const req = mockRequest({
        params: { shareId: sessionId },
        query: { conversable: 'invalid-token' }
      }) as Request;
      const res = mockResponse() as Response;

      await agentModeController.getProgressPublic(req, res);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({ error: 'Invalid or expired conversable token' });
    });

    it('should return 401 if interactive share is not active', async () => {
      const inactiveSession = {
        ...mockSession,
        interactiveShareMetadata: {
          isActive: false,
          token: 'test-conversable-token',
          sharedAt: '2024-01-01T00:00:00Z'
        }
      };
      (chatbotDb.getChatSession as jest.Mock).mockResolvedValue(inactiveSession);

      const req = mockRequest({
        params: { shareId: sessionId },
        query: { conversable: 'test-conversable-token' }
      }) as Request;
      const res = mockResponse() as Response;

      await agentModeController.getProgressPublic(req, res);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({ error: 'Invalid or expired conversable token' });
    });
  });

  describe('Progress emission during generation', () => {
    it('should emit progress updates during generateResponse', async () => {
      const mockProgressCallback = jest.fn();
      (generateMarketingResponseWorkerService.runInWorker as jest.Mock).mockImplementation(
        (params, onProgress) => {
          // Simulate progress updates
          if (onProgress) {
            onProgress({ iteration: 1, status: 'thinking', toolCalls: [] });
            onProgress({ iteration: 1, status: 'executing_tools', toolCalls: [], pendingTools: ['test_tool'] });
            onProgress({ iteration: 1, status: 'tool_executed', toolCalls: [{ name: 'test_tool' }] });
            onProgress({ iteration: 1, status: 'complete', toolCalls: [{ name: 'test_tool' }] });
          }
          return Promise.resolve({
            content: 'Response',
            toolCalls: [],
            knowledgeBaseQueries: [],
            sources: [],
            responseMessages: []
          });
        }
      );

      const req = mockRequest({
        body: {
          sessionId,
          userMessage: 'Test message'
        },
        user: { userId: 'test-user-id', email: 'test@example.com' } as User
      }) as Request;
      const res = mockResponse() as Response;

      await agentModeController.generateResponse(req as any, res);

      // Verify progress was emitted
      expect(emitProgress).toHaveBeenCalled();
    });

    it('emits terminal complete progress after a successful generateResponse', async () => {
      (generateMarketingResponseWorkerService.runInWorker as jest.Mock).mockImplementation(
        (params, onProgress) => {
          if (onProgress) {
            onProgress({
              iteration: 2,
              status: 'executing_tools',
              pendingTools: ['create_html_file'],
              toolCalls: [],
            });
          }
          return Promise.resolve({
            content: 'Done with final link',
            toolCalls: [{ name: 'create_html_file', result: { success: true } }],
            knowledgeBaseQueries: [],
            sources: [],
            responseMessages: []
          });
        }
      );

      const req = mockRequest({
        body: {
          sessionId,
          userMessage: 'Create an HTML report'
        },
        user: { userId: 'test-user-id', email: 'test@example.com' } as User
      }) as Request;
      const res = mockResponse() as Response;

      await agentModeController.generateResponse(req as any, res);

      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        content: 'Done with final link',
      }));
      expect(emitProgress).toHaveBeenLastCalledWith(sessionId, {
        iteration: 0,
        status: 'complete',
      });
    });
  });
});
