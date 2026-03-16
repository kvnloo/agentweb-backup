// Unit tests for image feedback endpoint in tasks routes

import express from 'express';
import request from 'supertest';
import { ChatbotDB } from '../services/chatbotService';
import { dynamodb } from '../config/aws';
import { taskDb } from '../services/db';

// Mock dependencies
jest.mock('../services/chatbotService');
jest.mock('../config/aws');
jest.mock('../services/db', () => ({
  taskDb: {
    getTaskExecutionById: jest.fn(),
    updateTaskExecution: jest.fn(),
    getAllTaskExecutionsByUserId: jest.fn(),
    getTasksByUserId: jest.fn()
  }
}));
jest.mock('../middleware/auth', () => ({
  authenticateToken: (req: any, res: any, next: any) => {
    req.user = { userId: 'user123', isAdmin: false };
    next();
  },
  getEffectiveOwnerId: (req: any) => req.user?.userId,
}));

const router = require('../routes/tasks').default;

describe('Tasks Routes - Image Feedback', () => {
  let app: express.Application;

  beforeEach(() => {
    jest.clearAllMocks();
    app = express();
    app.use(express.json());
    app.use('/api/tasks', router);
  });

  describe('POST /executions/:executionId/image-feedback', () => {
    // --- Validation tests ---

    it('should return 400 when imageUrl is missing', async () => {
      const response = await request(app)
        .post('/api/tasks/executions/exec-123/image-feedback')
        .send({ type: 'dislike', reasons: ['Low quality or blurry'] })
        .expect(400);

      expect(response.body.message).toContain('image URL are required');
    });

    it('should return 400 for invalid feedback type', async () => {
      const response = await request(app)
        .post('/api/tasks/executions/exec-123/image-feedback')
        .send({ imageUrl: 'https://example.com/img.png', type: 'neutral' })
        .expect(400);

      expect(response.body.message).toContain('Invalid feedback type');
    });

    it('should return 400 when comment exceeds 500 characters', async () => {
      const response = await request(app)
        .post('/api/tasks/executions/exec-123/image-feedback')
        .send({
          imageUrl: 'https://example.com/img.png',
          type: 'dislike',
          comment: 'x'.repeat(501),
        })
        .expect(400);

      expect(response.body.message).toContain('Comment too long');
    });

    // --- Agent mode tests ---

    it('should store dislike feedback on agent-mode session and inject system message', async () => {
      const sessionId = 'session-abc';
      const executionId = `${sessionId}-images`;
      const imageUrl = 'https://example.com/img.png';

      const mockSession = {
        sessionId,
        userId: 'user123',
        feedbacks: {},
        favorites: {},
      };

      (ChatbotDB.prototype.getChatSession as jest.Mock).mockResolvedValue(mockSession);
      (ChatbotDB.prototype.addMessageToSession as jest.Mock).mockResolvedValue({});
      (dynamodb.update as jest.Mock).mockReturnValue({
        promise: jest.fn().mockResolvedValue({}),
      });

      const response = await request(app)
        .post(`/api/tasks/executions/${executionId}/image-feedback`)
        .send({
          imageUrl,
          type: 'dislike',
          reasons: ['Logo is wrong', 'Low quality or blurry'],
          comment: 'The logo is stretched',
        })
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.feedback.type).toBe('dislike');
      expect(response.body.feedback.reasons).toEqual(['Logo is wrong', 'Low quality or blurry']);
      expect(response.body.feedback.comment).toBe('The logo is stretched');

      // Verify feedbacks were stored on session
      const updateCall = (dynamodb.update as jest.Mock).mock.calls[0][0];
      const feedbacks = updateCall.ExpressionAttributeValues[':feedbacks'];
      expect(feedbacks[imageUrl].type).toBe('dislike');

      // Verify system message was injected
      expect(ChatbotDB.prototype.addMessageToSession).toHaveBeenCalledWith(
        sessionId,
        expect.objectContaining({
          role: 'system',
          content: expect.stringContaining('[Image Feedback]'),
        })
      );
    });

    it('should store like feedback on agent-mode session without system message', async () => {
      const sessionId = 'session-abc';
      const executionId = `${sessionId}-images`;
      const imageUrl = 'https://example.com/img.png';

      const mockSession = {
        sessionId,
        userId: 'user123',
        feedbacks: {},
      };

      (ChatbotDB.prototype.getChatSession as jest.Mock).mockResolvedValue(mockSession);
      (dynamodb.update as jest.Mock).mockReturnValue({
        promise: jest.fn().mockResolvedValue({}),
      });

      const response = await request(app)
        .post(`/api/tasks/executions/${executionId}/image-feedback`)
        .send({ imageUrl, type: 'like' })
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.feedback.type).toBe('like');

      // System message should NOT be injected for likes
      expect(ChatbotDB.prototype.addMessageToSession).not.toHaveBeenCalled();
    });

    it('should return 404 when agent-mode session not found', async () => {
      const executionId = 'nonexistent-session-images';

      (ChatbotDB.prototype.getChatSession as jest.Mock).mockResolvedValue(null);

      const response = await request(app)
        .post(`/api/tasks/executions/${executionId}/image-feedback`)
        .send({ imageUrl: 'https://example.com/img.png', type: 'dislike' })
        .expect(404);

      expect(response.body.message).toContain('Session not found');
    });

    it('should return 403 when user does not own the session', async () => {
      const sessionId = 'other-user-session';
      const executionId = `${sessionId}-images`;

      const mockSession = {
        sessionId,
        userId: 'other-user-456',
        feedbacks: {},
      };

      (ChatbotDB.prototype.getChatSession as jest.Mock).mockResolvedValue(mockSession);

      const response = await request(app)
        .post(`/api/tasks/executions/${executionId}/image-feedback`)
        .send({ imageUrl: 'https://example.com/img.png', type: 'dislike' })
        .expect(403);

      expect(response.body.message).toContain('Not authorized');
    });

    // --- Regular execution tests ---

    it('should store dislike feedback on regular execution result_files', async () => {
      const executionId = 'exec-regular-123';
      const imageUrl = 'https://example.com/img.png';

      const mockExecution = {
        executionId,
        userId: 'user123',
        result_files: [
          { url: imageUrl, filename: 'img.png', token: 'tok1' },
          { url: 'https://example.com/other.png', filename: 'other.png', token: 'tok2' },
        ],
      };

      (taskDb.getTaskExecutionById as jest.Mock).mockResolvedValue(mockExecution);
      (taskDb.updateTaskExecution as jest.Mock).mockResolvedValue({});

      const response = await request(app)
        .post(`/api/tasks/executions/${executionId}/image-feedback`)
        .send({
          imageUrl,
          type: 'dislike',
          reasons: ['Wrong style or aesthetic'],
          comment: 'Too dark',
        })
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.feedback.type).toBe('dislike');

      // Verify updateTaskExecution was called with feedback on the correct file
      const updateCall = (taskDb.updateTaskExecution as jest.Mock).mock.calls[0];
      expect(updateCall[0]).toBe(executionId);
      const updatedFiles = updateCall[1].result_files;
      const targetFile = updatedFiles.find((f: any) => f.url === imageUrl);
      expect(targetFile.feedback.type).toBe('dislike');
      expect(targetFile.feedback.reasons).toEqual(['Wrong style or aesthetic']);

      // Other files should not be modified
      const otherFile = updatedFiles.find((f: any) => f.url !== imageUrl);
      expect(otherFile.feedback).toBeUndefined();
    });

    it('should return 404 when regular execution not found', async () => {
      (taskDb.getTaskExecutionById as jest.Mock).mockResolvedValue(null);

      const response = await request(app)
        .post('/api/tasks/executions/nonexistent-exec/image-feedback')
        .send({ imageUrl: 'https://example.com/img.png', type: 'dislike' })
        .expect(404);

      expect(response.body.message).toContain('Execution not found');
    });

    it('should return 403 when user does not own the execution', async () => {
      const mockExecution = {
        executionId: 'exec-other-user',
        userId: 'other-user-456',
        result_files: [],
      };

      (taskDb.getTaskExecutionById as jest.Mock).mockResolvedValue(mockExecution);

      const response = await request(app)
        .post('/api/tasks/executions/exec-other-user/image-feedback')
        .send({ imageUrl: 'https://example.com/img.png', type: 'dislike' })
        .expect(403);

      expect(response.body.message).toContain('Not authorized');
    });
  });

  describe('GET /executions/with-images - feedback field in agent-mode result_files', () => {
    const makeAgentSession = (overrides: Record<string, any>) => ({
      sessionId: 'session-fb-1',
      userId: 'user123',
      title: 'Image Session',
      createdAt: '2024-06-01T00:00:00Z',
      updatedAt: '2024-06-01T12:00:00Z',
      favorites: {},
      archives: {},
      messages: [],
      ...overrides,
    });

    it('should include feedback from session.feedbacks in agent-mode image result_files', async () => {
      const imageUrl = 'https://storage.example.com/gen-image.png';
      const feedbackData = {
        type: 'dislike' as const,
        reasons: ['Logo is wrong'],
        comment: 'Stretched logo',
        timestamp: '2024-06-01T12:00:00Z',
        userId: 'user123',
      };

      (taskDb.getAllTaskExecutionsByUserId as jest.Mock).mockResolvedValue([]);
      (taskDb.getTasksByUserId as jest.Mock).mockResolvedValue([]);

      const session = makeAgentSession({
        favorites: { [imageUrl]: true },
        feedbacks: { [imageUrl]: feedbackData },
        messages: [
          {
            role: 'assistant',
            content: 'Here is your image',
            metadata: {
              portalType: 'agent',
              timestamp: '2024-06-01T12:00:00Z',
              toolCalls: [
                {
                  name: 'generate_image',
                  result: { success: true, imageUrl, filename: 'gen-image.png' },
                },
              ],
            },
          },
        ],
      });
      // getUserSessions returns session stubs, getChatSession returns the full session with messages
      const { messages: msgs, ...sessionMeta } = session;
      (ChatbotDB.prototype.getSessionsWithoutMessages as jest.Mock).mockResolvedValue([{ ...sessionMeta, messages: [], messageCount: msgs.length }]);
      (ChatbotDB.prototype.getMessagesFromMessagesTable as jest.Mock).mockResolvedValue(msgs);
      (ChatbotDB.prototype.updateAssetCache as jest.Mock).mockResolvedValue(undefined);

      const response = await request(app)
        .get('/api/tasks/executions/with-images')
        .expect(200);

      const sessionKey = Object.keys(response.body).find(
        (key) => response.body[key].source === 'agent-mode'
      );
      expect(sessionKey).toBeDefined();

      const sessionData = response.body[sessionKey!];
      expect(sessionData.executions).toHaveLength(1);

      const file = sessionData.executions[0].result_files[0];
      expect(file.url).toBe(imageUrl);
      expect(file.is_favorited).toBe(true);
      expect(file.feedback).toEqual(feedbackData);
    });

    it('should set feedback to undefined when session has no feedbacks for an image', async () => {
      const imageUrl = 'https://storage.example.com/no-fb.png';

      (taskDb.getAllTaskExecutionsByUserId as jest.Mock).mockResolvedValue([]);
      (taskDb.getTasksByUserId as jest.Mock).mockResolvedValue([]);

      const session = makeAgentSession({
        sessionId: 'session-fb-2',
        title: 'No Feedback Session',
        messages: [
          {
            role: 'assistant',
            content: 'Image generated',
            metadata: {
              portalType: 'agent',
              timestamp: '2024-06-01T12:00:00Z',
              toolCalls: [
                {
                  name: 'generate_image',
                  result: { success: true, imageUrl, filename: 'no-fb.png' },
                },
              ],
            },
          },
        ],
      });
      const { messages: msgs, ...sessionMeta } = session;
      (ChatbotDB.prototype.getSessionsWithoutMessages as jest.Mock).mockResolvedValue([{ ...sessionMeta, messages: [], messageCount: msgs.length }]);
      (ChatbotDB.prototype.getMessagesFromMessagesTable as jest.Mock).mockResolvedValue(msgs);
      (ChatbotDB.prototype.updateAssetCache as jest.Mock).mockResolvedValue(undefined);

      const response = await request(app)
        .get('/api/tasks/executions/with-images')
        .expect(200);

      const sessionKey = Object.keys(response.body).find(
        (key) => response.body[key].source === 'agent-mode'
      );
      expect(sessionKey).toBeDefined();

      const file = response.body[sessionKey!].executions[0].result_files[0];
      expect(file.url).toBe(imageUrl);
      expect(file.is_favorited).toBe(false);
      expect(file.feedback).toBeUndefined();
    });

    it('should include like feedback from session.feedbacks for uploaded images', async () => {
      const imageUrl = 'https://storage.example.com/uploaded.png';
      const likeFeedback = {
        type: 'like' as const,
        timestamp: '2024-06-01T12:00:00Z',
        userId: 'user123',
      };

      (taskDb.getAllTaskExecutionsByUserId as jest.Mock).mockResolvedValue([]);
      (taskDb.getTasksByUserId as jest.Mock).mockResolvedValue([]);

      const session = makeAgentSession({
        sessionId: 'session-fb-3',
        title: 'Upload Session',
        favorites: { [imageUrl]: true },
        feedbacks: { [imageUrl]: likeFeedback },
        messages: [
          {
            role: 'assistant',
            content: 'Image uploaded',
            metadata: {
              portalType: 'agent',
              timestamp: '2024-06-01T12:00:00Z',
              toolCalls: [
                {
                  name: 'upload_image',
                  result: { success: true, imageUrl, filename: 'uploaded.png' },
                },
              ],
            },
          },
        ],
      });
      const { messages: msgs, ...sessionMeta } = session;
      (ChatbotDB.prototype.getSessionsWithoutMessages as jest.Mock).mockResolvedValue([{ ...sessionMeta, messages: [], messageCount: msgs.length }]);
      (ChatbotDB.prototype.getMessagesFromMessagesTable as jest.Mock).mockResolvedValue(msgs);
      (ChatbotDB.prototype.updateAssetCache as jest.Mock).mockResolvedValue(undefined);

      const response = await request(app)
        .get('/api/tasks/executions/with-images')
        .expect(200);

      const sessionKey = Object.keys(response.body).find(
        (key) => response.body[key].source === 'agent-mode'
      );
      expect(sessionKey).toBeDefined();

      const file = response.body[sessionKey!].executions[0].result_files[0];
      expect(file.url).toBe(imageUrl);
      expect(file.is_favorited).toBe(true);
      expect(file.feedback).toEqual(likeFeedback);
    });
  });
});
