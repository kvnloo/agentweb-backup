/**
 * POST /api/agent-mode/session/:sessionId/stop — session-ownership contract (ENG-360).
 *
 * Pre-existing gap (ENG-346 sibling-lane audit): stopGeneration did no session
 * read at all — it immediately fired requestCancel(sessionId) +
 * generateMarketingResponseWorkerService.cancelSession(sessionId) +
 * markProgressComplete(sessionId). Any authenticated user who learned another
 * user's sessionId could cancel that user's in-flight generation (DoS on
 * someone else's run) and flip their SSE progress to complete.
 *
 * Behavioral contract from the Linear issue (HUMAN-WRITTEN — do not modify):
 *   1. An authenticated non-owner POSTing /session/:id/stop gets 403 and the
 *      owner's in-flight generation is NOT cancelled (no requestCancel /
 *      cancelSession / markProgressComplete side effects).
 *   2. The session owner, a delegated admin (token targeting the owner), and
 *      an admin can still stop their session's generation — response shape
 *      { success: true } unchanged for them.
 *   3. Stopping a non-existent session returns 404 instead of silently
 *      succeeding.
 *
 * The public ishare lane (stopGenerationPublic, conversable token) is a
 * separate anon path and is deliberately NOT covered by this contract.
 */
import { Response } from 'express';

jest.mock('../services/chatbotService', () => ({
  chatbotDb: {
    getChatSession: jest.fn(),
  },
}));

jest.mock('../services/generateMarketingResponseWorkerService', () => ({
  generateMarketingResponseWorkerService: {
    runInWorker: jest.fn(),
    cancelSession: jest.fn(),
  },
}));

// markProgressComplete is a controller-local helper (emitProgress with
// status:'complete' + progressStore.delete), so the SSE-complete side effect
// is observed through these two real sseProgress exports.
jest.mock('../utils/sseProgress', () => ({
  progressStore: { delete: jest.fn() },
  emitProgress: jest.fn(),
  requestCancel: jest.fn(),
  clearCancel: jest.fn(),
  isCancelled: jest.fn().mockReturnValue(false),
  registerProgressCallback: jest.fn().mockReturnValue(() => {}),
  getLatestProgress: jest.fn().mockReturnValue(undefined),
  cleanupProgress: jest.fn(),
  clearTerminalProgress: jest.fn(),
}));

import { agentModeController } from '../controllers/agentModeController';
import { chatbotDb } from '../services/chatbotService';
import { generateMarketingResponseWorkerService } from '../services/generateMarketingResponseWorkerService';
import { requestCancel, emitProgress, progressStore } from '../utils/sseProgress';
import { AuthenticatedRequest } from '../middleware/auth';

const mockGetChatSession = chatbotDb.getChatSession as jest.Mock;
const mockCancelSession = generateMarketingResponseWorkerService.cancelSession as jest.Mock;
const mockRequestCancel = requestCancel as jest.Mock;
const mockEmitProgress = emitProgress as jest.Mock;
const mockProgressDelete = progressStore.delete as unknown as jest.Mock;

const OWNER = {
  userId: 'owner-123',
  email: 'owner@example.com',
  isAdmin: false,
  roles: ['customer'],
};

const NON_OWNER = {
  userId: 'attacker-456',
  email: 'attacker@example.com',
  isAdmin: false,
  roles: ['customer'],
};

const ADMIN = {
  userId: 'admin-789',
  email: 'admin@example.com',
  isAdmin: true,
  roles: ['partner'],
};

const SESSION = {
  sessionId: 'session-abc',
  userId: OWNER.userId,
  title: 'Owner session',
  messages: [],
  createdAt: '2026-07-16T00:00:00Z',
  updatedAt: '2026-07-16T00:00:00Z',
};

const mockRequest = (
  user: any,
  sessionId: string,
  delegateInfo?: any
): AuthenticatedRequest =>
  ({
    user,
    ...(delegateInfo ? { delegateInfo } : {}),
    params: { sessionId },
    body: {},
  } as unknown as AuthenticatedRequest);

const mockResponse = () => {
  const res: any = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res as Response & { status: jest.Mock; json: jest.Mock };
};

const expectNoCancelSideEffects = () => {
  expect(mockRequestCancel).not.toHaveBeenCalled();
  expect(mockCancelSession).not.toHaveBeenCalled();
  expect(mockEmitProgress).not.toHaveBeenCalled();
  expect(mockProgressDelete).not.toHaveBeenCalled();
};

const expectCancelSideEffects = (sessionId: string) => {
  expect(mockRequestCancel).toHaveBeenCalledTimes(1);
  expect(mockRequestCancel).toHaveBeenCalledWith(sessionId);
  expect(mockCancelSession).toHaveBeenCalledTimes(1);
  expect(mockCancelSession).toHaveBeenCalledWith(sessionId);
  // markProgressComplete(sessionId) === emitProgress(complete) + store delete
  expect(mockEmitProgress).toHaveBeenCalledTimes(1);
  expect(mockEmitProgress).toHaveBeenCalledWith(sessionId, { iteration: 0, status: 'complete' });
  expect(mockProgressDelete).toHaveBeenCalledWith(sessionId);
};

describe('stopGeneration — session ownership (ENG-360)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('ACCEPTANCE 1: non-owner gets 403, no cancel side effects', () => {
    it('returns 403 for an authenticated non-owner and fires no cancellation', async () => {
      mockGetChatSession.mockResolvedValue(SESSION);

      const req = mockRequest(NON_OWNER, SESSION.sessionId);
      const res = mockResponse();

      await agentModeController.stopGeneration(req, res);

      expect(mockGetChatSession).toHaveBeenCalledWith(SESSION.sessionId);
      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith({ error: 'Unauthorized access to session' });
      expectNoCancelSideEffects();
    });

    it('returns 401 when req.user is missing (defensive, matches sibling endpoints)', async () => {
      const req = mockRequest(undefined, SESSION.sessionId);
      const res = mockResponse();

      await agentModeController.stopGeneration(req, res);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(mockGetChatSession).not.toHaveBeenCalled();
      expectNoCancelSideEffects();
    });
  });

  describe('ACCEPTANCE 2: owner, delegated admin, and admin still stop — { success: true } unchanged', () => {
    it('lets the session owner stop generation', async () => {
      mockGetChatSession.mockResolvedValue(SESSION);

      const req = mockRequest(OWNER, SESSION.sessionId);
      const res = mockResponse();

      await agentModeController.stopGeneration(req, res);

      expect(res.status).not.toHaveBeenCalled();
      expect(res.json).toHaveBeenCalledWith({ success: true });
      expectCancelSideEffects(SESSION.sessionId);
    });

    it('lets a delegated admin (token targeting the owner) stop generation', async () => {
      // middleware/auth.ts resolves delegated tokens so req.user IS the target
      // user; req.delegateInfo carries the admin identity. Plain owner
      // equality is therefore delegation-safe.
      mockGetChatSession.mockResolvedValue(SESSION);

      const req = mockRequest(
        { ...OWNER },
        SESSION.sessionId,
        { adminUserId: 'admin-789', adminEmail: 'admin@example.com', isDelegated: true }
      );
      const res = mockResponse();

      await agentModeController.stopGeneration(req, res);

      expect(res.status).not.toHaveBeenCalled();
      expect(res.json).toHaveBeenCalledWith({ success: true });
      expectCancelSideEffects(SESSION.sessionId);
    });

    it('lets a raw admin stop another user\'s generation (parity with sibling session-mutating endpoints)', async () => {
      mockGetChatSession.mockResolvedValue(SESSION);

      const req = mockRequest(ADMIN, SESSION.sessionId);
      const res = mockResponse();

      await agentModeController.stopGeneration(req, res);

      expect(res.status).not.toHaveBeenCalled();
      expect(res.json).toHaveBeenCalledWith({ success: true });
      expectCancelSideEffects(SESSION.sessionId);
    });
  });

  describe('ACCEPTANCE 3: non-existent session returns 404, not silent success', () => {
    it('returns 404 and fires no cancellation when the session does not exist', async () => {
      mockGetChatSession.mockResolvedValue(null);

      const req = mockRequest(OWNER, 'no-such-session');
      const res = mockResponse();

      await agentModeController.stopGeneration(req, res);

      expect(mockGetChatSession).toHaveBeenCalledWith('no-such-session');
      expect(res.status).toHaveBeenCalledWith(404);
      expect(res.json).toHaveBeenCalledWith({ error: 'Session not found' });
      expectNoCancelSideEffects();
    });
  });

  describe('error path', () => {
    it('returns 500 and fires no cancellation when the session read fails', async () => {
      mockGetChatSession.mockRejectedValue(new Error('DynamoDB down'));

      const req = mockRequest(OWNER, SESSION.sessionId);
      const res = mockResponse();

      await agentModeController.stopGeneration(req, res);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({ error: 'Failed to stop generation' });
      expectNoCancelSideEffects();
    });
  });
});
