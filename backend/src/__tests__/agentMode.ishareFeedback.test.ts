import request from 'supertest';
import express from 'express';
import agentModeRouter from '../routes/agentMode';

// Mock dependencies
jest.mock('../services/chatbotService', () => ({
  chatbotDb: {
    getChatSession: jest.fn(),
    getMessagesFromMessagesTable: jest.fn(),
    updateMessageFeedback: jest.fn(),
  },
}));

const { chatbotDb } = require('../services/chatbotService');

describe('Agent Mode iShare Feedback', () => {
  let app: express.Application;

  beforeEach(() => {
    app = express();
    app.use(express.json());
    app.use('/api/agent-mode', agentModeRouter);
    jest.clearAllMocks();
  });

  describe('PUT /api/agent-mode/ishare/:shareId/message/:messageIndex/feedback', () => {
    it('should submit feedback for ishare session with valid conversable token', async () => {
      const mockSession = {
        sessionId: 'session-123',
        userId: 'user-123',
        messages: [],
        interactiveShareMetadata: {
          isActive: true,
          token: 'valid-token-123',
        },
      };

      const mockMessages = [
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi there!', metadata: {} },
      ];

      const mockUpdatedMessage = {
        role: 'assistant',
        content: 'Hi there!',
        metadata: {
          feedback: {
            type: 'like',
            comment: 'Very helpful!',
            timestamp: expect.any(String),
            userId: 'anonymous-ishare',
          },
        },
      };

      chatbotDb.getChatSession.mockResolvedValue(mockSession);
      chatbotDb.getMessagesFromMessagesTable.mockResolvedValue(mockMessages);
      chatbotDb.updateMessageFeedback.mockResolvedValue(mockUpdatedMessage);

      const response = await request(app)
        .put('/api/agent-mode/ishare/session-123/message/1/feedback?conversable=valid-token-123')
        .send({
          type: 'like',
          comment: 'Very helpful!',
        });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.message).toEqual(mockUpdatedMessage);

      // Verify session lookup
      expect(chatbotDb.getChatSession).toHaveBeenCalledWith('session-123');

      // Verify message lookup
      expect(chatbotDb.getMessagesFromMessagesTable).toHaveBeenCalledWith('session-123');

      // Verify feedback update with anonymous userId
      expect(chatbotDb.updateMessageFeedback).toHaveBeenCalledWith(
        'session-123',
        1,
        expect.objectContaining({
          type: 'like',
          comment: 'Very helpful!',
          userId: 'anonymous-ishare',
          timestamp: expect.any(String),
        })
      );
    });

    it('should submit dislike feedback without comment', async () => {
      const mockSession = {
        sessionId: 'session-456',
        userId: 'user-456',
        messages: [],
        interactiveShareMetadata: {
          isActive: true,
          token: 'valid-token-456',
        },
      };

      const mockMessages = [
        { role: 'user', content: 'Question' },
        { role: 'assistant', content: 'Answer', metadata: {} },
      ];

      const mockUpdatedMessage = {
        role: 'assistant',
        content: 'Answer',
        metadata: {
          feedback: {
            type: 'dislike',
            timestamp: expect.any(String),
            userId: 'anonymous-ishare',
          },
        },
      };

      chatbotDb.getChatSession.mockResolvedValue(mockSession);
      chatbotDb.getMessagesFromMessagesTable.mockResolvedValue(mockMessages);
      chatbotDb.updateMessageFeedback.mockResolvedValue(mockUpdatedMessage);

      const response = await request(app)
        .put('/api/agent-mode/ishare/session-456/message/1/feedback?conversable=valid-token-456')
        .send({
          type: 'dislike',
        });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);

      // Verify feedback with no comment
      expect(chatbotDb.updateMessageFeedback).toHaveBeenCalledWith(
        'session-456',
        1,
        expect.objectContaining({
          type: 'dislike',
          comment: undefined,
          userId: 'anonymous-ishare',
        })
      );
    });

    it('should reject feedback without conversable token', async () => {
      const response = await request(app)
        .put('/api/agent-mode/ishare/session-123/message/1/feedback')
        .send({
          type: 'like',
        });

      expect(response.status).toBe(401);
      expect(response.body.error).toBe('Conversable token required');
    });

    it('should reject feedback with invalid conversable token', async () => {
      const mockSession = {
        sessionId: 'session-789',
        userId: 'user-789',
        messages: [],
        interactiveShareMetadata: {
          isActive: true,
          token: 'correct-token',
        },
      };

      chatbotDb.getChatSession.mockResolvedValue(mockSession);

      const response = await request(app)
        .put('/api/agent-mode/ishare/session-789/message/1/feedback?conversable=wrong-token')
        .send({
          type: 'like',
        });

      expect(response.status).toBe(401);
      expect(response.body.error).toBe('Invalid or expired conversable token');
    });

    it('should reject feedback with invalid type', async () => {
      const mockSession = {
        sessionId: 'session-123',
        userId: 'user-123',
        messages: [],
        interactiveShareMetadata: {
          isActive: true,
          token: 'valid-token',
        },
      };

      chatbotDb.getChatSession.mockResolvedValue(mockSession);

      const response = await request(app)
        .put('/api/agent-mode/ishare/session-123/message/1/feedback?conversable=valid-token')
        .send({
          type: 'invalid',
        });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('Invalid feedback type. Must be "like" or "dislike"');
    });

    it('should reject feedback with comment exceeding 500 characters', async () => {
      const mockSession = {
        sessionId: 'session-123',
        userId: 'user-123',
        messages: [],
        interactiveShareMetadata: {
          isActive: true,
          token: 'valid-token',
        },
      };

      chatbotDb.getChatSession.mockResolvedValue(mockSession);

      const longComment = 'x'.repeat(501);

      const response = await request(app)
        .put('/api/agent-mode/ishare/session-123/message/1/feedback?conversable=valid-token')
        .send({
          type: 'like',
          comment: longComment,
        });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('Comment too long. Maximum 500 characters');
    });

    it('should reject feedback for non-existent session', async () => {
      chatbotDb.getChatSession.mockResolvedValue(null);

      const response = await request(app)
        .put('/api/agent-mode/ishare/session-999/message/1/feedback?conversable=token')
        .send({
          type: 'like',
        });

      expect(response.status).toBe(404);
      expect(response.body.error).toBe('Session not found');
    });

    it('should reject feedback for inactive ishare', async () => {
      const mockSession = {
        sessionId: 'session-123',
        userId: 'user-123',
        messages: [],
        interactiveShareMetadata: {
          isActive: false,
          token: 'valid-token',
        },
      };

      chatbotDb.getChatSession.mockResolvedValue(mockSession);

      const response = await request(app)
        .put('/api/agent-mode/ishare/session-123/message/1/feedback?conversable=valid-token')
        .send({
          type: 'like',
        });

      expect(response.status).toBe(401);
      expect(response.body.error).toBe('Invalid or expired conversable token');
    });

    it('should reject feedback for invalid message index', async () => {
      const mockSession = {
        sessionId: 'session-123',
        userId: 'user-123',
        messages: [],
        interactiveShareMetadata: {
          isActive: true,
          token: 'valid-token',
        },
      };

      const mockMessages = [
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi there!' },
      ];

      chatbotDb.getChatSession.mockResolvedValue(mockSession);
      chatbotDb.getMessagesFromMessagesTable.mockResolvedValue(mockMessages);

      const response = await request(app)
        .put('/api/agent-mode/ishare/session-123/message/99/feedback?conversable=valid-token')
        .send({
          type: 'like',
        });

      expect(response.status).toBe(404);
      expect(response.body.error).toBe('Message not found');
    });

    it('should reject feedback for user message (only assistant messages allowed)', async () => {
      const mockSession = {
        sessionId: 'session-123',
        userId: 'user-123',
        messages: [],
        interactiveShareMetadata: {
          isActive: true,
          token: 'valid-token',
        },
      };

      const mockMessages = [
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi there!' },
      ];

      chatbotDb.getChatSession.mockResolvedValue(mockSession);
      chatbotDb.getMessagesFromMessagesTable.mockResolvedValue(mockMessages);

      const response = await request(app)
        .put('/api/agent-mode/ishare/session-123/message/0/feedback?conversable=valid-token')
        .send({
          type: 'like',
        });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('Can only rate assistant messages');
    });
  });
});
