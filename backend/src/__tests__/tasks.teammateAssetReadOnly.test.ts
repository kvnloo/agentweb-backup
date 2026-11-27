/**
 * ENG-2874 / ENG-2840: in the shared workspace, a teammate's read of the asset library is read-only. Only the owner's own read may write
 * the session asset caches (the background warm of uncached sessions, the incremental cache update), as it alone may backfill report text.
 * Driven through the real GET /api/tasks/executions/with-videos and getExecutionsWithAssets.
 */
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
  taskDb: { getAllTaskExecutionsByUserId: jest.fn(), getTasksByUserId: jest.fn(), updateTaskExecutionResultFiles: jest.fn() },
  subscriberDb: {},
  userDb: { getUserById: jest.fn(async (userId: string) => ({ userId, orgId: 'org-1' })) },
  orgDb: { getOrgMembers: jest.fn(async () => [{ userId: 'owner-1', orgId: 'org-1' }, { userId: 'mate-1', orgId: 'org-1' }]) },
}));
jest.mock('../middleware/auth', () => ({
  authenticateToken: (req: any, _res: any, next: any) => {
    req.user = { userId: 'owner-1', isAdmin: false };
    next();
  },
}));

const router = require('../routes/tasks').default;
const proto = ChatbotDB.prototype as unknown as Record<string, jest.Mock>;
const VIDEO_URL = 'https://agentweb-user-files.s3.us-west-2.amazonaws.com/u/clip.mp4';
const videoMessage = {
  role: 'assistant', content: 'Generated video', timestamp: '2026-11-01T12:00:00Z', messageIndex: 0,
  metadata: { timestamp: '2026-11-01T12:00:00Z', toolCalls: [{ id: 't0', name: 'generate_video', arguments: {}, result: { success: true, videoUrl: VIDEO_URL, filename: 'clip.mp4' } }] },
};
const uncachedSessionOf = (userId: string) => ({ sessionId: `${userId}-s1`, userId, title: 'S', createdAt: '2026-11-01T00:00:00Z', archived: false, messageCount: 1, messages: [] });

async function settle() {
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve));
}

beforeEach(() => {
  jest.clearAllMocks();
  proto.getSessionsWithoutMessages.mockImplementation(async (userId: string) => [uncachedSessionOf(userId)]);
  proto.getMessagesFromMessagesTable.mockResolvedValue([videoMessage]);
  proto.getMessagesFromIndex.mockResolvedValue([]);
  proto.updateAssetCache.mockResolvedValue(undefined);
  (taskDb.getAllTaskExecutionsByUserId as jest.Mock).mockResolvedValue([]);
  (taskDb.getTasksByUserId as jest.Mock).mockResolvedValue([]);
});

it('writes only the owner\'s session caches; a teammate\'s sessions are read, never written', async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/tasks', router);

  await request(app).get('/api/tasks/executions/with-videos').expect(200);
  await settle();

  expect(proto.getSessionsWithoutMessages).toHaveBeenCalledWith('mate-1', 'agent');
  const written = proto.updateAssetCache.mock.calls.map((call: any[]) => call[0]);
  expect(written).toContain('owner-1-s1');
  expect(written).not.toContain('mate-1-s1');
});
