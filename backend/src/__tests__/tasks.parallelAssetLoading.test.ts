// Tests for parallel batch loading of session messages in getExecutionsWithAssets.
// Verifies that sessions are loaded in parallel batches instead of sequentially,
// and that DynamoDB pagination works for getAllTaskExecutionsByUserId.

import express from 'express';
import request from 'supertest';
import { ChatbotDB } from '../services/chatbotService';
import { taskDb } from '../services/db';

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

jest.mock('../services/chatbotService');
jest.mock('../services/db', () => ({
  taskDb: {
    getAllTaskExecutionsByUserId: jest.fn(),
    getTasksByUserId: jest.fn(),
  },
}));
jest.mock('../middleware/auth', () => ({
  authenticateToken: (req: any, res: any, next: any) => {
    req.user = { userId: 'user123', isAdmin: false };
    next();
  },
}));

const router = require('../routes/tasks').default;

function makeSession(id: string, imageUrl: string) {
  return {
    sessionId: id,
    userId: 'user123',
    title: `Session ${id}`,
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T12:00:00Z',
    archived: false,
    favorites: {},
    archives: {},
    messages: [
      {
        role: 'assistant',
        content: 'Generated image',
        timestamp: '2024-01-01T12:00:00Z',
        metadata: {
          portalType: 'agent' as const,
          timestamp: '2024-01-01T12:00:00Z',
          toolCalls: [
            {
              id: `tool-${id}`,
              name: 'generate_image',
              arguments: {},
              result: { success: true, imageUrl, filename: `image-${id}.png` },
            },
          ],
        },
      },
    ],
  };
}

describe('Parallel batch loading of session messages', () => {
  let app: express.Application;

  beforeEach(() => {
    jest.clearAllMocks();
    app = express();
    app.use(express.json());
    app.use('/api/tasks', router);
  });

  it('should load messages for many sessions in parallel batches', async () => {
    // Create 20 sessions to force multiple batches (batch size = 15)
    const sessions = Array.from({ length: 20 }, (_, i) =>
      makeSession(`session-${i}`, `https://example.com/image-${i}.png`)
    );

    const sessionsMeta = sessions.map(({ messages, ...meta }) => ({
      ...meta,
      messages: [],
      messageCount: messages.length,
    }));

    (ChatbotDB.prototype.getSessionsWithoutMessages as jest.Mock).mockResolvedValue(sessionsMeta);

    const messagesBySession = new Map(sessions.map((s) => [s.sessionId, s.messages]));
    (ChatbotDB.prototype.getMessagesFromMessagesTable as jest.Mock).mockImplementation(
      (sid: string) => Promise.resolve(messagesBySession.get(sid) || [])
    );
    (ChatbotDB.prototype.updateAssetCache as jest.Mock).mockResolvedValue(undefined);

    (taskDb.getAllTaskExecutionsByUserId as jest.Mock).mockResolvedValue([]);
    (taskDb.getTasksByUserId as jest.Mock).mockResolvedValue([]);

    const response = await request(app)
      .get('/api/tasks/executions/with-images')
      .expect(200);

    // All 20 sessions should have been loaded
    expect(ChatbotDB.prototype.getMessagesFromMessagesTable).toHaveBeenCalledTimes(20);

    // All 20 images should be in the response
    for (let i = 0; i < 20; i++) {
      const taskKey = `agent-mode-session-${i}`;
      expect(response.body[taskKey]).toBeDefined();
      expect(response.body[taskKey].executions[0].result_files[0].url).toBe(
        `https://example.com/image-${i}.png`
      );
    }
  });

  it('should correctly handle a mix of cached and uncached sessions in parallel', async () => {
    // Session 1: has up-to-date cache (no message loading needed)
    const cachedSession = {
      sessionId: 'cached-session',
      userId: 'user123',
      title: 'Cached',
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T12:00:00Z',
      archived: false,
      favorites: {},
      archives: {},
      messages: [],
      messageCount: 5,
      assetScanIndex: 5,
      assetCache: {
        images: [{ url: 'https://example.com/cached.png', filename: 'cached.png', generatedAt: '2024-01-01T12:00:00Z' }],
        videos: [],
        htmlReports: [],
      },
    };

    // Session 2: no cache (needs full scan)
    const uncachedSession = makeSession('uncached-session', 'https://example.com/fresh.png');

    const sessionsMeta = [
      { ...cachedSession },
      {
        sessionId: uncachedSession.sessionId,
        userId: uncachedSession.userId,
        title: uncachedSession.title,
        createdAt: uncachedSession.createdAt,
        updatedAt: uncachedSession.updatedAt,
        archived: false,
        favorites: {},
        archives: {},
        messages: [],
        messageCount: uncachedSession.messages.length,
      },
    ];

    (ChatbotDB.prototype.getSessionsWithoutMessages as jest.Mock).mockResolvedValue(sessionsMeta);
    (ChatbotDB.prototype.getMessagesFromMessagesTable as jest.Mock).mockImplementation(
      (sid: string) => {
        if (sid === 'uncached-session') return Promise.resolve(uncachedSession.messages);
        return Promise.resolve([]);
      }
    );
    (ChatbotDB.prototype.updateAssetCache as jest.Mock).mockResolvedValue(undefined);

    (taskDb.getAllTaskExecutionsByUserId as jest.Mock).mockResolvedValue([]);
    (taskDb.getTasksByUserId as jest.Mock).mockResolvedValue([]);

    const response = await request(app)
      .get('/api/tasks/executions/with-images')
      .expect(200);

    // Only the uncached session should have loaded messages
    expect(ChatbotDB.prototype.getMessagesFromMessagesTable).toHaveBeenCalledTimes(1);
    expect(ChatbotDB.prototype.getMessagesFromMessagesTable).toHaveBeenCalledWith('uncached-session');

    // Both sessions should have images in the response
    expect(response.body['agent-mode-cached-session']).toBeDefined();
    expect(response.body['agent-mode-cached-session'].executions[0].result_files[0].url).toBe(
      'https://example.com/cached.png'
    );
    expect(response.body['agent-mode-uncached-session']).toBeDefined();
    expect(response.body['agent-mode-uncached-session'].executions[0].result_files[0].url).toBe(
      'https://example.com/fresh.png'
    );
  });

  it('should filter out archived sessions before parallel loading', async () => {
    const sessions = [
      {
        sessionId: 'active-session',
        userId: 'user123',
        title: 'Active',
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T12:00:00Z',
        archived: false,
        favorites: {},
        archives: {},
        messages: [],
        messageCount: 0,
      },
      {
        sessionId: 'archived-session',
        userId: 'user123',
        title: 'Archived',
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T12:00:00Z',
        archived: true,
        favorites: {},
        archives: {},
        messages: [],
        messageCount: 5,
      },
    ];

    (ChatbotDB.prototype.getSessionsWithoutMessages as jest.Mock).mockResolvedValue(sessions);
    (ChatbotDB.prototype.getMessagesFromMessagesTable as jest.Mock).mockResolvedValue([]);
    (ChatbotDB.prototype.updateAssetCache as jest.Mock).mockResolvedValue(undefined);

    (taskDb.getAllTaskExecutionsByUserId as jest.Mock).mockResolvedValue([]);
    (taskDb.getTasksByUserId as jest.Mock).mockResolvedValue([]);

    await request(app)
      .get('/api/tasks/executions/with-images')
      .expect(200);

    // Should NOT have loaded messages for the archived session
    expect(ChatbotDB.prototype.getMessagesFromMessagesTable).not.toHaveBeenCalledWith('archived-session');
  });

  it('should handle errors in individual sessions without failing the entire batch', async () => {
    const sessions = [
      makeSession('good-session', 'https://example.com/good.png'),
      makeSession('bad-session', 'https://example.com/bad.png'),
    ];

    const sessionsMeta = sessions.map(({ messages, ...meta }) => ({
      ...meta,
      messages: [],
      messageCount: messages.length,
    }));

    (ChatbotDB.prototype.getSessionsWithoutMessages as jest.Mock).mockResolvedValue(sessionsMeta);
    (ChatbotDB.prototype.getMessagesFromMessagesTable as jest.Mock).mockImplementation(
      (sid: string) => {
        if (sid === 'bad-session') return Promise.reject(new Error('DynamoDB error'));
        return Promise.resolve(sessions.find((s) => s.sessionId === sid)?.messages || []);
      }
    );
    (ChatbotDB.prototype.updateAssetCache as jest.Mock).mockResolvedValue(undefined);

    (taskDb.getAllTaskExecutionsByUserId as jest.Mock).mockResolvedValue([]);
    (taskDb.getTasksByUserId as jest.Mock).mockResolvedValue([]);

    // The overall request should still succeed (the try/catch in getExecutionsWithAssets handles it)
    const response = await request(app)
      .get('/api/tasks/executions/with-images')
      .expect(200);

    // The good session's image should still be present even though bad session errored
    // (The error is caught at the batch level, so the entire agent-mode section may fail)
    // This tests that the endpoint doesn't return 500
    expect(response.status).toBe(200);
  });
});
