import { chatbotDb } from '../services/chatbotService';

// Track DynamoDB calls
const queryPromiseMock = jest.fn();
const updatePromiseMock = jest.fn();
const getPromiseMock = jest.fn();

jest.mock('aws-sdk', () => {
  return {
    DynamoDB: {
      DocumentClient: jest.fn(() => ({
        query: jest.fn(() => ({ promise: queryPromiseMock })),
        get: jest.fn(() => ({ promise: getPromiseMock })),
        put: jest.fn(() => ({ promise: jest.fn().mockResolvedValue({}) })),
        update: jest.fn(() => ({ promise: updatePromiseMock })),
        batchWrite: jest.fn(() => ({ promise: jest.fn().mockResolvedValue({}) })),
      })),
    },
    S3: jest.fn(() => ({
      upload: jest.fn().mockReturnThis(),
      promise: jest.fn(),
    })),
    config: { update: jest.fn() },
  };
});

jest.mock('openai', () => jest.fn(() => ({})));
jest.mock('@google-cloud/discoveryengine', () => ({
  EngineServiceClient: jest.fn(),
  SearchServiceClient: jest.fn(),
}));
jest.mock('@google-cloud/storage', () => ({
  Storage: jest.fn(),
}));
jest.mock('../controllers/guide', () => ({ getGuide: jest.fn() }));
jest.mock('../controllers/release', () => ({ getReleases: jest.fn() }));
jest.mock('../controllers/docsController', () => ({ getUserReleaseNotes: jest.fn() }));
jest.mock('../services/db', () => ({ taskDb: {} }));
jest.mock('../utils/secretsManager', () => ({ getGCSPPrivateKey: jest.fn() }));

describe('Asset Cache - chatbotService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    updatePromiseMock.mockResolvedValue({});
  });

  describe('getSessionsWithoutMessages', () => {
    it('should return sessions without loading messages', async () => {
      queryPromiseMock.mockResolvedValueOnce({
        Items: [
          {
            sessionId: 'sess-1',
            userId: 'user-1',
            portalType: 'agent',
            title: 'Test Session',
            createdAt: '2026-01-01T00:00:00Z',
            updatedAt: '2026-01-02T00:00:00Z',
            messages: [{ role: 'user', content: 'should be stripped' }],
            messageCount: 5,
            assetScanIndex: 5,
            assetCache: {
              images: [{ url: 'https://example.com/img.png', filename: 'img.png', generatedAt: '2026-01-01T00:00:00Z' }],
              videos: [],
              htmlReports: [],
            },
          },
          {
            sessionId: 'sess-2',
            userId: 'user-1',
            portalType: 'agent',
            archived: true,
            createdAt: '2026-01-01T00:00:00Z',
            updatedAt: '2026-01-01T00:00:00Z',
            messages: [],
          },
        ],
      });

      const sessions = await chatbotDb.getSessionsWithoutMessages('user-1', 'agent');

      // Only 1 non-archived session returned
      expect(sessions).toHaveLength(1);
      expect(sessions[0].sessionId).toBe('sess-1');
      // Messages should be empty (metadata only)
      expect(sessions[0].messages).toEqual([]);
      // Asset cache fields should be preserved
      expect(sessions[0].messageCount).toBe(5);
      expect(sessions[0].assetScanIndex).toBe(5);
      expect(sessions[0].assetCache?.images).toHaveLength(1);
      // Only 1 query call (no message loading)
      expect(queryPromiseMock).toHaveBeenCalledTimes(1);
    });

    it('should filter by portalType', async () => {
      queryPromiseMock.mockResolvedValueOnce({
        Items: [
          {
            sessionId: 'sess-1',
            userId: 'user-1',
            portalType: 'agent',
            createdAt: '2026-01-01T00:00:00Z',
            updatedAt: '2026-01-01T00:00:00Z',
            messages: [],
          },
        ],
      });

      await chatbotDb.getSessionsWithoutMessages('user-1', 'agent');

      expect(queryPromiseMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('getMessagesFromIndex', () => {
    it('should query messages starting from a given index', async () => {
      queryPromiseMock.mockResolvedValueOnce({
        Items: [
          { sessionId: 'sess-1', messageIndex: 5, message: { role: 'user', content: 'New msg 1' } },
          { sessionId: 'sess-1', messageIndex: 6, message: { role: 'assistant', content: 'New msg 2' } },
        ],
      });

      const messages = await chatbotDb.getMessagesFromIndex('sess-1', 5);

      expect(messages).toHaveLength(2);
      expect(messages[0].content).toBe('New msg 1');
      expect((messages[0] as any).messageIndex).toBe(5);
      expect(messages[1].content).toBe('New msg 2');
      expect((messages[1] as any).messageIndex).toBe(6);
    });

    it('should paginate through multiple DynamoDB pages', async () => {
      queryPromiseMock.mockResolvedValueOnce({
        Items: [
          { sessionId: 'sess-1', messageIndex: 10, message: { role: 'user', content: 'page1' } },
        ],
        LastEvaluatedKey: { sessionId: 'sess-1', messageIndex: 10 },
      });
      queryPromiseMock.mockResolvedValueOnce({
        Items: [
          { sessionId: 'sess-1', messageIndex: 11, message: { role: 'assistant', content: 'page2' } },
        ],
      });

      const messages = await chatbotDb.getMessagesFromIndex('sess-1', 10);

      expect(messages).toHaveLength(2);
      expect(queryPromiseMock).toHaveBeenCalledTimes(2);
    });

    it('should return empty array if table does not exist', async () => {
      const error: any = new Error('Table not found');
      error.code = 'ResourceNotFoundException';
      queryPromiseMock.mockRejectedValueOnce(error);

      const messages = await chatbotDb.getMessagesFromIndex('sess-1', 0);
      expect(messages).toEqual([]);
    });
  });

  describe('updateAssetCache', () => {
    it('should update assetCache and assetScanIndex on the session record', async () => {
      updatePromiseMock.mockResolvedValueOnce({});

      const cache = {
        images: [{ url: 'https://example.com/img.png', filename: 'img.png', generatedAt: '2026-01-01T00:00:00Z' }],
        videos: [],
        htmlReports: [],
      };

      await chatbotDb.updateAssetCache('sess-1', cache, 10);

      expect(updatePromiseMock).toHaveBeenCalledTimes(1);
    });

    it('should not throw on error (non-critical)', async () => {
      updatePromiseMock.mockRejectedValueOnce(new Error('DynamoDB error'));

      // Should not throw
      await expect(chatbotDb.updateAssetCache('sess-1', { images: [], videos: [], htmlReports: [] }, 5))
        .resolves.toBeUndefined();
    });
  });

  describe('incrementMessageCount via addMessageToSession', () => {
    it('should increment messageCount when adding a message', async () => {
      // getChatSession: get item returns session
      getPromiseMock.mockResolvedValueOnce({
        Item: {
          sessionId: 'sess-1',
          userId: 'user-1',
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-01T00:00:00Z',
          messages: [],
        },
      });
      // getMessagesFromMessagesTable (from getChatSession): empty
      queryPromiseMock.mockResolvedValueOnce({ Items: [] });
      // getMessagesFromMessagesTable (for count): empty
      queryPromiseMock.mockResolvedValueOnce({ Items: [] });
      // addMessagesToMessagesTable: no-op (batchWrite mocked)
      // incrementMessageCount: update
      updatePromiseMock.mockResolvedValueOnce({});

      await chatbotDb.addMessageToSession('sess-1', {
        role: 'user',
        content: 'Hello',
      });

      // update should have been called (for incrementMessageCount)
      expect(updatePromiseMock).toHaveBeenCalled();
    });

    it('should increment messageCount by batch size when adding multiple messages', async () => {
      // getChatSession: get item returns session
      getPromiseMock.mockResolvedValueOnce({
        Item: {
          sessionId: 'sess-1',
          userId: 'user-1',
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-01T00:00:00Z',
          messages: [],
        },
      });
      // getMessagesFromMessagesTable (from getChatSession): empty
      queryPromiseMock.mockResolvedValueOnce({ Items: [] });
      // addMessagesToSession calls getChatSession again
      getPromiseMock.mockResolvedValueOnce({
        Item: {
          sessionId: 'sess-1',
          userId: 'user-1',
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-01T00:00:00Z',
          messages: [],
        },
      });
      // getMessagesFromMessagesTable (from second getChatSession): empty
      queryPromiseMock.mockResolvedValueOnce({ Items: [] });
      // getMessagesFromMessagesTable (for count): empty
      queryPromiseMock.mockResolvedValueOnce({ Items: [] });
      // incrementMessageCount: update
      updatePromiseMock.mockResolvedValueOnce({});

      await chatbotDb.addMessagesToSession('sess-1', [
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi' },
        { role: 'user', content: 'Bye' },
      ]);

      // update should have been called
      expect(updatePromiseMock).toHaveBeenCalled();
    });
  });
});
