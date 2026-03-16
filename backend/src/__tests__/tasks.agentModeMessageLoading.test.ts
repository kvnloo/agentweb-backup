// Unit tests for Agent Mode message loading in getExecutionsWithAssets
// Tests verify that getSessionsWithoutMessages + getMessagesFromMessagesTable are used
// for incremental asset caching instead of loading full sessions.

import express from 'express';
import request from 'supertest';
import { ChatbotDB } from '../services/chatbotService';
import { taskDb } from '../services/db';

// Mock AWS SDK to prevent real calls when run alongside other test suites
jest.mock('aws-sdk', () => ({
  config: { update: jest.fn() },
  DynamoDB: {
    DocumentClient: jest.fn(() => ({
      get: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
      put: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
      query: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({ Items: [] }) }),
      update: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
      delete: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
      scan: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({ Items: [] }) }),
    })),
  },
  S3: jest.fn(() => ({
    upload: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({ Location: '', Key: '' }) }),
    getObject: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
    getSignedUrl: jest.fn(),
  })),
  SecretsManager: jest.fn(() => ({
    getSecretValue: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({ SecretString: '{}' }) }),
  })),
}));

// Mock dependencies
jest.mock('../services/chatbotService');
jest.mock('../services/db', () => ({
  taskDb: {
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

/**
 * Helper: set up mocks for getSessionsWithoutMessages + getMessagesFromMessagesTable.
 * Takes sessions with messages, splits them into metadata-only sessions + message arrays.
 */
function mockSessionsForAssetLoading(sessions: Array<{ messages: any[]; [key: string]: any }>) {
  const sessionsMeta = sessions.map(({ messages, ...meta }) => ({
    ...meta,
    messages: [],
    messageCount: messages.length,
  }));

  (ChatbotDB.prototype.getSessionsWithoutMessages as jest.Mock).mockResolvedValue(sessionsMeta);

  // Map sessionId → messages for getMessagesFromMessagesTable
  const messagesBySession = new Map(sessions.map(s => [s.sessionId, s.messages]));
  (ChatbotDB.prototype.getMessagesFromMessagesTable as jest.Mock).mockImplementation((sid: string) => {
    return Promise.resolve(messagesBySession.get(sid) || []);
  });

  (ChatbotDB.prototype.updateAssetCache as jest.Mock).mockResolvedValue(undefined);
}

describe('Tasks Routes - Agent Mode Message Loading Fix', () => {
  let app: express.Application;
  const mockUserId = 'user123';

  beforeEach(() => {
    jest.clearAllMocks();
    app = express();
    app.use(express.json());
    app.use('/api/tasks', router);
  });

  describe('GET /executions/with-images', () => {
    it('should load session messages via getMessagesFromMessagesTable for asset scanning', async () => {
      const sessionId = 'session-123';
      const imageUrl = 'https://example.com/image.png';

      const messages = [
        {
          role: 'assistant',
          content: 'Generated an image',
          timestamp: '2024-01-01T12:00:00Z',
          metadata: {
            portalType: 'agent' as const,
            timestamp: '2024-01-01T12:00:00Z',
            toolCalls: [
              {
                id: 'tool-call-1',
                name: 'generate_image',
                arguments: {},
                result: {
                  success: true,
                  imageUrl: imageUrl,
                  filename: 'generated-image.png'
                }
              }
            ]
          }
        }
      ];

      mockSessionsForAssetLoading([{
        sessionId,
        userId: mockUserId,
        title: 'Test Session',
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T12:00:00Z',
        archived: false,
        favorites: {},
        archives: {},
        messages,
      }]);

      (taskDb.getAllTaskExecutionsByUserId as jest.Mock).mockResolvedValue([]);
      (taskDb.getTasksByUserId as jest.Mock).mockResolvedValue([]);

      const response = await request(app)
        .get('/api/tasks/executions/with-images')
        .expect(200);

      // Verify getSessionsWithoutMessages was called
      expect(ChatbotDB.prototype.getSessionsWithoutMessages).toHaveBeenCalledWith(mockUserId, 'agent');

      // Verify the image was found and included in results
      const taskKey = `agent-mode-${sessionId}`;
      expect(response.body[taskKey]).toBeDefined();
      expect(response.body[taskKey].source).toBe('agent-mode');
      expect(response.body[taskKey].executions).toHaveLength(1);
      expect(response.body[taskKey].executions[0].result_files).toHaveLength(1);
      expect(response.body[taskKey].executions[0].result_files[0].url).toBe(imageUrl);
      expect(response.body[taskKey].executions[0].result_files[0].filename).toBe('generated-image.png');
    });

    it('should handle sessions that have no messages after loading', async () => {
      const sessionId = 'session-456';

      mockSessionsForAssetLoading([{
        sessionId,
        userId: mockUserId,
        title: 'Empty Session',
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T12:00:00Z',
        archived: false,
        favorites: {},
        archives: {},
        messages: [],
      }]);

      (taskDb.getAllTaskExecutionsByUserId as jest.Mock).mockResolvedValue([]);
      (taskDb.getTasksByUserId as jest.Mock).mockResolvedValue([]);

      const response = await request(app)
        .get('/api/tasks/executions/with-images')
        .expect(200);

      // Verify getSessionsWithoutMessages was called
      expect(ChatbotDB.prototype.getSessionsWithoutMessages).toHaveBeenCalledWith(mockUserId, 'agent');

      // Verify no images were found (session has no messages with tool calls)
      const taskKey = `agent-mode-${sessionId}`;
      expect(response.body[taskKey]).toBeUndefined();
    });

    it('should skip archived sessions', async () => {
      const sessionId = 'session-archived';

      // getSessionsWithoutMessages already filters out archived sessions,
      // but test that the code handles it if one slips through
      (ChatbotDB.prototype.getSessionsWithoutMessages as jest.Mock).mockResolvedValue([{
        sessionId,
        userId: mockUserId,
        title: 'Archived Session',
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T12:00:00Z',
        archived: true,
        favorites: {},
        archives: {},
        messages: [],
      }]);
      (ChatbotDB.prototype.updateAssetCache as jest.Mock).mockResolvedValue(undefined);

      (taskDb.getAllTaskExecutionsByUserId as jest.Mock).mockResolvedValue([]);
      (taskDb.getTasksByUserId as jest.Mock).mockResolvedValue([]);

      const response = await request(app)
        .get('/api/tasks/executions/with-images')
        .expect(200);

      // Verify no messages were loaded for archived sessions
      expect(ChatbotDB.prototype.getMessagesFromMessagesTable).not.toHaveBeenCalled();

      // Verify no images were found
      const taskKey = `agent-mode-${sessionId}`;
      expect(response.body[taskKey]).toBeUndefined();
    });

    it('should handle multiple sessions and load messages for each', async () => {
      const sessionId1 = 'session-1';
      const sessionId2 = 'session-2';
      const imageUrl1 = 'https://example.com/image1.png';
      const imageUrl2 = 'https://example.com/image2.png';

      mockSessionsForAssetLoading([
        {
          sessionId: sessionId1,
          userId: mockUserId,
          title: 'Session 1',
          createdAt: '2024-01-01T00:00:00Z',
          updatedAt: '2024-01-01T12:00:00Z',
          archived: false,
          favorites: {},
          archives: {},
          messages: [
            {
              role: 'assistant',
              content: 'Generated image 1',
              timestamp: '2024-01-01T12:00:00Z',
              metadata: {
                portalType: 'agent' as const,
                timestamp: '2024-01-01T12:00:00Z',
                toolCalls: [
                  {
                    id: 'tool-call-1',
                    name: 'generate_image',
                    arguments: {},
                    result: { success: true, imageUrl: imageUrl1, filename: 'image1.png' }
                  }
                ]
              }
            }
          ],
        },
        {
          sessionId: sessionId2,
          userId: mockUserId,
          title: 'Session 2',
          createdAt: '2024-01-02T00:00:00Z',
          updatedAt: '2024-01-02T12:00:00Z',
          archived: false,
          favorites: {},
          archives: {},
          messages: [
            {
              role: 'assistant',
              content: 'Generated image 2',
              timestamp: '2024-01-02T12:00:00Z',
              metadata: {
                portalType: 'agent' as const,
                timestamp: '2024-01-02T12:00:00Z',
                toolCalls: [
                  {
                    id: 'tool-call-2',
                    name: 'generate_image',
                    arguments: {},
                    result: { success: true, imageUrl: imageUrl2, filename: 'image2.png' }
                  }
                ]
              }
            }
          ],
        },
      ]);

      (taskDb.getAllTaskExecutionsByUserId as jest.Mock).mockResolvedValue([]);
      (taskDb.getTasksByUserId as jest.Mock).mockResolvedValue([]);

      const response = await request(app)
        .get('/api/tasks/executions/with-images')
        .expect(200);

      // Verify both images were found
      const taskKey1 = `agent-mode-${sessionId1}`;
      const taskKey2 = `agent-mode-${sessionId2}`;
      expect(response.body[taskKey1]).toBeDefined();
      expect(response.body[taskKey2]).toBeDefined();
      expect(response.body[taskKey1].executions[0].result_files[0].url).toBe(imageUrl1);
      expect(response.body[taskKey2].executions[0].result_files[0].url).toBe(imageUrl2);
    });

    it('should handle both generate_image and upload_image tool calls', async () => {
      const sessionId = 'session-mixed';
      const generatedImageUrl = 'https://example.com/generated.png';
      const uploadedImageUrl = 'https://example.com/uploaded.png';

      mockSessionsForAssetLoading([{
        sessionId,
        userId: mockUserId,
        title: 'Mixed Session',
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T12:00:00Z',
        archived: false,
        favorites: {},
        archives: {},
        messages: [
          {
            role: 'assistant',
            content: 'Generated an image',
            timestamp: '2024-01-01T10:00:00Z',
            metadata: {
              portalType: 'agent' as const,
              timestamp: '2024-01-01T10:00:00Z',
              toolCalls: [
                {
                  id: 'tool-call-1',
                  name: 'generate_image',
                  arguments: {},
                  result: { success: true, imageUrl: generatedImageUrl, filename: 'generated.png' }
                }
              ]
            }
          },
          {
            role: 'system',
            content: 'Image uploaded',
            timestamp: '2024-01-01T12:00:00Z',
            metadata: {
              portalType: 'agent' as const,
              timestamp: '2024-01-01T12:00:00Z',
              toolCalls: [
                {
                  id: 'tool-call-2',
                  name: 'upload_image',
                  arguments: {},
                  result: { success: true, imageUrl: uploadedImageUrl, filename: 'uploaded.png' }
                }
              ]
            }
          }
        ],
      }]);

      (taskDb.getAllTaskExecutionsByUserId as jest.Mock).mockResolvedValue([]);
      (taskDb.getTasksByUserId as jest.Mock).mockResolvedValue([]);

      const response = await request(app)
        .get('/api/tasks/executions/with-images')
        .expect(200);

      const taskKey = `agent-mode-${sessionId}`;
      expect(response.body[taskKey]).toBeDefined();
      expect(response.body[taskKey].executions[0].result_files).toHaveLength(2);

      const imageUrls = response.body[taskKey].executions[0].result_files.map((f: any) => f.url);
      expect(imageUrls).toContain(generatedImageUrl);
      expect(imageUrls).toContain(uploadedImageUrl);
    });
  });

  describe('GET /executions/with-videos', () => {
    it('should load messages via getMessagesFromMessagesTable for videos', async () => {
      const sessionId = 'session-video';
      const videoUrl = 'https://example.com/video.mp4';

      mockSessionsForAssetLoading([{
        sessionId,
        userId: mockUserId,
        title: 'Video Session',
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T12:00:00Z',
        archived: false,
        favorites: {},
        archives: {},
        messages: [
          {
            role: 'assistant',
            content: 'Generated a video',
            timestamp: '2024-01-01T12:00:00Z',
            metadata: {
              portalType: 'agent' as const,
              timestamp: '2024-01-01T12:00:00Z',
              toolCalls: [
                {
                  id: 'tool-call-1',
                  name: 'generate_video',
                  arguments: {},
                  result: { success: true, videoUrl: videoUrl, filename: 'generated-video.mp4' }
                }
              ]
            }
          }
        ],
      }]);

      (taskDb.getAllTaskExecutionsByUserId as jest.Mock).mockResolvedValue([]);
      (taskDb.getTasksByUserId as jest.Mock).mockResolvedValue([]);

      const response = await request(app)
        .get('/api/tasks/executions/with-videos')
        .expect(200);

      // Verify getSessionsWithoutMessages was called
      expect(ChatbotDB.prototype.getSessionsWithoutMessages).toHaveBeenCalledWith(mockUserId, 'agent');

      // Verify the video was found
      const taskKey = `agent-mode-${sessionId}`;
      expect(response.body[taskKey]).toBeDefined();
      expect(response.body[taskKey].source).toBe('agent-mode');
      expect(response.body[taskKey].executions[0].result_files).toHaveLength(1);
      expect(response.body[taskKey].executions[0].result_files[0].url).toBe(videoUrl);
    });
  });
});
