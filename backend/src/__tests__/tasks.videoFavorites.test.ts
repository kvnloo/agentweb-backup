// Unit tests for video favorites and archives in tasks routes

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
}));

// Import the router after mocking
const router = require('../routes/tasks').default;

describe('Tasks Routes - Video Favorites and Archives', () => {
  let app: express.Application;

  beforeEach(() => {
    jest.clearAllMocks();
    app = express();
    app.use(express.json());
    app.use('/api/tasks', router);
  });

  describe('POST /executions/:executionId/favorite-image (for videos)', () => {
    it('should toggle favorite status for agent-mode video', async () => {
      const sessionId = 'session-123';
      const executionId = `${sessionId}-videos`;
      const videoUrl = 'https://example.com/video.mp4';

      const mockSession = {
        sessionId,
        userId: 'user123',
        favorites: {},
        archives: {}
      };

      (ChatbotDB.prototype.getChatSession as jest.Mock).mockResolvedValue(mockSession);
      (dynamodb.update as jest.Mock).mockReturnValue({
        promise: jest.fn().mockResolvedValue({})
      });

      const response = await request(app)
        .post(`/api/tasks/executions/${executionId}/favorite-image`)
        .send({ imageUrl: videoUrl })
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.is_favorited).toBe(true);
      expect(ChatbotDB.prototype.getChatSession).toHaveBeenCalledWith(sessionId);
      expect(dynamodb.update).toHaveBeenCalled();
    });

    it('should unfavorite an already favorited agent-mode video', async () => {
      const sessionId = 'session-123';
      const executionId = `${sessionId}-videos`;
      const videoUrl = 'https://example.com/video.mp4';

      const mockSession = {
        sessionId,
        userId: 'user123',
        favorites: {
          [videoUrl]: true
        },
        archives: {}
      };

      (ChatbotDB.prototype.getChatSession as jest.Mock).mockResolvedValue(mockSession);
      (dynamodb.update as jest.Mock).mockReturnValue({
        promise: jest.fn().mockResolvedValue({})
      });

      const response = await request(app)
        .post(`/api/tasks/executions/${executionId}/favorite-image`)
        .send({ imageUrl: videoUrl })
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.is_favorited).toBe(false);
      
      // Verify the update removes the favorite
      const updateCall = (dynamodb.update as jest.Mock).mock.calls[0][0];
      const favorites = updateCall.ExpressionAttributeValues[':favorites'];
      expect(favorites[videoUrl]).toBeUndefined();
    });

    it('should handle regular task video favorites', async () => {
      const executionId = 'exec-123';
      const videoUrl = 'https://example.com/video.mp4';

      const mockExecution = {
        executionId,
        userId: 'user123',
        result_files: [{
          url: videoUrl,
          filename: 'video.mp4',
          is_favorited: false
        }]
      };

      (taskDb.getTaskExecutionById as jest.Mock).mockResolvedValue(mockExecution);
      (taskDb.updateTaskExecution as jest.Mock).mockResolvedValue({});

      const response = await request(app)
        .post(`/api/tasks/executions/${executionId}/favorite-image`)
        .send({ imageUrl: videoUrl })
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.is_favorited).toBe(true);
    });
  });

  describe('POST /executions/:executionId/archive-image (for videos)', () => {
    it('should archive an agent-mode video', async () => {
      const sessionId = 'session-123';
      const executionId = `${sessionId}-videos`;
      const videoUrl = 'https://example.com/video.mp4';

      const mockSession = {
        sessionId,
        userId: 'user123',
        favorites: {},
        archives: {}
      };

      (ChatbotDB.prototype.getChatSession as jest.Mock).mockResolvedValue(mockSession);
      (dynamodb.update as jest.Mock).mockReturnValue({
        promise: jest.fn().mockResolvedValue({})
      });

      const response = await request(app)
        .post(`/api/tasks/executions/${executionId}/archive-image`)
        .send({ imageUrl: videoUrl })
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(ChatbotDB.prototype.getChatSession).toHaveBeenCalledWith(sessionId);
      
      // Verify the update sets archive to true
      const updateCall = (dynamodb.update as jest.Mock).mock.calls[0][0];
      const archives = updateCall.ExpressionAttributeValues[':archives'];
      expect(archives[videoUrl]).toBe(true);
    });

    it('should handle regular task video archives', async () => {
      const executionId = 'exec-123';
      const videoUrl = 'https://example.com/video.mp4';

      const mockExecution = {
        executionId,
        userId: 'user123',
        result_files: [{
          url: videoUrl,
          filename: 'video.mp4',
          is_archived: false
        }]
      };

      (taskDb.getTaskExecutionById as jest.Mock).mockResolvedValue(mockExecution);
      (taskDb.updateTaskExecution as jest.Mock).mockResolvedValue({});

      const response = await request(app)
        .post(`/api/tasks/executions/${executionId}/archive-image`)
        .send({ imageUrl: videoUrl })
        .expect(200);

      expect(response.body.success).toBe(true);
    });
  });

  describe('GET /executions/with-videos', () => {
    it('should include agent-mode videos with favorite status', async () => {
      const sessionId = 'session-123';
      const videoUrl = 'https://example.com/video.mp4';

      const messages = [{
        timestamp: '2024-01-01T00:00:00Z',
        metadata: {
          toolCalls: [{
            name: 'generate_video',
            result: {
              success: true,
              videoUrl: videoUrl,
              filename: 'video.mp4'
            }
          }]
        }
      }];

      (ChatbotDB.prototype.getSessionsWithoutMessages as jest.Mock).mockResolvedValue([{
        sessionId,
        userId: 'user123',
        title: 'Test Session',
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
        archived: false,
        favorites: { [videoUrl]: true },
        archives: {},
        messages: [],
        messageCount: messages.length,
      }]);
      (ChatbotDB.prototype.getMessagesFromMessagesTable as jest.Mock).mockResolvedValue(messages);
      (ChatbotDB.prototype.updateAssetCache as jest.Mock).mockResolvedValue(undefined);

      (taskDb.getAllTaskExecutionsByUserId as jest.Mock).mockResolvedValue([]);
      (taskDb.getTasksByUserId as jest.Mock).mockResolvedValue([]);

      const response = await request(app)
        .get('/api/tasks/executions/with-videos')
        .expect(200);

      // Verify getSessionsWithoutMessages was called
      expect(ChatbotDB.prototype.getSessionsWithoutMessages).toHaveBeenCalledWith('user123', 'agent');

      const taskKey = `agent-mode-${sessionId}`;
      expect(response.body[taskKey]).toBeDefined();
      expect(response.body[taskKey].source).toBe('agent-mode');
      expect(response.body[taskKey].executions[0].result_files[0].is_favorited).toBe(true);
    });

    it('should filter out archived agent-mode videos', async () => {
      const sessionId = 'session-123';
      const videoUrl = 'https://example.com/video.mp4';

      const messages = [{
        timestamp: '2024-01-01T00:00:00Z',
        metadata: {
          toolCalls: [{
            name: 'generate_video',
            result: {
              success: true,
              videoUrl: videoUrl,
              filename: 'video.mp4'
            }
          }]
        }
      }];

      (ChatbotDB.prototype.getSessionsWithoutMessages as jest.Mock).mockResolvedValue([{
        sessionId,
        userId: 'user123',
        title: 'Test Session',
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
        archived: false,
        favorites: {},
        archives: { [videoUrl]: true },
        messages: [],
        messageCount: messages.length,
      }]);
      (ChatbotDB.prototype.getMessagesFromMessagesTable as jest.Mock).mockResolvedValue(messages);
      (ChatbotDB.prototype.updateAssetCache as jest.Mock).mockResolvedValue(undefined);

      (taskDb.getAllTaskExecutionsByUserId as jest.Mock).mockResolvedValue([]);
      (taskDb.getTasksByUserId as jest.Mock).mockResolvedValue([]);

      const response = await request(app)
        .get('/api/tasks/executions/with-videos')
        .expect(200);

      // Verify getSessionsWithoutMessages was called
      expect(ChatbotDB.prototype.getSessionsWithoutMessages).toHaveBeenCalledWith('user123', 'agent');

      const taskKey = `agent-mode-${sessionId}`;
      // Archived videos should not appear in results
      // The task object may still exist but with empty executions
      if (response.body[taskKey]) {
        expect(response.body[taskKey].executions).toEqual([]);
      } else {
        // Or the task object itself may not exist
        expect(response.body[taskKey]).toBeUndefined();
      }
    });
  });
});

